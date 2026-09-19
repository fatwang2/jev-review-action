#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHub, collectRepository } from '../src/github.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { validateEntry } from '../src/validation.mjs';
import { review } from '../src/review.mjs';
import { judgeConfig } from '../src/jev.mjs';

try {
  const { values } = parseArgs({ options: { policy: { type: 'string' }, entry: { type: 'string' }, repository: { type: 'string' }, output: { type: 'string', default: 'reports/review.json' }, model: { type: 'string', default: 'jev-latest' } } });
  if (!values.policy || (!values.entry && !values.repository)) throw new Error('Usage: npm run review -- --policy POLICY.json --entry ENTRY.json [--output REPORT.json]');
  const policy = validatePolicy(JSON.parse(await readFile(values.policy, 'utf8')));
  const submission = values.entry ? validateEntry(JSON.parse(await readFile(values.entry, 'utf8')), policy.categories) : undefined;
  // Same switches as the Action: JEV_PROVIDERS orders typesafe, vercel and cloudflare.
  const judge = judgeConfig({
    providers: process.env.JEV_PROVIDERS, typesafeApiKey: process.env.TYPESAFE_API_KEY, typesafeModel: values.model,
    aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY, aiGatewayModel: process.env.AI_GATEWAY_MODEL,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN, cloudflareModel: process.env.CLOUDFLARE_AI_MODEL,
  });
  const collected = await collectRepository(new GitHub(process.env.GITHUB_TOKEN), submission?.repository ?? values.repository, submission?.evidence ?? [], { judge });
  const report = await review({ policy, collected, submission, judge });
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ decision: report.decision, category: report.category, model: report.model, usage: report.usage, report: output }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
