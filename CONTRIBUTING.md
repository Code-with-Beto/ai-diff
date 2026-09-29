# Contributing to AI Diff

Thanks for helping developers understand their GitHub activity. Bug fixes, accessibility improvements, clearer explanations, and meaningful calculation tests are welcome.

## Get started

1. Fork this repository and create a branch for your change.
2. Use Node.js 24 or newer and run `npm ci`.
3. Run `npm run dev`. The labeled sample works without credentials.
4. Make your change and explain the problem it solves in a pull request.

Before opening the pull request, run:

```sh
npm test
npm run test:git
npm run build
```

For UI changes, include a screenshot using sample data. For calculation or authentication changes, add a focused regression test. Open an issue before undertaking a substantial new feature so we can agree on its scope.

## Product principles

- Measure lines added in selected GitHub history accurately. Do not present the result as AI authorship, code quality, or productivity.
- Preserve UTC cutoff rules, primary-author attribution, merge exclusion, deduplication, and incomplete-result labels.
- Keep private repositories optional and retain explicit acknowledgment before sharing their totals.
- Keep credentials on the server. Use narrow, fixed GitHub queries and read-only permissions.
- Keep the tool free to use and inexpensive to host, without tracking scripts, advertising gates, or a database requirement.
- Preserve subtle Code with Beto attribution and keyboard/mobile accessibility.

## Keep contributions safe

Never attach real session cookies, authorization codes, tokens, private repository details, or unredacted network traces to an issue or pull request. Use fictional fixtures. Do not commit `.dev.vars*`, `.env*`, `wrangler.local.jsonc`, build artifacts, or private keys; the example environment file is intentionally blank.

For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

Contributions are licensed under the repository's [MIT license](LICENSE).
