import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/index.mjs';

const fixturePolicy = JSON.parse(await readFile(new URL('../examples/pull-request.json', import.meta.url)));
const head = 'b'.repeat(40), newer = 'c'.repeat(40);

async function runAction({ moveHead = false, staleEvent = false, modelFails = false, catalog = false, wrongCheckout = false, entries, entryFailure, rejected, uncertain, removed = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-action-test-'));
  const priorEnv = { ...process.env }, priorFetch = globalThis.fetch, priorExit = process.exitCode;
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
    await mkdir(join(dir, '.github'));
    const policy = entries ? { ...fixturePolicy, mode: 'catalog', entryDirectory: 'entries' } : catalog ? JSON.parse(await readFile(new URL('../examples/catalog.json', import.meta.url))) : fixturePolicy;
    await writeFile(join(dir, '.github/jev-review.json'), JSON.stringify(policy));
    git(['add', '.']); git(['commit', '-m', 'Trusted base']);
    const base = git(['rev-parse', 'HEAD']);
    const event = { repository: { full_name: 'owner/catalog', default_branch: 'main' }, pull_request: { number: 1, head: { sha: head }, base: { sha: wrongCheckout ? newer : base, ref: 'main' } } };
    await writeFile(join(dir, 'event.json'), JSON.stringify(event));
    const env = { GITHUB_WORKSPACE: dir, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REPOSITORY: 'owner/catalog', GITHUB_RUN_ID: '123', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), 'INPUT_TYPESAFE-API-KEY': 'fixture-key', 'INPUT_GITHUB-TOKEN': 'fixture-token', INPUT_POLICY: '.github/jev-review.json', INPUT_MODEL: 'jev-latest', INPUT_COMMENT: 'true', 'INPUT_REPORT-PATH': 'report.json' };
    Object.assign(process.env, env);
    let pullReads = 0, modelCalls = 0, activeModels = 0, maxActiveModels = 0;
    const writes = [];
    globalThis.fetch = async (url, opts) => {
      const json = data => new Response(JSON.stringify(data));
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        modelCalls++;
        activeModels++;
        maxActiveModels = Math.max(maxActiveModels, activeModels);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeModels--;
        const project = JSON.stringify(JSON.parse(opts.body).state);
        if (modelFails === true || typeof modelFails === 'string' && project.includes(modelFails)) return new Response('sensitive provider detail', { status: 401 });
        return json({ model: 'jev-fixture', usage: { input_tokens: 12, output_tokens: 4 }, answers: { scope_match: { type: 'noul', noul: rejected && project.includes(rejected) ? 0.1 : uncertain && project.includes(uncertain) ? 0.5 : 0.95 }, category: { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 1, bugfix: 0, feature: 0, maintenance: 0, other: 0 } } } });
      }
      if (entries && !url.startsWith('https://api.github.com/repos/owner/catalog/')) {
        const repo = new URL(url).pathname.split('/')[3];
        if (url.endsWith(`/owner/${repo}`)) return json({ private: false, full_name: `owner/${repo}`, default_branch: 'main', license: { spdx_id: 'MIT' } });
        if (url.includes('/commits/')) return json({ sha: head });
        if (url.includes('/git/trees/')) return json({ tree: ['README.md', 'src/client.ts'].map((path, i) => ({ path, type: 'blob', mode: '100644', size: 100, sha: String(i + 1).repeat(40) })) });
        if (url.includes('/git/blobs/')) return json({ encoding: 'base64', content: Buffer.from('TypeSafe client https://api.typesafe.ai/v1/systemone').toString('base64') });
      }
      assert.ok(url.startsWith('https://api.github.com/repos/owner/catalog/'));
      if (opts.method === 'POST' || opts.method === 'PATCH') { writes.push(JSON.parse(opts.body)); return json({ id: 7 }); }
      if (url.endsWith('/pulls/1')) {
        pullReads++;
        return json({ number: 1, state: 'open', title: 'Update docs', body: 'Improve setup instructions', changed_files: entries?.length ?? (catalog ? 2 : 1), head: { sha: staleEvent || moveHead && pullReads > 1 ? newer : head, repo: { full_name: 'owner/catalog' } }, html_url: 'https://github.com/owner/catalog/pull/1' });
      }
      if (entries && url.includes('/files?')) return json(entries.map(name => ({ filename: `entries/owner--${name}.json`, status: removed ? 'removed' : 'added' })));
      if (entries && url.includes('/git/trees/')) return json({ tree: entries.map((name, i) => ({ path: `entries/owner--${name}.json`, type: 'blob', mode: '100644', size: 200, sha: (i + 1).toString(16).repeat(40) })) });
      if (entries && url.includes('/git/blobs/')) {
        const name = entries[parseInt(url.split('/').at(-1)[0], 16) - 1];
        return json({ encoding: 'base64', content: Buffer.from(name === entryFailure ? '{invalid' : JSON.stringify({ name, repository: `owner/${name}`, description: 'A concrete project.', category: 'documentation', evidence: ['src/client.ts'] })).toString('base64') });
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
    return { report: JSON.parse(await readFile(join(dir, 'report.json'))), outputs: await readFile(join(dir, 'output'), 'utf8'), writes, modelCalls, maxActiveModels, exitCode: process.exitCode };
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
  assert.match(run.report.reasons[0], /1–10 entry files/);
});

test('submitted head checkout is refused before any provider call', async () => {
  await runAction({ wrongCheckout: true });
});

test('batch preserves independent judgments and one summary comment', async () => {
  const run = await runAction({ entries: ['alpha', 'beta', 'gamma'], rejected: 'owner/beta', uncertain: 'owner/gamma' });
  assert.equal(run.modelCalls, 3);
  assert.equal(run.writes.length, 1);
  assert.equal(run.report.schemaVersion, 2);
  assert.equal(run.report.decision, 'not-recommended');
  assert.deepEqual(run.report.reports.map(r => [r.projectRepository, r.decision]), [['owner/alpha', 'recommended'], ['owner/beta', 'not-recommended'], ['owner/gamma', 'needs-review']]);
  assert.ok(run.report.reports.every(r => r.answers && r.sourceCommit === head && r.policyHash && r.evidence.length === 2));
  assert.equal(run.writes[0].body.split('<!-- jev-review-action:v1 -->').length, 2);
  assert.match(run.writes[0].body, /<details>/);
  assert.match(run.outputs, /category<<[^\n]+\n\n/);
});

test('invalid entry and provider failure do not discard successful siblings', async () => {
  const run = await runAction({ entries: ['bad', 'alpha', 'beta'], entryFailure: 'bad', modelFails: 'owner/alpha' });
  assert.equal(run.report.decision, 'error');
  assert.equal(run.exitCode, 1);
  assert.equal(run.modelCalls, 2);
  assert.deepEqual(run.report.reports.map(r => r.decision), ['error', 'error', 'recommended']);
  assert.ok(!JSON.stringify(run).includes('sensitive provider detail'));
});

test('batch boundaries and single-entry compatibility', async () => {
  const single = await runAction({ entries: ['alpha'] });
  assert.equal(single.report.schemaVersion, 1);
  assert.equal(single.report.category, 'documentation');
  assert.equal(single.report.reports, undefined);
  const ten = await runAction({ entries: Array.from({ length: 10 }, (_, i) => `p${i}`) });
  assert.equal(ten.modelCalls, 10);
  assert.equal(ten.maxActiveModels, 2);
  assert.equal(ten.report.decision, 'recommended');
  for (const options of [{ entries: Array.from({ length: 11 }, (_, i) => `p${i}`) }, { entries: ['alpha', 'beta'], removed: true }]) {
    const run = await runAction(options);
    assert.equal(run.report.decision, 'error');
    assert.equal(run.modelCalls, 0);
  }
});

test('batch results survive a stale-head check without publishing', async () => {
  const run = await runAction({ entries: ['alpha', 'beta'], moveHead: true });
  assert.equal(run.report.decision, 'skipped');
  assert.equal(run.report.reports.length, 2);
  assert.equal(run.writes.length, 0);
});
