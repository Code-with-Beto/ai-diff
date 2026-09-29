# AI Diff

Compare your GitHub activity before and after you started using AI. Connect GitHub, choose a date and repositories, then explore lines added, monthly activity, and a result you can share. Free to use and open source.

**[Open AI Diff →](https://aidiff.cwb.sh)** · by [Code with Beto](https://codewithbeto.dev)

![AI Diff sample report showing before-and-after additions and monthly activity](docs/preview.jpg)

*Fictional sample data.*

## How it works

- Discover public repositories you own or recently contributed to. Add a public organization to load its repositories, or add a repository by URL.
- Include private repositories through selected GitHub App installations. Private organization access may require an owner’s approval.
- Choose an AI release date or your own cutoff. Change the date and filters after scanning without fetching the history again.
- Explore additions, deletions, monthly activity, and repository coverage. Copy or download a result image, or share a result link.

AI Diff counts **lines added in default-branch commits whose primary author matches your GitHub account**. It excludes forks and merge commits, deduplicates commit SHAs, and splits the periods at midnight UTC.

Additions include documentation, lockfiles, generated text, imports, and repeated edits. Commits changing more than 100,000 lines are skipped by default; you can inspect or disable that filter. It is a whole-commit size heuristic, not file-level detection.

Results cover selected, accessible history. Automatic discovery does not include every organization you have worked in. These numbers measure commit activity, not AI authorship or productivity. [Read the methodology](https://aidiff.cwb.sh/about).

## Run locally

Use **Node.js 24 LTS** and npm:

```sh
git clone https://github.com/Code-with-Beto/ai-diff.git
cd ai-diff
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** and try the sample report. No credentials are needed.

For real GitHub sign-in, follow [GitHub App configuration](README-backend.md#configuration). The app uses React, TypeScript, Vite, and a small Cloudflare Worker. No database, repository cloning, or AI API is required.

## Checks

```sh
npm test
npm run build
```

Run `npm run test:git` when changing counting logic. It checks the calculation against a controlled local Git history.

## Setup and privacy

See the [backend guide](README-backend.md) for configuration, API contracts, [deployment](README-backend.md#deploying-your-own-instance), and [privacy details](README-backend.md#privacy-and-sharing).

GitHub access is read-only. Analysis stays in browser memory, and images are generated locally. Private repository names are left out of shared results.

## Contributing

[Contributions](CONTRIBUTING.md) and [bug reports](https://github.com/Code-with-Beto/ai-diff/issues) are welcome. For security issues, follow [SECURITY.md](SECURITY.md).

Licensed under [MIT](LICENSE).

---

[Code with Beto](https://codewithbeto.dev) · [YouTube](https://cwb.sh/youtube) · [Sponsor](https://github.com/sponsors/betomoedano)
