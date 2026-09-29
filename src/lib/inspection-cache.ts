import type { CommitRecord } from '../../shared/types';
import { hasCompleteFiles } from '../../shared/file-policy';

/** Tab-local, account-scoped LRU. Fresh authorized history is always read first. */
export class InspectionCache {
  private entries = new Map<string, { commit: CommitRecord; bytes: number }>();
  private bytes = 0;
  private account: string | null = null;
  constructor(private readonly maximumBytes = 16 * 1024 * 1024) {}

  forAccount(account: string | null): void {
    if (account !== this.account) { this.clear(); this.account = account; }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; this.account = null; }

  get(commit: CommitRecord): CommitRecord | undefined {
    if (!this.account || commit.authorId !== this.account) return;
    const cached = this.entries.get(commit.oid);
    if (!cached) return;
    const previous = cached.commit;
    if (previous.additions !== commit.additions || previous.deletions !== commit.deletions ||
      previous.committedDate !== commit.committedDate || previous.parentCount !== commit.parentCount ||
      previous.authorId !== commit.authorId || previous.changedFiles !== commit.changedFiles) return;
    this.entries.delete(commit.oid); this.entries.set(commit.oid, cached);
    // Never reuse an old capability, repository attribution or error.
    return { ...commit, files: previous.files, filesComplete: true, filesError: undefined };
  }

  put(commit: CommitRecord): void {
    if (!this.account || commit.authorId !== this.account || !hasCompleteFiles(commit)) return;
    const bytes = 512 + commit.files!.reduce((size, file) => size + 192 + 2 * (file.filename.length + (file.previousFilename?.length ?? 0)), 0);
    if (bytes > this.maximumBytes) return;
    const existing = this.entries.get(commit.oid);
    if (existing) { this.bytes -= existing.bytes; this.entries.delete(commit.oid); }
    while (this.bytes + bytes > this.maximumBytes && this.entries.size) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
    const inspected: CommitRecord = {
      oid: commit.oid, additions: commit.additions, deletions: commit.deletions, committedDate: commit.committedDate,
      authorId: commit.authorId, parentCount: commit.parentCount, changedFiles: commit.changedFiles,
      files: commit.files, filesComplete: true,
    };
    this.entries.set(commit.oid, { commit: inspected, bytes }); this.bytes += bytes;
  }
}
