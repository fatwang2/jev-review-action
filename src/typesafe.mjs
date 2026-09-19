import { judgeConfig, systemOne } from './jev.mjs';
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

/**
 * One evaluation through the Jev provider chain. Pass `judge` from
 * judgeConfig(); `apiKey`/`model` alone is the TypeSafe-only shorthand.
 * Answers from every provider pass the same validation, and `judge` in the
 * result names the provider that answered.
 */
export async function evaluate({ judge, apiKey, model, state, questions, fetchImpl }) {
  if (!judge) {
    invariant(typeof apiKey === 'string' && apiKey.trim().length > 0, 'TypeSafe API key is missing');
    judge = judgeConfig({ typesafeApiKey: apiKey, typesafeModel: model });
  }
  const started = Date.now();
  const { provider, ...response } = await systemOne(judge, { state, questions, fetchImpl });
  return { ...validateAnswers(response, questions), judge: provider, latencyMs: Date.now() - started };
}
