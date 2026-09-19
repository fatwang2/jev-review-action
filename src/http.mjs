import { setTimeout as sleep } from 'node:timers/promises';

export async function jsonRequest(url, { token, method = 'GET', body, fetchImpl = fetch, attempts = 1, maxBytes = 8_000_000, headers = {} } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'jev-review-action', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Request to ${new URL(url).hostname} failed or timed out`);
    }
    if ([429, 529, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
      await response.body?.cancel();
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('Response exceeded size limit');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Provider returned invalid JSON'); }
  }
}
