import { jsonRequest } from './http.mjs';
import { invariant, repository, relativePath } from './validation.mjs';

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
    invariant(!tree.truncated, 'Repository tree is incomplete; narrow the submission or review manually');
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
const textExtension = /\.(?:md|mdx|txt|json|[cm]?js|jsx|ts|tsx|py|rs|go|rb|toml|ya?ml)$/i;

export async function collectRepository(github, repo, requestedPaths = []) {
  repository(repo);
  const metadata = await github.request(`/repos/${repo}`);
  invariant(metadata.private === false, 'Only public submitted repositories are supported');
  const commit = await github.request(`/repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`);
  const sha = commit.sha;
  const tree = await github.tree(repo, sha);
  const regular = tree.filter(n => n.type === 'blob' && ['100644', '100755'].includes(n.mode));
  const readme = regular.find(n => /^readme(?:\.md|\.txt|\.rst)?$/i.test(n.path));
  const paths = [...new Set([
    ...(readme ? [readme.path] : []),
    ...requestedPaths,
    ...regular.filter(n => manifests.has(n.path)).slice(0, 2).map(n => n.path),
    ...regular.filter(n => textExtension.test(n.path) && /(?:^|\/)[^/]*(?:jev|typesafe)[^/]*\.(?:[cm]?js|ts|py|rs|go|rb)$/i.test(n.path)).slice(0, 2).map(n => n.path),
  ])].slice(0, 10);
  const evidence = [];
  const warnings = [];
  if (!readme) warnings.push('No root README found');
  if (metadata.archived) warnings.push('Repository is archived');
  if (!metadata.license?.spdx_id || metadata.license.spdx_id === 'NOASSERTION') warnings.push('GitHub could not identify a license; check it manually');
  let budget = 48_000;
  for (const path of paths) {
    relativePath(path);
    if (!textExtension.test(path) && !manifests.has(path)) { warnings.push(`Unsupported evidence file: ${path}`); continue; }
    const node = tree.find(n => n.path === path);
    try {
      const content = await github.blob(repo, node);
      const limit = Math.min(path === readme?.path ? 14_000 : 8000, budget);
      const excerpt = content.slice(0, limit);
      if (limit <= 0) { warnings.push('Evidence budget exhausted'); break; }
      const truncated = excerpt.length < content.length;
      if (truncated && requestedPaths.includes(path)) warnings.push(`Requested evidence was truncated: ${path}`);
      evidence.push({ path, url: `https://github.com/${repo}/blob/${sha}/${encodePath(path)}`, sha: node.sha, truncated, content: excerpt });
      budget -= excerpt.length;
    } catch {
      warnings.push(`Could not read evidence file: ${path}`);
    }
  }
  invariant(evidence.length > 0, 'No readable repository evidence');
  return {
    state: { repository: { name: metadata.full_name, description: metadata.description, license: metadata.license?.spdx_id ?? null, archived: metadata.archived, commit: sha }, files: evidence },
    evidence: evidence.map(({ content, ...source }) => source), warnings, sourceCommit: sha,
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
