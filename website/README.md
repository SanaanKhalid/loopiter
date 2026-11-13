# Loopiter landing page

The existing Vinext application builds a Cloudflare Worker and static assets.
Its design and canonical Fern documentation links are shared across deployments.

Public Cloudflare URL: https://loopiter-website.sanaansanaan.workers.dev

Live `robots.txt` at https://loopiter.co is served by Cloudflare's managed robots.txt setting, which overrides `app/robots.ts`. Edits here may not take effect live; changes to crawler rules must be made in Cloudflare.

## Deploy to your Cloudflare account

Use Node 22 or 24, then run from this directory:

```sh
npm ci
npx wrangler login
npx wrangler whoami
npm run typecheck
npm run lint
npm run deploy:cloudflare
```

The command builds and deploys the `loopiter-website` Worker using the generated
`dist/server/wrangler.json`. Static assets are uploaded from `dist/client`.
Use `CLOUDFLARE_ACCOUNT_ID` to select the intended account when your login has
access to multiple accounts. Credentials belong in Wrangler's local authentication
or an application-owned secret manager, never in this repository.

Wrangler prints the public `workers.dev` URL and deployment version on success.
Confirm `/`, `/docs` and `/docs/` respond successfully; the docs route redirects
in the browser to Fern and preserves known legacy anchors. A custom domain can
be connected separately after choosing a domain owned by your Cloudflare account.

The `.openai/hosting.json` metadata remains associated with the existing Sites
project. This direct Cloudflare deployment is separate and does not replace or
redeploy the existing Sites URL. No model credentials or database are required
by the landing page.
