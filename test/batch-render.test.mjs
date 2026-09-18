import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComment, MARKER } from '../src/render.mjs';

test('batch summary escapes invalid paths and bounds details without dropping summary rows', () => {
  const reports = Array.from({ length: 10 }, (_, i) => ({
    entryPath: `entries/<details>@someone|${i}.json`, decision: 'error',
    reasons: Array.from({ length: 20 }, () => 'x'.repeat(600)),
  }));
  const text = renderComment({ decision: 'error', reports });
  assert.ok(text.length < 60000);
  assert.ok(!text.includes('@someone'));
  assert.ok(!text.includes('<details>@someone'));
  assert.ok(text.includes('someone\\|9\\.json | error |'));
  assert.match(text, /Further details omitted/);
  assert.equal(text.split(MARKER).length, 2);
  assert.equal(reports.length, 10);
});
