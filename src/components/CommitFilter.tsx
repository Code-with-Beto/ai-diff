import type { AnalysisResult, CommitFilterSummary } from '../../shared/types';
import { formatDate, formatNumber, OVERSIZED_COMMIT_THRESHOLD } from '../lib/analysis';
import { describeCommitFilter } from '../lib/share';
import './CommitFilter.css';

const compactThreshold = (threshold: number) => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(threshold).toLowerCase();

export function CommitFilterControl({ enabled, scope, onEnabledChange, onScopeChange }: {
  enabled: boolean;
  scope: CommitFilterSummary['scope'];
  onEnabledChange: (enabled: boolean) => void;
  onScopeChange: (scope: CommitFilterSummary['scope']) => void;
}) {
  return <section className="commit-filter-control" aria-label="Commit size filter">
    <label className="commit-filter-toggle"><input type="checkbox" checked={enabled} onChange={event => onEnabledChange(event.target.checked)} /><span>Skip oversized commits</span></label>
    <p className="commit-filter-threshold">Over {compactThreshold(OVERSIZED_COMMIT_THRESHOLD)} added + deleted lines.</p>
    <details className="commit-filter-options">
      <summary>Options{enabled && scope === 'before' ? ' · before only' : ''}</summary>
      <label className="commit-filter-scope">Apply to<select value={scope} disabled={!enabled} onChange={event => onScopeChange(event.target.value as CommitFilterSummary['scope'])}>
        <option value="both">Both periods</option><option value="before">Before only (unequal filter)</option>
      </select></label>
      {enabled && scope === 'before' && <p>Different rules apply to each period. Large commits after your date stay included.</p>}
      <p>Skips whole commits. Change the filter or turn it off without rescanning.</p>
    </details>
  </section>;
}

export function CommitFilterNotice({ result }: { result: AnalysisResult }) {
  const filter = result.commitFilter;
  const flagged = result.oversizedCommits ?? [];
  const excluded = (filter?.excludedBefore.commits ?? 0) + (filter?.excludedAfter.commits ?? 0);
  const excludedAdditions = (filter?.excludedBefore.additions ?? 0) + (filter?.excludedAfter.additions ?? 0);
  const excludedDeletions = (filter?.excludedBefore.deletions ?? 0) + (filter?.excludedAfter.deletions ?? 0);
  const unequal = filter?.enabled && filter.scope === 'before';
  if (!flagged.length && !excluded && !unequal) return null;
  const largest = [...flagged].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 10);
  const count = excluded || flagged.length;
  return <details className="commit-filter-notice">
    <summary>
      <span>{count > 0 ? `${formatNumber(count)} large commit${count === 1 ? '' : 's'} ${excluded ? 'excluded' : 'included'} (over ${compactThreshold(filter?.threshold ?? OVERSIZED_COMMIT_THRESHOLD)} changed lines)` : 'No large commits excluded'}{unequal ? ' · before-only (unequal filter)' : ''}.</span>
      <span className="commit-filter-details-link">Details</span>
    </summary>
    <div className="commit-filter-audit">
      {flagged.length > 0 && <p>{formatNumber(flagged.length)} large commit{flagged.length === 1 ? '' : 's'} found: {formatNumber(excluded)} excluded, {formatNumber(Math.max(0, flagged.length - excluded))} included.</p>}
      {excluded > 0 && <p>{formatNumber(excludedAdditions)} additions and {formatNumber(excludedDeletions)} deletions left out of the totals and chart.</p>}
      <p>{describeCommitFilter(filter)}</p>
      <p>Large commits can contain imported projects, templates, dependencies, generated files, or lockfiles. A root commit can add an entire codebase even when its primary author matches your account. Size alone cannot identify the source of those lines.</p>
      {largest.length > 0 && <>
        <h3>Largest commits{flagged.length > 10 ? ' (10 shown)' : ''}</h3>
        <ul>
          {largest.map(commit => {
            const isBefore = Date.parse(commit.committedDate) < Date.parse(`${result.cutoff}T00:00:00Z`);
            const skipped = filter?.enabled && (filter.scope === 'both' || isBefore);
            return <li key={commit.oid}><div><code>{commit.oid.slice(0, 8)}</code><span>{formatDate(commit.committedDate)} · {isBefore ? 'Before' : 'After'} · {skipped ? 'Excluded' : 'Included'}</span></div><div className="commit-filter-counts"><span>+{formatNumber(commit.additions)}</span><span>−{formatNumber(commit.deletions)}</span></div></li>;
          })}
        </ul>
      </>}
      <p>This is a whole-commit size heuristic, not file-level filtering. It can exclude legitimate work and miss smaller generated changes. No source code or filenames are fetched.</p>
    </div>
  </details>;
}
