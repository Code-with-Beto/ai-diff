import type { CommitFile, CommitRecord, LineTotals } from './types.ts';

// Exact dependency-lock basenames, at any depth. Manifests and source stay included.
const lockfiles = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lock', 'bun.lockb', 'deno.lock', 'podfile.lock', 'package.resolved',
  'gemfile.lock', 'cargo.lock', 'composer.lock', 'poetry.lock', 'pipfile.lock',
  'uv.lock', 'pdm.lock', 'pubspec.lock', 'mix.lock',
  'packages.lock.json', 'gradle.lockfile', 'go.sum', 'flake.lock',
]);

export function isLockfile(filename: string): boolean {
  return lockfiles.has(filename.slice(filename.lastIndexOf('/') + 1).toLowerCase());
}

export function excludedFileLines(file: CommitFile): LineTotals {
  return {
    additions: isLockfile(file.filename) ? file.additions : 0,
    deletions: isLockfile(file.previousFilename ?? file.filename) ? file.deletions : 0,
  };
}

/** Validate the whole list and total exclusions in one pass. Null means unknown, never zero. */
export function summarizeCommitFiles(commit: CommitRecord): LineTotals | null {
  if (!commit.filesComplete || !commit.files || commit.files.length > 3000) return null;
  if (!Number.isSafeInteger(commit.changedFiles) || commit.changedFiles! < 0 || commit.files.length !== commit.changedFiles) return null;
  const paths = new Set<string>();
  let additions = 0, deletions = 0;
  const excluded = { additions: 0, deletions: 0 };
  for (const file of commit.files) {
    if (!file.filename || paths.has(file.filename) || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0) return null;
    paths.add(file.filename);
    additions += file.additions; deletions += file.deletions;
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) return null;
    if (isLockfile(file.filename)) excluded.additions += file.additions;
    if (isLockfile(file.previousFilename ?? file.filename)) excluded.deletions += file.deletions;
  }
  return additions === commit.additions && deletions === commit.deletions ? excluded : null;
}

/** Never label missing, repeated or partially paginated file statistics as clean. */
export function hasCompleteFiles(commit: CommitRecord): boolean {
  return summarizeCommitFiles(commit) !== null;
}
