# TFDiagram

Paste a GitHub repo URL containing Terraform (AWS or Azure) and get an architecture diagram.
Like GitDiagram, but it parses the `.tf` files directly instead of guessing with an LLM.

    npm start            # http://localhost:3000
    npm test

URL forms: `https://github.com/owner/repo` or `.../tree/<branch>/<path>` for a subfolder.
Private repos or rate limits: paste a GitHub token in the page (sent per request, never stored).

## How it works
- `lib/github.js` lists and downloads `.tf` files via the GitHub API.
- `lib/modules.js` follows local module sources (`./x`, `../../`) and loads those folders too.
- `lib/parse.js` extracts `resource` / `module` / `data` blocks.
- `lib/graph.js` finds references between blocks (`aws_subnet.x.id`) as edges, groups nodes
  (Networking, Compute, Data, Security & IAM), hides plumbing by default, and emits Mermaid.
- `public/index.html` renders the Mermaid in the browser.

## Input
Paste `.tf` code or give a GitHub URL; pick AWS, Azure, or auto-detect.

## Not yet
Cloud icons, `count`/`for_each` expansion, registry (non-local) module internals, GCP, plan diffs.

## Deploy (Cloudflare Workers)
`wrangler.jsonc` serves `public/` as static assets and routes `/api/*` to `worker.js`.
In the Cloudflare dashboard: Workers & Pages > Create > Import a repository > this repo,
name `tfdiagram`, empty build command, deploy command `npx wrangler deploy`.
Optional: `npx wrangler secret put GITHUB_TOKEN` to raise the shared GitHub API rate limit.
Repos are limited to 45 `.tf` files per request (free plan subrequest limit).
