import './About.css';

export default function About() {
  return (
    <main className="about-page">
      <header className="about-header">
        <h1>About</h1>
        <p>AI Diff compares lines added in your GitHub commits before and after a date you choose.</p>
      </header>

      <article className="about-article" aria-label="AI Diff methodology and privacy">
        <section id="the-numbers" aria-labelledby="numbers-heading">
          <h2 id="numbers-heading">What it measures</h2>
          <p>We count <strong>lines added in commits</strong> you authored, including code, documentation, lockfiles, generated text, and repeated edits. Add a line, delete it, and add it again: both additions count.</p>
          <p>Imported projects, templates, generated files, and lockfiles can inflate additions even when GitHub matches the commit’s primary author to your account. A root commit can add an existing codebase in one step; author matching does not prove that you wrote every line.</p>
          <p>By default, we skip entire commits with more than 100,000 added and deleted lines combined, using the same rule before and after your date. A short notice links to excluded totals and the largest commits. You can turn the filter off without rescanning. Filter options also include a before-only scope, labeled as an unequal filter.</p>
          <p>This is a size heuristic, not file-level filtering. Smaller commits can still contain generated code, and large legitimate commits may be excluded. Shared images and links disclose the filter and exclusion count.</p>
          <p>This measures commit activity. It cannot identify which lines AI wrote, measure code quality, or tell you how productive you were. A smaller number can be a good thing.</p>
        </section>

        <section id="methodology" aria-labelledby="methodology-heading">
          <h2 id="methodology-heading">How we count</h2>
          <p>For each selected repository, we snapshot the default branch’s latest commit and walk its history. Each scan has a fixed end time. A commit counts only when GitHub associates its primary author with your connected account. We exclude merge commits and deduplicate identical commit SHAs across repositories. Forked repositories are excluded entirely.</p>
          <p>Your comparison date divides commits at <strong>midnight UTC</strong>. We use the commit timestamp: earlier commits go in “before,” and commits at or after it go in “after.” You can change the date after a scan without fetching the history again.</p>
          <p>The two periods may be different lengths, so we show their date ranges alongside the totals. The percentage compares total additions, not productivity. Deletions and net change provide more context.</p>
        </section>

        <section id="coverage" aria-labelledby="coverage-heading">
          <h2 id="coverage-heading">Coverage and limitations</h2>
          <p>Results cover <strong>selected GitHub repository history</strong>, not your entire career. Deleted or inaccessible repositories, work outside the default branch, uncommitted work, and old author identities that GitHub cannot connect to your account can be missing. Co-author credits do not count as primary authorship.</p>
          <p>Automatic discovery includes your owned public repositories and repositories GitHub lists as recently contributed to. It does not include every organization you have worked in. Enter an organization’s GitHub handle or URL to load its public repositories, or add a public repository by URL. Archived repositories are included. Forks are excluded from discovery, manual additions, and analysis.</p>
          <p>Private organization repositories require a GitHub App installation with access to the repositories you choose. You also need access through your own GitHub account. Organization owners may need to approve installation, and organization policies or SSO requirements can limit access.</p>
          <p>Every result shows completed, unavailable, and incomplete repositories. A cancelled or interrupted scan is a partial result. Large histories can take longer, and GitHub’s API limits may temporarily pause a scan.</p>
        </section>

        <section id="comparison-date" aria-labelledby="date-heading">
          <h2 id="date-heading">The default date</h2>
          <p>In his <a href="https://lexfridman.com/?p=6512" target="_blank" rel="noopener noreferrer">conversation with Lex Fridman</a>, DHH describes Claude Opus 4.5 as a turning point in how he built software. <a href="https://www.anthropic.com/news/claude-opus-4-5" target="_blank" rel="noopener noreferrer">Opus 4.5 launched on November 24, 2025</a>, which is our default comparison date.</p>
          <p>We also offer <a href="https://www.anthropic.com/news/claude-sonnet-4-5" target="_blank" rel="noopener noreferrer">Sonnet 4.5’s September 29, 2025 release</a> as a preset. You can choose any date. The date is a comparison point, not evidence that you used AI.</p>
        </section>

        <section id="privacy" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading">Privacy and permissions</h2>
          <p>Public repositories work with GitHub sign-in. Private repositories are optional and require installing our read-only GitHub App on repositories you select.</p>
          <p>GitHub’s Contents permission technically allows reading code. AI Diff requests commit metadata and line counts. It does not fetch source files, clone repositories, or send code to an AI model.</p>
          <p>Your GitHub credential is encrypted in an expiring, HttpOnly session cookie. Our server uses it for the requested GitHub reads; client-side JavaScript cannot read it. We do not keep refresh tokens. Disconnecting clears the session and attempts to revoke its GitHub token.</p>
          <p>Analysis data lives in your browser’s memory and passes through the server only to retrieve GitHub responses. We do not save a copy in a database, record commit data in application logs, or include third-party tracking scripts. Reloading starts a new analysis. Only your light/dark preference is saved in local browser storage. GitHub and our hosting provider still process requests to operate their services.</p>
        </section>

        <section id="sharing" aria-labelledby="sharing-heading">
          <h2 id="sharing-heading">Sharing</h2>
          <p>Images are generated in your browser. You can preview, copy, or download one without uploading it. If private repositories contributed, their counts are included in the aggregate totals, but their names are left out.</p>
          <p>A result link contains only the displayed aggregate summary in its URL fragment, the part after <code>#</code>. That fragment is not sent to our server. Anyone with the full link can view and reshare those totals, including private contributions. Keep the link private if you want the totals to stay private.</p>
          <p>A result link preserves the numbers you chose to share. Opening it does not fetch GitHub again, and its contents can be edited. AI Diff does not independently verify shared summaries. Social link previews describe AI Diff; opening the full link displays the result.</p>
        </section>
      </article>

      <footer className="about-footer">
        <p>Built by <a href="https://codewithbeto.dev" target="_blank" rel="noopener noreferrer">Code with Beto</a>. Beto is a software engineer and educator sharing practical lessons on mobile development and AI.</p>
        <a href="https://github.com/Code-with-Beto/ai-diff" target="_blank" rel="noopener noreferrer">View the source on GitHub</a>
      </footer>
    </main>
  );
}
