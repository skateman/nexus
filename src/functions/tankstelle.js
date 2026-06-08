const { app } = require('@azure/functions');

// Tankstelle is a TypeScript/ESM Hono app published as @skateman/tankstelle.
// This Function App is CommonJS, so we bridge to ESM with a lazy dynamic import().
// createApp() reads configuration from process.env at first call, so all
// App Settings (storage URI + MI client id, Azure OpenAI endpoint/key) must be
// present by the time the first request arrives — which they always are.
let appPromise;
function getApp() {
  if (!appPromise) {
    appPromise = import('@skateman/tankstelle')
      .then((m) => m.createApp())
      .catch((err) => {
        // Don't cache a rejected promise: let the next request retry after a
        // transient import/config failure.
        appPromise = undefined;
        throw err;
      });
  }
  return appPromise;
}

// Tankstelle owns the /api/tankstelle/* namespace on this Function App. Other
// HTTP functions can coexist anywhere else under /api/*. The embedded Hono app
// serves its routes under /api/* internally, so we strip the /api/tankstelle
// prefix before handing the request over — the app never needs to know it is
// mounted behind a sub-path.
//
// External: /api/tankstelle/health  ->  internal: /api/health
const ROUTE_PREFIX = '/api/tankstelle';

app.http('tankstelle', {
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'tankstelle/{*path}',
  handler: async (request) => {
    const honoApp = await getApp();

    // Map the external prefix onto the app's internal /api/* contract.
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(
      new RegExp(`^${ROUTE_PREFIX}(?=/|$)`),
      '/api',
    );

    const init = { method: request.method, headers: request.headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // arrayBuffer preserves binary/multipart bodies (e.g. /api/ocr/pump uploads).
      init.body = Buffer.from(await request.arrayBuffer());
    }

    const res = await honoApp.fetch(new Request(url, init));

    return {
      status: res.status,
      // Pass the Headers object through directly so multi-value headers
      // (e.g. Set-Cookie) are preserved rather than collapsed.
      headers: res.headers,
      body: Buffer.from(await res.arrayBuffer()),
    };
  },
});
