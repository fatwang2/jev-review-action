import { readFile, writeFile, appendFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GitHub, collectPullRequest } from './github.mjs';
import { validatePolicy } from './policy.mjs';
import { invariant, repository } from './validation.mjs';
import { review } from './review.mjs';
import { reviewCatalog } from './catalog.mjs';
import { MARKER, renderComment } from './render.mjs';
import { classifyReviewError } from './errors.mjs';
import { judgeConfig } from './jev.mjs';

const input = name => process.env[`INPUT_${name.toUpperCase()}`] ?? '';
const contained = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };

export async function main() {
  const workspace = await realpath(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  invariant(process.env.GITHUB_EVENT_NAME === 'pull_request_target', 'Use pull_request_target with a trusted base checkout; ordinary fork PR runs cannot safely access credentials');
  invariant(event.pull_request && event.repository, 'A pull request event is required');
  const repo = repository(process.env.GITHUB_REPOSITORY);
  const number = event.pull_request.number;
  invariant(event.repository.full_name === repo, 'Event repository mismatch');
  invariant(event.pull_request.base.ref === event.repository.default_branch, 'Only PRs targeting the default branch are reviewed');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  invariant(checkout === event.pull_request.base.sha, 'Checkout must be the trusted PR base SHA, never the submitted head');
  const policyPath = await realpath(resolve(workspace, input('policy') || '.github/jev-review.json'));
  invariant(contained(workspace, policyPath), 'Policy must be inside the trusted checkout');
  const policy = validatePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
  const output = resolve(workspace, input('report-path') || 'jev-report.json');
  invariant(contained(workspace, output) && output !== workspace, 'Report must be inside the workspace');
  await mkdir(dirname(output), { recursive: true });
  invariant(contained(workspace, await realpath(dirname(output))), 'Report directory must not escape the workspace');
  const github = new GitHub(input('github-token') || process.env.GITHUB_TOKEN);
  const pull = await github.pull(repo, number);
  const context = { repository: repo, pullRequest: number, headSha: event.pull_request.head.sha, runUrl: `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` };
  let report;
  try {
    invariant(pull.head.sha === event.pull_request.head.sha, 'PR changed before review started; run the latest review');
    invariant(pull.state === 'open', 'PR is no longer open');
    const files = await github.changedFiles(repo, number);
    invariant(files.length === pull.changed_files, 'Incomplete PR file list');
    // Provider credentials are read here and never written to the report.
    const judge = judgeConfig({
      providers: input('jev-providers'),
      typesafeApiKey: input('typesafe-api-key'), typesafeModel: input('model'),
      aiGatewayApiKey: input('ai-gateway-api-key'), aiGatewayModel: input('ai-gateway-model'),
      cloudflareAccountId: input('cloudflare-account-id'), cloudflareApiToken: input('cloudflare-api-token'), cloudflareModel: input('cloudflare-ai-model'),
    });
    const options = { policy, judge, context };
    if (policy.mode === 'catalog') {
      report = await reviewCatalog({ ...options, files, pull, github });
    } else report = await review({ ...options, collected: collectPullRequest(pull, files) });
  } catch (error) {
    report = { ...context, ...classifyReviewError(error), reviewedAt: new Date().toISOString() };
  }
  const current = await github.pull(repo, number);
  if (current.head.sha !== context.headSha || current.state !== 'open') {
    report = { ...report, decision: 'skipped', reasons: ['PR changed or closed while review was running; no comment was published'] };
  } else if (input('comment') !== 'false') {
    try { await github.upsertComment(repo, number, renderComment(report), MARKER); }
    catch { report = { ...report, decision: 'error', reasons: [...(report.reasons ?? []), 'Could not publish the review comment; check pull-requests write permission'] }; }
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${renderComment(report)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries({ decision: report.decision, category: report.category ?? '', 'report-path': output })) {
      const delimiter = randomUUID();
      await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
    }
  }
  console.log(`Jev review: ${report.decision}`);
  if (report.decision === 'error') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Jev review failed before completion. Check the event, trusted checkout, permissions, policy, and network access.'); process.exitCode = 1; });
}
