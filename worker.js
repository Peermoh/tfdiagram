import { handleApi, handleSearch } from './lib/api.js';
import { handleMcp } from './lib/mcp.js';
import { handleRepo } from './lib/repoapi.js';

// Static files in ./public are served by the assets binding; only /api/* reaches this Worker
// (see run_worker_first in wrangler.jsonc).
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/diagram') return handleApi(request, env);
    if (pathname === '/api/repo') return handleRepo(request, env);
    if (pathname === '/mcp') return handleMcp(request, env);
    if (pathname === '/api/search') return handleSearch(request, env);
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  },
};
