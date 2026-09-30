/** Keep every request, including redirects, inside the local-model boundary. */
export function localModelUrl(base: string, endpoint: string): URL {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('OLLAMA_URL must be a loopback HTTP(S) origin without credentials, query or path.');
  }
  // Avoid relying on DNS for the localhost spelling.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = endpoint;
  return url;
}

export function fetchLocalModel(base: string, endpoint: string, init: RequestInit = {}): Promise<Response> {
  return fetch(localModelUrl(base, endpoint), { ...init, redirect: 'error' });
}
