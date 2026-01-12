# GithubCard

Cloudflare Worker that generates a modern SVG GitHub profile card.

## Features
- `/{username}` endpoint that returns an SVG image.
- Uses GitHub GraphQL to collect yearly contributions and totals.
- Includes a simple rating (grade + score) for quick comparison.
- Demo mode via `/{username}?demo=1` or `/test` without a token.
- Force refresh via `/{username}?refresh=1` to bypass cache once.
- Theme support via `?theme=light`, `?theme=dark` (default), `?theme=matrix`, `?theme=ayaka`, or `?theme=sakura` (snow + petals).

## Local Development
1. Install dependencies
   ```bash
   npm install
   ```
2. Create a `.dev.vars` file (for `wrangler dev`):
   ```
   GITHUB_TOKEN=ghp_your_token_here
   ```
3. Start the worker
   ```bash
   npm run dev
   ```
4. Visit `http://localhost:8787/{github-name}`

## Deploy
1. Authenticate Wrangler:
   ```bash
   npx wrangler login
   ```
2. Add the GitHub token as a secret:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```
4. Access `https://your-worker-domain/{github-name}`

## Notes
- The GitHub token only needs `read:user` + `repo` public access to query stats.
- Cached responses are stored for one hour to reduce API usage.
- Grade thresholds and scoring weights can be edited in `src/index.js`.
- Avatars are inlined in the SVG by default for GitHub README compatibility; use `?avatar=external` to keep the original URL.
