import { ArrowUpRight, GitCommitHorizontal, LockKeyhole, Share2 } from 'lucide-react';

export default function About() {
  return (
    <article className="about-page prose">
      <p className="eyebrow">THE STORY BEHIND THE NUMBERS</p>
      <h1>A little perspective<br />on how you build.</h1>
      <p className="about-intro">AI changed the way many of us write software. AI Diff gives you a way to look back at your own GitHub history and see what changed around the date you chose.</p>

      <div className="about-grid">
        <section className="about-card">
          <GitCommitHorizontal size={22} aria-hidden="true" />
          <h2>What the number means</h2>
          <p>We count <strong>lines added in commits</strong> you authored. That includes code, documentation, lockfiles, generated text, and repeated edits. Add a line, delete it, and add it again: both additions count.</p>
          <p>This is a view of your commit activity. It cannot identify which lines AI wrote, measure code quality, or tell you how productive you were. A smaller number can be a very good thing.</p>
        </section>
        <section className="about-card">
          <LockKeyhole size={22} aria-hidden="true" />
          <h2>Your code stays yours</h2>
          <p>Public repositories work with GitHub sign-in. Private repositories are optional and require installing our read-only GitHub App on repositories you select.</p>
          <p>GitHub’s Contents permission technically allows reading code. AI Diff requests commit metadata and line counts; it does not fetch source files, clone repositories, or send code to an AI model.</p>
        </section>
      </div>

      <section>
        <h2>How the comparison works</h2>
        <p>For each selected repository, we snapshot the default branch’s latest commit and walk its history. We count commits whose primary author GitHub associates with your account, exclude merge commits, and count identical commit SHAs only once across repositories.</p>
        <p>Your chosen date is the dividing line at <strong>midnight UTC</strong>. We use the commit timestamp, with everything earlier in “before” and everything at or after it in “after.” Each scan has a fixed end time. You can move the dividing line after a scan without fetching the history again.</p>
        <p>The two periods may be very different lengths. Their dates are always shown alongside their totals. The comparison ratio describes total additions across those periods, not a productivity increase. Deletions and net change provide a little more context.</p>
      </section>

      <section>
        <h2>A useful slice, with some gaps</h2>
        <p>These results cover <strong>selected GitHub repository history</strong>, not your entire career. Deleted or inaccessible repositories, work outside the default branch, uncommitted work, and old author identities that GitHub cannot connect to your account can be missing. Co-author credits do not count as primary authorship.</p>
        <p>Discovery includes your owned public repositories and repositories GitHub lists as recently contributed to. You can add a public repository by URL. Archived repositories are included; forks start unchecked. Organization policies may limit private access even after installation.</p>
        <p>Coverage stays attached to every result: completed, unavailable, and incomplete repositories. A cancelled or interrupted scan is a partial result. Large histories can take longer and GitHub’s API limits may temporarily pause a scan.</p>
      </section>

      <section>
        <h2>Why November 24, 2025?</h2>
        <p>In his <a href="https://lexfridman.com/?p=6512" target="_blank" rel="noopener noreferrer">conversation with Lex Fridman</a>, DHH describes Claude Opus 4.5 as a turning point in how he built software. <a href="https://www.anthropic.com/news/claude-opus-4-5" target="_blank" rel="noopener noreferrer">Opus 4.5 launched on November 24, 2025</a>, so that is our starting date.</p>
        <p>Your turning point may be different. There is also a preset for <a href="https://www.anthropic.com/news/claude-sonnet-4-5" target="_blank" rel="noopener noreferrer">Sonnet 4.5’s September 29, 2025 release</a>, and you can choose any date that makes sense for you. The date is your comparison point; it is not evidence that you used AI.</p>
      </section>

      <section>
        <h2>Privacy, in plain English</h2>
        <p>Your GitHub credential is encrypted in an expiring, HttpOnly session cookie. Our server uses it to make the requested GitHub reads; client-side JavaScript cannot read the credential. We do not keep refresh tokens. Disconnecting clears the session and attempts to revoke its GitHub token.</p>
        <p>Analysis data lives in your browser’s memory and passes through the server only to retrieve GitHub responses. We do not save a copy in a database, record commit data in application logs, or include third-party tracking scripts. Reloading the page starts a new analysis. GitHub and our hosting provider still process requests as part of operating their services.</p>
      </section>

      <section className="about-card">
        <Share2 size={22} aria-hidden="true" />
        <h2>Share the result you choose</h2>
        <p>Images are generated in your browser. You can preview, copy, or download one without uploading it. If private repositories contributed, their counts are included in the aggregate totals, but their names are left out.</p>
        <p>Copying a result link puts only the displayed aggregate summary in the URL fragment, the part after <code>#</code>. That fragment is not sent to our server. Anyone with the full link can view and reshare those totals, including any private contributions. Keep the link private if you want the totals to stay private.</p>
            <p>Shared summaries are editable and unverified. They are a way to share a snapshot, not proof of GitHub activity. Social link previews describe AI Diff; opening the full link displays the result.</p>
      </section>

      <section>
        <p className="eyebrow">BUILT BY CODE WITH BETO</p>
        <h2>Curiosity is a good reason to build.</h2>
        <p>Beto is a software engineer and educator exploring how we build useful software, from React Native and mobile apps to AI. Code with Beto is where he shares practical lessons, experiments, and the things he learns along the way. AI Diff started with a simple question: what does that change look like in our own history?</p>
        <a className="about-link" href="https://codewithbeto.dev" target="_blank" rel="noopener noreferrer">Explore Code with Beto <ArrowUpRight size={17} aria-hidden="true" /></a>
      </section>
    </article>
  );
}
