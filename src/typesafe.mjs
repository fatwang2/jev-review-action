import { jsonRequest } from './http.mjs';
import { invariant, object, probability, text } from './validation.mjs';

export function validateAnswers(response, questions) {
  object(response, 'TypeSafe response');
  text(response.model, 'resolved model', 100);
  object(response.answers, 'answers');
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer = object(response.answers[id], `answer ${id}`);
    invariant(answer.type === q.type, `Wrong answer type for ${id}`);
    if (q.type === 'noul') {
      probability(answer.noul, `${id}.noul`);
      answers[id] = { type: 'noul', noul: answer.noul };
    } else {
      invariant(Object.hasOwn(q.criteria, answer.choice), `Unknown choice for ${id}`);
      probability(answer.confidence, `${id}.confidence`);
      object(answer.probabilities, `${id}.probabilities`);
      const keys = Object.keys(q.criteria);
      invariant(Object.keys(answer.probabilities).length === keys.length, `Incomplete probability distribution for ${id}`);
      for (const key of keys) probability(answer.probabilities[key], `${id}.${key}`);
      invariant(Math.abs(keys.reduce((n, k) => n + answer.probabilities[k], 0) - 1) <= 0.02, `Invalid probability sum for ${id}`);
      invariant(answer.probabilities[answer.choice] >= Math.max(...Object.values(answer.probabilities)) - 0.001, `Selected choice is not the highest probability for ${id}`);
      answers[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
    }
  }
  object(response.usage, 'usage');
  for (const key of ['input_tokens', 'output_tokens']) invariant(Number.isInteger(response.usage[key]) && response.usage[key] >= 0, 'Invalid token usage');
  return { model: response.model, answers, usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } };
}

export async function evaluate({ apiKey, model = 'jev-latest', state, questions, fetchImpl }) {
  invariant(typeof apiKey === 'string' && apiKey.trim().length > 0, 'TypeSafe API key is missing');
  invariant(/^jev-[a-zA-Z0-9.-]+$/.test(model), 'Only Jev model IDs are supported');
  const started = Date.now();
  const response = await jsonRequest('https://api.typesafe.ai/v1/systemone', {
    token: apiKey, method: 'POST', body: { model, state, questions }, fetchImpl, attempts: 3, maxBytes: 200_000,
  });
  return { ...validateAnswers(response, questions), latencyMs: Date.now() - started };
}
