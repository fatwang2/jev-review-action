export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function object(value, name) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value;
}

export function text(value, name, max = 2000) {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} must be a non-empty string of at most ${max} characters`);
  invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${name} contains control characters`);
  return value;
}

export function probability(value, name) {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `${name} must be between 0 and 1`);
  return value;
}

export function identifier(value, name) {
  invariant(typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value), `${name} must use lowercase letters, digits, and underscores`);
  invariant(!['__proto__', 'constructor', 'prototype', 'category'].includes(value), `${name} is reserved`);
  return value;
}

export function repository(value) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value), 'Expected a GitHub owner/repository, not a URL');
  return value;
}

export function relativePath(value) {
  text(value, 'file path', 240);
  invariant(!value.startsWith('/') && !value.includes('\\') && !/[\r\n?#]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe file path');
  return value;
}

export function validateEntry(value, categories) {
  object(value, 'entry');
  const allowed = new Set(['name', 'repository', 'description', 'category', 'evidence']);
  invariant(Object.keys(value).every(k => allowed.has(k)), 'Unknown entry field');
  text(value.name, 'entry name', 80);
  invariant(!/[\r\n]/.test(value.name), 'Entry name must be one line');
  repository(value.repository);
  text(value.description, 'entry description', 350);
  invariant(!/[\r\n]/.test(value.description), 'Entry description must be one line');
  invariant(Object.hasOwn(categories, value.category) && value.category !== 'other', 'Entry category must be a configured category other than other');
  invariant(Array.isArray(value.evidence) && value.evidence.length >= 1 && value.evidence.length <= 6, 'Entry needs 1–6 evidence file paths');
  value.evidence.forEach(relativePath);
  invariant(new Set(value.evidence).size === value.evidence.length, 'Duplicate evidence file path');
  return value;
}

export function entryFilename(repo) {
  return `${repository(repo).toLowerCase().replace('/', '--')}.json`;
}
