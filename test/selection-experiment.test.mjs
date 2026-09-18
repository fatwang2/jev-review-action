import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionQuestions, selectedPaths } from '../bin/selection-experiment.mjs';

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
