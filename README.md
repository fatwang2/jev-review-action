# Jev Review Action

[![CI](https://github.com/fatwang2/jev-review-action/actions/workflows/ci.yml/badge.svg)](https://github.com/fatwang2/jev-review-action/actions/workflows/ci.yml)

Review submissions and classify pull requests with [TypeSafe Jev](https://typesafe.ai). You define the criteria and categories; Jev returns typed judgments; code applies the policy and updates one PR comment.

**Only Jev is used.** Comments come from a fixed template. There is no text-generation model, autonomous agent, or hosted bot server.

An independent personal open-source project by [fatwang2](https://github.com/fatwang2), not an official TypeSafe product. The first consumer is [Awesome Jev](https://github.com/fatwang2/awesome-jev).

## Two modes, one engine

| Mode | Evidence | Example |
| --- | --- | --- |
| `catalog` | 1–10 submitted JSON entries, each with its public GitHub repository's README and source files at an immutable commit | Awesome lists, integration directories, project showcases |
| `pull-request` | PR title, body and changed-file patches | Scope checks and change classification for an ordinary repository |

Policies are JSON. The action does not hardcode Jev ecosystem criteria: replace the categories and questions to review another topic. Examples: [catalog policy](examples/catalog.json), [PR policy](examples/pull-request.json).

## Quick start

1. Copy an example policy to `.github/jev-review.json` on your default branch.
2. Set the repository secret `TYPESAFE_API_KEY` to your own TypeSafe key.
3. Add the workflow below to the default branch. It only runs trusted base-branch code. For production, replace the action version with the full commit SHA from the release.

```yaml
name: Jev review
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: jev-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  review:
    if: github.event.pull_request.base.ref == github.event.repository.default_branch
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
      - uses: fatwang2/jev-review-action@v0.2.0
        id: review
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        if: always()
        with:
          name: jev-review-${{ github.event.pull_request.number }}
          path: jev-report.json
          if-no-files-found: ignore
          retention-days: 14
```

External fork submissions work through `pull_request_target`. Never check out, install dependencies from, or execute the PR head in this privileged workflow. The action verifies that the local checkout matches the event's base SHA. It reads submitted data through the GitHub API, rejects symlinks and submodules, and does not execute it.

## Policy

Each check is a positive yes/no criterion with `id`, `title`, `question`, `yes`, `no`, `accept`, and `reject`. All checks are required. One `Choice` question selects among `categories`, which must include `other`. Set `categoryConfidence` to your review boundary.

- **recommended:** all checks pass, a category is supported, and evidence is complete within the configured collector.
- **needs-review:** ambiguous answers, category disagreement, missing/truncated integration evidence, archive status, or an unrecognized license.
- **not-recommended:** at least one check fails, with no evidence collection warning.
- **error:** invalid submission, API failure, or invalid model response; the action fails and does not approve anything.
- **skipped:** no catalog entry changed, or the PR changed/closed before publication.

`recommended` is advisory, not a GitHub review approval. The action never merges, closes, edits submissions, or applies labels. Outputs let a caller implement additional behavior explicitly. Example thresholds are provisional: use human-labeled examples to measure false acceptance, false rejection, and category agreement before relying on them.

Changing the policy requires a separate maintainer PR. A catalog submission changing non-entry files, removing/renaming entries, or exceeding ten entries is rejected before inference.

### Batch catalog reviews (unreleased)

Batch support requires the commit containing this change; the v0.2.0 quick-start pin above still accepts only one entry. Publish the updated Action and pin its immutable commit before enabling batch submissions in a consumer.

Each project gets independent evidence collection and a separate Jev call, with at most two projects processed concurrently. One invalid entry or provider failure does not discard sibling results. One comment contains a summary table and expandable per-project details; oversized details remain available in the JSON report.

The batch decision has precedence `error` → `not-recommended` → `needs-review` → `recommended`. Only an all-recommended batch is recommended; any error fails the Action. This is not majority voting or automatic merge enforcement. GitHub merges the entire PR, so resolve, remove, or split unresolved entries before merging.

Single-entry reports retain `schemaVersion: 1` and their existing top-level fields. Multi-entry reports use `schemaVersion: 2`, with ordered `reports` containing each entry's full result, `entryPath`, and (when valid) `projectRepository`. The top-level `repository` remains the PR host repository. Batch `category` output is empty; categories belong to individual results. Every rerun reviews all entries again; results are not cached. Reports remain Actions artifacts with the caller's retention period, not a permanent archive.

## Catalog entry

Use `entries/owner--repository.json` (lowercase). Submit one file per project, up to ten projects per PR with batch support:

```json
{
  "name": "Example project",
  "repository": "owner/repository",
  "description": "A concrete description whose claims can be checked against source.",
  "category": "search"
}
```

`evidence` is optional. Omit it (or use `[]`) to let the Action find integration source files. If you know the relevant files, add up to six relative paths, for example `"evidence": ["src/client.ts"]`. Supplied paths still receive strict validation and priority.

The file name is the canonical repository identity and prevents duplicate filenames. The directory's own validation should also check its full catalog for duplicates. Only public GitHub source repositories are supported in catalog mode. Non-GitHub projects and arbitrary webpages need a future evidence adapter, not unrestricted URL fetching.

The collector resolves the submitted repository's default branch to an immutable commit. Jev selects up to six source files using the complete root README, up to two root manifests, and candidate paths/sizes, without seeing source contents or submission evidence hints. Each candidate receives a Noul judgment; candidates scoring at least 0.5 are ranked by probability, then path. Dependencies, generated output, tests, fixtures, symlinks, and submodules are excluded from automatic candidates; source files are limited to 100 KB. Up to six optional evidence paths are read in addition to the selected files. Explicit evidence can still point to a regular supported test or example file.

Selection is a retrieval hint, not proof of integration. A separate Jev call judges the actual source. The selector targets TypeSafe/Jev; it is not a general-purpose ecosystem selector. No selected or supplied source means maintainer review. Provider errors fail visibly rather than falling back to favorable rule-based results. The old rule selector remains available internally for offline comparisons only.

Catalog files are never truncated: at most ten complete files and 48,000 file-content characters reach the review. A file that cannot fit is omitted with a visible warning requiring maintainer review; smaller subsequent files can still fit. Selection refuses more than 200 candidates, 65,000 serialized state bytes, or 180,000 serialized state-plus-question bytes. These are local resource guards, not exact model token counts; provider context errors remain errors. Ordinary pull-request diff mode retains its separate excerpt behavior.

The JSON report's `discovery` field records selection candidates, probabilities, selected/included paths, model, token usage, latency, and state/question hashes. Top-level `usage` describes the final review call only; add `discovery.usage` for total model usage. Missing evidence still requires maintainer review; no second retrieval round is implemented. Discovery does not inspect an entire repository or prove that a project works.

## Inputs and outputs

| Input | Default | Purpose |
| --- | --- | --- |
| `typesafe-api-key` | required | TypeSafe key, sent only to `api.typesafe.ai` |
| `github-token` | `github.token` | Read evidence and write PR comments |
| `policy` | `.github/jev-review.json` | Trusted policy file |
| `model` | `jev-latest` | Jev model ID; pin a version for comparisons |
| `comment` | `true` | Set `false` for report-only use |
| `report-path` | `jev-report.json` | JSON report in the workspace |

Outputs: `decision`, `category`, and `report-path`. The JSON report includes raw typed answers, token usage, resolved model, source commit, PR head, policy/state hashes, thresholds, evidence URLs and follow-up reasons. It does not contain the API key or complete source files. Changing a threshold can be evaluated against saved answers without another provider call.

Every run costs provider tokens; each catalog project normally uses one Jev file-selection call and one review call containing its checks and category question. Only transient HTTP failures retry, at most twice. GitHub file counts, evidence size, request timeouts, and question counts are bounded. No API keys are needed for CI tests.

## Local review

Node.js 22+; the GitHub Action uses Node.js 24. There are no npm dependencies and no generated bundle to audit.

```bash
npm test
export TYPESAFE_API_KEY=your_key
export GITHUB_TOKEN=your_read_only_token # optional, raises GitHub rate limits
npm run review -- --policy examples/catalog.json --entry /path/to/entry.json
```

The CLI only writes a local report. It does not post to GitHub. `--repository owner/repo` can be used instead of `--entry` for exploratory checks without a proposed description/category.

## Data and permissions

PR title/body/diff in PR mode, or submitted descriptions and public repository excerpts in catalog mode, are sent to TypeSafe. Do not enable it on private PR data unless this transfer is intended. GitHub requests go only to `api.github.com`, model calls only to `api.typesafe.ai`, and redirects are rejected. Retrieved text is untrusted evidence; model judgments are advisory and cannot grant permissions.

Use the standard `GITHUB_TOKEN` for one-comment updates: the action only edits comments authored by `github-actions[bot]` with its marker. A fresh PR-head check suppresses stale results; keep the workflow concurrency group to serialize reviews of one PR. Reports identify the reviewed head so changes remain visible.

## Development and validation

`npm test` covers policy decisions, malformed model answers, bounded evidence, symlinks, unsafe paths, private-source refusal, comment ownership/pagination, stale PR suppression, trusted checkout enforcement, and a mocked end-to-end action run. These tests validate software behavior, not Jev's classification accuracy.

Live calibration is not yet published. Configure a dedicated TypeSafe key and compare saved reports against human labels before claiming accuracy or enabling downstream automation.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed; TypeSafe and Jev names belong to their respective owners.
