# Setup and technical notes

The Worker uses GitHub App **user access tokens**. The sign-in flow is designed to read public resources without requiring installation. Private repositories are opt-in: users install the app on selected repositories, then choose repositories to scan. Permissions are **Contents: read** and **Metadata: read** only. No installation token, app private key, or repository clone is used at runtime.

## Configuration

Sample mode runs without credentials. To connect GitHub locally, register your own development GitHub App and copy the example configuration:

```sh
cp .dev.vars.example .dev.vars
```

Set `APP_ORIGIN`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SESSION_SECRET` in `.dev.vars`. Generate a unique session secret with `openssl rand -base64 32`. Keep this file private and ignored by Git. Never put secrets in `VITE_*` variables, source files, or committed configuration.

Set `APP_ORIGIN` to the exact deployment origin without a trailing slash. Configure `GITHUB_APP_SLUG` and `GITHUB_CLIENT_ID`. Store `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` using Cloudflare secrets, never in source. `SESSION_SECRET` must be a base64-encoded 32-byte random value. Keep `.dev.vars` ignored for local configuration. Local `APP_ORIGIN` may use `http://localhost:PORT` or `http://127.0.0.1:PORT`; production requires HTTPS.

Register a **public GitHub App** with the callback URL `APP_ORIGIN/api/auth/github/callback` and setup URL `APP_ORIGIN/api/github/setup`. Leave **Request user authorization (OAuth) during installation** unchecked so this app always manages its own state and PKCE flow. Leave expiring user tokens enabled. Disable device flow and webhooks for this on-demand tool. No organization or user-email permissions are required. Organization owners may need to approve installation; SAML organizations may require an active SSO session.

GitHub may require generating a private key during app registration before installation is available. The Worker does not consume that key: its runtime flow uses the client secret to exchange authorization codes for user tokens. No private-key binding or app JWT exists in this implementation. Keep any downloaded private key out of source and do not install it as an unused Worker secret.

Authentication uses GitHub's authorization-code flow with S256 PKCE and a server-side client secret. Encrypted HttpOnly cookies retain the user token for at most eight hours. Refresh tokens are discarded. Logout revokes the user token and clears local cookies; a revocation failure is reported while local cookies are still cleared. Session and descriptor keys are derived separately from `SESSION_SECRET` with HKDF.

Production also binds `AUTH_LIMITER` at 20 requests per 60 seconds and `API_LIMITER` at 120 requests per 60 seconds. OAuth starts are limited by Cloudflare's client IP; repository and scan requests are limited by the authenticated user's stable GitHub ID. These optional bindings may be omitted in unit tests/local development. Rejected API calls return `429` with `retryAfter: 60`; browser sign-in journeys redirect to a safe `auth=rate_limited` status. Logout is exempt so users can always revoke and clear their session after a throttled scan.

These counters are local to each Cloudflare location and eventually consistent. They are not exact global accounting or a daily-spend cap. See [Cloudflare Rate Limiting locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## API

All API responses use `Cache-Control: no-store`. All authenticated POST routes require the configured `Origin` and `x-csrf-token` from `GET /api/session`. Send JSON for routes with request bodies. JSON errors use `{error:{code,message,retryAfter?}}` with an appropriate HTTP status; browser authorization routes redirect as described below.

| Method / path | Contract |
| --- | --- |
| `GET /api/session` | Configuration state; authenticated viewer, CSRF token, and Unix-second expiry when connected. No GitHub credentials. |
| `GET /api/auth/github/start` | Starts GitHub sign-in and sets a ten-minute encrypted state/PKCE cookie. |
| `GET /api/auth/github/callback` | Verifies state, exchanges the code, obtains viewer identity, and redirects home. |
| `POST /api/auth/logout` | Revokes the current GitHub token and clears cookies. |
| `POST /api/github/install` | Returns `{url}` for GitHub's selected-repository installation flow. |
| `GET /api/github/setup` | Validates installation-return state and redirects to `/?private=connected`. Installation IDs in the callback do not authorize access. |
| `GET /api/github/installations?page=1` | Returns `{installations:[{id,login}],nextPage}` from the user-access-token API. |
| `GET /api/github/repositories?kind=owned\|contributed&cursor=...` | Public owned repositories or GitHub's recent contributed repositories; returns `RepositoryPage`. |
| `GET /api/github/repositories?kind=organization&organization=...&cursor=...` | Public, non-fork repositories belonging to a supplied organization login or `https://github.com/org` URL. Returns `RepositoryPage` with up to 100 repositories and an opaque next cursor. Requires no additional GitHub App permissions. |
| `GET /api/github/repositories?kind=installation&installationId=...&cursor=...` | Repositories accessible to both the installation and the signed-in user; cursor is the REST page number. |
| `POST /api/github/repository` | `{url}` → `{repository}`; only public `https://github.com/owner/repo` URLs. |
| `POST /api/scan/start` | `{repositoryId,includePrivate,asOf}` → `ScanStart`. Takes a snapshot of the default HEAD. |
| `POST /api/scan/page` | `{handle}` → `ScanPage`. Reads at most 100 author-filtered commits and returns the next signed handle. |

Browser OAuth failures redirect to the fixed home origin with only an allowlisted status: `auth=cancelled`, `auth=expired`, `auth=failed`, or `auth=rate_limited`. Installation-return failures use `auth=installation_failed`. The frontend should translate these to static recovery messages without reflecting query text.

Callback diagnosis may report a static error code such as `oauth_client_configuration`, `oauth_redirect_configuration`, or `oauth_code_rejected`. Never print or retain authorization codes, token responses, raw GitHub error descriptions, cookies, or callback URLs while debugging. Browser callback URLs necessarily carry GitHub's temporary authorization code during the OAuth round trip; the server then redirects to the clean application origin.

The Worker imports the response contracts from `shared/types.ts`. `asOf` is an ISO timestamp no later than the present scan (one minute clock tolerance). Each scan handle binds the session, GitHub user ID, repository node ID, immutable HEAD, as-of date, pagination cursor, privacy, and session expiry. Handles are HMAC-authenticated, not encrypted; they contain no GitHub token or repository name and must stay out of public URLs. Page replay is read-only; the client deduplicates commit SHAs. Current permissions are rechecked by GitHub on every request.

## Measurement and failure handling

The backend requests commit metadata, aggregate additions/deletions, primary author identity, and parent counts. It never requests file contents, patches, commit messages, or author emails. A commit counts only when GitHub associates its primary author with the connected account. The client excludes merge commits and duplicate SHAs and partitions by committed date at midnight UTC. Forks are excluded from discovery, manual additions, and scans.

GitHub's aggregate line counts include documentation, lockfiles, generated files, imports, and repeated edits. An imported project or template can inflate totals even when the primary author matches. A root commit can add an existing codebase in one step. These counts do not identify AI-written code, original line authorship, or unique lines remaining in the codebase.

The calculation skips commits with more than 100,000 added and deleted lines combined by default, applying the same rule to both periods. A small disclosure shows excluded totals and the largest commits. Users can disable the filter or choose a before-only scope, which stays labeled as an unequal filter. Changes recalculate in browser memory. This is a whole-commit size heuristic, not file-level dependency detection: legitimate large commits may be excluded and smaller generated changes may remain. Share images, text, and links preserve the filter and exclusion count.

Automatic discovery combines owned public repositories and GitHub's recently contributed repositories. `repositoriesContributedTo` is not a complete career archive or a list of every organization the user has worked in. The unified repository-or-organization input can load an organization's public repositories by login or URL, or add a public repository by URL. Organization enumeration includes only public non-forks; private organization repositories require an installation granted access to the selected repositories, the user's own GitHub access, and any required organization approval or SSO authorization.

Inaccessible, deleted, non-default-branch, unpushed, or unmatched-author history cannot be counted. Never interpret an unavailable or incomplete repository as zero. A partial GraphQL response causes an error; retry the same signed page rather than advancing the cursor. Rate-limit responses include retry guidance. Repository enumeration is paginated without an artificial career-history cap.

There is no database, persistent server scan job, general GitHub proxy, or token exposed to browser JavaScript. The browser owns scan progress and aggregated results. The Worker checks current repository visibility on every scan page and stops if a public snapshot becomes private, requiring explicit private selection and a new scan. Stateless handles are not a global traffic rate limiter; the production bindings add Cloudflare rate limits. Recheck production cookies, OAuth, selected private-repository access, and Worker CPU after changes to these boundaries.

## Privacy and sharing

GitHub's Contents permission technically permits reading source code. AI Diff requests commit metadata and line counts, not source files or patches. Tokens remain encrypted in expiring HttpOnly session cookies and are never exposed to browser JavaScript. Refresh tokens are discarded. Logout attempts revocation and clears local session state even when revocation fails.

Analysis stays in browser memory, so reloading starts a new scan. Only the light/dark preference is saved in local browser storage. There are no third-party tracking scripts or stored server-side reports. GitHub and the hosting provider still process requests as part of operating their services.

Share images are generated locally. Result links contain an aggregate summary in the URL fragment, after `#`, which is not sent to the server. Private repository names and raw commits are omitted. Sharing totals that include private contributions requires explicit acknowledgment.

The 1200 × 600 PNG supports light and dark export themes, initially matching the interface. Changing the export theme does not change the website theme or private-sharing consent. One continuous line shows the before/after portions of the combined counted additions; its blue segment is the portion on or after the comparison date. Both-zero totals leave a neutral line.

A result link preserves the numbers chosen at the time of sharing; opening it does not fetch GitHub again. Anyone with the full link can read, edit, or reshare the summary. AI Diff does not independently verify those shared numbers. Social previews describe the app; opening the full link displays the result.

## Development reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local app and Worker |
| `npm run build` | Type-check and build the client and Worker |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run TypeScript checks |
| `npm test` | Run the automated suite |
| `npm run test:git` | Compare the calculation against controlled local Git history |
| `npm run build:deploy` | Build using the ignored deployment configuration |
| `npm run check:deploy` | Build and validate deployment without publishing |
| `npm run deploy` | Build and publish the configured Worker |

The React + TypeScript + Vite client owns scan progress, in-memory aggregation, charts, and image generation. The same-origin Cloudflare Worker owns authentication, encrypted sessions, request validation, and bounded GitHub GraphQL/REST reads. There are no repository clones, background jobs, AI inference calls, or persistent result storage.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `?` | Show shortcuts |
| `T` | Toggle light/dark mode |
| `/` | Focus repository search |
| `⌘/Ctrl + Enter` | Analyze selected repositories |
| `⌘/Ctrl + Shift + S` | Open sharing |
| `⌘/Ctrl + Shift + C` | Copy the image while sharing |
| `Esc` | Close a dialog |

The app follows the system theme until the user selects a preference. Single-key shortcuts are inactive while typing and can be disabled for the current page session in Keyboard shortcuts. Modifier shortcuts remain enabled; analysis and sharing shortcuts apply only when those actions are available.

## Sources and verification

- [GitHub App user tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Public-resource permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [User installation and repository APIs](https://docs.github.com/en/rest/apps/installations)
- [GraphQL commit history](https://docs.github.com/en/graphql/reference/commits)
- [GitHub rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

Run `npx vitest run tests/worker.test.ts`. Tests mock GitHub and cover PKCE/state, secret boundaries, CSRF, expiry, logout revocation failure, repository pagination, private consent, signed-handle tampering/session binding, fixed snapshot/cursor behavior, empty repositories, partial responses, and rate limits. These tests do not substitute for live authorization with the configured GitHub App.

The launch validation exercised public sign-in without installation, repository discovery, a public history scan, selected-only private access using synthetic data, two-page pagination, cancellation, sharing, and logout. A separate local Git fixture validates the counting rules. Organization restrictions, denied installation, and natural session expiry have automated coverage but were not all exercised live against external accounts.

## Deploying your own instance

The tracked `wrangler.jsonc` is safe for local development and credential-free builds. It contains no production account identifier, GitHub client configuration, or domain route. Create your own ignored configuration:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

In `wrangler.local.jsonc`, choose your own Worker name and Cloudflare account. Set `APP_ORIGIN` to your exact HTTPS origin, and set `GITHUB_CLIENT_ID` and `GITHUB_APP_SLUG` for your own GitHub App. If using a custom domain, add a `routes` entry for that domain. Do not reuse the hosted AI Diff application's callback or credentials.

Store secrets in Cloudflare:

```sh
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npm run check:deploy
npm run deploy
```

Generate a unique `SESSION_SECRET` with `openssl rand -base64 32` and paste it into the secret prompt. Never include it in the JSON config, client variables, or source control. Rotating it signs out active sessions and invalidates scan handles.

`npm run build` uses the tracked development config. `npm run build:deploy`, `npm run check:deploy`, and `npm run deploy` explicitly select the ignored local config through Vite's deployment mode. The Cloudflare Vite plugin writes the resolved Worker config into ignored build output, which Wrangler uses for deployment. A missing local config should fail deployment rather than target the hosted project by accident.

Disable request/body observability or carefully scrub it. Never log callback URLs, cookies, upstream response bodies, private repository names, or commit data. Application callback diagnostics include only a fixed internal code. Provider infrastructure still processes ordinary request metadata.

After deploying, verify sign-in, secure cookie behavior, selected private access, logout, and domain routing using your own synthetic repositories. Review [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [runtime limits](https://developers.cloudflare.com/workers/platform/limits/) for current free allowances. The application does not enable or upgrade a paid plan automatically.

## Performance diagnostic

Each request reads at most 100 commits. Separate requests keep long histories out of a single Worker invocation. Network wait does not count as Worker CPU, while encryption, validation, JSON parsing, and response construction do. Measured launch requests used 1–4 ms CPU; this small sample is not a worst-case guarantee. Measure your own deployment and respect both Cloudflare and GitHub limits.

The opt-in local diagnostic uses mocked 100-commit pages, encrypted sessions, signed handles, and rate-limit bindings. It measures local wall time, not deployed Cloudflare CPU:

```sh
WORKER_BENCHMARK=1 npx vitest run tests/worker-performance.test.ts
```

It asserts response correctness and reports timings without a timing threshold. It does not measure GitHub network latency, production binding overhead, or cold starts.

## Worker runtime compatibility check

Real-network checks in local workerd found that `fetch` with `redirect: 'error'` throws a `TypeError` before making a request. The production helper therefore uses `redirect: 'manual'` and rejects all 3xx responses explicitly, preserving the rule that credentials are never forwarded to a redirect destination. A public request to `https://api.github.com/zen` through the patched production helper returned HTTP 200. `AbortSignal.timeout(15000)` was supported by the same runtime.

The isolated diagnostic can be repeated with `npx wrangler dev --config worker/runtime.wrangler.jsonc --local --port 8789`, then `curl http://localhost:8789/`. It uses no credentials or repository access and is not imported into the production Worker. Callback failure diagnostics log only `auth_callback_failed` plus a static internal error code; raw upstream errors, bodies, credentials, and callback URLs are never included in application logs.
