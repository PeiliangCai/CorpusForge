/** Test-process preload only: the unchanged built Next gateway reaches an isolated workflow. */
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'http://127.0.0.1:3210') {
    if (!url.pathname.startsWith('/api/workbench/')) throw new Error('Unexpected fixture upstream path');
    url.port = '3215';
    return original(input instanceof Request ? new Request(url, input) : url, init);
  }
  return original(input, init);
};
