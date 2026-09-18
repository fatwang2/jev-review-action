import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHub, collectRepository } from '../src/github.mjs';
import { validateEntry } from '../src/validation.mjs';
import { decide } from '../src/policy.mjs';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../examples/catalog.json', import.meta.url)));
const sha = 'a'.repeat(40);
function fixture(files, extra = []) {
  const blobs = new Map();
  const reads = [];
  const tree = Object.entries(files).map(([path, content]) => {
    const hash = createHash('sha1').update(content).digest('hex');
    blobs.set(hash, content);
    return { path, sha: hash, size: Buffer.byteLength(content), type: 'blob', mode: '100644' };
  });
  const github = new GitHub('', async url => {
    const json = data => new Response(JSON.stringify(data));
    if (url.endsWith('/repos/owner/project')) return json({ private: false, full_name: 'owner/project', default_branch: 'main', license: { spdx_id: 'MIT' } });
    if (url.includes('/commits/')) return json({ sha });
    if (url.includes('/git/trees/')) return json({ truncated: false, tree: [...tree, ...extra] });
    if (url.includes('/git/blobs/')) {
      const id = url.split('/').at(-1);
      reads.push(tree.find(n => n.sha === id)?.path);
      assert.ok(blobs.has(id), 'Must only fetch regular bounded files');
      return json({ encoding: 'base64', content: Buffer.from(blobs.get(id)).toString('base64') });
    }
    throw new Error('Unexpected URL');
  });
  return { github, reads };
}

test('evidence may be omitted or empty; supplied paths still obey validation', () => {
  const entry = { name: 'Example', repository: 'owner/project', description: 'A tool.', category: 'developer_tools' };
  assert.equal(validateEntry(entry, policy.categories), entry);
  assert.doesNotThrow(() => validateEntry({ ...entry, evidence: [] }, policy.categories));
  for (const evidence of [null, 'src/index.ts', ['../secret'], ['a.ts', 'a.ts'], Array.from({ length: 7 }, (_, i) => `${i}.ts`)]) {
    assert.throws(() => validateEntry({ ...entry, evidence }, policy.categories));
  }
});

test('without hints, README and entrypoint imports find integration under generic names', async () => {
  const files = {
    'README.md': 'Install the package and configure your API key. See `tools/start.ts`.',
    'package.json': '{"main":"tools/start.ts"}',
    'tools/start.ts': "import { evaluate } from '../engine/connection.js'; evaluate();",
    'engine/connection.ts': "export const evaluate = () => fetch('https://api.typesafe.ai/v1/systemone');",
    ...Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`src/a${i}.ts`, `export const n = ${i};`])),
  };
  const { github, reads } = fixture(files);
  const result = await collectRepository(github, 'owner/project');
  assert.ok(result.evidence.some(e => e.path === 'engine/connection.ts'));
  assert.ok(reads.indexOf('engine/connection.ts') < reads.indexOf('src/a0.ts'));
  assert.equal(result.warnings.length, 0);
  assert.equal(result.discovery.scannedFiles, 24);
  assert.ok(result.discovery.scannedBytes <= 512_000);
  assert.ok(result.state.files.every(s => s.url.includes(`/blob/${sha}/`)));
  assert.ok(result.state.files.reduce((n, s) => n + s.content.length, 0) <= 48_000);
  assert.ok(result.evidence.length <= 10);
});

test('README-only claims and generic type safety ask for evidence instead of rejecting', async () => {
  const { github, reads } = fixture({
    'README.md': 'Our project uses Jev! Example: fetch("https://api.typesafe.ai/v1/systemone")',
    'src/index.ts': 'export const typeSafe = (n) => n;',
    'tests/jev.test.ts': 'fetch("https://api.typesafe.ai/v1/systemone")',
    'vendor/typesafe.js': 'fetch("https://api.typesafe.ai/v1/systemone")',
  });
  const result = await collectRepository(github, 'owner/project');
  assert.match(result.warnings.join(' '), /Add 1–6 relative source file paths/);
  assert.ok(!reads.includes('tests/jev.test.ts'));
  assert.ok(!reads.includes('vendor/typesafe.js'));
  const answers = Object.fromEntries(policy.checks.map(c => [c.id, { noul: 0.1 }]));
  answers.category = { choice: 'other', confidence: 0.9 };
  assert.equal(decide(policy, answers, result).decision, 'needs-review');
});

test('explicit integration paths work even without recognizable provider keywords', async () => {
  const { github } = fixture({ 'README.md': 'Setup instructions', 'custom/decision.ts': 'export const decide = () => provider.evaluate();' });
  const result = await collectRepository(github, 'owner/project', ['custom/decision.ts']);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.evidence.some(e => e.path === 'custom/decision.ts'));
});

test('oversized files, symlinks and dependency trees cannot enter automatic discovery', async () => {
  const { github, reads } = fixture({ 'README.md': 'Setup', 'node_modules/sdk/typesafe.js': 'a', 'src/huge.ts': 'x'.repeat(100_001) }, [
    { path: 'src/typesafe.ts', mode: '120000', type: 'blob', size: 4, sha },
  ]);
  const result = await collectRepository(github, 'owner/project');
  assert.deepEqual(reads, ['README.md']);
  assert.equal(result.discovery.scannedFiles, 0);
  assert.ok(result.warnings.length > 0);
});

test('large discovered sources remain visibly incomplete, with bounded reads and model context', async () => {
  const { github, reads } = fixture({
    'README.md': 'Setup',
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/client${i}.ts`, `fetch('https://api.typesafe.ai/v1/systemone'); // ${i}\n` + 'x'.repeat(89_000)])),
  });
  const result = await collectRepository(github, 'owner/project');
  assert.ok(result.discovery.scannedBytes <= 512_000);
  assert.ok(reads.length <= 6);
  assert.ok(result.warnings.some(w => w.includes('Full file omitted')));
  assert.ok(result.state.files.every(file => file.truncated === false));
  assert.ok(result.state.files.reduce((n, s) => n + s.content.length, 0) <= 48_000);
});

test('Jev chooses from document metadata only and selected files are read without truncation', async () => {
  const source = 'x'.repeat(8500) + '\nclient.system_one();';
  const { github, reads } = fixture({ 'README.md': 'Run it', 'src/client.ts': source, 'src/unrelated.ts': 'UNRELATED_SOURCE', 'tests/hidden.ts': 'hidden' });
  const result = await collectRepository(github, 'owner/project', [], {
    apiKey: 'fixture', model: 'jev-fixture', fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.deepEqual(request.state.candidates.map(f => f.path), ['src/client.ts', 'src/unrelated.ts']);
      assert.equal(JSON.stringify(request.state).includes('UNRELATED_SOURCE'), false);
      assert.equal(JSON.stringify(request.state).includes('client.system_one'), false);
      return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 10, output_tokens: 2 }, answers: { file_0: { type: 'noul', noul: 0.9 }, file_1: { type: 'noul', noul: 0.1 } } }));
    },
  });
  assert.deepEqual(reads, ['README.md', 'src/client.ts']);
  assert.equal(result.state.files[1].content, source);
  assert.equal(result.state.files[1].truncated, false);
  assert.equal(result.discovery.method, 'jev');
  assert.equal(result.discovery.usage.input_tokens, 10);
  assert.deepEqual(result.warnings, []);
});

test('selector failures are not converted into favorable rule-based results', async () => {
  const { github } = fixture({ 'README.md': 'Run it', 'src/client.ts': 'client.system_one();' });
  await assert.rejects(collectRepository(github, 'owner/project', [], { apiKey: 'fixture', model: 'jev-fixture', fetchImpl: async () => new Response('', { status: 401 }) }), /401/);
});

test('over-budget full files are omitted explicitly and do not hide smaller later files', async () => {
  const { github } = fixture({ 'README.md': 'r'.repeat(48001), 'src/client.ts': 'client.system_one();' });
  const result = await collectRepository(github, 'owner/project', ['src/client.ts']);
  assert.deepEqual(result.evidence.map(f => f.path), ['src/client.ts']);
  assert.match(result.warnings.join(' '), /Full file omitted.*README/);
});
