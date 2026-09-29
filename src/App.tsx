import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, CircleHelp, Code2, Github, GitFork, GitCommitHorizontal, Link2, LockKeyhole, LogOut, Plus, Search, Share2, ShieldCheck, Square, X } from 'lucide-react';
import type { AnalysisResult, CommitRecord, InstallationsPage, Repository, RepositoryPage, RepositoryProgress, ScanPage, ScanStart, SessionInfo, ShareResult } from '../shared/types';
import { ApiError, api, waitForRetry } from './api';
import { analyzeCommits, formatDate, formatNumber } from './lib/analysis';
import { SAMPLE_AS_OF, SAMPLE_COMMITS, SAMPLE_REPOSITORIES, SAMPLE_USER } from './lib/sample';
import { createShareResult, decodeShare } from './lib/share';
import { callbackMessage, comparisonDateAllowed, createOperationScope, isAuthenticationError, normalizeRepositoryUrl } from './lib/client-state';
import About from './components/About';
import MonthlyChart from './components/MonthlyChart';
import ShareDialog from './components/ShareDialog';

const DEFAULT_DATE = '2025-11-24';
const today = () => new Date().toISOString().slice(0, 10);
const completeSample = SAMPLE_REPOSITORIES.map(repository => ({ repository, status: 'complete' as const, commits: 0 }));
function Header({ user, logout }: { user?: string; logout: () => void }) { return <header className="site-header"><a className="brand" href="/" aria-label="AI Diff home"><span className="brand-symbol" aria-hidden="true">−<span>+</span></span><span>AI Diff</span><span className="beta-label">BETA</span></a><nav aria-label="Main navigation"><a href="/about">About the numbers</a>{user ? <button className="user-button" onClick={logout} title="Disconnect GitHub" aria-label={`Disconnect GitHub account ${user}`}><Github size={16} />{user}<LogOut size={14} /></button> : <a className="creator-link" href="https://codewithbeto.dev" target="_blank" rel="noreferrer">by Code with Beto <ArrowUpRight size={13} /></a>}</nav></header>; }
function Footer() { return <footer className="site-footer"><span>Made for the way we build now.</span><a href="https://codewithbeto.dev" target="_blank" rel="noreferrer">Code with Beto <ArrowUpRight size={13} /></a><a href="/about#privacy">Privacy & methodology</a><a href="https://github.com/Code-with-Beto/ai-diff" target="_blank" rel="noreferrer"><Github size={14} aria-hidden="true" />GitHub</a></footer>; }
function Result({ result, login, sample, share, shared = false }: { result: AnalysisResult; login: string; sample: boolean; share: () => void; shared?: boolean }) {
  const all = result.before.additions + result.after.additions;
  const afterPercent = all ? Math.round(result.after.additions / all * 100) : 0;
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  const previousDay = new Date(new Date(result.cutoff + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const beforeRange = result.firstCommitAt && result.firstCommitAt.slice(0, 10) < result.cutoff
    ? `${formatDate(result.firstCommitAt)} – ${formatDate(previousDay)}` : `Before ${formatDate(result.cutoff)}`;
  const net = all - result.before.deletions - result.after.deletions;

  return <section className="results" aria-labelledby="result-title">
    <div className="result-topline">
      <div className="identity">
        <span className="avatar-placeholder"><Github size={20} aria-hidden="true" /></span>
        <div><h2 id="result-title">@{login}</h2><span>Selected GitHub repository history</span></div>
      </div>
      <button className="button secondary share-result" onClick={share} title="Share result (⌘/Ctrl + Shift + S)" aria-keyshortcuts="Meta+Shift+S Control+Shift+S"><Share2 size={16} aria-hidden="true" />Share result</button>
    </div>
    <div className="result-summary">
      <div className="result-context"><span className={`status-pill ${sample ? 'sample' : ''}`}>{sample ? 'Sample data' : shared ? 'Shared result' : partial ? 'Partial result' : 'Your result'}</span><span>Turning point <strong>{formatDate(result.cutoff)}</strong></span></div>
      <div className="numbers-grid">
        <div className="number-cell before">
          <span className="metric-label"><span className="metric-sign" aria-hidden="true">−</span>Before AI</span>
          <strong className={String(result.before.additions).length > 9 ? 'long-number' : undefined} style={{ fontSize: `min(60px, ${Math.min(22, 160 / formatNumber(result.before.additions).length)}cqi)` }}>{formatNumber(result.before.additions)}</strong><span className="metric-unit">lines added</span><p>{beforeRange}</p>
        </div>
        <div className="number-cell after">
          <span className="metric-label"><span className="metric-sign" aria-hidden="true">+</span>After AI</span>
          <strong className={String(result.after.additions).length > 9 ? 'long-number' : undefined} style={{ fontSize: `min(60px, ${Math.min(22, 160 / formatNumber(result.after.additions).length)}cqi)` }}>{formatNumber(result.after.additions)}</strong><span className="metric-unit">lines added</span><p>{formatDate(result.cutoff)} – {formatDate(result.asOf)}</p>
        </div>
      </div>
      <div className="comparison-track" aria-label={`${afterPercent}% of counted lines were added on or after the cutoff`}><span style={{ width: `${100 - afterPercent}%` }} /><span style={{ width: `${afterPercent}%` }} /></div>
      <div className="comparison-insight">
        {result.ratio !== null ? <><span className="ratio-value">{result.ratio.toLocaleString('en-US', { maximumFractionDigits: 2 })}×</span><div><p>as many lines added after your turning point</p><span>Different time spans. Activity, not productivity.</span></div></> : <div><p>{result.after.additions > 0 ? 'No added-line baseline before your turning point.' : 'Your history, on either side of a turning point.'}</p><span>Activity around a date, not a measure of productivity.</span></div>}
      </div>
    </div>
    {result.months.length > 0 && <MonthlyChart months={result.months} cutoff={result.cutoff} />}
    <div className="secondary-stats">
      <div><span>Commits counted</span><strong>{formatNumber(result.before.commits + result.after.commits)}</strong></div>
      <div><span>Lines deleted</span><strong>{formatNumber(result.before.deletions + result.after.deletions)}</strong></div>
      <div><span>Net change</span><strong>{net >= 0 ? '+' : ''}{formatNumber(net)}</strong></div>
    </div>
    <div className="result-bottom">
      <div className="coverage-line"><ShieldCheck size={18} aria-hidden="true" /><div><p><strong>{result.coverage.completed} of {result.coverage.total}</strong> repositories complete</p><span>{result.includesPrivate ? 'Includes private aggregate totals' : 'Public repository history'}{partial && ' · Partial result'}</span></div><span className={`coverage-status ${partial ? 'partial' : ''}`}>{partial ? 'Partial coverage' : result.coverage.completed === result.coverage.total ? 'Scan complete' : 'Scan in progress'}</span></div>
      {partial && <p className="partial-note">{result.coverage.unavailable} unavailable · {result.coverage.incomplete} incomplete. These totals are partial.</p>}
      <p className="small-text">Includes docs, lockfiles, generated files, and repeated edits. <a href="/about">How we count <ArrowUpRight size={12} aria-hidden="true" /></a></p>
    </div>
  </section>;
}
export default function App() {
  const isAbout = window.location.pathname === '/about', isShared = window.location.pathname === '/share';
  const [session, setSession] = useState<SessionInfo | null>(null), [sessionFailed, setSessionFailed] = useState(false);
  const [connectionExpired, setConnectionExpired] = useState(false);
  const [cutoff, setCutoff] = useState(DEFAULT_DATE), [customDate, setCustomDate] = useState(false);
  const [sample, setSample] = useState(false), [repositories, setRepositories] = useState<Repository[]>([]), [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingRepos, setLoadingRepos] = useState(false), [addingRepo, setAddingRepo] = useState(false), [installing, setInstalling] = useState(false);
  const [search, setSearch] = useState(''), [repoUrl, setRepoUrl] = useState('');
  const [includePrivate, setIncludePrivate] = useState(() => new URLSearchParams(window.location.search).get('private') === 'connected' || new URLSearchParams(window.location.search).get('auth') === 'installation_failed');
  const [commits, setCommits] = useState<CommitRecord[]>([]), [progress, setProgress] = useState<RepositoryProgress[]>([]), [asOf, setAsOf] = useState(new Date().toISOString());
  const [scanning, setScanning] = useState(false), [scanMessage, setScanMessage] = useState(''), [error, setError] = useState('');
  const [callbackError, setCallbackError] = useState(() => callbackMessage(window.location.search));
  const [share, setShare] = useState<ShareResult | null>(null), [sharedResult, setSharedResult] = useState(() => isShared ? decodeShare(window.location.hash) : null);
  const operations = useRef(createOperationScope());
  const knownRepositories = useRef(new Set<string>());
  const authenticated = !!session?.authenticated;

  useEffect(() => () => operations.current.invalidateAll(), []);
  useEffect(() => {
    if (!isShared) return;
    const changed = () => { setShare(null); setSharedResult(decodeShare(window.location.hash)); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [isShared]);
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
  function mergeRepositories(items: Repository[]) {
    const newIds = items.filter(repo => !knownRepositories.current.has(repo.id) && !repo.isFork).map(repo => repo.id);
    items.forEach(repo => knownRepositories.current.add(repo.id));
    setRepositories(previous => {
      const map = new Map(previous.map(repo => [repo.id, repo]));
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
    setAddingRepo(true); setError('');
    try {
      const data = await api<{ repository: Repository }>('/api/github/repository', { body: { url: normalizeRepositoryUrl(repoUrl) }, csrf: session?.csrfToken, signal: task.signal });
      if (!task.isActive()) return;
      mergeRepositories([data.repository]);
      // An explicitly added fork is intentional, unlike forks discovered automatically.
      setSelected(previous => new Set([...previous, data.repository.id]));
      setRepoUrl('');
    } catch (value) { if (task.isActive()) reportError(value, 'Repository could not be added.'); }
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
    knownRepositories.current.clear();
    setRepositories([]); setSelected(new Set()); setProgress([]); setCommits([]); setShare(null); setSearch(''); setRepoUrl(''); setScanMessage('');
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
    stopOperations(); resetReport(); setSample(false); setIncludePrivate(false); setConnectionExpired(false); setError('');
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
    const chosen = repositories.filter(repo => selected.has(repo.id) && (!repo.isPrivate || includePrivate));
    if (!chosen.length) return;
    const task = operations.current.start('scan');
    const snapshotTime = new Date().toISOString();
    setAsOf(snapshotTime); setCommits([]); setError(''); setScanning(true); setScanMessage('Starting your analysis…');
    let states: RepositoryProgress[] = chosen.map(repository => ({ repository, status: 'pending', commits: 0 }));
    setProgress([...states]);
    let allCommits: CommitRecord[] = [];
    let interrupted = false;
    function update(index: number, patch: Partial<RepositoryProgress>) {
      if (!task.isCurrent()) return;
      states[index] = { ...states[index], ...patch }; setProgress([...states]);
    }
    async function request<T>(path: string, body: unknown): Promise<T> {
      for (;;) {
        if (!task.isActive()) throw new DOMException('Aborted', 'AbortError');
        try { return await api<T>(path, { body, csrf: session?.csrfToken, signal: task.signal }); }
        catch (value) {
          if (!task.isActive()) throw value;
          if (value instanceof ApiError && value.code === 'rate_limited' && value.retryAfter && value.retryAfter > 0) {
            const delay = Math.min(value.retryAfter, 3600) * 1000;
            setScanMessage(`GitHub needs a pause. Continuing after ${new Date(Date.now() + delay).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You can cancel anytime.`);
            await waitForRetry(delay, task.signal);
          } else throw value;
        }
      }
    }
    try {
      for (let index = 0; index < chosen.length; index++) {
        if (!task.isActive()) break;
        const repo = chosen[index]; update(index, { status: 'scanning' }); setScanMessage(`Reading ${repo.nameWithOwner}`);
        try {
          const start = await request<ScanStart>('/api/scan/start', { repositoryId: repo.id, includePrivate, asOf: snapshotTime });
          if (!task.isActive()) break;
          update(index, { repository: start.repository });
          let handle = start.handle;
          while (handle && task.isActive()) {
            const page = await request<ScanPage>('/api/scan/page', { handle });
            if (!task.isActive()) break;
            allCommits = allCommits.concat(page.commits); setCommits([...allCommits]);
            update(index, { commits: states[index].commits + page.commits.length });
            handle = page.nextHandle;
            setScanMessage(`Reading ${repo.nameWithOwner} · ${formatNumber(allCommits.length)} commits received`);
            if (handle && page.remaining <= 10) {
              const delay = Math.max(1000, Math.min(3600000, new Date(page.resetAt).getTime() - Date.now() + 1000));
              setScanMessage(`GitHub rate limit reached. Analysis resumes at ${new Date(Date.now() + delay).toLocaleTimeString()}.`);
              await waitForRetry(delay, task.signal);
            }
          }
          if (task.isActive()) update(index, { status: 'complete' });
        } catch (value) {
          if (!task.isActive()) break;
          const message = value instanceof Error ? value.message : 'Could not finish this repository.';
          update(index, { status: states[index].commits ? 'incomplete' : 'unavailable', message });
          if (isAuthenticationError(value)) { interrupted = true; expireSession(); break; }
          if (value instanceof ApiError && value.code === 'invalid_scan') { interrupted = true; setError('This scan expired. Start a new scan to continue.'); break; }
        }
      }
    } finally {
      if (task.isCurrent()) {
        states = states.map(item => item.status === 'pending' || item.status === 'scanning' ? { ...item, status: 'incomplete' } : item);
        setProgress([...states]); setScanning(false);
        const partial = states.some(item => item.status !== 'complete');
        setScanMessage(task.signal.aborted ? 'Scan canceled. Results include only the history read so far.' : interrupted || partial ? 'Scan stopped with partial results. See repository coverage below.' : 'Scan finished.');
        task.finish();
      }
    }
  }
  const preview = !authenticated && !sample && progress.length === 0;
  const result = useMemo(() => analyzeCommits(preview ? SAMPLE_COMMITS : commits, sample || preview ? SAMPLE_USER.id : session?.user?.id ?? '', cutoff, preview ? SAMPLE_AS_OF : asOf, preview ? completeSample : progress), [preview, commits, sample, session, cutoff, asOf, progress]);
  const maxCutoff = sample || preview ? SAMPLE_AS_OF.slice(0, 10) : progress.length ? asOf.slice(0, 10) : today();
  const visibleRepositories = repositories.filter(repo => (sample || includePrivate || !repo.isPrivate) && repo.nameWithOwner.toLowerCase().includes(search.toLowerCase()));
  const selectedRepositories = repositories.filter(repo => selected.has(repo.id) && (sample || includePrivate || !repo.isPrivate));
  const selectedCount = selectedRepositories.length;
  const selectionChanged = !sample && !preview && !scanning && progress.length > 0 && (selectedCount !== progress.length || progress.some(item => !selectedRepositories.some(repo => repo.id === item.repository.id)));
  const user = sample || preview ? SAMPLE_USER : session?.user;
  const shareResult = () => {
    if (isShared) { if (sharedResult) setShare(sharedResult); return; }
    if (user) try { setShare(createShareResult(user.login, result, sample || preview)); } catch (value) { reportError(value, 'This result could not be shared.'); }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isAbout || share || !(isShared ? sharedResult : preview || sample || progress.length > 0)) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); shareResult(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [result, user, preview, progress, sample, isAbout, isShared, sharedResult, share]);
  if (isAbout) return <div className="app-shell"><Header logout={() => {}} /><About /><Footer /></div>;
  if (isShared) { const aggregate: AnalysisResult | null = sharedResult ? { ...sharedResult, months: [], ratio: sharedResult.before.additions ? sharedResult.after.additions / sharedResult.before.additions : null } : null; return <div className="app-shell"><Header logout={() => {}} /><main className="shared-page"><div className="shared-intro"><span className="eyebrow">A TURNING POINT, IN NUMBERS</span><h1>Your code has a before and after.</h1><p>Shared aggregate numbers. Self-reported and editable, not independently verified.</p></div>{aggregate && sharedResult ? <Result result={aggregate} login={sharedResult.login} sample={sharedResult.sample} shared share={() => setShare(sharedResult)} /> : <div className="empty-result"><CircleHelp size={30} /><h2>This result link isn’t valid.</h2><p>It may be incomplete or use an unsupported format.</p></div>}<a href="/" className="button primary shared-cta"><Github size={18} />Find your own turning point</a></main><Footer />{share && <ShareDialog result={share} close={() => setShare(null)} />}</div>; }
  return <div className="app-shell"><Header user={authenticated ? session?.user?.login : undefined} logout={() => void disconnect()} /><main>
    <section className="intro"><div className="intro-heading"><div className="eyebrow"><span className="tiny-plus" aria-hidden="true">+</span> A TURNING POINT, IN NUMBERS</div><h1>Your code.<br /><span>Before and after <em>AI.</em></span></h1></div><div className="intro-description"><p>Same developer. Different era.<br /> See the shift in your GitHub history.</p><span><span className="live-dot" aria-hidden="true" />Free to use. Open source. Yours to explore.</span></div></section>
    <div className="workspace"><aside className="setup-panel" aria-label="Analysis settings"><div className="connection-settings"><div className="panel-step"><span>01</span><h2>Your GitHub</h2></div>
      {sample ? <div className="sample-account"><span className="status-pill sample">SAMPLE MODE</span><p>Four fictional repositories. Change the date to explore. These aren’t your numbers.</p><button className="text-button" onClick={exitSample}>Exit sample</button></div> : authenticated ? <div className="connected-account"><Github size={22} /><div><strong>{session?.user?.login}</strong><span><Check size={12} />Connected</span></div></div> : <><a href="/api/auth/github/start" className={`button primary connect-button ${!session?.configured ? 'disabled' : ''}`} aria-disabled={!session?.configured} onClick={e => { if (!session?.configured) e.preventDefault(); }}><Github size={18} />{connectionExpired ? 'Reconnect GitHub' : 'Connect GitHub'}</a><p className="permission-note"><ShieldCheck size={14} />Read-only. Public repos first.</p>{session && !session.configured && <p className="setup-notice">GitHub connection is being set up. Explore the sample while it’s getting ready.</p>}{sessionFailed && <p className="setup-notice">Connection unavailable. <button className="text-button" onClick={() => window.location.reload()}>Retry</button></p>}<button className="sample-button" onClick={startSample}>Try a sample first <span>↗</span></button></>}
      </div><div className="setting-section date-settings"><div className="panel-step"><span>02</span><h2>Your turning point</h2></div><p className="setting-description">When did AI change how you code?</p><label className="select-wrap"><span className="sr-only">AI start date preset</span><select value={customDate ? 'custom' : cutoff} onChange={e => { if (e.target.value === 'custom') setCustomDate(true); else { setCustomDate(false); setCutoff(e.target.value); } }}><option value="2025-11-24">Claude Opus 4.5</option><option value="2025-09-29">Claude Sonnet 4.5</option><option value="custom">My own date</option></select><ChevronDown size={16} /></label>{customDate ? <label className="date-label">My AI start date<input type="date" value={cutoff} max={maxCutoff} min="1970-01-01" onChange={e => { if (comparisonDateAllowed(e.target.value, maxCutoff)) setCutoff(e.target.value); }} /></label> : <p className="date-caption">{formatDate(cutoff)}<span>00:00 UTC</span></p>}<p className="setting-tip">Your date, your story. Change it anytime.</p></div>
      <div className="setting-section repo-settings"><div className="panel-step"><span>03</span><h2>Your repositories</h2></div>{authenticated || sample ? <><div className="repo-heading"><span>{sample ? '4 sample repositories' : `${selectedCount} selected`}</span>{loadingRepos && <span className="loading-label">Finding repos…</span>}</div><label className="search-wrap"><Search size={14} /><input placeholder="Find a repository…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Filter repositories" disabled={scanning} /></label><div className="repo-controls"><button className="text-button" disabled={scanning || sample || loadingRepos || addingRepo} onClick={() => setSelected(previous => new Set([...previous, ...visibleRepositories.map(r => r.id)]))}>Select all</button><button className="text-button" disabled={scanning || sample || loadingRepos || addingRepo} onClick={() => setSelected(new Set())}>Clear</button></div><div className="repository-list">{visibleRepositories.map(repo => <label key={repo.id} className="repository-option"><input type="checkbox" checked={selected.has(repo.id)} disabled={scanning || sample || loadingRepos || addingRepo} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(repo.id); else next.delete(repo.id); return next; })} /><span title={repo.nameWithOwner}><span className="repo-owner">{repo.nameWithOwner.split('/')[0]}/</span>{repo.nameWithOwner.split('/').slice(1).join('/')}{repo.isArchived && <small>Archived</small>}</span>{repo.isPrivate ? <LockKeyhole size={13} /> : repo.isFork ? <GitFork size={13} /> : null}</label>)}{!visibleRepositories.length && <p className="small-text">{loadingRepos ? 'Looking through your GitHub…' : 'No repositories found. Try another search or add a public repository.'}</p>}</div>{!sample && <><form className="add-repository" onSubmit={e => void addRepository(e)}><input placeholder="github.com/owner/repo" aria-label="Public repository URL" value={repoUrl} onChange={e => setRepoUrl(e.target.value)} disabled={scanning || loadingRepos || addingRepo} /><button className="icon-button" aria-label={addingRepo ? 'Adding repository' : 'Add public repository'} disabled={!repoUrl.trim() || scanning || loadingRepos || addingRepo}><Plus size={17} /></button></form><label className="private-toggle"><input type="checkbox" checked={includePrivate} disabled={scanning || loadingRepos || addingRepo || installing} onChange={e => { setIncludePrivate(e.target.checked); if (e.target.checked) void loadRepositories(true); }} /><span>Include private repositories</span><LockKeyhole size={13} /></label>{includePrivate && <div className="private-info"><p>You choose which repositories AI Diff can read. We request line counts and commit metadata.</p><button className="text-button" disabled={scanning || installing || loadingRepos || addingRepo} onClick={() => void installPrivate()}>{installing ? 'Opening GitHub…' : 'Choose private repositories on GitHub'}</button><button className="text-button" disabled={loadingRepos || scanning || addingRepo || installing} onClick={() => void loadRepositories(true)}>Refresh access</button></div>}<button className="button primary scan-button" disabled={scanning ? false : !selectedCount || loadingRepos || addingRepo || installing} onClick={() => scanning ? operations.current.cancel('scan') : void scan()}>{scanning ? <><Square size={14} />Cancel scan</> : <><GitCommitHorizontal size={17} />Analyze my history</>}</button></>}</> : <div className="repos-placeholder"><Code2 size={18} /><p>Connect to choose your repositories.<span>Private repos are always optional.</span></p></div>}</div>
      <a className="methodology-link" href="/about"><CircleHelp size={14} />What do these numbers mean?</a>
    </aside><div className="result-area">{(error || callbackError) && <div className="error-banner" role="alert"><span>{error || callbackError}{connectionExpired && <> <a href="/api/auth/github/start" className="reconnect-link">Reconnect GitHub</a></>}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => { setError(''); setCallbackError(''); window.history.replaceState({}, '', '/'); }}><X size={16} /></button></div>}{selectionChanged && <p className="selection-notice" role="status">Repository selection changed. Analyze again to update these results.</p>}{scanning && <div className="scan-progress" role="status" aria-live="polite"><span className="spinner" /><div><strong>{scanMessage}</strong><span>{progress.filter(r => r.status === 'complete').length} of {progress.length} repositories complete</span></div></div>}{preview || sample || progress.length > 0 ? <Result result={result} login={user?.login ?? ''} sample={sample || preview} share={shareResult} /> : <div className="empty-result"><GitCommitHorizontal size={36} /><span className="eyebrow">YOUR NEXT CHAPTER</span><h2>Let’s find your turning point.</h2><p>Choose your repositories, then analyze your history.<br />Your code stays on GitHub.</p><div className="empty-code"><span>− before: ?</span><span>+ after: ?</span></div></div>}{!scanning && scanMessage && <p className="scan-completion" role="status">{scanMessage}</p>}{progress.some(p => p.message) && <details className="coverage-details"><summary>Repository coverage details</summary>{progress.filter(p => p.message).map(p => <p key={p.repository.id}><strong>{p.repository.nameWithOwner}</strong>: {p.message}</p>)}</details>}<p className="result-disclaimer"><CircleHelp size={14} aria-hidden="true" /><span>Git history shows what changed, not who or what wrote it. <a href="/about">Read the methodology</a></span></p></div></div>
  </main><Footer />{share && <ShareDialog result={share} close={() => setShare(null)} />}</div>;
}
