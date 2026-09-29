import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, CircleHelp, Github, ListChecks, ListX, LogOut, Plus, Search, SlidersHorizontal, Square, X } from 'lucide-react';
import type { AnalysisResult, CommitRecord, InstallationsPage, Repository, RepositoryPage, RepositoryProgress, SessionInfo, ShareResult } from '../shared/types';
import { ApiError, api } from './api';
import { analyzeCommits, formatDate, formatNumber } from './lib/analysis';
import { SAMPLE_AS_OF, SAMPLE_COMMITS, SAMPLE_REPOSITORIES, SAMPLE_USER } from './lib/sample';
import { createShareResult, decodeShare, describeAdditionChange } from './lib/share';
import { readPublishedShare } from './lib/published-share';
import { scanRepositories } from './lib/repository-scan';
import { InspectionCache } from './lib/inspection-cache';
import { isNonForkRepository } from '../shared/repository-policy';
import { callbackMessage, comparisonDateAllowed, createOperationScope, isAuthenticationError, parseRepositorySource } from './lib/client-state';
import About from './components/About';
import MonthlyChart from './components/MonthlyChart';
import { CommitFilterControl, CommitFilterNotice } from './components/CommitFilter';
import ShareDialog from './components/ShareDialog';
import ThemeToggle from './components/ThemeToggle';
import KeyboardShortcuts from './components/KeyboardShortcuts';
import ComparisonDateHelp from './components/ComparisonDateHelp';
import FilterDropdown from './components/FilterDropdown';
import RepositorySelect from './components/RepositorySelect';
import Switch from './components/Switch';
import { HelpTooltip, Tooltip } from './components/Tooltip';
import { areSingleKeyShortcutsEnabled, isEditingTarget, modifierLabel } from './lib/shortcuts';

const DEFAULT_DATE = '2025-11-24';
const today = () => new Date().toISOString().slice(0, 10);
const completeSample = SAMPLE_REPOSITORIES.map(repository => ({ repository, status: 'complete' as const, commits: 0 }));
function Header() {
  return <header className="site-header"><a className="brand" href="/" aria-label="AI Diff home">AI Diff</a><nav aria-label="Main navigation"><a href="/about">About</a><a className="icon-button github-link" href="https://github.com/Code-with-Beto/ai-diff" target="_blank" rel="noreferrer" aria-label="GitHub repository" title="View source on GitHub"><Github size={18} aria-hidden="true" /></a><KeyboardShortcuts /><ThemeToggle /></nav></header>;
}
function Footer() {
  return <footer className="site-footer"><a href="https://codewithbeto.dev" target="_blank" rel="noreferrer">by Code with Beto</a><a href="https://github.com/Code-with-Beto/ai-diff" target="_blank" rel="noreferrer">GitHub</a><a href="/about#privacy">Privacy</a></footer>;
}
function Result({ result, login, sample, share, shared = false }: { result: AnalysisResult; login: string; sample: boolean; share: () => void; shared?: boolean }) {
  const missingFiles = (result.fileFilter?.uninspectedBefore.commits ?? 0) + (result.fileFilter?.uninspectedAfter.commits ?? 0);
  const removedLockLines = (result.fileFilter?.excludedBefore.additions ?? 0) + (result.fileFilter?.excludedAfter.additions ?? 0);
  const all = result.before.additions + result.after.additions;
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  const cutoffTime = Date.parse(`${result.cutoff}T00:00:00.000Z`);
  const previousDay = new Date(Math.min(cutoffTime - 1, Date.parse(result.asOf))).toISOString();
  const beforeRange = result.firstCommitAt && result.firstCommitAt.slice(0, 10) < result.cutoff
    ? `${formatDate(result.firstCommitAt)} – ${formatDate(previousDay)}` : `Before ${formatDate(result.cutoff)}`;
  const afterRange = cutoffTime <= Date.parse(result.asOf)
    ? `${formatDate(result.cutoff)} – ${formatDate(result.asOf)}` : 'Cutoff falls after this snapshot';
  const net = all - result.before.deletions - result.after.deletions;
  const scale = Math.max(result.before.additions, result.after.additions, 1);

  return <section className="results" aria-labelledby="result-title">
    <div className="result-topline">
      <div className="identity">
        <div><h2 id="result-title">@{login}</h2><span>{sample ? 'Sample data · fictional account' : shared ? 'Your commits, split by date' : 'Selected GitHub repository history'}</span></div>
      </div>
      <button className="link-button share-result" onClick={share} title="Share result (⌘/Ctrl + Shift + S)" aria-keyshortcuts="Meta+Shift+S Control+Shift+S"><span>Share</span><kbd>{modifierLabel} ⇧ S</kbd></button>
    </div>
    <div className="result-summary">
      <div className="numbers-grid">
        <div className="number-cell before">
          <span className="metric-label">Before</span>
          <strong className={String(result.before.additions).length > 9 ? 'long-number' : undefined} style={{ fontSize: `min(60px, ${Math.min(22, 160 / formatNumber(result.before.additions).length)}cqi)` }}>{formatNumber(result.before.additions)}</strong><span className="metric-unit">lines added</span><p>{beforeRange}</p><div className="addition-track" aria-hidden="true"><span style={{ width: `${result.before.additions / scale * 100}%` }} /></div>
        </div>
        <div className="number-cell after">
          <span className="metric-label">After</span>
          <strong className={String(result.after.additions).length > 9 ? 'long-number' : undefined} style={{ fontSize: `min(60px, ${Math.min(22, 160 / formatNumber(result.after.additions).length)}cqi)` }}>{formatNumber(result.after.additions)}</strong><span className="metric-unit">lines added</span><p>{afterRange}</p><div className="addition-track" aria-hidden="true"><span style={{ width: `${result.after.additions / scale * 100}%` }} /></div>
        </div>
      </div>
      <p className="comparison-insight">{describeAdditionChange(result.before.additions, result.after.additions)}</p>
    </div>
    {result.fileFilter?.enabled && <p className="file-filter-note">Lockfiles excluded · {formatNumber(removedLockLines)} added lines removed from both periods{missingFiles > 0 && <><br /><span role="status">Partial file coverage: {formatNumber(missingFiles)} commits without complete file checks are not included.</span></>}</p>}
    <CommitFilterNotice result={result} />
    {result.months.length > 0 && <MonthlyChart months={result.months} cutoff={result.cutoff} details={result.details} excludeLockfiles={result.fileFilter?.enabled} />}
    <div className="secondary-stats">
      <div><span>Commits counted</span><strong>{formatNumber(result.before.commits + result.after.commits)}</strong></div>
      <div><span>Lines deleted</span><strong>{formatNumber(result.before.deletions + result.after.deletions)}</strong></div>
      <div><span>Net change</span><strong>{net >= 0 ? '+' : ''}{formatNumber(net)}</strong></div>
    </div>
    <div className="result-bottom">
      <p className="coverage-line"><strong>{result.coverage.completed}/{result.coverage.total}</strong> repositories complete · {result.includesPrivate ? 'includes private totals' : 'public history'}</p>
      {partial && <p className="partial-note" role="status">Partial result: {result.coverage.unavailable} unavailable, {result.coverage.incomplete} incomplete.</p>}
      <p className="small-text">{result.fileFilter?.enabled ? 'Lockfiles excluded. Still includes docs, scaffolding, generated files, and repeated edits.' : 'Includes docs, lockfiles, generated files, and repeated edits.'}</p>
    </div>
  </section>;
}
export default function App() {
  const published = useMemo(readPublishedShare, []);
  const isAbout = window.location.pathname === '/about', isShared = window.location.pathname === '/share' || !!published;
  const [session, setSession] = useState<SessionInfo | null>(null), [sessionFailed, setSessionFailed] = useState(false);
  const [connectionExpired, setConnectionExpired] = useState(false);
  const [cutoff, setCutoff] = useState(DEFAULT_DATE), [customDate, setCustomDate] = useState(false);
  const [skipOversized, setSkipOversized] = useState(true);
  const [excludeLockfiles, setExcludeLockfiles] = useState(true);
  const [sample, setSample] = useState(false), [repositories, setRepositories] = useState<Repository[]>([]), [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingRepos, setLoadingRepos] = useState(false), [addingRepo, setAddingRepo] = useState(false), [installing, setInstalling] = useState(false);
  const [search, setSearch] = useState(''), [repoUrl, setRepoUrl] = useState(''), [sourceNotice, setSourceNotice] = useState('');
  const [openFilter, setOpenFilter] = useState<'account' | 'repositories' | 'filters' | null>(null);
  const [includePrivate, setIncludePrivate] = useState(() => new URLSearchParams(window.location.search).get('private') === 'connected' || new URLSearchParams(window.location.search).get('auth') === 'installation_failed');
  const [commits, setCommits] = useState<CommitRecord[]>([]), [progress, setProgress] = useState<RepositoryProgress[]>([]), [asOf, setAsOf] = useState(new Date().toISOString());
  const [scanning, setScanning] = useState(false), [scanMessage, setScanMessage] = useState(''), [error, setError] = useState('');
  const [callbackError, setCallbackError] = useState(() => callbackMessage(window.location.search));
  const [share, setShare] = useState<ShareResult | null>(null), [sharedResult, setSharedResult] = useState(() => published?.result ?? (isShared ? decodeShare(window.location.hash) : null));
  const operations = useRef(createOperationScope());
  const repositorySearch = useRef<HTMLInputElement>(null);
  const knownRepositories = useRef(new Set<string>());
  const inspectionCache = useRef(new InspectionCache());
  const authenticated = !!session?.authenticated;

  useEffect(() => () => { operations.current.invalidateAll(); inspectionCache.current.clear(); }, []);
  useEffect(() => { inspectionCache.current.forAccount(authenticated ? session?.user?.id ?? null : null); }, [authenticated, session?.user?.id]);
  useEffect(() => {
    if (!isShared || published) return;
    const changed = () => { setShare(null); setSharedResult(decodeShare(window.location.hash)); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [isShared, published]);
  useEffect(() => {
    if (isAbout || isShared) return;
    const task = operations.current.start('session');
    api<SessionInfo>('/api/session', { signal: task.signal }).then(data => {
      if (task.isActive()) { setSession(data); setSessionFailed(false); }
    }).catch(() => { if (task.isActive()) setSessionFailed(true); });
    return () => operations.current.cancel('session');
  }, [isAbout, isShared]);
  useEffect(() => {
    if (authenticated && !sample) void loadRepositories(includePrivate);
  }, [authenticated, session?.user?.id, sample]);
  useEffect(() => {
    if (!authenticated || !session?.expiresAt) return;
    const timeout = setTimeout(() => expireSession(), Math.max(0, session.expiresAt * 1000 - Date.now()));
    return () => clearTimeout(timeout);
  }, [authenticated, session?.expiresAt]);

  function stopOperations() {
    operations.current.invalidateAll();
    setLoadingRepos(false); setAddingRepo(false); setInstalling(false); setScanning(false);
  }
  function expireSession() {
    stopOperations();
    setOpenFilter(null);
    inspectionCache.current.clear();
    setSession(previous => previous ? { ...previous, authenticated: false, csrfToken: undefined } : { configured: true, authenticated: false });
    setConnectionExpired(true);
    setProgress(previous => previous.map(item => item.status === 'pending' || item.status === 'scanning' ? { ...item, status: 'incomplete' } : item));
    setError('Your GitHub connection expired. Reconnect to start a new scan. Any results already counted remain available.');
    setScanMessage('');
  }
  function reportError(value: unknown, fallback: string) {
    if (isAuthenticationError(value)) { expireSession(); return; }
    setError(value instanceof Error ? value.message : fallback);
  }
  function mergeRepositories(discovered: Repository[]) {
    const items = discovered.filter(isNonForkRepository);
    const newIds = items.filter(repo => !knownRepositories.current.has(repo.id) && !repo.isFork).map(repo => repo.id);
    items.forEach(repo => knownRepositories.current.add(repo.id));
    setRepositories(previous => {
      const map = new Map(previous.filter(isNonForkRepository).map(repo => [repo.id, repo]));
      items.forEach(repo => map.set(repo.id, repo));
      return [...map.values()].sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
    });
    setSelected(previous => new Set([...previous, ...newIds]));
  }
  async function loadRepositories(privateToo: boolean) {
    const task = operations.current.start('discovery');
    setLoadingRepos(true); setError('');
    try {
      for (const kind of ['owned', 'contributed']) {
        let cursor: string | null = null;
        do {
          const page: RepositoryPage = await api(`/api/github/repositories?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: task.signal });
          if (!task.isActive()) return;
          mergeRepositories(page.repositories.filter(repo => !repo.isPrivate));
          cursor = page.hasNextPage ? page.cursor : null;
        } while (cursor);
      }
      if (privateToo) {
        let nextPage: number | null = 1;
        do {
          const installations: InstallationsPage = await api(`/api/github/installations?page=${nextPage}`, { signal: task.signal });
          if (!task.isActive()) return;
          for (const installation of installations.installations) {
            let cursor: string | null = null;
            do {
              const page: RepositoryPage = await api(`/api/github/repositories?kind=installation&installationId=${installation.id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: task.signal });
              if (!task.isActive()) return;
              mergeRepositories(page.repositories);
              cursor = page.hasNextPage ? page.cursor : null;
            } while (cursor);
          }
          nextPage = installations.nextPage;
        } while (nextPage);
      }
    } catch (value) { if (task.isActive()) reportError(value, 'Repositories could not be loaded.'); }
    finally { if (task.isCurrent()) { setLoadingRepos(false); task.finish(); } }
  }
  async function addRepository(event: React.FormEvent) {
    event.preventDefault();
    if (!authenticated || scanning || loadingRepos || addingRepo || !repoUrl.trim()) return;
    const task = operations.current.start('add');
    setAddingRepo(true); setError(''); setSourceNotice('');
    try {
      const source = parseRepositorySource(repoUrl);
      if (source.kind === 'organization') {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        const found = new Map<string, Repository>();
        do {
          setSourceNotice(`Finding public repositories in ${source.login}…`);
          const query = new URLSearchParams({ kind: 'organization', organization: source.login, ...(cursor ? { cursor } : {}) });
          const page: RepositoryPage = await api(`/api/github/repositories?${query}`, { signal: task.signal });
          if (!task.isActive()) return;
          page.repositories.filter(repo => isNonForkRepository(repo) && !repo.isPrivate).forEach(repo => found.set(repo.id, repo));
          cursor = page.hasNextPage ? page.cursor : null;
          if (page.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error('GitHub could not finish the organization list. Try adding it again.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        mergeRepositories([...found.values()]);
        setSelected(previous => new Set([...previous, ...found.keys()]));
        setSearch(`${source.login}/`);
        setSourceNotice(found.size ? `${found.size} public repositories loaded from ${source.login}. Only your commits will count.` : `No public non-fork repositories found in ${source.login}. For private repositories, use the access option below.`);
      } else {
        const data = await api<{ repository: Repository }>('/api/github/repository', { body: { url: source.url }, csrf: session?.csrfToken, signal: task.signal });
        if (!task.isActive()) return;
        if (!isNonForkRepository(data.repository)) throw new Error('Forks are excluded. Add the original repository instead.');
        mergeRepositories([data.repository]);
        setSelected(previous => new Set([...previous, data.repository.id]));
        setSearch(data.repository.nameWithOwner);
        setSourceNotice('Repository added. Only your commits will count.');
      }
      setRepoUrl('');
    } catch (value) { if (task.isActive()) { setSourceNotice(''); reportError(value, 'Repositories could not be added.'); } }
    finally { if (task.isCurrent()) { setAddingRepo(false); task.finish(); } }
  }
  async function installPrivate() {
    if (!authenticated || scanning || installing) return;
    const task = operations.current.start('install');
    setInstalling(true); setError('');
    try {
      const data = await api<{ url: string }>('/api/github/install', { body: {}, csrf: session?.csrfToken, signal: task.signal });
      if (task.isActive()) window.location.assign(data.url);
    } catch (value) { if (task.isActive()) reportError(value, 'GitHub setup could not start.'); }
    finally { if (task.isCurrent()) { setInstalling(false); task.finish(); } }
  }
  function resetReport() {
    setOpenFilter(null);
    knownRepositories.current.clear();
    setRepositories([]); setSelected(new Set()); setProgress([]); setCommits([]); setShare(null); setSearch(''); setRepoUrl(''); setSourceNotice(''); setScanMessage('');
  }
  function startSample() {
    stopOperations(); resetReport(); setSample(true); setError('');
    knownRepositories.current = new Set(SAMPLE_REPOSITORIES.map(repo => repo.id));
    setRepositories(SAMPLE_REPOSITORIES); setSelected(new Set(SAMPLE_REPOSITORIES.map(repo => repo.id)));
    setProgress(completeSample); setAsOf(SAMPLE_AS_OF); setCommits(SAMPLE_COMMITS);
    if (cutoff > SAMPLE_AS_OF.slice(0, 10)) { setCutoff(SAMPLE_AS_OF.slice(0, 10)); setCustomDate(true); }
  }
  function exitSample() {
    stopOperations(); resetReport(); setSample(false); setError('');
    if (cutoff > today()) { setCutoff(today()); setCustomDate(true); }
  }
  async function disconnect() {
    const csrf = session?.csrfToken;
    const configured = session?.configured ?? true;
    stopOperations(); inspectionCache.current.clear(); resetReport(); setSample(false); setIncludePrivate(false); setConnectionExpired(false); setError('');
    // Clear local account data immediately, including when remote token revocation fails.
    setSession({ configured, authenticated: false });
    const task = operations.current.start('logout');
    try { await api('/api/auth/logout', { body: {}, csrf, signal: task.signal }); }
    catch (value) {
      if (task.isActive() && !isAuthenticationError(value)) setError(value instanceof ApiError && value.code === 'revoke_failed'
        ? value.message : 'Disconnected here. GitHub token revocation could not be confirmed; you can revoke AI Diff in GitHub Settings → Applications.');
    } finally { task.finish(); }
  }
  async function scan() {
    if (!authenticated || sample || scanning || loadingRepos || addingRepo) return;
    const chosen = repositories.filter(repo => isNonForkRepository(repo) && selected.has(repo.id) && (!repo.isPrivate || includePrivate));
    if (!chosen.length) return;
    setOpenFilter(null);
    const task = operations.current.start('scan');
    const scanStarted = performance.now();
    const snapshotTime = new Date().toISOString();
    setAsOf(snapshotTime); setCommits([]); setError(''); setScanning(true); setScanMessage('Starting your analysis…');
    setProgress(chosen.map(repository => ({ repository, status: 'pending', commits: 0 })));
    try {
      const scanned = await scanRepositories({
        repositories: chosen, userId: session!.user!.id, includePrivate, asOf: snapshotTime,
        signal: task.signal, cache: inspectionCache.current,
        request: (path, body, signal) => api(path, { body, csrf: session?.csrfToken, signal }),
        onUpdate: update => {
          if (!task.isCurrent()) return;
          setCommits(update.commits); setProgress(update.progress); setScanMessage(update.message);
        },
      });
      if (!task.isCurrent()) return;
      // Fork status can change while scanning. Remove only repositories rejected
      // by the current scan, leaving concurrent results and selections intact.
      const retained = new Set(scanned.progress.map(item => item.repository.id));
      const forks = new Set(chosen.filter(repo => !retained.has(repo.id)).map(repo => repo.id));
      if (forks.size) {
        setRepositories(previous => previous.filter(repo => !forks.has(repo.id)));
        setSelected(previous => new Set([...previous].filter(id => !forks.has(id))));
      }
      const partial = scanned.progress.some(item => item.status !== 'complete');
      const incompleteFiles = scanned.progress.some(item => item.status === 'complete' && !!item.message);
      const elapsed = (performance.now() - scanStarted) / 1000;
      const duration = elapsed < 60 ? `${elapsed.toFixed(elapsed < 10 ? 1 : 0)}s` : `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
      setScanMessage(task.signal.aborted ? 'Scan canceled. Results include only the history read so far.' : scanned.error || partial ? 'Scan stopped with partial results. See repository coverage below.' : incompleteFiles ? `History scan finished in ${duration}. Some file checks are incomplete; filtered totals omit those commits.` : `Scan finished in ${duration}.${scanned.reused ? ` ${formatNumber(scanned.reused)} verified commits reused.` : ''}`);
      if (isAuthenticationError(scanned.error)) expireSession();
      else if (scanned.error instanceof ApiError) setError(scanned.error.code === 'rate_limited' ? 'GitHub is still limiting this scan. Try again later; completed file checks can be reused in this tab.' : scanned.error.message);
    } catch (value) {
      if (task.isActive()) setError(value instanceof Error ? value.message : 'Could not finish this scan.');
    } finally {
      if (task.isCurrent()) { setScanning(false); task.finish(); }
    }
  }

  const preview = !authenticated && !sample && progress.length === 0;
  const result = useMemo(() => analyzeCommits(preview ? SAMPLE_COMMITS : commits, sample || preview ? SAMPLE_USER.id : session?.user?.id ?? '', cutoff, preview ? SAMPLE_AS_OF : asOf, preview ? completeSample : progress, { enabled: skipOversized, scope: 'both', excludeLockfiles }), [preview, commits, sample, session, cutoff, asOf, progress, skipOversized, excludeLockfiles]);
  const maxCutoff = sample || preview ? SAMPLE_AS_OF.slice(0, 10) : progress.length ? asOf.slice(0, 10) : today();
  const visibleRepositories = repositories.filter(repo => isNonForkRepository(repo) && (sample || includePrivate || !repo.isPrivate) && repo.nameWithOwner.toLowerCase().includes(search.toLowerCase()));
  const selectedRepositories = repositories.filter(repo => isNonForkRepository(repo) && selected.has(repo.id) && (sample || includePrivate || !repo.isPrivate));
  const selectedCount = selectedRepositories.length;
  const selectionChanged = !sample && !preview && !scanning && progress.length > 0 && (selectedCount !== progress.length || progress.some(item => !selectedRepositories.some(repo => repo.id === item.repository.id)));
  const user = sample || preview ? SAMPLE_USER : session?.user;
  const shareResult = () => {
    if (isShared) { if (sharedResult) setShare(sharedResult); return; }
    if (user) try { setShare(createShareResult(user.login, result, sample || preview)); } catch (value) { reportError(value, 'This result could not be shared.'); }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isAbout || share || document.querySelector('dialog[open]') || !(isShared ? sharedResult : preview || sample || progress.length > 0)) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); shareResult(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [result, user, preview, progress, sample, isAbout, isShared, sharedResult, share]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isAbout || isShared || event.repeat || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      if (event.key === '/' && areSingleKeyShortcutsEnabled() && !isEditingTarget(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && (authenticated || sample) && !scanning) {
        event.preventDefault(); setOpenFilter('repositories'); repositorySearch.current?.focus();
      }
      if (event.key === 'Enter' && !event.altKey && (event.metaKey || event.ctrlKey) && authenticated && !sample && !scanning && selectedCount > 0 && !loadingRepos && !addingRepo && !installing) {
        event.preventDefault(); void scan();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [isAbout, isShared, authenticated, sample, scanning, selectedCount, loadingRepos, addingRepo, installing, selectedRepositories]);
  if (isAbout) return <div className="app-shell"><Header /><About /><Footer /></div>;
  if (isShared) { const aggregate: AnalysisResult | null = sharedResult ? { ...sharedResult, months: [], ratio: sharedResult.before.additions ? sharedResult.after.additions / sharedResult.before.additions : null } : null; return <div className="app-shell"><Header /><main className="shared-page"><div className="shared-intro"><h1>Before and after AI.</h1><p>Lines added through your GitHub commits.</p></div>{aggregate && sharedResult ? <Result result={aggregate} login={sharedResult.login} sample={sharedResult.sample} shared share={() => setShare(sharedResult)} /> : <div className="empty-result"><CircleHelp size={30} /><h2>This result link isn’t valid.</h2><p>It may be incomplete or use an unsupported format.</p></div>}<a href="/" className="button primary shared-cta"><Github size={18} />Compare your history</a></main><Footer />{share && <ShareDialog result={share} publishedShare={published?.publishedShare} close={() => setShare(null)} />}</div>; }
  return <div className="app-shell"><Header /><main>
    <section className="intro"><h1>Before and after AI.</h1><p>Lines added to your GitHub history, split by date.</p></section>
    <div className="workspace">
      <section className="analysis-toolbar" aria-label="Analysis settings">
        {sample || authenticated ? <FilterDropdown
          className="account-filter"
          label={<><Github size={16} aria-hidden="true" /><span className="account-name">{sample ? 'Sample account' : session?.user?.login}</span></>}
          ariaLabel={sample ? 'Sample account options' : `GitHub account ${session?.user?.login}`}
          open={openFilter === 'account'} onOpenChange={open => setOpenFilter(open ? 'account' : null)}
        >
          {sample ? <><div className="account-status">Sample account<HelpTooltip label="About sample data">Explore fictional commits to try the filters and sharing tools.</HelpTooltip></div><button className="button secondary account-action" onClick={exitSample}>Exit sample</button></> : <>
            <div className="account-status"><Check size={14} aria-hidden="true" />Connected<HelpTooltip label="About GitHub access">Read-only access. AI Diff reads commit metadata and line counts.</HelpTooltip></div>
            <button className="button secondary account-action" onClick={() => void disconnect()}><LogOut size={15} aria-hidden="true" />Disconnect</button>
          </>}
        </FilterDropdown> : <div className="connection-controls">
          <a href="/api/auth/github/start" className={`button primary ${!session?.configured ? 'disabled' : ''}`} aria-disabled={!session?.configured} onClick={event => { if (!session?.configured) event.preventDefault(); }}><Github size={16} aria-hidden="true" />{connectionExpired ? 'Reconnect GitHub' : 'Connect GitHub'}</a>
          <HelpTooltip label="About GitHub access">Read-only access. Private repositories are optional.</HelpTooltip>
          <button className="text-button explore-sample" onClick={startSample}>Explore sample</button>
        </div>}

        <div className="filter-date">
          <label className="select-wrap">
            <span className="sr-only">Comparison date</span>
            <select aria-label="Comparison date" value={customDate ? 'custom' : cutoff} onChange={event => {
              setOpenFilter(null);
              if (event.target.value === 'custom') setCustomDate(true);
              else { setCustomDate(false); setCutoff(event.target.value); }
            }}>
              <option value="2025-11-24">Opus 4.5 · Nov 24, 2025</option>
              <option value="2025-09-29">Sonnet 4.5 · Sep 29, 2025</option>
              <option value="custom">My own date</option>
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          {customDate && <label className="custom-date"><span className="sr-only">My AI start date</span><input type="date" aria-label="My AI start date" value={cutoff} max={maxCutoff} min="1970-01-01" onChange={event => { if (comparisonDateAllowed(event.target.value, maxCutoff)) setCutoff(event.target.value); }} /></label>}
          <ComparisonDateHelp />
        </div>

        <FilterDropdown
          className="repository-filter"
          label={<>Repositories <span className="filter-count">{loadingRepos ? '…' : selectedCount}</span></>}
          ariaLabel={`Repositories, ${selectedCount} selected`}
          disabled={!authenticated && !sample}
          open={openFilter === 'repositories'} onOpenChange={open => setOpenFilter(open ? 'repositories' : null)}
          initialFocusRef={repositorySearch}
        >
          <label className="search-wrap"><Search size={15} aria-hidden="true" /><input ref={repositorySearch} aria-keyshortcuts="/" placeholder="Find a repository…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              const option = event.currentTarget.closest('.filter-popover')?.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
              if (option) { event.preventDefault(); option.focus(); }
            }
          }} aria-label="Filter repositories" disabled={scanning} /><kbd>/</kbd></label>
          <div className="repo-controls">
            <div className="repo-selection-status"><span className="small-text" role="status">{loadingRepos ? 'Finding repos…' : `${selectedCount} selected`}</span><HelpTooltip label="About repository selection">Only your authored commits are counted. Forks are excluded.</HelpTooltip></div>
            <div className="repo-bulk-actions">
              <Tooltip label={search ? 'Select matching repositories' : 'Select all repositories'}><button type="button" className="icon-button" aria-label={search ? 'Select matching repositories' : 'Select all repositories'} disabled={scanning || sample || loadingRepos || addingRepo} onClick={() => setSelected(previous => new Set([...previous, ...visibleRepositories.map(repository => repository.id)]))}><ListChecks size={17} aria-hidden="true" /></button></Tooltip>
              <Tooltip label="Clear selection"><button type="button" className="icon-button" aria-label="Clear selection" disabled={scanning || sample || loadingRepos || addingRepo || !selectedCount} onClick={() => setSelected(new Set())}><ListX size={17} aria-hidden="true" /></button></Tooltip>
            </div>
          </div>
          <RepositorySelect repositories={visibleRepositories} selected={selected} disabled={scanning || sample || loadingRepos || addingRepo} loading={loadingRepos} onToggle={(id, checked) => setSelected(previous => {
            const next = new Set(previous);
            if (checked) next.add(id); else next.delete(id);
            return next;
          })} />
          {!sample && <details className="repository-access">
            <summary>Add repositories or private access</summary>
            <div className="repository-source-row"><form className="add-repository" onSubmit={event => void addRepository(event)}>
              <input placeholder="Repository or organization" aria-label="Repository or organization" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} disabled={scanning || loadingRepos || addingRepo} />
              <Tooltip label="Add repository or organization"><button className="icon-button" aria-label={addingRepo ? 'Adding repositories' : 'Add repository or organization'} disabled={!repoUrl.trim() || scanning || loadingRepos || addingRepo}><Plus size={17} aria-hidden="true" /></button></Tooltip>
            </form><HelpTooltip label="How to add repositories">Paste a public GitHub repository URL or an organization name to find more repositories.</HelpTooltip></div>
            {sourceNotice && <p className="source-notice" role="status">{sourceNotice}</p>}
            <div className="setting-toggle private-toggle"><span>Private repositories</span><HelpTooltip label="About private repositories">Choose personal or organization repositories on GitHub. Access is read-only, and your organization may need to approve it.</HelpTooltip><Switch label="Include private repositories" checked={includePrivate} disabled={scanning || loadingRepos || addingRepo || installing} onCheckedChange={checked => { setIncludePrivate(checked); if (checked) void loadRepositories(true); }} /></div>
            {includePrivate && <div className="private-info">
              <button className="text-button" disabled={scanning || installing || loadingRepos || addingRepo} onClick={() => void installPrivate()}>{installing ? 'Opening GitHub…' : 'Choose repositories on GitHub'}</button>
              <button className="text-button" disabled={loadingRepos || scanning || addingRepo || installing} onClick={() => void loadRepositories(true)}>Refresh access</button>
            </div>}
          </details>}
        </FilterDropdown>

        <FilterDropdown
          className="line-filters"
          label={<><SlidersHorizontal size={15} aria-hidden="true" />Filters<span className="filter-count">{Number(excludeLockfiles) + Number(skipOversized)}</span></>}
          ariaLabel="Line-count filters"
          open={openFilter === 'filters'} onOpenChange={open => setOpenFilter(open ? 'filters' : null)}
        >
          <section className="commit-filter-control" aria-label="File filter"><div className="setting-toggle"><span>Exclude lockfiles</span><HelpTooltip label="About the lockfile filter">Removes verified lockfile changes from both periods.</HelpTooltip><Switch label="Exclude lockfiles" checked={excludeLockfiles} onCheckedChange={setExcludeLockfiles} /></div></section>
          <CommitFilterControl enabled={skipOversized} onEnabledChange={setSkipOversized} />
        </FilterDropdown>

        <button className="button primary analyze-action" aria-keyshortcuts="Meta+Enter Control+Enter" title="Analyze selected repositories (⌘/Ctrl + Enter)" disabled={scanning ? false : !authenticated || sample || !selectedCount || loadingRepos || addingRepo || installing} onClick={() => scanning ? operations.current.cancel('scan') : void scan()}>
          {scanning ? <><Square size={14} aria-hidden="true" />Cancel scan</> : <>Analyze<kbd>{modifierLabel} ↵</kbd></>}
        </button>
      </section>
      {!authenticated && !sample && (sessionFailed || (session && !session.configured)) && <div className="connection-note">
        {sessionFailed ? <span>Connection unavailable. <button className="link-button" onClick={() => window.location.reload()}>Retry</button></span> : 'GitHub isn’t configured locally. Explore the sample.'}
      </div>}
      <div className="result-area">
{(error || callbackError) && <div className="error-banner" role="alert"><span>{error || callbackError}{connectionExpired && <> <a href="/api/auth/github/start" className="reconnect-link">Reconnect GitHub</a></>}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => { setError(''); setCallbackError(''); window.history.replaceState({}, '', '/'); }}><X size={16} /></button></div>}{selectionChanged && <p className="selection-notice" role="status">Repository selection changed. Analyze again to update these results.</p>}{scanning && <div className="scan-progress" role="status" aria-live="polite"><span className="spinner" /><div><strong>{scanMessage}</strong><span>{progress.filter(r => r.status === 'complete').length} of {progress.length} repositories complete</span></div></div>}{preview || sample || progress.length > 0 ? <Result result={result} login={user?.login ?? ''} sample={sample || preview} share={shareResult} /> : <div className="empty-result"><h2>Select repositories to begin.</h2><p>Your code stays on GitHub.</p><kbd>{modifierLabel} ↵ to analyze</kbd></div>}{!scanning && scanMessage && <p className="scan-completion" role="status">{scanMessage}</p>}{progress.some(p => p.message) && <details className="coverage-details"><summary>Repository coverage details</summary>{progress.filter(p => p.message).map(p => <p key={p.repository.id}><strong>{p.repository.nameWithOwner}</strong>: {p.message}</p>)}</details>}<p className="result-disclaimer">Unequal time spans. Activity, not AI authorship or productivity. <a href="/about">Methodology</a></p></div></div>
  </main><Footer />{share && <ShareDialog result={share} ownResult close={() => setShare(null)} />}</div>;
}
