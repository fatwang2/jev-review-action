import { posix } from 'node:path';

export const sourceExtension = /\.(?:[cm]?js|jsx|ts|tsx|py|rs|go|rb|java|kt|swift|php|cs)$/i;
const excluded = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.git|__pycache__|tests?|__tests__|fixtures?|mocks?)(?:\/|$)|(?:\.min|\.test|\.spec|\.d)\.[^/]+$/i;
// Retrieval hints only. Jev must still judge whether this is real integration.
export const integrationSignal = /api\.typesafe\.ai|(?:@typesafe-ai\/|typesafe[-_]sdk|typesafe_ai)|\bTypeSafeClient\b|\bjev-[a-z0-9][a-z0-9.-]*|\bsystem_?[Oo]ne\s*\(/i;

export function sourceCandidates(nodes) {
  return nodes.filter(n => sourceExtension.test(n.path) && !excluded.test(n.path)
    && Number.isInteger(n.size) && n.size <= 100_000);
}

// Resolve only paths that already exist in the immutable Git tree. Never follow URLs.
export function referencedSources(content, fromPath, candidates) {
  const paths = new Set(candidates.map(n => n.path));
  const found = new Set();
  const resolve = value => {
    if (value.startsWith('/') || value.includes('://') || value.includes('\\')) return;
    const bases = [value.replace(/^\.\//, ''), posix.join(posix.dirname(fromPath), value)];
    for (const base of bases) {
      for (const path of [base, base.replace(/\.[cm]?js$/, '.ts'), ...['.ts', '.tsx', '.js', '.mjs', '.py', '/index.ts', '/index.js', '/__init__.py'].map(suffix => base + suffix)]) {
        if (paths.has(path)) found.add(path);
      }
    }
  };
  for (const match of content.matchAll(/[A-Za-z0-9_@./-]+/g)) {
    const token = match[0].replace(/\.+$/, '');
    if (token.length <= 240 && sourceExtension.test(token)) resolve(token);
  }
  for (const match of content.matchAll(/(?:from\s*|import\s*|require\s*\(\s*|import\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g)) resolve(match[1]);
  for (const match of content.matchAll(/\bfrom\s+(\.*[A-Za-z_][\w.]*)\s+import\b/g)) {
    const dots = match[1].match(/^\.+/)?.[0].length ?? 0;
    const module = match[1].slice(dots).replace(/\./g, '/');
    resolve(dots ? '../'.repeat(dots - 1) + './' + module : module);
    if (!dots) resolve('src/' + module);
  }
  return found;
}

export function candidateScore(path, hints) {
  let score = hints.has(path) ? 100 : 0;
  if (/(?:jev|typesafe)/i.test(path)) score += 60;
  if (/(?:^|\/)(?:src|lib|app|api|server|providers?)(?:\/|$)/i.test(path)) score += 20;
  if (/(?:^|\/)(?:index|main|client|judge|rank|search|provider|agent)\.[^/]+$/i.test(path)) score += 15;
  if (/(?:^|\/)(?:examples?|demos?)(?:\/|$)/i.test(path)) score -= 10;
  return score - path.split('/').length;
}

export async function discoverSources({ nodes, seeds, read }) {
  const candidates = sourceCandidates(nodes);
  const hints = new Set();
  const visited = new Set(seeds.map(s => s.path));
  const matches = [];
  const learn = source => {
    for (const path of referencedSources(source.content, source.path, candidates)) hints.add(path);
    if (sourceExtension.test(source.path) && integrationSignal.test(source.content)) matches.push(source);
  };
  seeds.forEach(learn);
  let scannedFiles = 0, scannedBytes = 0, failedFiles = 0;
  while (scannedFiles < 24) {
    const next = candidates.filter(n => !visited.has(n.path)).sort((a, b) => candidateScore(b.path, hints) - candidateScore(a.path, hints) || a.path.localeCompare(b.path, 'en'))[0];
    if (!next || scannedBytes + next.size > 512_000) break;
    visited.add(next.path); scannedFiles++; scannedBytes += next.size;
    try { learn({ path: next.path, content: await read(next) }); }
    catch { failedFiles++; }
  }
  return { matches, scannedFiles, scannedBytes, failedFiles, candidateFiles: candidates.length };
}
