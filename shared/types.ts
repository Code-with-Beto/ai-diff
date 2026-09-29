export interface Viewer { id: string; login: string; avatarUrl: string }
export interface SessionInfo { configured: boolean; authenticated: boolean; user?: Viewer; csrfToken?: string; expiresAt?: number }
export interface Repository { id: string; nameWithOwner: string; isPrivate: boolean; isFork: boolean; isArchived: boolean; description: string | null }
export interface CommitFile { filename: string; previousFilename?: string; status: string; additions: number; deletions: number }
export interface CommitRecord { oid: string; additions: number; deletions: number; committedDate: string; authorId: string | null; parentCount: number; headline?: string; changedFiles?: number | null; filesHandle?: string; repository?: Pick<Repository, 'id' | 'nameWithOwner' | 'isPrivate'>; files?: CommitFile[]; filesComplete?: boolean; filesError?: string }
export interface AnalyzedCommit extends CommitRecord { countedAdditions: number; countedDeletions: number; lockfileAdditions: number; lockfileDeletions: number; exclusion: 'files_unavailable' | 'oversized' | null }
export interface RepositoryPage { repositories: Repository[]; cursor: string | null; hasNextPage: boolean }
export interface Installation { id: number; login: string }
export interface InstallationsPage { installations: Installation[]; nextPage: number | null }
export interface ScanStart { handle: string | null; repository: Repository; empty: boolean }
export interface ScanPage { commits: CommitRecord[]; nextHandle: string | null; remaining: number; resetAt: string }
export interface FileScanPage { oid: string; files: CommitFile[]; nextHandle: string | null; complete: boolean; remaining: number; resetAt: string }
export type RepositoryStatus = 'pending' | 'scanning' | 'complete' | 'unavailable' | 'incomplete';
export interface RepositoryProgress { repository: Repository; status: RepositoryStatus; commits: number; message?: string }
export interface Totals { additions: number; deletions: number; commits: number }
export interface MonthTotal { month: string; before: number; after: number }
export interface Coverage { completed: number; unavailable: number; incomplete: number; total: number }
export interface CommitFilterSummary { enabled: boolean; threshold: number; scope: 'both' | 'before'; excludedBefore: Totals; excludedAfter: Totals }
export interface LineTotals { additions: number; deletions: number }
export interface FileFilterSummary { enabled: boolean; excludedBefore: LineTotals; excludedAfter: LineTotals; inspectedCommits: number; uninspectedBefore: Totals; uninspectedAfter: Totals }
export interface AnalysisResult { before: Totals; after: Totals; months: MonthTotal[]; firstCommitAt: string | null; cutoff: string; asOf: string; coverage: Coverage; includesPrivate: boolean; ratio: number | null; commitFilter?: CommitFilterSummary; oversizedCommits?: CommitRecord[]; fileFilter?: FileFilterSummary; details?: AnalyzedCommit[] }
export interface ShareResult { version: 1; login: string; cutoff: string; asOf: string; firstCommitAt: string | null; before: Totals; after: Totals; coverage: Coverage; includesPrivate: boolean; sample: boolean; commitFilter?: CommitFilterSummary; fileFilter?: FileFilterSummary }
export interface ApiErrorBody { error: { code: string; message: string; retryAfter?: number } }
