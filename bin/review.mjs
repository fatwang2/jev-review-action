#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHub, collectRepository } from '../src/github.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { validateEntry } from '../src/validation.mjs';
import { review } from '../src/review.mjs';

try {
  const { values } = parseArgs({ options: { policy: { type: 'string' }, entry: { type: 'string' }, repository: { type: 'string' }, output: { type: 'string', default: 'reports/review.json' }, model: { type: 'string', default: 'jev-latest' } } });
  if (!values.policy || (!values.entry && !values.repository)) throw new Error('Usage: npm run review -- --policy POLICY.json --entry ENTRY.json [--output REPORT.json]');
  const policy = validatePolicy(JSON.parse(await readFile(values.policy, 'utf8')));
  const submission = values.entry ? validateEntry(JSON.parse(await readFile(values.entry, 'utf8')), policy.categories) : undefined;
  const collected = await collectRepository(new GitHub(process.env.GITHUB_TOKEN), submission?.repository ?? values.repository, submission?.evidence ?? [], { apiKey: process.env.TYPESAFE_API_KEY, model: values.model });
  const report = await review({ policy, collected, submission, apiKey: process.env.TYPESAFE_API_KEY, model: values.model });
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ decision: report.decision, category: report.category, model: report.model, usage: report.usage, report: output }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
