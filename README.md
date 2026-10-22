# TFDiagram

Paste a GitHub repo URL containing Terraform (AWS or Azure) and get an architecture diagram.
Like GitDiagram, but it parses the `.tf` files directly instead of guessing with an LLM.

    npm start            # http://localhost:3000
    npm test

Upload zip: choose or drop a `.zip` of a Terraform project (or a repo from GitHub's Code > Download ZIP). The zip is
opened in the browser (`public/unzip.js`, no library); only the `.tf` text is sent to `/api/diagram`. If it holds several
folders, pick which one to draw; local modules (`./x`, `../../`) are followed inside the zip. Limits: 3000 files,
500 KB per file, 8 MB of `.tf` text; `.terraform/`, `.git/` and macOS junk are ignored.

URL forms: `https://github.com/owner/repo` or `.../tree/<branch>/<path>` for a subfolder.
Private repos or rate limits: paste a GitHub token in the page (sent per request, never stored).

## How it works
- `public/unzip.js` reads `.tf` files out of an uploaded zip in the browser.
- `lib/github.js` lists and downloads `.tf` files via the GitHub API.
- `lib/modules.js` follows local module sources (`./x`, `../../`) and loads those folders too.
- `lib/parse.js` extracts `resource` / `module` / `data` blocks.
- `lib/graph.js` finds references between blocks (`aws_subnet.x.id`) as edges, groups nodes
  (Networking, Compute, Data, Security & IAM), hides plumbing by default, and emits Mermaid.
- `lib/graph.js` also follows `local.*` values, so references hidden behind locals still become arrows.
- `public/diagram.js` draws the SVG (icons, legend colours, right-angle arrows) using dagre for layout (`public/vendor/dagre.min.js`, MIT, (c) Chris Pettitt).
- `public/render.js` filters the graph (layer, search, module, collapse) and emits Mermaid; `public/index.html` draws it in the browser.

## Input
Paste `.tf` code or give a GitHub URL; pick AWS, Azure, or auto-detect.

## Not yet
Cloud icons, `count`/`for_each` expansion, registry (non-local) module internals, GCP, plan diffs.

## Official AWS and Azure icons (optional)
The app draws its own icons by default. To use the vendors' official artwork instead, download the packs yourself
and import them (the repo does not ship them):

1. AWS Architecture Icons: https://aws.amazon.com/architecture/icons/ (the Asset Package zip)
2. Azure icons: https://learn.microsoft.com/azure/architecture/icons/ (the SVG zip)
3. Unzip both, then run:

       npm run icons -- --aws <unzipped AWS folder> --azure <unzipped Azure folder>

   It matches files to Terraform resource types by name, copies the matches to `public/icons/`, writes
   `public/icons/manifest.json`, and prints which types had no match (those keep the built-in icon).
4. Commit `public/icons/` and push; Cloudflare redeploys. Diagrams show the official icons, unmodified.

   No computer? In GitHub open Actions > "Import official icons" > Run workflow, paste the direct download link of each
   pack (copy the link address of the Download button), and it does steps 2-4 for you and shows the match report.

Read the vendors' icon terms first (they restrict modifying the icons and implying endorsement, and may restrict
redistributing the packs; keep the repo private if in doubt). The page shows a short attribution note whenever
official icons are installed. Delete the files in `public/icons/` and reset `manifest.json` to `{}` to go back.

## Deploy (Cloudflare Workers)
`wrangler.jsonc` serves `public/` as static assets and routes `/api/*` to `worker.js`.
In the Cloudflare dashboard: Workers & Pages > Create > Import a repository > this repo,
name `tfdiagram`, empty build command, deploy command `npx wrangler deploy`.
Optional: `npx wrangler secret put GITHUB_TOKEN` to raise the shared GitHub API rate limit.
Repos are limited to 45 `.tf` files per request (free plan subrequest limit).
