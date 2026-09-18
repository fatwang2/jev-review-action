import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionQuestions, selectedPaths } from '../bin/selection-experiment.mjs';
import { selectSources } from '../src/selection.mjs';

test('selector asks about observed paths without embedding source code', () => {
  const questions = selectionQuestions([{ path: 'src/client.py', size: 9000 }, { path: 'ui.ts', size: 5 }]);
  assert.equal(Object.keys(questions).length, 2);
  assert.equal(questions.file_0.type, 'noul');
  assert.ok(questions.file_0.instructions.includes('src/client.py'));
  assert.ok(!questions.file_0.instructions.includes('ui.ts'));
});

test('selection is capped, ranked, thresholded, deterministic, and permits no matches', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => ({ path: `${i}.py`, size: 1 }));
  const values = [0.1, 0.49, 0.5, 0.8, 0.7, 0.95, 0.9, 0.6, 0.55];
  const answers = Object.fromEntries(values.map((noul, i) => [`file_${i}`, { noul }]));
  assert.deepEqual(selectedPaths(candidates, answers), ['5.py', '6.py', '3.py', '4.py', '7.py', '8.py']);
  assert.deepEqual(selectedPaths(candidates.slice(0, 3), answers), ['2.py']);
  assert.deepEqual(selectedPaths(candidates.slice(0, 2), answers), []);
});

test('274 candidates and large metadata use one complete request, not count or byte cutoffs', async () => {
  const nodes = Array.from({ length: 274 }, (_, i) => ({ path: `src/file-${String(i).padStart(3, '0')}.rs`, size: 10 }));
  const documents = [{ path: 'README.md', content: 'Readme '.repeat(20000) + 'END' }];
  let calls = 0;
  const result = await selectSources({ repo: 'owner/repo', nodes, documents, apiKey: 'fixture', fetchImpl: async (_url, options) => {
    calls++;
    const { state, questions } = JSON.parse(options.body);
    assert.deepEqual(state.documents, documents);
    assert.deepEqual(state.candidates, nodes);
    assert.equal(Object.keys(questions).length, 274);
    assert.ok(questions.file_273.instructions.includes(nodes[273].path));
    assert.ok(Buffer.byteLength(options.body) > 180000);
    // Only the final candidate is relevant: a hidden 200-path slice must fail.
    return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 100, output_tokens: 20 },
      answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: id === 'file_273' ? 0.9 : 0.1 }])) }));
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.selectedPaths, [nodes[273].path]);
});

test('empty candidates make no request; provider context rejection is surfaced without splitting', async () => {
  let calls = 0;
  const options = { repo: 'owner/repo', documents: [], apiKey: 'fixture', fetchImpl: async () => {
    calls++;
    return new Response('private provider details', { status: 422 });
  } };
  assert.deepEqual((await selectSources({ ...options, nodes: [] })).selectedPaths, []);
  assert.equal(calls, 0);
  await assert.rejects(selectSources({ ...options, nodes: [{ path: 'client.py', size: 10 }] }), /HTTP 422/);
  assert.equal(calls, 1);
});
