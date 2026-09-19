import { collectRepository } from './github.mjs';
import { review } from './review.mjs';
import { hash } from './policy.mjs';
import { entryFilename, invariant, repository, validateEntry } from './validation.mjs';
import { classifyReviewError } from './errors.mjs';

export async function reviewCatalog({ files, pull, github, policy, context, judge }) {
  const entries = files.filter(file => file.filename.startsWith(`${policy.entryDirectory}/`));
  if (!entries.length) return { ...context, decision: 'skipped', reasons: ['This PR does not change catalog entries'] };
  invariant(entries.length <= 10 && entries.length === files.length, 'Submit 1–10 entry files per PR, without workflow, policy, or generated-file changes');
  invariant(entries.every(file => ['added', 'modified'].includes(file.status)), 'Removal or rename requires manual maintenance review');
  const treeRepo = repository(pull.head.repo.full_name);
  const reports = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const index = next++;
      const file = entries[index];
      const entryContext = { ...context, entryPath: file.filename };
      try {
        const submission = validateEntry(await github.entryAt(treeRepo, pull.head.sha, file.filename), policy.categories);
        invariant(file.filename === `${policy.entryDirectory}/${entryFilename(submission.repository)}`, 'Entry filename must match owner--repository.json in lowercase');
        entryContext.projectRepository = submission.repository;
        const collected = await collectRepository(github, submission.repository, submission.evidence, { judge });
        reports[index] = await review({ policy, collected, submission, judge, context: entryContext });
      } catch (error) {
        reports[index] = { schemaVersion: 1, ...entryContext, policyHash: hash(policy), reviewedAt: new Date().toISOString(), ...classifyReviewError(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, entries.length) }, worker));
  if (reports.length === 1) return reports[0];
  const decision = ['error', 'not-recommended', 'needs-review'].find(value => reports.some(report => report.decision === value)) ?? 'recommended';
  return { schemaVersion: 2, ...context, reviewedAt: new Date().toISOString(), policyTitle: policy.title, policyHash: hash(policy), decision, reports };
}
