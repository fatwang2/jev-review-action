import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePolicy, buildQuestions, decide } from '../src/policy.mjs';
import { validateEntry, entryFilename, repository, relativePath } from '../src/validation.mjs';
import { validateAnswers, evaluate } from '../src/typesafe.mjs';
import { GitHub, collectRepository, collectPullRequest } from '../src/github.mjs';
import { jsonRequest } from '../src/http.mjs';
import { renderComment, MARKER } from '../src/render.mjs';
import { review } from '../src/review.mjs';

const policy = JSON.parse(readFileSync(new URL('../examples/catalog.json', import.meta.url)));
const clone = x => structuredClone(x);
const questions = buildQuestions(policy);
function response(category = 'search') {
  return { model: 'jev-test-fixture', usage: { input_tokens: 100, output_tokens: 20 }, answers: {
    ...Object.fromEntries(policy.checks.map(c => [c.id, { type: 'noul', noul: 0.95 }])),
    category: { type: 'choice', choice: category, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(policy.categories).map(c => [c, c === category ? 1 : 0])) },
  } };
}
const json = data => new Response(JSON.stringify(data));
const sha = 'a'.repeat(40);

test('rejects malformed policies and thresholds before provider I/O', () => {
  assert.equal(validatePolicy(policy), policy);
  for (const mutate of [p => p.checks.push(p.checks[0]), p => p.checks[0].reject = 0.99, p => delete p.categories.other, p => p.entryDirectory = '../config']) {
    const p = clone(policy); mutate(p); assert.throws(() => validatePolicy(p));
  }
});

test('one batched request contains independent checks and a bounded category', () => {
  assert.equal(Object.keys(questions).length, policy.checks.length + 1);
  assert.equal(questions.category.type, 'choice');
  assert.match(questions.uses_jev.instructions, /untrusted evidence/);
  assert.ok(questions.category.criteria.other);
});

test('positive, negative, ambiguous and incomplete evidence take different paths', () => {
  const r = response();
  assert.equal(decide(policy, r.answers).decision, 'recommended');
  r.answers.uses_jev.noul = 0.1;
  assert.equal(decide(policy, r.answers).decision, 'not-recommended');
  assert.equal(decide(policy, r.answers, { warnings: ['README unavailable'] }).decision, 'needs-review');
  r.answers.uses_jev.noul = 0.5;
  assert.equal(decide(policy, r.answers).decision, 'needs-review');
  assert.equal(decide(policy, response().answers, { proposedCategory: 'sdk' }).decision, 'needs-review');
  assert.equal(decide(policy, response('other').answers).decision, 'needs-review');
});

test('invalid or missing model answers cannot become successful reviews', () => {
  for (const mutate of [r => delete r.answers.uses_jev, r => r.answers.uses_jev.noul = '0.99', r => r.answers.category.choice = 'invented', r => r.answers.category.confidence = NaN, r => r.answers.category.probabilities = { search: 1 }, r => r.answers.category.probabilities.search = 0.4, r => r.usage.input_tokens = -1]) {
    const r = response(); mutate(r); assert.throws(() => validateAnswers(r, questions));
  }
  assert.equal(validateAnswers(response(), questions).answers.uses_jev.noul, 0.95);
});

test('provider receives only the fixed TypeSafe endpoint and preserves usage', async () => {
  let calls = 0;
  const out = await evaluate({ apiKey: 'test-not-a-secret', state: {}, questions, fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(opts.redirect, 'error');
    assert.deepEqual(JSON.parse(opts.body).questions, questions);
    return json(response());
  } });
  assert.equal(calls, 1); assert.equal(out.usage.input_tokens, 100);
});

test('provider errors do not expose response bodies, keys or submitted data', async () => {
  await assert.rejects(evaluate({ apiKey: 'SECRET', questions, state: {}, fetchImpl: async () => new Response('SECRET and user text', { status: 401 }) }), /^Error: api.typesafe.ai returned HTTP 401$/);
  await assert.rejects(evaluate({ apiKey: '', questions, state: {} }), /missing/);
  await assert.rejects(evaluate({ apiKey: 'test', model: 'another-model', questions, state: {} }), /Only Jev/);
});

test('HTTP response size is bounded', async () => {
  await assert.rejects(jsonRequest('https://api.github.com/repos/a/b', { maxBytes: 5, fetchImpl: async () => json({ text: 'too long' }) }), /size limit/);
});

test('submission URLs and traversal paths are rejected', () => {
  for (const value of ['https://evil.test/a/b', 'owner/repo/../../secrets', 'owner/repo?token=x']) assert.throws(() => repository(value));
  for (const value of ['../.env', '/etc/passwd', 'a/../b', 'a\\b', 'a?x']) assert.throws(() => relativePath(value));
  const entry = { name: 'Example', repository: 'Owner/Repo', description: 'A project', category: 'search', evidence: ['src/index.ts'] };
  assert.equal(validateEntry(entry, policy.categories), entry);
  assert.equal(entryFilename(entry.repository), 'owner--repo.json');
  assert.throws(() => validateEntry({ ...entry, command: 'run this' }, policy.categories));
});

test('GitHub evidence refuses symlinks, binary and oversized blobs', async () => {
  const gh = new GitHub('', async () => json({ encoding: 'base64', content: Buffer.from('a\0b').toString('base64') }));
  await assert.rejects(gh.blob('owner/repo', { type: 'blob', mode: '120000', size: 10, sha }), /symlink/);
  await assert.rejects(gh.blob('owner/repo', { type: 'blob', mode: '100644', size: 1_000_000, sha }), /size/);
  await assert.rejects(gh.blob('owner/repo', { type: 'blob', mode: '100644', size: 3, sha }), /text/);
});

test('evidence is read at a commit and missing requested files force review', async () => {
  const paths = [];
  const gh = new GitHub('', async url => {
    paths.push(url);
    if (url.endsWith('/repos/owner/repo')) return json({ private: false, full_name: 'owner/repo', default_branch: 'main', license: { spdx_id: 'MIT' } });
    if (url.includes('/commits/')) return json({ sha });
    if (url.includes('/git/trees/')) return json({ truncated: false, tree: [{ path: 'README.md', type: 'blob', mode: '100644', size: 12, sha }] });
    if (url.includes('/git/blobs/')) return json({ encoding: 'base64', content: Buffer.from('README text').toString('base64') });
    throw new Error('Unexpected request');
  });
  const result = await collectRepository(gh, 'owner/repo', ['src/missing.ts']);
  assert.equal(result.sourceCommit, sha);
  assert.match(result.evidence[0].url, new RegExp(sha));
  assert.ok(result.warnings.includes('Could not read evidence file: src/missing.ts'));
  assert.ok(result.warnings.some(w => w.includes('optional evidence field')));
  assert.ok(paths.every(p => p.startsWith('https://api.github.com/')));
});

test('private source repositories never reach Jev', async () => {
  const gh = new GitHub('', async () => json({ private: true }));
  await assert.rejects(collectRepository(gh, 'owner/repo'), /Only public/);
});

test('truncated PR diffs are explicitly incomplete', () => {
  const result = collectPullRequest({ title: 'Change', body: '', head: { sha }, html_url: 'https://github.com/owner/repo/pull/1' }, [{ filename: 'file.ts', status: 'modified' }]);
  assert.deepEqual(result.warnings, ['Incomplete diff: file.ts']);
});

test('comment updates only the action bot, including on subsequent pages', async () => {
  const calls = [];
  const gh = new GitHub('test', async (url, opts) => {
    calls.push([url, opts.method]);
    if (opts.method === 'PATCH') return json({ id: 123 });
    if (url.endsWith('page=1')) return json(Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'human', type: 'User' }, body: `${MARKER}\nspoof` })));
    return json([{ id: 123, user: { login: 'github-actions[bot]', type: 'Bot' }, body: MARKER }]);
  });
  await gh.upsertComment('owner/repo', 1, `${MARKER}\nnew`, MARKER);
  assert.equal(calls.length, 3);
  assert.ok(calls[2][0].endsWith('/issues/comments/123'));
});

test('template escapes submissions rather than posting executable markup or mentions', () => {
  const body = renderComment({ decision: 'error', reasons: ['<img src=x> @everyone [click](javascript:x)\n## injected'] });
  assert.ok(body.startsWith(MARKER));
  assert.ok(!body.includes('<img')); assert.ok(!body.includes('@everyone'));
  assert.ok(!body.includes('\n## injected'));
});

test('generic PR policy and catalog policy use the same review engine', async () => {
  const p = JSON.parse(readFileSync(new URL('../examples/pull-request.json', import.meta.url)));
  const out = await review({ policy: p, apiKey: 'test', collected: { state: { changes: [] }, evidence: [], warnings: [], sourceCommit: sha }, fetchImpl: async () => json({ model: 'jev-test-fixture', usage: { input_tokens: 50, output_tokens: 10 }, answers: { scope_match: { type: 'noul', noul: 0.9 }, category: { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 1, bugfix: 0, feature: 0, maintenance: 0, other: 0 } } } }) });
  assert.equal(out.decision, 'recommended'); assert.equal(out.category, 'documentation');
  assert.equal(out.policyHash.length, 64); assert.equal(out.stateHash.length, 64);
});
