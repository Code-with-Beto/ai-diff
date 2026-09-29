import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AnalyzedCommit } from '../../shared/types';
import { excludedFileLines, isLockfile } from '../../shared/file-policy';
import { formatDate, formatNumber } from '../lib/analysis';
import './MonthlyBreakdown.css';

const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function commitLink(commit: AnalyzedCommit): string | null {
  if (commit.repository?.id.startsWith('sample-')) return null;
  const parts = commit.repository?.nameWithOwner.split('/');
  if (!parts || parts.length !== 2 || !parts.every(Boolean)) return null;
  return `https://github.com/${parts.map(encodeURIComponent).join('/')}/commit/${encodeURIComponent(commit.oid)}`;
}

function CommitRow({ commit, excludeLockfiles }: { commit: AnalyzedCommit; excludeLockfiles: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const files = expanded ? [...(commit.files ?? [])].sort((a, b) => b.additions - a.additions || a.filename.localeCompare(b.filename)) : [];
  const link = commitLink(commit);
  const exclusion = commit.exclusion === 'files_unavailable' ? 'File details unavailable'
    : commit.exclusion === 'oversized' ? 'Oversized commit excluded' : null;

  return <details className="mb-commit" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="mb-commit-label">
        <span className="mb-commit-title">{commit.headline || 'Untitled commit'}</span>
        <span className="mb-commit-meta">{formatDate(commit.committedDate)} · <code>{commit.oid.slice(0, 8)}</code>{exclusion && <> · {exclusion}</>}</span>
      </span>
      <span className="mb-commit-counts" aria-label={`${formatNumber(commit.countedAdditions)} counted additions, ${formatNumber(commit.countedDeletions)} counted deletions`}>
        <span aria-hidden="true">+{formatNumber(commit.countedAdditions)}</span>
        <span aria-hidden="true">−{formatNumber(commit.countedDeletions)}</span>
      </span>
    </summary>
    {expanded && <div className="mb-commit-body">
      <dl className="mb-commit-totals">
        <div><dt>Raw changes</dt><dd>+{formatNumber(commit.additions)} / −{formatNumber(commit.deletions)}</dd></div>
        <div><dt>{excludeLockfiles ? 'Lockfile lines excluded' : 'Lockfile lines'}</dt><dd>{commit.filesComplete
          ? <>+{formatNumber(commit.lockfileAdditions)} / −{formatNumber(commit.lockfileDeletions)}</>
          : 'Not available'}</dd></div>
      </dl>
      {commit.exclusion === 'oversized' && <p className="mb-note">The size filter excluded this whole commit after applying the lockfile setting.</p>}
      {commit.exclusion === 'files_unavailable' && <p className="mb-note">This commit is excluded from the filtered totals because its file details are incomplete. Run the analysis again to retry.</p>}
      {!commit.filesComplete && commit.exclusion === null && <p className="mb-note">File details are incomplete. The original commit counts are included without a file-level adjustment.</p>}
      {files.length > 0 ? <div className="mb-files-scroll" role="region" aria-label={`Changed files for commit ${commit.oid.slice(0, 8)}`} tabIndex={0}>
        <table className="mb-files">
          <caption>{commit.filesComplete ? 'Changed files' : 'Available file details'} · raw additions and deletions</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Added</th><th scope="col">Deleted</th></tr></thead>
          <tbody>{files.map(file => {
            const lockfile = isLockfile(file.filename) || isLockfile(file.previousFilename ?? '');
            const excluded = excludedFileLines(file);
            const allExcluded = lockfile && excluded.additions === file.additions && excluded.deletions === file.deletions;
            const lockfileStatus = allExcluded ? 'Lockfile · excluded'
              : excluded.additions > 0 ? 'Lockfile additions excluded' : 'Lockfile deletions excluded';
            return <tr key={file.filename} className={allExcluded && excludeLockfiles ? 'mb-file-excluded' : undefined}>
              <th scope="row"><code>{file.filename}</code>{file.previousFilename && <span className="mb-previous-file">Previously {file.previousFilename}</span>}{lockfile && <span className="mb-file-status">{excludeLockfiles ? lockfileStatus : 'Lockfile changes'}</span>}</th>
              <td className={excluded.additions > 0 && excludeLockfiles ? 'mb-file-count-excluded' : undefined}>+{formatNumber(file.additions)}</td><td className={excluded.deletions > 0 && excludeLockfiles ? 'mb-file-count-excluded' : undefined}>−{formatNumber(file.deletions)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="mb-note">{commit.filesComplete ? 'No changed files in this commit.' : 'No complete file breakdown is available for this commit.'}</p>}
      {link && <a className="mb-commit-link" href={link} target="_blank" rel="noopener noreferrer">Open commit on GitHub</a>}
    </div>}
  </details>;
}

export default function MonthlyBreakdown({ month, details, excludeLockfiles, close }: {
  month: string;
  details: AnalyzedCommit[];
  excludeLockfiles: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const commits = useMemo(() => details.filter(commit => {
    const timestamp = Date.parse(commit.committedDate);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 7) === month;
  }), [details, month]);
  const groups = useMemo(() => {
    const repositories = new Map<string, { name: string; isPrivate: boolean; additions: number; commits: AnalyzedCommit[] }>();
    for (const commit of commits) {
      const key = commit.repository?.id ?? commit.repository?.nameWithOwner ?? 'unknown';
      const group = repositories.get(key) ?? { name: commit.repository?.nameWithOwner ?? 'Repository unavailable', isPrivate: commit.repository?.isPrivate ?? false, additions: 0, commits: [] };
      group.additions += commit.countedAdditions;
      group.commits.push(commit);
      repositories.set(key, group);
    }
    return [...repositories.entries()].map(([key, group]) => ({
      key, ...group, commits: group.commits.sort((a, b) => b.countedAdditions - a.countedAdditions || b.additions - a.additions || b.committedDate.localeCompare(a.committedDate)),
    })).sort((a, b) => b.additions - a.additions || a.name.localeCompare(b.name));
  }, [commits]);
  const counted = commits.reduce((sum, commit) => sum + commit.countedAdditions, 0);
  const raw = commits.reduce((sum, commit) => sum + commit.additions, 0);
  const lockfiles = commits.reduce((sum, commit) => sum + (commit.filesComplete ? commit.lockfileAdditions : 0), 0);
  const unavailable = commits.filter(commit => !commit.filesComplete).length;
  const excludedUnknown = commits.filter(commit => commit.exclusion === 'files_unavailable').length;
  const label = monthFormatter.format(new Date(`${month}-01T00:00:00Z`));

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus();
    return () => {
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={dialog} className="mb-dialog" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="mb-header">
      <div><h2 ref={heading} tabIndex={-1} id={`${id}-heading`}>{label}</h2><p id={`${id}-description`}>{formatNumber(commits.length)} commit{commits.length === 1 ? '' : 's'} · {formatNumber(groups.length)} repositor{groups.length === 1 ? 'y' : 'ies'}</p></div>
      <button type="button" className="mb-close" onClick={close} aria-label="Close monthly details" title="Close (Esc)"><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="mb-body">
      <dl className="mb-overview">
        <div><dt>Counted additions</dt><dd>{formatNumber(counted)}</dd></div>
        <div><dt>Raw additions</dt><dd>{formatNumber(raw)}</dd></div>
        <div><dt>{excludeLockfiles ? 'Lockfile additions excluded' : 'Lockfile additions'}</dt><dd>{unavailable === commits.length && unavailable > 0 ? 'Unknown' : formatNumber(lockfiles)}{unavailable > 0 && unavailable < commits.length && <span className="mb-partial"> · partial</span>}</dd></div>
      </dl>
      {unavailable > 0 && <p className="mb-note">File details are incomplete for {formatNumber(unavailable)} commit{unavailable === 1 ? '' : 's'}.{excludedUnknown > 0 && <> {formatNumber(excludedUnknown)} {excludedUnknown === 1 ? 'is' : 'are'} excluded from the filtered totals.</>}</p>}
      {commits.length === 0 ? <p className="mb-empty">No commits in this month.</p> : groups.map(group => <section className="mb-repository" key={group.key}>
        <header className="mb-repository-header"><h3>{group.name}{group.isPrivate && <span className="mb-private">Private</span>}</h3><span className="mb-repository-count" aria-label={`${formatNumber(group.additions)} counted additions`}>+{formatNumber(group.additions)}</span></header>
        <div>{group.commits.map(commit => <CommitRow key={commit.oid} commit={commit} excludeLockfiles={excludeLockfiles} />)}</div>
      </section>)}
      <p className="mb-footnote">This breakdown stays in your browser and is not included in shared results.</p>
    </div>
  </dialog>;
}
