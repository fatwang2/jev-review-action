import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeConfig, parseProviders, systemOne } from '../src/jev.mjs';
import { evaluate } from '../src/typesafe.mjs';
import { review } from '../src/review.mjs';
import { buildQuestions } from '../src/policy.mjs';
import { renderComment } from '../src/render.mjs';
import { classifyReviewError } from '../src/errors.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const QUESTIONS = {
  uses: { type: 'noul', instructions: 'Uses Jev?', criteria: { true: 'Yes', false: 'No' } },
  category: { type: 'choice', instructions: 'Which?', criteria: { sdk: 'SDK', other: 'Other' } },
};
const NATIVE = { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 }, answers: {
  uses: { type: 'noul', noul: 0.95 },
  category: { type: 'choice', choice: 'sdk', confidence: 0.9, probabilities: { sdk: 0.9, other: 0.1 } },
} };
const GATEWAY = { answers: {
  uses: { type: 'boolean', probability: 0.95 },
  category: { type: 'choice', choice: 'sdk', probabilities: { sdk: 0.9, other: 0.1 } },
}, usage: { inputTokens: 100, outputTokens: 20 }, providerMetadata: { typesafe: { confidence: { category: 0.9 } } } };
const CF_ACCOUNT = 'a'.repeat(32);
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, method: init.method, redirect: init.redirect, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}
const quiet = t => { const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; }); };
const chain = judgeConfig({ providers: 'typesafe,cloudflare,vercel', typesafeApiKey: 'ts', aiGatewayApiKey: 'vc', cloudflareAccountId: CF_ACCOUNT, cloudflareApiToken: 'cf' });

test('jev-providers is the switch: order, aliases, skipped credentials and validation', () => {
  assert.deepEqual(parseProviders(''), ['typesafe']);
  assert.deepEqual(parseProviders(' Vercel-AI-Gateway, cloudflare-workers-ai ,typesafe,vercel'), ['vercel', 'cloudflare', 'typesafe']);
  assert.throws(() => parseProviders('openai'), /unknown provider "openai"/);
  assert.deepEqual(judgeConfig({ typesafeApiKey: 'ts' }), { providers: [{ provider: 'typesafe', apiKey: 'ts', model: 'jev-latest' }] });
  assert.deepEqual(judgeConfig({ typesafeApiKey: 'ts', aiGatewayApiKey: 'vc', cloudflareAccountId: CF_ACCOUNT, cloudflareApiToken: 'cf' }).providers.map(p => p.provider), ['typesafe']);
  assert.deepEqual(chain.providers, [
    { provider: 'typesafe', apiKey: 'ts', model: 'jev-latest' },
    { provider: 'cloudflare', accountId: CF_ACCOUNT, apiToken: 'cf', model: 'typesafe/jev' },
    { provider: 'vercel', apiKey: 'vc', model: 'typesafe-ai/jev' },
  ]);
  assert.deepEqual(judgeConfig({ providers: 'vercel,cloudflare,typesafe', typesafeApiKey: 'ts' }).providers.map(p => p.provider), ['typesafe']);
  assert.throws(() => judgeConfig({}), /jev-providers=typesafe; set typesafe-api-key/);
  assert.throws(() => judgeConfig({ providers: 'vercel', typesafeApiKey: 'ts' }), /set ai-gateway-api-key/);
  assert.throws(() => judgeConfig({ providers: 'cloudflare', cloudflareAccountId: CF_ACCOUNT }), /both cloudflare-account-id and cloudflare-api-token/);
  assert.throws(() => judgeConfig({ providers: 'cloudflare', cloudflareAccountId: 'not-hex', cloudflareApiToken: 'cf' }), /32-character hex/);
  for (const inputs of [{ typesafeApiKey: 'ts', typesafeModel: 'gpt-4' }, { providers: 'vercel', aiGatewayApiKey: 'vc', aiGatewayModel: 'openai/gpt' }, { providers: 'cloudflare', cloudflareAccountId: CF_ACCOUNT, cloudflareApiToken: 'cf', cloudflareModel: '@cf/meta/llama' }]) {
    assert.throws(() => judgeConfig(inputs), /Only Jev model IDs/);
  }
});

test('Vercel speaks the evaluation-model dialect and its answers pass the same validation', async () => {
  const { calls, fetchImpl } = recorder(() => json(GATEWAY));
  const judge = judgeConfig({ providers: 'vercel', aiGatewayApiKey: 'vc-key' });
  const out = await evaluate({ judge, state: { request: 'x' }, questions: QUESTIONS, fetchImpl });
  const [call] = calls;
  assert.equal(call.url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  assert.equal(call.redirect, 'error');
  assert.equal(call.headers.Authorization, 'Bearer vc-key');
  assert.equal(call.headers['ai-model-id'], 'typesafe-ai/jev');
  assert.equal(call.headers['ai-evaluation-model-specification-version'], '4');
  assert.deepEqual(call.body, { state: { request: 'x' }, questions: {
    uses: { type: 'boolean', instructions: 'Uses Jev?', criteria: { true: 'Yes', false: 'No' } },
    category: QUESTIONS.category,
  } });
  assert.equal(out.judge, 'vercel');
  assert.equal(out.model, 'typesafe-ai/jev');
  assert.deepEqual(out.usage, { input_tokens: 100, output_tokens: 20 });
  assert.deepEqual(out.answers, NATIVE.answers);
  // Without metadata the chosen probability stands in for confidence; without probabilities validation fails.
  const bare = await evaluate({ judge, state: 'x', questions: QUESTIONS, fetchImpl: async () => json({ ...GATEWAY, providerMetadata: undefined }) });
  assert.equal(bare.answers.category.confidence, 0.9);
  const incomplete = structuredClone(GATEWAY); delete incomplete.answers.category.probabilities;
  await assert.rejects(evaluate({ judge, state: 'x', questions: QUESTIONS, fetchImpl: async () => json(incomplete) }), /probabilities must be an object/);
});

test('Cloudflare uses the Workers AI REST API and unwraps its envelope', async t => {
  quiet(t);
  const judge = judgeConfig({ providers: 'cloudflare', cloudflareAccountId: CF_ACCOUNT, cloudflareApiToken: 'cf-token' });
  const { calls, fetchImpl } = recorder(() => json({ success: true, errors: [], result: NATIVE }));
  const out = await evaluate({ judge, state: { request: 'x' }, questions: QUESTIONS, fetchImpl });
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run`);
  assert.equal(calls[0].headers.Authorization, 'Bearer cf-token');
  assert.deepEqual(calls[0].body, { model: 'typesafe/jev', input: { state: { request: 'x' }, questions: QUESTIONS } });
  assert.equal(out.judge, 'cloudflare');
  assert.deepEqual(out.answers, NATIVE.answers);
  const plain = await evaluate({ judge, state: 'x', questions: QUESTIONS, fetchImpl: async () => json(NATIVE) });
  assert.equal(plain.model, 'jev-1.13.0');
  // An exhausted balance arrives inside a 200 envelope and must count as an outage.
  await assert.rejects(systemOne(judge, { state: 'x', questions: QUESTIONS, fetchImpl: async () => json({ success: false, errors: [{ code: 2049, message: 'Insufficient balance; add money to your gateway' }] }) }),
    error => error.status === 402 && !error.message.includes('gateway'));
  await assert.rejects(systemOne(judge, { state: 'x', questions: QUESTIONS, fetchImpl: async () => json({ success: false, errors: [{ code: 7000, message: 'boom' }] }) }), error => error.status === 502);
});

test('the chain moves on only for credit, throttling and server failures', async t => {
  quiet(t);
  for (const status of [402, 429, 503]) {
    const { calls, fetchImpl } = recorder(call => call.url.includes('typesafe.ai') ? new Response('No credits', { status })
      : call.url.includes('cloudflare.com') ? json({ success: false, errors: [{ code: 2021, message: 'Insufficient AI Gateway credits' }] }) : json(GATEWAY));
    const out = await evaluate({ judge: chain, state: 'x', questions: QUESTIONS, fetchImpl });
    assert.deepEqual([...new Set(calls.map(c => new URL(c.url).host))], ['api.typesafe.ai', 'api.cloudflare.com', 'ai-gateway.vercel.sh']);
    assert.equal(out.judge, 'vercel');
  }
  const client = recorder(() => new Response('SECRET', { status: 401 }));
  await assert.rejects(evaluate({ judge: chain, state: 'x', questions: QUESTIONS, fetchImpl: client.fetchImpl }), /^Error: api.typesafe.ai returned HTTP 401$/);
  assert.equal(client.calls.length, 1);
  const all = recorder(call => new Response('', { status: call.url.includes('typesafe.ai') ? 402 : 400 }));
  await assert.rejects(evaluate({ judge: chain, state: 'x', questions: QUESTIONS, fetchImpl: all.fetchImpl }), /api.cloudflare.com returned HTTP 400/);
  await assert.rejects(systemOne({ providers: [] }, { state: 'x', questions: QUESTIONS }), /No Jev provider/);
  // The TypeSafe-only shorthand is unchanged.
  const short = await evaluate({ apiKey: 'ts', state: 'x', questions: QUESTIONS, fetchImpl: async () => json(NATIVE) });
  assert.equal(short.judge, 'typesafe');
});

test('reports and comments name the answering provider; context limits are provider-agnostic', async t => {
  quiet(t);
  const policy = JSON.parse(readFileSync(new URL('../examples/pull-request.json', import.meta.url)));
  const questions = buildQuestions(policy);
  const answers = { scope_match: { type: 'boolean', probability: 0.9 }, category: { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, bugfix: 0, feature: 0, maintenance: 0, other: 0 } } };
  const judge = judgeConfig({ providers: 'typesafe,vercel', typesafeApiKey: 'ts', aiGatewayApiKey: 'vc' });
  const report = await review({ policy, judge, collected: { state: { changes: [] }, evidence: [], warnings: [], sourceCommit: 'a'.repeat(40) },
    fetchImpl: async url => url.includes('typesafe.ai') ? new Response('', { status: 402 }) : json({ answers, usage: { inputTokens: 5, outputTokens: 1 }, providerMetadata: { typesafe: { confidence: { category: 0.9 } } } }) });
  assert.equal(report.decision, 'recommended');
  assert.equal(report.judge, 'vercel');
  assert.equal(report.model, 'typesafe-ai/jev');
  assert.equal(Object.keys(questions).length, 2);
  assert.match(renderComment({ ...report, policyHash: 'b'.repeat(64) }), /Model: `typesafe-ai\/jev` via vercel · policy:/);
  assert.equal(classifyReviewError(new Error('ai-gateway.vercel.sh returned HTTP 422')).errorKind, 'pipeline-limit');
  assert.equal(classifyReviewError(new Error('api.cloudflare.com returned HTTP 4220')).errorKind, 'infra');
});
