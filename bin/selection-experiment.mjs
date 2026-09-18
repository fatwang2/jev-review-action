#!/usr/bin/env node
// Local experiment only; never posts comments or modifies catalog entries.
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { GitHub } from '../src/github.mjs';
import { discoverSources, sourceCandidates } from '../src/discovery.mjs';
import { evaluate } from '../src/typesafe.mjs';
import { MAX_SELECTED, selectionQuestions, selectedPaths } from '../src/selection.mjs';
export { selectionQuestions, selectedPaths } from '../src/selection.mjs';

async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function main() {
  const [mode, entriesArg, outputArg] = process.argv.slice(2);
  if (!['prepare', 'run'].includes(mode) || !entriesArg || !outputArg) throw new Error('Usage: node bin/selection-experiment.mjs prepare|run ENTRIES_DIR OUTPUT_DIR');
  const entriesDir = resolve(entriesArg), output = resolve(outputArg);
  await mkdir(output, { recursive: true });
  const entries = await readdir(entriesDir);
  const github = mode === 'prepare' ? new GitHub(process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()) : undefined;
  if (mode === 'run' && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required; no requests were made');
  for (const filename of entries.filter(name => name.endsWith('.json')).sort()) {
    const { repository } = JSON.parse(await readFile(join(entriesDir, filename), 'utf8'));
    const snapshotPath = join(output, filename);
    if (mode === 'prepare') {
      if (await exists(snapshotPath)) { console.log(`${repository}: using fixed snapshot`); continue; }
      const metadata = await github.request(`/repos/${repository}`);
      if (metadata.private !== false || metadata.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error(`Repository is private or renamed: ${repository}`);
      const { sha } = await github.request(`/repos/${repository}/commits/${encodeURIComponent(metadata.default_branch)}`);
      const tree = (await github.tree(repository, sha)).filter(n => n.type === 'blob' && ['100644', '100755'].includes(n.mode));
      const docs = tree.filter(n => /^readme(?:\.md|\.txt|\.rst)?$/i.test(n.path) || ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile'].includes(n.path));
      const cache = new Map();
      const read = async node => {
        if (!cache.has(node.path)) cache.set(node.path, await github.blob(repository, node));
        return cache.get(node.path);
      };
      const seeds = [];
      for (const node of docs) seeds.push({ path: node.path, content: await read(node) });
      const candidates = sourceCandidates(tree).sort((a, b) => a.path.localeCompare(b.path, 'en')).map(n => ({ path: n.path, size: n.size }));
      const started = Date.now();
      const baseline = await discoverSources({ nodes: tree, seeds, read });
      const baselineMs = Date.now() - started;
      // Cache all eligible sources locally for later independent inspection. None enter the selector's state.
      for (const candidate of candidates) await read(tree.find(n => n.path === candidate.path));
      await save(snapshotPath, { repository, sourceCommit: sha, preparedAt: new Date().toISOString(), state: { repository, documents: seeds, candidates }, baseline: { ...baseline, matches: baseline.matches.map(s => s.path), selectedPaths: baseline.matches.slice(0, MAX_SELECTED).map(s => s.path), latencyMs: baselineMs }, sources: Object.fromEntries(cache) });
      console.log(`${repository}: ${candidates.length} candidates; baseline ${baseline.matches.slice(0, MAX_SELECTED).map(s => s.path).join(', ')}`);
    } else {
      const reportPath = join(output, filename.replace(/\.json$/, '.selection.json'));
      if (await exists(reportPath)) { console.log(`${repository}: preserving existing selection`); continue; }
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      if (snapshot.repository !== repository) throw new Error('Snapshot repository mismatch');
      const questions = selectionQuestions(snapshot.state.candidates);
      const result = await evaluate({ apiKey: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0', state: snapshot.state, questions });
      const selected = selectedPaths(snapshot.state.candidates, result.answers);
      await save(reportPath, { repository, sourceCommit: snapshot.sourceCommit, selectedPaths: selected, selectedBytes: selected.reduce((n, path) => n + Buffer.byteLength(snapshot.sources[path]), 0), questions, ...result });
      console.log(`${repository}: ${selected.join(', ')}; ${result.usage.input_tokens} input tokens; ${result.latencyMs} ms`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
