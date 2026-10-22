import { handleApi } from './lib/api.js';

// Static files in ./public are served by the assets binding; only /api/* reaches this Worker
// (see run_worker_first in wrangler.jsonc).
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/diagram') return handleApi(request, env);
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  },
};
