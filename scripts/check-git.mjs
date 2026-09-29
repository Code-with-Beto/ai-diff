import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeCommits } from '../src/lib/analysis.ts';

const directory = mkdtempSync(join(tmpdir(), 'ai-diff-git-fixture-'));
const git = (args, env = {}) => execFileSync('git', args, {
  cwd: directory, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const record = (file, text, date, author = 'fixture@example.test') => {
  writeFileSync(join(directory, file), text);
  git(['add', file]);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', `Fixture ${file}`], {
    GIT_AUTHOR_NAME: author === 'fixture@example.test' ? 'Fixture Builder' : 'Other Builder',
    GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 'Fixture Builder', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  });
};

try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture Builder']);
  git(['config', 'user.email', 'fixture@example.test']);
  record('main.txt', 'one\ntwo\n', '2019-01-01T12:00:00Z');
  record('package-lock.json', 'dependency\n'.repeat(20), '2025-09-27T12:00:00Z');
  record('main.txt', 'one\ntwo\nthree\nfour\nfive\n', '2025-09-28T23:59:59Z');
  record('other.txt', 'not mine\n', '2025-09-28T23:59:59Z', 'other@example.test');
  record('generated.txt', 'a\nb\nc\nd\n', '2025-09-29T00:00:00Z');
  record('package-lock.json', 'new dependency\n'.repeat(5), '2025-09-29T12:00:00Z');
  git(['checkout', '-b', 'feature']);
  record('feature.txt', 'feature one\nfeature two\n', '2025-09-30T12:00:00Z');
  git(['checkout', 'main']);
  record('main.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n', '2025-09-30T13:00:00Z');
  git(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'Fixture merge'], {
    GIT_AUTHOR_DATE: '2025-09-30T14:00:00Z', GIT_COMMITTER_DATE: '2025-09-30T14:00:00Z',
  });
  record('future.txt', 'future work\n'.repeat(20), '2025-10-02T00:00:00Z');

  const commits = git(['log', '--format=%H|%cI|%ae|%P']).split('\n').map(line => {
    const [oid, committedDate, email, parents] = line.split('|');
    const stats = git(['show', '--format=', '--numstat', '--first-parent', oid]);
    let additions = 0;
    let deletions = 0;
    const files = [];
    for (const row of stats.split('\n').filter(Boolean)) {
      const [added, deleted, filename] = row.split('\t');
      if (added !== '-' && deleted !== '-') { additions += Number(added); deletions += Number(deleted); files.push({filename, status:'modified', additions:Number(added), deletions:Number(deleted)}); }
    }
    return { files, filesComplete: true, changedFiles: files.length, oid, committedDate, additions, deletions, authorId: email === 'fixture@example.test' ? 'fixture' : 'other', parentCount: parents ? parents.split(' ').length : 0 };
  });
  const cutoff = '2025-09-29';
  const asOf = '2025-10-01T12:00:00.000Z';
  const result = analyzeCommits([...commits, ...commits.slice(2, 5)], 'fixture', cutoff, asOf, [{
    repository: { id: 'fixture', nameWithOwner: 'fixture/test', isPrivate: false, isFork: false, isArchived: false, description: null },
    status: 'complete', commits: commits.length,
  }]);

  const totalFromGit = bounds => {
    const rows = git(['log', '--no-merges', '--author=fixture@example.test', '--format=', '--numstat', ...bounds]);
    let additions = 0;
    let deletions = 0;
    for (const row of rows.split('\n').filter(Boolean)) {
      const [added, deleted] = row.split('\t');
      if (added !== '-' && deleted !== '-') { additions += Number(added); deletions += Number(deleted); }
    }
    const count = Number(git(['rev-list', '--count', '--no-merges', '--author=fixture@example.test', ...bounds, 'HEAD']));
    return { additions, deletions, commits: count };
  };
  const before = totalFromGit(['--until=2025-09-28T23:59:59Z']);
  const after = totalFromGit(['--since=2025-09-29T00:00:00Z', `--until=${asOf}`]);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, after);
  assert.equal(result.before.additions, 25);
  assert.equal(result.after.additions, 12);
  assert.equal(result.before.commits + result.after.commits, 7);
  const filtered = analyzeCommits([...commits, ...commits], 'fixture', cutoff, asOf, [{repository: { id:'fixture', nameWithOwner:'fixture/test', isPrivate:false, isFork:false, isArchived:false, description:null }, status:'complete', commits:commits.length}], {excludeLockfiles:true});
  for (const [period,bounds] of [['before',['--until=2025-09-28T23:59:59Z']],['after',['--since=2025-09-29T00:00:00Z',`--until=${asOf}`]]]) {
    const rows=git(['log','--no-merges','--author=fixture@example.test','--format=','--numstat',...bounds,'--','.',':(exclude)package-lock.json']);
    let additions=0,deletions=0;
    for(const row of rows.split('\n').filter(Boolean)){const [added,deleted]=row.split('\t');if(added!=='-'&&deleted!=='-'){additions+=Number(added);deletions+=Number(deleted);}}
    assert.equal(filtered[period].additions, additions);assert.equal(filtered[period].deletions,deletions);
  }
  assert.equal(filtered.before.additions,5);assert.equal(filtered.after.additions,7);
  assert.equal(filtered.fileFilter.excludedBefore.additions,20);assert.equal(filtered.fileFilter.excludedAfter.deletions,20);
  console.log(`Git fixture verified: ${before.additions} additions before; ${after.additions} after. Root, merge exclusion, primary author, UTC cutoff, pagination duplicates and snapshot end match local Git. Lockfile-filtered additions also match Git path exclusions (5 before; 7 after).`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
