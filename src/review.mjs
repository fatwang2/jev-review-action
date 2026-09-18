import { buildQuestions, decide, hash, validatePolicy } from './policy.mjs';
import { evaluate } from './typesafe.mjs';

export async function review({ policy, collected, submission, apiKey, model, fetchImpl, context = {} }) {
  validatePolicy(policy);
  const state = { ...collected.state, ...(submission ? { submission } : {}) };
  const questions = buildQuestions(policy);
  const result = await evaluate({ apiKey, model, state, questions, fetchImpl });
  return {
    schemaVersion: 1, reviewedAt: new Date().toISOString(), ...context,
    policyTitle: policy.title, policyHash: hash(policy), stateHash: hash(state), sourceCommit: collected.sourceCommit,
    ...result,
    ...decide(policy, result.answers, { warnings: collected.warnings, proposedCategory: submission?.category }),
    evidence: collected.evidence, warnings: collected.warnings,
    ...(collected.discovery ? { discovery: collected.discovery } : {}),
  };
}
