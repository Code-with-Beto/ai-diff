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

Production also binds `AUTH_LIMITER` at 20 requests per 60 seconds and `API_LIMITER` at 120 requests per 60 seconds. OAuth starts are limited by Cloudflare's client IP; repository discovery requests are limited by the authenticated user's stable GitHub ID. These optional bindings may be omitted in unit tests/local development. Rejected API calls return `429` with `retryAfter: 60`; browser sign-in journeys redirect to a safe `auth=rate_limited` status. Logout is exempt so users can always revoke and clear their session after a throttled scan.

History scans use `SCAN_LIMITER` at 600 requests per 60 seconds, checked against both `scan:user:<GitHub user ID>` and `scan:ip:<Cloudflare client IP>`. This covers `/api/scan/start` and `/api/scan/page` independently of discovery, so accounts with more than 120 repositories do not exhaust the discovery allowance just by reading their history.

File inspection uses `FILE_LIMITER` at 600 requested file pages per 60 seconds, checked against both user and IP. A batch consumes one unit per requested page. The browser works on up to four repositories concurrently through one global scheduler with at most four API requests in flight. Each file request contains at most two signed handles from one repository, so at most eight GitHub file reads can be in flight across the whole scan. Each Worker invocation still checks current repository access, visibility, and fork status before reading any files and retains the same small response bounds.

The scheduler smooths history requests and file pages to separate budgets of 480 units per rolling minute, with initial bursts of four history requests and eight file pages. Rate-limit signals stop queued work across all repositories until the shared cooldown expires; retries do not pay the same pause twice. Cancelling aborts active and queued work. Session failures stop the whole scan; repository failures affect that repository. Results remain in selection order, and a repository newly identified as a fork is removed without disturbing concurrent results. File pages contain at most 100 files; inspection stops after 30 pages / 3,000 files. Add both bindings to the ignored deployment configuration as well as local development configuration.

Batch REST responses are capped at 384 KiB per item while streaming, for at most 768 KiB of parsed file-response JSON per Worker invocation. If an item exceeds that cap, its `file_batch_retry_single` result tells the client to retry the same handle alone with a 2 MiB cap; this fallback is not an incomplete commit. The actual response size determines the fallback, since large line counts can still have small metadata responses. Per-item failures preserve successful batch pages. GitHub rate limits pause further work according to retry timing. Responses that exceed the individual cap, unknown changed-file counts, truncated lists, or mismatched stats leave file coverage incomplete; they must never silently become zero lockfile exclusions.

Public-link publishing uses the `SHARE_RESULTS` KV namespace and `SHARE_LIMITER`, configured for five requests per 60 seconds. The limiter checks both `share:user:<GitHub user ID>` and `share:ip:<Cloudflare client IP>`. Real results require an authenticated session whose handle matches the summary, same-origin and CSRF checks, and an explicit publish action (Create link or Post on X). The request’s `publishConsent: true` flag records that action; there is no separate private-totals checkbox. Sample links use fixed assets and do not write to KV.

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
| `POST /api/scan/start` | `{repositoryId,includePrivate,asOf,includeFirstPage?}` → `ScanStart`. With `includeFirstPage:true`, one bounded GraphQL query returns both the default HEAD and `initialPage`; `handle` is its next-page continuation or `null`. Without the option, the original snapshot-only contract remains. |
| `POST /api/scan/page` | `{handle}` → `ScanPage`. Reads at most 100 author-filtered commits and returns the next signed handle. |
| `POST /api/scan/files` | `{handle}` → `FileScanPage`. Reads one signed file page, including larger responses retried outside a batch. Returns no patches or file contents. |
| `POST /api/scan/files/batch` | `{handles:string[]}` with one or two distinct commit SHAs from one repository; maximum body 32 KiB. Legacy requests with three or four handles receive `file_batch_retry_single` item errors without GitHub reads, preserving older clients. Returns `{results:({oid,page:FileScanPage}\|{oid,error:{code,message,retryAfter?}})[]}`. Each continuation uses its own signed `nextHandle`; account/repository access errors fail the whole request. |
| `POST /api/share` | `{result:ShareResult,imageTheme:"light"\|"dark",image:<base64 PNG>,publishConsent:true}` → `{url,imageUrl,imageTheme}`. Requires authentication, a matching handle, `sample:false`, and CSRF. Maximum request body: 280 KiB; decoded PNG: 192 KiB at exactly 1200 × 600. |

Public `GET`/`HEAD /s/<id>` returns a share page with server-rendered Open Graph metadata; `/s/<id>/image.png` returns the stored PNG. These public responses may be cached and do not require GitHub sign-in. `/s/sample-light` and `/s/sample-dark`, including their image routes, serve the fixed `share-sample.json` and `share-sample-{theme}.png` assets without KV storage. Sample routes bypass the immutable-report cache so updated demo images are available on deployment; their image responses use a five-minute browser cache. There is no anonymous publish endpoint.

Browser OAuth failures redirect to the fixed home origin with only an allowlisted status: `auth=cancelled`, `auth=expired`, `auth=failed`, or `auth=rate_limited`. Installation-return failures use `auth=installation_failed`. The frontend should translate these to static recovery messages without reflecting query text.

Callback diagnosis may report a static error code such as `oauth_client_configuration`, `oauth_redirect_configuration`, or `oauth_code_rejected`. Never print or retain authorization codes, token responses, raw GitHub error descriptions, cookies, or callback URLs while debugging. Browser callback URLs necessarily carry GitHub's temporary authorization code during the OAuth round trip; the server then redirects to the clean application origin.

The Worker imports the response contracts from `shared/types.ts`. `asOf` is an ISO timestamp no later than the present scan (one minute clock tolerance). Each scan handle binds the session, GitHub user ID, repository node ID, immutable HEAD, as-of date, pagination cursor, privacy, and session expiry. Handles are HMAC-authenticated, not encrypted; they contain no GitHub token or repository name and must stay out of public URLs. Page replay is read-only; the client deduplicates commit SHAs. Current permissions are rechecked by GitHub on every request.

## Measurement and failure handling

The backend requests commit metadata, aggregate additions/deletions, primary author identity, parent counts, commit headlines, and changed-file metadata. GitHub's REST commit response may also contain patches with source-code context and other fields. The Worker discards patches and unneeded fields before responding to the browser, and does not log, cache, or persist those upstream responses. It does not request individual source-file contents or clone repositories. A commit counts only when GitHub associates its primary author with the connected account. The client excludes merge commits and duplicate SHAs and partitions by committed date at midnight UTC. Forks are excluded from discovery, manual additions, and scans.

GitHub's aggregate line counts include documentation, lockfiles, generated files, imports, and repeated edits. An imported project or template can inflate totals even when the primary author matches. A root commit can add an existing codebase in one step. These counts do not identify AI-written code, original line authorship, or unique lines remaining in the codebase.

The default calculation first removes additions and deletions in recognized dependency lockfiles and checksums, then skips whole commits with more than 100,000 remaining added and deleted lines combined. Both filters apply to both periods. Users can inspect the monthly commit/file breakdown or disable either filter; changes recalculate in browser memory. File inspection is based on recognized filenames, not a general generated-code detector. Other generated files can remain, and the size heuristic may exclude legitimate work. Legacy shared results may retain a before-only size filter, explicitly labeled as unequal.

When lockfile filtering is enabled, only fully inspected commits enter totals or monthly additions. Failed, uninspected, or incomplete file lists omit the whole commit and retain its raw additions/deletions in separate coverage counters. A commit made entirely of excluded lockfiles still counts as one inspected commit with zero lines. Raw mode retains known aggregate counts without requiring complete file inspection, subject to the selected whole-commit size filter. Repository-history coverage and file-inspection coverage are separate; a clean result is partial if either is incomplete.

New shares optionally include `fileFilter: {enabled, excludedBefore, excludedAfter, inspectedCommits, uninspectedBefore, uninspectedAfter}`. Excluded values contain only additions/deletions; uninspected values also contain commit counts. Lockfile exclusions include all inspected eligible commits, including those subsequently excluded by size. Thus lockfile removals, post-lockfile size exclusions, counted lines, and clean-mode uninspected raw totals are disjoint. In raw mode lockfile exclusions are zero and uninspected counts are already represented in raw totals or size exclusions. Validation checks these count relationships and safe integer bounds. Older shares without this field keep their original totals and do not imply lockfile filtering. No file paths, commit headlines, monthly detail records, or repository names enter share payloads.

Automatic discovery combines owned public repositories and GitHub's recently contributed repositories. `repositoriesContributedTo` is not a complete career archive or a list of every organization the user has worked in. The unified repository-or-organization input can load an organization's public repositories by login or URL, or add a public repository by URL. Organization enumeration includes only public non-forks; private organization repositories require an installation granted access to the selected repositories, the user's own GitHub access, and any required organization approval or SSO authorization.

Inaccessible, deleted, non-default-branch, unpushed, or unmatched-author history cannot be counted. Never interpret an unavailable or incomplete repository as zero. A partial GraphQL response causes an error; retry the same signed page rather than advancing the cursor. Rate-limit responses include retry guidance. Repository enumeration is paginated without an artificial career-history cap.

There is no persistent server scan job, general GitHub proxy, or token exposed to browser JavaScript. The browser owns scan progress and aggregated results; only explicitly published aggregate snapshots are stored in KV. The Worker checks current repository visibility on every scan page and stops if a public snapshot becomes private, requiring explicit private selection and a new scan. Stateless handles are not a global traffic rate limiter; the production bindings add Cloudflare rate limits. Recheck production cookies, OAuth, selected private-repository access, and Worker CPU after changes to these boundaries.

## Privacy and sharing

GitHub's Contents permission technically permits reading source code. AI Diff requests commit and file metadata with line counts; those GitHub file responses can include diff context that the Worker receives and discards. Patches are never returned to the client or logged, cached, or persisted by the application. File paths, commit headlines, and repository labels are used only for the in-memory analysis and drilldown. Tokens remain encrypted in expiring HttpOnly session cookies and are never exposed to browser JavaScript. Refresh tokens are discarded. Logout attempts revocation and clears local session state even when revocation fails.

Analysis stays in browser memory. A bounded 16 MiB in-memory cache retains fully verified file details for repeated scans in the same tab. Every scan still reads current authorized repository history; a cached inspection is reused only when the SHA and immutable commit metadata match. Least-recently-used entries are evicted when the cache is full. Reloading, session expiry, disconnecting, or switching accounts discards this cache. Local browser storage contains only the light/dark preference and an account-scoped private-repository inclusion flag; it never contains credentials, repository names, or commit data. There are no third-party tracking scripts. Scanning does not persist a report or upload an image for sharing. GitHub and the hosting provider still process requests as part of operating their services.

Share images are generated locally. Previewing, copying, or downloading one does not upload it. **Create link** and **Post on X** upload the selected export PNG and aggregate summary, including any private totals in the displayed result. There is no extra checkbox. A real public snapshot is stored under a random 16-character ID as one immutable KV value: a four-byte header length, a JSON header containing the validated result, theme and creation time, then the exact PNG bytes. This takes one KV write and avoids storing the PNG as base64. No source files, file paths, repository names, raw commits, or GitHub credentials are part of the shared record.

The 1200 × 600 PNG supports light and dark export themes, initially matching the interface. Changing the export theme does not change the website theme. Published links are reused for the same result and image theme. One continuous line shows the before/after portions of the combined counted additions; its blue segment is the portion on or after the comparison date. Both-zero totals leave a neutral line. The image omits coverage, private-total and filter labels; those details remain on the result page and in the text summary under More options.

Post on X creates or reuses the theme-specific short link and opens `https://x.com/intent/tweet` with an encoded personal caption and URL. Resharing a public result credits its GitHub handle; sample captions stay labeled as examples. It uses no X API credentials or tracking script. The user edits and posts in X. A pending tab is reserved during the click to survive asynchronous link creation; failed or canceled publishing closes it, and a blocked popup gets an ordinary Open X link. X controls whether and when its card preview appears.

A short public link preserves the numbers and image chosen at publication; opening it does not fetch GitHub again. Its HTML points social crawlers to the exact 1200 × 600 PNG, including the chosen light or dark theme. Published snapshots have no automatic expiry. Anyone with a link can view and reshare it, and social platforms may retain cached copies. Signing out does not remove a published snapshot. AI Diff does not independently verify submitted numbers or the image's claims.

Existing long links under `/share#...` continue to work. They carry the aggregate summary in the URL fragment, which is not sent to the server; anyone with the full link can read, edit, or reshare it. They have the app's generic social preview until the user explicitly creates a public link. If public-link storage is unavailable or reaches a free quota, image downloads and the long-link fallback remain available.

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

The React + TypeScript + Vite client owns scan progress, in-memory aggregation, charts, and image generation. The same-origin Cloudflare Worker owns authentication, encrypted sessions, request validation, bounded GitHub GraphQL/REST reads, and explicitly published KV snapshots. There are no repository clones, background jobs, or AI inference calls.

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

### Public-link storage

Create a KV namespace in your own account:

```sh
npx wrangler login
npx wrangler kv namespace create SHARE_RESULTS --config wrangler.local.jsonc --update-config=false
```

Use the returned namespace ID for `SHARE_RESULTS` in `wrangler.local.jsonc`. Merge these fields into the existing configuration, keeping the authentication/API limiters and other asset settings. Choose an unused rate-limit namespace ID for your account:

```jsonc
{
  "kv_namespaces": [
    { "binding": "SHARE_RESULTS", "id": "<your-namespace-id>" }
  ],
  "ratelimits": [
    // Keep AUTH_LIMITER and API_LIMITER here too.
    { "name": "SHARE_LIMITER", "namespace_id": "1003", "simple": { "limit": 5, "period": 60 } }
  ],
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/s/*"]
  }
}
```

The `/s/*` Worker-first route is required: otherwise the SPA fallback can answer a social crawler before the Worker adds result-specific metadata. Local development uses locally simulated KV; do not enable a remote binding for ordinary sample or test work. Sample previews are fixed assets and require neither publishing credentials nor KV writes. See [KV namespace commands](https://developers.cloudflare.com/kv/reference/kv-commands/) and [selective Worker-first routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#run-worker-first-for-selective-paths).

Use the Cache API only for public share pages and images; never cache authentication, scan responses, or publishing requests. KV is eventually consistent, so a new link may take time to become visible in another region. Missing-key reads are also cached by KV; avoid caching missing share responses at the HTTP layer. See [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/) and [Cache API behavior](https://developers.cloudflare.com/workers/runtime-apis/cache/). Do not enable Worker-wide caching as a quota workaround: [Workers Cache pricing](https://developers.cloudflare.com/workers/cache/#pricing) counts even normally-free static asset requests at the standard Worker request rate when enabled.

### Free-plan boundaries

On **Workers Free**, KV includes 1 GB of storage, 100,000 key reads/day, and 1,000 each of writes, deletes, and list requests/day. Daily limits reset at midnight UTC; operations fail when their allowance is exhausted. A new real snapshot takes one KV write. These are account allowances, not a guaranteed per-app budget. KV metadata is limited to 1,024 bytes, so the aggregate and PNG are stored together in the value rather than in metadata. See [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) and [KV limits](https://developers.cloudflare.com/kv/platform/limits/).

Workers Free allows 100,000 dynamic requests/day and 10 ms of CPU per invocation. Cached share handlers still consume Worker requests; caching reduces KV reads. The app does not render PNGs on the server, create an R2 subscription, or enable a paid plan automatically. If quotas prevent publishing, keep using local exports or the long result link. No automatic snapshot expiry is used, so storage capacity must be monitored. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Confirm the account's **Workers** plan in Cloudflare's dashboard before relying on the free-plan failure behavior; a zone's Free plan does not establish the Workers billing plan. `wrangler whoami` confirms authentication but does not report that plan. A read-only [account subscriptions API](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) request requires Billing Read access. Never print authentication tokens while checking it.

### Publish the deployment

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

Each history request reads at most 100 commits. Startup combines the default-branch snapshot and first page in one GraphQL call. Up to four repositories progress concurrently using a shared four-request scheduler. File responses stay small (two pages per invocation), and larger pages retry individually. The scheduler coordinates request pacing, rate cooldowns, and cancellation across every repository. Successful inspections are reused from a bounded in-memory cache; no scan cache is stored on the server or in persistent browser storage.

Network wait does not count as Worker CPU, while encryption, validation, JSON parsing, and response construction do. Cloudflare’s Free plan allows 10 ms CPU and tolerates occasional overruns, but may terminate consistently over-budget invocations. Measure the deployed version under representative scans; successful HTTP responses alone do not establish CPU safety. Exact lockfile filtering still requires reading the changed-file list for every uncached authored commit. Large histories remain subject to GitHub quotas.

A deterministic 180-repository fixture compares sequential and concurrent orchestration using simulated network delays and identical verified totals. This is a scheduler benchmark, not a prediction of GitHub latency:

```sh
SCAN_BENCHMARK=1 npx vitest run tests/repository-scan.test.ts
```

The opt-in local diagnostic uses mocked 100-commit pages, encrypted sessions, signed handles, and rate-limit bindings. It measures local wall time, not deployed Cloudflare CPU:

```sh
WORKER_BENCHMARK=1 npx vitest run tests/worker-performance.test.ts
```

It asserts response correctness and reports timings without a timing threshold. It does not measure GitHub network latency, production binding overhead, or cold starts.

## Worker runtime compatibility check

Real-network checks in local workerd found that `fetch` with `redirect: 'error'` throws a `TypeError` before making a request. The production helper therefore uses `redirect: 'manual'` and rejects all 3xx responses explicitly, preserving the rule that credentials are never forwarded to a redirect destination. A public request to `https://api.github.com/zen` through the patched production helper returned HTTP 200. `AbortSignal.timeout(15000)` was supported by the same runtime.

The isolated diagnostic can be repeated with `npx wrangler dev --config worker/runtime.wrangler.jsonc --local --port 8789`, then `curl http://localhost:8789/`. It uses no credentials or repository access and is not imported into the production Worker. Callback failure diagnostics log only `auth_callback_failed` plus a static internal error code; raw upstream errors, bodies, credentials, and callback URLs are never included in application logs.
