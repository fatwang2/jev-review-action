import test from 'node:test';
import assert from 'node:assert/strict';
import { fullEvidence } from '../bin/full-review-experiment.mjs';

const source = 'x'.repeat(8500) + '\nclient.system_one(); // 尾部';
const snapshot = { repository: 'owner/repo', sourceCommit: 'a'.repeat(40),
  state: { candidates: [{ path: 'src/client.py' }], documents: [{ path: 'README.md' }] },
  sources: { 'README.md': 'Setup instructions', 'src/client.py': source } };

test('full evidence preserves a call after the old cutoff and keeps metadata free of source', () => {
  const result = fullEvidence(snapshot, ['src/client.py', 'src/client.py']);
  assert.equal(result.state.files.length, 2);
  assert.equal(result.state.files[1].content, source);
  assert.equal(result.state.files[1].truncated, false);
  assert.ok(result.evidence[1].url.endsWith('/src/client.py'));
  assert.ok(!Object.hasOwn(result.evidence[1], 'content'));
  assert.deepEqual(result.warnings, []);
});

test('unknown or missing files cannot silently become complete evidence', () => {
  assert.throws(() => fullEvidence(snapshot, ['invented.py']), /not a candidate/);
  assert.throws(() => fullEvidence({ ...snapshot, sources: {} }, ['src/client.py']), /Missing full source/);
  assert.equal(fullEvidence(snapshot, []).warnings.length, 1);
});
