import { jsonRequest } from './http.mjs';
import { invariant, repository, relativePath } from './validation.mjs';
import { discoverSources, sourceExtension } from './discovery.mjs';
import { selectSources } from './selection.mjs';
import { classifyReviewError, pipelineLimit, SOURCE_LIMIT_REMEDY } from './errors.mjs';

export const encodePath = path => relativePath(path).split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
const shaPattern = /^[0-9a-f]{40}$/;

export class GitHub {
  constructor(token, fetchImpl) { this.token = token; this.fetchImpl = fetchImpl; }
  request(path, options = {}) {
    invariant(path.startsWith('/repos/') && !path.includes('..') && !path.includes('\\'), 'Invalid GitHub API path');
    return jsonRequest(`https://api.github.com${path}`, { token: this.token, fetchImpl: this.fetchImpl, ...options });
  }
  async pull(repo, number) {
    repository(repo);
    invariant(Number.isInteger(number) && number > 0, 'Invalid pull request number');
    return this.request(`/repos/${repo}/pulls/${number}`);
  }
  async changedFiles(repo, number) {
    const files = await this.request(`/repos/${repository(repo)}/pulls/${number}/files?per_page=100`);
    invariant(Array.isArray(files) && files.length < 100, 'Pull request is too large for one bounded review');
    return files;
  }
  async tree(repo, sha) {
    invariant(shaPattern.test(sha), 'Expected an immutable commit SHA');
    const tree = await this.request(`/repos/${repository(repo)}/git/trees/${sha}?recursive=1`);
    if (tree.truncated) throw pipelineLimit(new Error('Repository tree is incomplete; narrow the submission or review manually'));
    return tree.tree;
  }
  async blob(repo, node, max = 100_000) {
    invariant(node?.type === 'blob' && ['100644', '100755'].includes(node.mode), 'Evidence must be a regular file, not a symlink or submodule');
    invariant(node.size <= max && shaPattern.test(node.sha), 'Evidence file exceeds size limit');
    const file = await this.request(`/repos/${repository(repo)}/git/blobs/${node.sha}`, { maxBytes: max * 2 + 2000 });
    invariant(file.encoding === 'base64', 'Unsupported evidence encoding');
    const buffer = Buffer.from(file.content, 'base64');
    invariant(buffer.length <= max && !buffer.includes(0), 'Evidence must be bounded text');
    return buffer.toString('utf8');
  }
  async entryAt(repo, sha, filename) {
    const tree = await this.tree(repo, sha);
    const node = tree.find(n => n.path === filename);
    const source = await this.blob(repo, node, 8000);
    try { return JSON.parse(source); } catch { throw new Error('Submission file must contain valid JSON'); }
  }
  async upsertComment(repo, number, body, marker) {
    // Never overwrite a comment authored by a human who copied the marker.
    let existing;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.request(`/repos/${repository(repo)}/issues/${number}/comments?per_page=100&page=${page}`);
      existing = comments.find(c => c.user?.login === 'github-actions[bot]' && c.user?.type === 'Bot' && c.body?.startsWith(marker));
      if (existing || comments.length < 100) break;
      invariant(page < 10, 'Too many comments to safely locate the review comment');
    }
    return existing
      ? this.request(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } })
      : this.request(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }
}

const manifests = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile']);
const textExtension = /\.(?:md|mdx|rst|txt|json|[cm]?js|jsx|ts|tsx|py|rs|go|rb|java|kt|swift|php|cs|toml|ya?ml)$/i;

function packageDependencyNames(content) {
  try {
    const pkg = JSON.parse(content);
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return [];
    const names = [];
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const value = pkg[field];
      if (value && typeof value === 'object' && !Array.isArray(value)) names.push(...Object.keys(value));
    }
    return [...new Set(names)].slice(0, 40);
  } catch { return []; }
}

function repositoryFacts(metadata, tree, cache) {
  const topLevel = [...new Set(tree.map(n => n.path.split('/')[0]).filter(Boolean))].sort().slice(0, 80);
  return {
    githubAction: tree.some(n => n.path === 'action.yml' || n.path === 'action.yaml'),
    license: metadata.license?.spdx_id && !['NOASSERTION', 'NONE'].includes(metadata.license.spdx_id) ? metadata.license.spdx_id : null,
    topLevel,
    packageDependencies: typeof cache.get('package.json') === 'string' ? packageDependencyNames(cache.get('package.json')) : [],
  };
}

export async function collectRepository(github, repo, requestedPaths = [], selectionOptions) {
  repository(repo);
  const metadata = await github.request(`/repos/${repo}`);
  invariant(metadata.private === false, 'Only public submitted repositories are supported');
  const commit = await github.request(`/repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`);
  const sha = commit.sha;
  const tree = await github.tree(repo, sha);
  const regular = tree.filter(n => n.type === 'blob' && ['100644', '100755'].includes(n.mode));
  const readme = regular.find(n => /^readme(?:\.md|\.txt|\.rst)?$/i.test(n.path));
  const initialPaths = [...new Set([
    ...(readme ? [readme.path] : []),
    ...requestedPaths,
    ...regular.filter(n => manifests.has(n.path)).slice(0, 2).map(n => n.path),
  ])];
  const warnings = [];
  if (!readme) warnings.push('No root README found');
  if (metadata.archived) warnings.push('Repository is archived');
  if (!metadata.license?.spdx_id || metadata.license.spdx_id === 'NOASSERTION') warnings.push('GitHub could not identify a license; check it manually');
  const cache = new Map();
  const attempted = new Set();
  const read = async node => {
    if (!cache.has(node.path)) cache.set(node.path, await github.blob(repo, node));
    return cache.get(node.path);
  };
  for (const path of initialPaths) {
    relativePath(path);
    attempted.add(path);
    if (!textExtension.test(path) && !manifests.has(path)) { warnings.push(`Unsupported evidence file: ${path}`); continue; }
    try { await read(tree.find(n => n.path === path)); }
    catch { warnings.push(`Could not read evidence file: ${path}`); }
  }
  let discovery, selection;
  if (selectionOptions) {
    try {
      selection = await selectSources({ ...selectionOptions, repo, nodes: regular,
        documents: [...cache].filter(([path]) => path === readme?.path || manifests.has(path)).map(([path, content]) => ({ path, content })) });
      for (const path of selection.selectedPaths) {
        try { await read(regular.find(n => n.path === path)); }
        catch { warnings.push(`Could not read selected source: ${path}`); }
      }
    } catch (error) {
      if (classifyReviewError(error).errorKind !== 'pipeline-limit') throw error;
      if (!requestedPaths.some(path => sourceExtension.test(path))) throw pipelineLimit(error);
      warnings.push(SOURCE_LIMIT_REMEDY);
      selection = { method: 'jev', selectedPaths: [], failed: true };
    }
  } else {
    // Retained for offline comparison; production callers explicitly supply selection options.
    discovery = await discoverSources({
      nodes: regular.filter(n => !attempted.has(n.path)),
      seeds: [...cache].map(([path, content]) => ({ path, content })), read,
    });
  }
  const discoveredPaths = selection?.selectedPaths ?? discovery.matches.map(s => s.path);
  const paths = [...new Set([...initialPaths, ...discoveredPaths])];
  const evidence = [];
  let budget = 48_000;
  for (const path of paths) {
    const content = cache.get(path);
    if (content === undefined) continue;
    if (content.length > budget || evidence.length >= 10) {
      warnings.push(`Full file omitted because it exceeds the evidence budget: ${path}; maintainer review required`);
      continue;
    }
    const node = tree.find(n => n.path === path);
    evidence.push({ path, url: `https://github.com/${repo}/blob/${sha}/${encodePath(path)}`, sha: node.sha, truncated: false, content });
    budget -= content.length;
  }
  const suppliedSource = evidence.some(s => requestedPaths.includes(s.path) && sourceExtension.test(s.path));
  const discoveredSource = evidence.some(s => sourceExtension.test(s.path) && discoveredPaths.includes(s.path));
  if (!suppliedSource && !discoveredSource) warnings.push('Automatic discovery could not find enough integration source evidence. Add 1–6 relative source file paths in the optional evidence field so a maintainer can review the integration.');
  invariant(evidence.length > 0, 'No readable repository evidence');
  const discoverySummary = selection
    ? { ...selection, includedPaths: evidence.filter(s => discoveredPaths.includes(s.path)).map(s => s.path) }
    : { scannedFiles: discovery.scannedFiles, scannedBytes: discovery.scannedBytes, failedFiles: discovery.failedFiles, candidateFiles: discovery.candidateFiles, selectedPaths: evidence.filter(s => discoveredPaths.includes(s.path)).map(s => s.path) };
  return {
    state: { repository: { name: metadata.full_name, description: metadata.description, license: metadata.license?.spdx_id ?? null, archived: metadata.archived, commit: sha }, facts: repositoryFacts(metadata, tree, cache), files: evidence },
    evidence: evidence.map(({ content, ...source }) => source), warnings, sourceCommit: sha, discovery: discoverySummary,
  };
}

export function collectPullRequest(pull, files) {
  const warnings = [];
  let remaining = 48_000;
  const changes = files.map(file => {
    const patch = typeof file.patch === 'string' ? file.patch : '';
    const excerpt = patch.slice(0, Math.min(12_000, Math.max(remaining, 0)));
    remaining -= excerpt.length;
    if (!patch || patch.length > excerpt.length) warnings.push(`Incomplete diff: ${file.filename}`);
    return { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: excerpt };
  });
  return {
    state: { pullRequest: { title: pull.title.slice(0, 500), body: (pull.body ?? '').slice(0, 8000), head: pull.head.sha }, changes },
    evidence: [{ path: 'Pull request diff', url: `${pull.html_url}/files`, sha: pull.head.sha, truncated: warnings.length > 0 }],
    warnings, sourceCommit: pull.head.sha,
  };
}
