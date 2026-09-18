#!/usr/bin/env node
// Compare full-file evidence from the two selectors. No GitHub writes or production changes.
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { review } from '../src/review.mjs';
import { encodePath } from '../src/github.mjs';
import { validatePolicy } from '../src/policy.mjs';

export function fullEvidence(snapshot, selectedPaths) {
  const allowed = new Set(snapshot.state.candidates.map(file => file.path));
  if (selectedPaths.some(path => !allowed.has(path))) throw new Error('Selected path is not a candidate');
  const paths = [...new Set([...snapshot.state.documents.map(file => file.path), ...selectedPaths])];
  const files = paths.map(path => {
    const content = snapshot.sources[path];
    if (typeof content !== 'string') throw new Error(`Missing full source: ${path}`);
    const bytes = Buffer.from(content);
    return { path, content, truncated: false,
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      url: `https://github.com/${snapshot.repository}/blob/${snapshot.sourceCommit}/${encodePath(path)}` };
  });
  return { sourceCommit: snapshot.sourceCommit,
    state: { repository: { name: snapshot.repository, commit: snapshot.sourceCommit }, files },
    evidence: files.map(({ content, ...metadata }) => metadata),
    warnings: selectedPaths.length ? [] : ['No integration source selected'],
  };
}

async function main() {
  const [entriesArg, snapshotsArg, policyArg, outputArg] = process.argv.slice(2);
  if (!outputArg) throw new Error('Usage: node bin/full-review-experiment.mjs ENTRIES SNAPSHOTS POLICY OUTPUT');
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required');
  const output = resolve(outputArg);
  await mkdir(output, { recursive: true });
  const policy = validatePolicy(JSON.parse(await readFile(resolve(policyArg), 'utf8')));
  for (const filename of (await readdir(resolve(entriesArg))).filter(f => f.endsWith('.json')).sort()) {
    const { evidence, ...submission } = JSON.parse(await readFile(join(resolve(entriesArg), filename), 'utf8'));
    const snapshot = JSON.parse(await readFile(join(resolve(snapshotsArg), filename), 'utf8'));
    const selection = JSON.parse(await readFile(join(resolve(snapshotsArg), filename.replace('.json', '.selection.json')), 'utf8'));
    if (submission.repository !== snapshot.repository || selection.sourceCommit !== snapshot.sourceCommit) throw new Error('Snapshot identity mismatch');
    for (const [selector, paths] of [['rules', snapshot.baseline.selectedPaths], ['jev', selection.selectedPaths]]) {
      const target = join(output, filename.replace('.json', `.${selector}.json`));
      try { await access(target); console.log(`${submission.repository} ${selector}: preserving existing result`); continue; } catch {}
      const collected = fullEvidence(snapshot, paths);
      // A local guard, not a token estimate. Never silently cut files to fit.
      if (Buffer.byteLength(JSON.stringify({ ...collected.state, submission })) > 90000) throw new Error(`Full evidence needs explicit budget review: ${submission.repository}`);
      const started = Date.now();
      let result;
      try {
        result = await review({ policy, collected, submission, apiKey: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0' });
      } catch (error) { result = { decision: 'error', reasons: [error.message] }; }
      await writeFile(target, JSON.stringify({ experiment: 'full-file-selector-comparison', selector, repository: snapshot.repository,
        sourceCommit: snapshot.sourceCommit, policy, submission, selectedPaths: paths,
        limitations: ['Local evidence experiment, not a live catalog review; archive/license checks are not repeated from the source snapshots.'],
        input: collected.state, elapsedMs: Date.now() - started, report: result }, null, 2) + '\n');
      console.log(JSON.stringify({ repository: snapshot.repository, selector, decision: result.decision, reasons: result.reasons, checks: result.checks, tokens: result.usage?.input_tokens }));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
