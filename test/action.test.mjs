import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/index.mjs';

const fixturePolicy = JSON.parse(await readFile(new URL('../examples/pull-request.json', import.meta.url)));
const head = 'b'.repeat(40), newer = 'c'.repeat(40);

async function runAction({ moveHead = false, staleEvent = false, modelFails = false, catalog = false, wrongCheckout = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-action-test-'));
  const priorEnv = { ...process.env }, priorFetch = globalThis.fetch, priorExit = process.exitCode;
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
    await mkdir(join(dir, '.github'));
    await writeFile(join(dir, '.github/jev-review.json'), JSON.stringify(catalog ? JSON.parse(await readFile(new URL('../examples/catalog.json', import.meta.url))) : fixturePolicy));
    git(['add', '.']); git(['commit', '-m', 'Trusted base']);
    const base = git(['rev-parse', 'HEAD']);
    const event = { repository: { full_name: 'owner/catalog', default_branch: 'main' }, pull_request: { number: 1, head: { sha: head }, base: { sha: wrongCheckout ? newer : base, ref: 'main' } } };
    await writeFile(join(dir, 'event.json'), JSON.stringify(event));
    const env = { GITHUB_WORKSPACE: dir, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REPOSITORY: 'owner/catalog', GITHUB_RUN_ID: '123', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), 'INPUT_TYPESAFE-API-KEY': 'fixture-key', 'INPUT_GITHUB-TOKEN': 'fixture-token', INPUT_POLICY: '.github/jev-review.json', INPUT_MODEL: 'jev-latest', INPUT_COMMENT: 'true', 'INPUT_REPORT-PATH': 'report.json' };
    Object.assign(process.env, env);
    let pullReads = 0, modelCalls = 0;
    const writes = [];
    globalThis.fetch = async (url, opts) => {
      const json = data => new Response(JSON.stringify(data));
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        modelCalls++;
        if (modelFails) return new Response('sensitive provider detail', { status: 401 });
        return json({ model: 'jev-fixture', usage: { input_tokens: 12, output_tokens: 4 }, answers: { scope_match: { type: 'noul', noul: 0.95 }, category: { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 1, bugfix: 0, feature: 0, maintenance: 0, other: 0 } } } });
      }
      assert.ok(url.startsWith('https://api.github.com/repos/owner/catalog/'));
      if (opts.method === 'POST' || opts.method === 'PATCH') { writes.push(JSON.parse(opts.body)); return json({ id: 7 }); }
      if (url.endsWith('/pulls/1')) {
        pullReads++;
        return json({ number: 1, state: 'open', title: 'Update docs', body: 'Improve setup instructions', changed_files: catalog ? 2 : 1, head: { sha: staleEvent || moveHead && pullReads > 1 ? newer : head, repo: { full_name: 'owner/catalog' } }, html_url: 'https://github.com/owner/catalog/pull/1' });
      }
      if (url.includes('/files?')) return json(catalog ? [{ filename: 'entries/owner--project.json', status: 'added' }, { filename: '.github/workflows/review.yml', status: 'modified' }] : [{ filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-old docs\n+new docs' }]);
      if (url.includes('/comments?')) return json([]);
      throw new Error('Unexpected endpoint');
    };
    if (wrongCheckout) {
      await assert.rejects(main(), /trusted PR base SHA/);
      assert.equal(modelCalls, 0); assert.equal(writes.length, 0);
      return;
    }
    await main();
    return { report: JSON.parse(await readFile(join(dir, 'report.json'))), outputs: await readFile(join(dir, 'output'), 'utf8'), writes, modelCalls, exitCode: process.exitCode };
  } finally {
    globalThis.fetch = priorFetch; process.exitCode = priorExit;
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    await rm(dir, { recursive: true, force: true });
  }
}

test('full action reads trusted policy, evaluates, comments and writes report/outputs', async () => {
  const run = await runAction();
  assert.equal(run.modelCalls, 1); assert.equal(run.writes.length, 1);
  assert.equal(run.report.decision, 'recommended'); assert.equal(run.report.headSha, head);
  assert.match(run.outputs, /recommended/); assert.match(run.writes[0].body, /Suggested category/);
});

test('changed PR head suppresses publishing an obsolete judgment', async () => {
  const run = await runAction({ moveHead: true });
  assert.equal(run.report.decision, 'skipped'); assert.equal(run.writes.length, 0);
});

test('old queued event does not evaluate or overwrite the latest review', async () => {
  const run = await runAction({ staleEvent: true });
  assert.equal(run.report.decision, 'skipped'); assert.equal(run.modelCalls, 0); assert.equal(run.writes.length, 0);
});

test('provider failure writes a visible failure report rather than a passing review', async () => {
  const run = await runAction({ modelFails: true });
  assert.equal(run.report.decision, 'error'); assert.equal(run.exitCode, 1);
  assert.equal(run.writes.length, 1); assert.ok(!JSON.stringify(run).includes('sensitive provider detail'));
});

test('catalog PR cannot alter workflows alongside its submission', async () => {
  const run = await runAction({ catalog: true });
  assert.equal(run.report.decision, 'error'); assert.equal(run.modelCalls, 0);
  assert.match(run.report.reasons[0], /exactly one entry/);
});

test('submitted head checkout is refused before any provider call', async () => {
  await runAction({ wrongCheckout: true });
});
