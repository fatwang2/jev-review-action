export const SOURCE_LIMIT_REMEDY = "Review couldn't select source files within bounds. Add up to 6 `evidence` paths in the entry pointing at the key implementation files, or a maintainer can review manually.";

const PR_DEFECT = /submit 1–10 entry files|removal or rename requires|entry filename must match|unknown entry field|submission file must contain valid JSON|only public submitted repositories|expected a github owner\/repository|entry (category|name|description)|duplicate evidence file path|optional evidence must contain|unsafe file path|file path must be|name is reserved/i;

export function classifyReviewError(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Review failed';
  if (PR_DEFECT.test(message)) return { decision: 'error', errorKind: 'pr-defect', reasons: [message] };
  if (error?.pipelineLimit === true || /Repository tree is incomplete|Too many source candidates|returned HTTP 422\b/.test(message)) {
    return { decision: 'needs-review', errorKind: 'pipeline-limit', reasons: [SOURCE_LIMIT_REMEDY] };
  }
  return { decision: 'error', errorKind: 'infra', reasons: [message] };
}

export function pipelineLimit(error) {
  error.pipelineLimit = true;
  return error;
}
