/**
 * The changelog UI: every release on one page at `/changelog`, newest first.
 *
 * A changelog is conventionally a single scrollable page rather than a page per
 * release, so this renders all `changelog` entries inline. Each release's body is
 * the HTML `@lesto/content-markdown` produced and sanitized at build time. Shares
 * the global `SiteLayout` chrome and the centered `.prose-shell` frame with the
 * blog.
 */

import type { ReactElement } from "react";

import type { ChangelogRelease } from "../content";
import { formatDate } from "./blog";

/** Every release, newest first, each as a version heading + its rendered notes. */
export function ChangelogPage({ releases }: { releases: readonly ChangelogRelease[] }): ReactElement {
  return (
    <main className="prose-shell">
      <h1>Changelog</h1>
      <p className="prose-lede">
        Notable changes to Lesto, newest first. Release entries are generated from changesets as
        versions ship; the entries below track what is landing on the road to the first release.
      </p>
      {releases.map((release) => (
        <section className="changelog-release" key={release.version}>
          <h2>
            {release.version}
            <time dateTime={release.date}> · {formatDate(release.date)}</time>
          </h2>
          {release.title !== undefined ? <p className="prose-lede">{release.title}</p> : null}
          {/* release.html is sanitized by the content-markdown render pass at build time. */}
          <article className="prose" dangerouslySetInnerHTML={{ __html: release.html }} />
        </section>
      ))}
    </main>
  );
}

/** Bind the release list into a zero-prop page component for static registration. */
export function makeChangelog(releases: readonly ChangelogRelease[]): () => ReactElement {
  return function BoundChangelog(): ReactElement {
    return <ChangelogPage releases={releases} />;
  };
}
