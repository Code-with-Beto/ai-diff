# AI Diff

**Your code. Before and after AI.**

Explore your GitHub history around the day AI became part of your workflow. Connect GitHub, pick a date and some repositories, then see your before-and-after totals, monthly activity, and a result you can share.

**[Try AI Diff →](https://aidiff.cwb.sh)** · Built by **[Code with Beto](https://codewithbeto.dev)**

Free to use, open source, and designed to run without a database or an AI API bill.

![AI Diff sample report with before-and-after additions and a monthly activity chart](docs/preview.jpg)

*Preview uses fictional sample data.*

## What you can do

- **Connect GitHub** and analyze public repositories without installing an app.
- **Include private repositories** by granting read-only access to selected repositories.
- **Choose your turning point:** Claude Opus 4.5, Sonnet 4.5, or a custom date. Change it after a scan without fetching the history again.
- **Explore the numbers:** lines added before and after, monthly activity, deletions, net change, and repository coverage.
- **Share in a few clicks:** copy an image, download a PNG, copy share text, or send a result link. In the share dialog, use **⌘/Ctrl + Shift + C** to copy the image.
- **Try the sample report** without connecting an account. Scans show progress, can be cancelled, and label incomplete results clearly.

## What the numbers mean

AI Diff measures **lines added in commits**, including documentation, lockfiles, generated text, and repeated edits. Add a line, delete it, and add it again: both additions count. These numbers describe commit activity; they cannot identify AI authorship, measure code quality, or establish a productivity increase.

For each selected repository, AI Diff snapshots the default branch and reads its commit history. A commit counts only when GitHub associates its primary author with your connected account. Merge commits are excluded, and identical commit SHAs are deduplicated across repositories. **Forked repositories are excluded entirely**, including discovery, manual additions, and analysis. The cutoff is midnight UTC on your chosen date, using the commit timestamp.

Imported projects, templates, generated files, and lockfiles can inflate additions even when the primary author matches your account. A root commit can add an existing codebase in one step. Author matching does not establish who originally wrote each line.

The calculation skips commits with **more than 100,000 added and deleted lines combined** by default, using the same rule in both periods. A short notice links to excluded totals and an audit of the largest commits. Turn off **Skip oversized commits** to restore them instantly, or open **Options** and choose **Before only (unequal filter)**. Shared images, text, and links retain the filter and exclusion count. This is a whole-commit size heuristic, not file-level dependency detection: a large legitimate commit may be excluded, and smaller commits can still contain generated code. It requires no additional GitHub requests.

Results cover **selected GitHub repository history**, not your entire career. Deleted or inaccessible repositories, old unlinked author identities, work outside default branches, and uncommitted work can be missing. The two periods may have different lengths, so their dates and coverage stay visible alongside the totals.

The default date is [November 24, 2025, the Opus 4.5 release](https://www.anthropic.com/news/claude-opus-4-5), inspired by [DHH’s conversation with Lex Fridman](https://lexfridman.com/?p=6512). The [Sonnet 4.5 release on September 29, 2025](https://www.anthropic.com/news/claude-sonnet-4-5) is another preset. Neither date implies that you used AI. Read more on the [About page](https://aidiff.cwb.sh/about).

## Keyboard shortcuts and themes

AI Diff uses your system theme by default. The header toggle or **T** switches between light and dark mode and remembers your choice on this device. The interface and exported images pair a grayscale base with Sky 500 in light mode and Sky 400 in dark mode. Exported images use Sky 400 on black.

| Shortcut | Action |
| --- | --- |
| `?` | Show shortcuts |
| `T` | Toggle light/dark mode |
| `/` | Focus repository search |
| `⌘/Ctrl + Enter` | Analyze selected repositories |
| `⌘/Ctrl + Shift + S` | Open sharing |
| `⌘/Ctrl + Shift + C` | Copy the image while sharing |
| `Esc` | Close a dialog |

Single-key shortcuts are inactive while typing. In Keyboard shortcuts, uncheck **Enable single-key shortcuts** to disable T, /, and ? for the current page session; this setting is not saved. Modifier shortcuts remain enabled, and analysis and sharing shortcuts apply when those actions are available.

## Run locally

Use **Node.js 24 LTS** and npm:

```sh
git clone https://github.com/Code-with-Beto/ai-diff.git
cd ai-diff
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** and choose the sample report. No GitHub credentials are needed for sample mode.

For real GitHub sign-in, register your own development GitHub App, then create a local configuration file:

```sh
cp .dev.vars.example .dev.vars
```

Set `APP_ORIGIN`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SESSION_SECRET` in `.dev.vars`. Generate a session secret with `openssl rand -base64 32`. Keep this file private; it is ignored by Git.

Your GitHub App needs **Contents: read-only** and **Metadata: read-only** permissions. Use `/api/auth/github/callback` as the authorization callback and `/api/github/setup` as the setup URL under your configured origin. The runtime uses user access tokens and does not require an app private key. See [the backend setup guide](README-backend.md#configuration) for registration settings, token handling, and organization-access details.

## Architecture

| Part | Responsibility |
| --- | --- |
| React + TypeScript + Vite | Interface, scan progress, in-memory aggregation, charts, and image generation |
| Cloudflare Worker | Same-origin authentication, encrypted sessions, request validation, and bounded GitHub API reads |
| GitHub GraphQL + REST | Repository discovery, default-branch snapshots, commit counts, and selected installation access |
| Vitest + local Git fixtures | Calculation, authentication, pagination, privacy, and sharing checks |

The browser owns each scan. The Worker requests up to 100 commits per page using fixed queries and signed pagination handles. There are no repository clones, background jobs, AI inference calls, or persistent result storage.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local app and Worker |
| `npm run build` | Type-check and build the client and Worker |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run TypeScript checks |
| `npm test` | Run the automated suite |
| `npm run test:git` | Compare the calculation against a controlled local Git history |
| `npm run build:deploy` | Build using your ignored `wrangler.local.jsonc` deployment configuration |
| `npm run check:deploy` | Build and validate that deployment without publishing |
| `npm run deploy` | Build and publish your configured Worker |

The optional `WORKER_BENCHMARK=1 npx vitest run tests/worker-performance.test.ts` diagnostic measures local wall time with mocked GitHub responses. It is not a measurement of Cloudflare CPU usage. See [backend verification notes](README-backend.md) for test coverage and limitations.

## Host your own

AI Diff is designed for Cloudflare Workers and Static Assets. It can fit within the free tier, subject to [Cloudflare’s current limits](https://developers.cloudflare.com/workers/platform/pricing/) and GitHub’s API quotas.

The committed `wrangler.jsonc` contains safe defaults. Copy it to the ignored `wrangler.local.jsonc` for your own deployment configuration:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

Set your Worker name, Cloudflare account, public app settings, and HTTPS `APP_ORIGIN` in that local file. Add your own custom-domain route if needed. Register a production GitHub App whose callback and setup URLs match that origin, and store `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` as Worker secrets. Never put secrets in `VITE_*` variables, source files, or committed configuration.

```sh
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npm run check:deploy
npm run deploy
```

Keep rate-limit bindings enabled for a public deployment. After deploying, verify sign-in, a known repository’s counts, private access if enabled, sharing, and logout. The [backend guide](README-backend.md) documents API contracts, security boundaries, and runtime behavior.

## Privacy and sharing

GitHub tokens are encrypted in expiring HttpOnly session cookies and never exposed to browser JavaScript. Refresh tokens are discarded. Logout attempts to revoke the GitHub token and clears local state even if revocation fails.

Private access is optional and limited by both the repositories granted to the GitHub App and your GitHub permissions. GitHub’s Contents permission technically permits reading source code; AI Diff requests commit metadata and line counts, not source files or patches. No code is sent to an AI model.

Analysis stays in browser memory, so reloading starts a new scan. Only the light/dark preference is saved in local browser storage. There are no third-party tracking scripts or stored server-side reports. GitHub and the hosting provider still process requests as part of operating their services.

Share images are generated locally. Result links carry only an aggregate summary in the URL fragment, the part after `#`, which is not sent to the server. Anyone holding the full link can view, modify, or reshare those totals, so shared results are labeled unverified. Private repository names are omitted, and sharing totals that include private contributions requires an explicit acknowledgment. Social previews describe AI Diff; opening the full link displays the result.

## Contributing

Bug fixes, accessibility improvements, and useful tests are welcome. [Open an issue](https://github.com/Code-with-Beto/ai-diff/issues) for a bug report or to discuss a larger change, then send a pull request with a short explanation and relevant validation. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide.

Before opening a pull request, run `npm run typecheck`, `npm test`, and `npm run build`. Include `npm run test:git` when changing the counting logic. Use fixtures for private-repository scenarios and keep tokens, private repository details, and local deployment configuration out of your changes.

For suspected vulnerabilities, follow the [security policy](SECURITY.md).

## License

[MIT](LICENSE).

---

Built by [Code with Beto](https://codewithbeto.dev), sharing practical lessons on mobile development, AI, and building useful software.

[Website](https://codewithbeto.dev) · [YouTube](https://cwb.sh/youtube) · [Learn React Native](https://codewithbeto.dev/learn) · [Sponsor on GitHub](https://github.com/sponsors/betomoedano)
