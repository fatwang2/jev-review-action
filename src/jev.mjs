// Jev provider chain. Jev is served by three providers that speak slightly
// different dialects of the same evaluation API; callers only see TypeSafe's
// shape. The first configured provider is primary and the rest are tried in
// order when it is out of credit (402), throttled (429) or failing (5xx).
// Every origin is fixed; redirects are rejected by jsonRequest.
// - TypeSafe System One: https://docs.typesafe.ai/api
// - Vercel AI Gateway, model typesafe-ai/jev: https://vercel.com/ai-gateway/models/jev
// - Cloudflare Workers AI REST API, model typesafe/jev: https://developers.cloudflare.com/ai/models/typesafe/jev/
import { jsonRequest } from './http.mjs';
import { invariant } from './validation.mjs';

export const DEFAULT_PROVIDERS = ['typesafe'];
const ALIASES = {
  typesafe: 'typesafe',
  vercel: 'vercel', 'vercel-ai-gateway': 'vercel',
  cloudflare: 'cloudflare', 'cloudflare-workers-ai': 'cloudflare', 'cloudflare-ai-gateway': 'cloudflare',
};
export const DEFAULT_MODELS = { typesafe: 'jev-latest', vercel: 'typesafe-ai/jev', cloudflare: 'typesafe/jev' };
// Only Jev model IDs are accepted, in each provider's naming.
const MODEL_PATTERN = { typesafe: /^jev-[a-zA-Z0-9.-]+$/, vercel: /^typesafe-ai\/jev(?:-[a-zA-Z0-9.-]+)?$/, cloudflare: /^typesafe\/jev(?:-[a-zA-Z0-9.-]+)?$/ };
const CREDENTIAL = { typesafe: 'typesafe-api-key', vercel: 'ai-gateway-api-key', cloudflare: 'cloudflare-account-id and cloudflare-api-token' };
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const VERCEL_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
const CLOUDFLARE_URL = 'https://api.cloudflare.com/client/v4/accounts';
const present = value => typeof value === 'string' && value.trim().length > 0;

export function parseProviders(value) {
  const names = String(value ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return [...DEFAULT_PROVIDERS];
  const order = [];
  for (const name of names) {
    const id = ALIASES[name];
    invariant(id, `jev-providers lists unknown provider "${name}"; use ${Object.keys(ALIASES).join(', ')}`);
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

function model(id, value) {
  const resolved = present(value) ? value.trim() : DEFAULT_MODELS[id];
  invariant(MODEL_PATTERN[id].test(resolved), `Only Jev model IDs are supported for ${id}`);
  return resolved;
}

function configured(id, inputs) {
  if (id === 'typesafe') return present(inputs.typesafeApiKey) ? { provider: id, apiKey: inputs.typesafeApiKey, model: model(id, inputs.typesafeModel) } : null;
  if (id === 'vercel') return present(inputs.aiGatewayApiKey) ? { provider: id, apiKey: inputs.aiGatewayApiKey, model: model(id, inputs.aiGatewayModel) } : null;
  if (!present(inputs.cloudflareAccountId) && !present(inputs.cloudflareApiToken)) return null;
  invariant(present(inputs.cloudflareAccountId) && present(inputs.cloudflareApiToken), 'cloudflare needs both cloudflare-account-id and cloudflare-api-token');
  invariant(/^[a-f0-9]{32}$/.test(inputs.cloudflareAccountId), 'cloudflare-account-id must be a 32-character hex account ID');
  return { provider: id, accountId: inputs.cloudflareAccountId, apiToken: inputs.cloudflareApiToken, model: model(id, inputs.cloudflareModel) };
}

/**
 * `providers` is the switch: only listed providers are used, in the order given;
 * unset means TypeSafe alone. A listed provider without credentials is skipped,
 * so unlisted credentials never activate a provider by accident.
 */
export function judgeConfig(inputs = {}) {
  const order = parseProviders(inputs.providers);
  const providers = order.map(id => configured(id, inputs)).filter(Boolean);
  invariant(providers.length, `No Jev provider is configured for jev-providers=${order.join(',')}; set ${order.map(id => CREDENTIAL[id]).join(' or ')}`);
  return { providers };
}

const normalise = (provider, config, body) => ({
  model: typeof body?.model === 'string' ? body.model : config.model,
  provider,
  answers: body?.answers,
  usage: body?.usage,
});

async function callTypeSafe(config, state, questions, fetchImpl) {
  const body = await jsonRequest(TYPESAFE_URL, { token: config.apiKey, method: 'POST', body: { model: config.model, state, questions }, fetchImpl, attempts: 3, maxBytes: 200_000 });
  return normalise('typesafe', config, body);
}

// Cloudflare's REST API wraps results in { result, success, errors }; an
// exhausted AI Gateway balance arrives as an error object rather than HTTP 402.
async function callCloudflare(config, state, questions, fetchImpl) {
  const body = await jsonRequest(`${CLOUDFLARE_URL}/${config.accountId}/ai/run`, {
    token: config.apiToken, method: 'POST', body: { model: config.model, input: { state, questions } }, fetchImpl, attempts: 3, maxBytes: 200_000,
  });
  if (body && typeof body === 'object' && 'success' in body) {
    if (body.success !== true) {
      const codes = Array.isArray(body.errors) ? body.errors.map(e => `${e?.code ?? ''} ${e?.message ?? ''}`).join('; ') : '';
      const status = /insufficient .*(balance|credits)|\b(2021|2049)\b/i.test(codes) ? 402 : /rate.?limit|too many requests/i.test(codes) ? 429 : 502;
      const error = new Error(`api.cloudflare.com returned HTTP ${status}`);
      error.status = status;
      throw error;
    }
    return normalise('cloudflare', config, body.result);
  }
  return normalise('cloudflare', config, body);
}

// Vercel speaks the AI SDK evaluation-model dialect: noul questions are
// `boolean`, usage is camelCase and TypeSafe's confidence rides in metadata.
const toGatewayQuestion = question => question.type === 'noul'
  ? { type: 'boolean', instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) }
  : question;

function fromGatewayAnswer(answer, confidence) {
  if (answer?.type === 'boolean') return { type: 'noul', noul: answer.probability };
  if (answer?.type === 'choice') {
    // Missing probabilities are left missing so answer validation fails visibly.
    const probabilities = answer.probabilities;
    return { type: 'choice', choice: answer.choice, probabilities, confidence: confidence ?? probabilities?.[answer.choice] };
  }
  return answer;
}

async function callVercel(config, state, questions, fetchImpl) {
  const body = await jsonRequest(VERCEL_URL, {
    token: config.apiKey, method: 'POST', fetchImpl, attempts: 3, maxBytes: 200_000,
    headers: {
      'ai-gateway-auth-method': 'api-key',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': config.model,
    },
    body: { state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toGatewayQuestion(q)])) },
  });
  const confidence = body?.providerMetadata?.typesafe?.confidence ?? {};
  const answers = body?.answers && typeof body.answers === 'object'
    ? Object.fromEntries(Object.entries(body.answers).map(([id, answer]) => [id, fromGatewayAnswer(answer, confidence[id])]))
    : undefined;
  const usage = body?.usage && typeof body.usage === 'object' ? { input_tokens: body.usage.inputTokens, output_tokens: body.usage.outputTokens } : undefined;
  return { model: config.model, provider: 'vercel', answers, usage };
}

function call(config, state, questions, fetchImpl) {
  if (config.provider === 'vercel') return callVercel(config, state, questions, fetchImpl);
  if (config.provider === 'cloudflare') return callCloudflare(config, state, questions, fetchImpl);
  return callTypeSafe(config, state, questions, fetchImpl);
}

/** Failures worth retrying elsewhere: no credit, throttled, or the service is down. */
export const isProviderOutage = error => error?.status === 402 || error?.status === 429 || error?.status >= 500;

/** Asks the provider chain; each fallback is tried once, in order, for outages only. */
export async function systemOne(judge, { state, questions, fetchImpl }) {
  invariant(judge?.providers?.length, 'No Jev provider is configured');
  for (let index = 0; ; index++) {
    const config = judge.providers[index];
    try { return await call(config, state, questions, fetchImpl); }
    catch (error) {
      const next = judge.providers[index + 1];
      if (!next || !isProviderOutage(error)) throw error;
      console.warn(`Jev provider ${config.provider} returned HTTP ${error.status}; retrying with ${next.provider}`);
    }
  }
}
