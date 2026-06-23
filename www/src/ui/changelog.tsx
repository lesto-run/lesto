/**
 * The changelog UI: every release on one page at `/changelog`, newest first.
 *
 * A changelog is conventionally a single scrollable page rather than a page per
 * release, so this renders all `changelog` entries inline. Each release's body is
 * the HTML `@lesto/content-markdown` produced and sanitized at build time. Shares
 * the global `SiteLayout` chrome and the centered reading frame (Tailwind utilities)
 * + `.prose` typography (custom CSS) with the blog.
 */

import type { ReactElement } from "react";

import type { ChangelogRelease } from "../content";
import { formatDate, LEDE, SHELL, SHELL_H1 } from "./blog";

/** Every release, newest first, each as a version heading + its rendered notes. */
export function ChangelogPage({
  releases,
}: {
  releases: readonly ChangelogRelease[];
}): ReactElement {
  return (
    <main className={SHELL}>
      <h1 className={SHELL_H1}>Changelog</h1>
      <p className={LEDE}>
        Notable changes to Lesto, newest first. Release entries are generated from changesets as
        versions ship; the entries below track what is landing on the road to the first release.
      </p>
      {releases.map((release) => (
        <section className="mb-12" key={release.version}>
          <h2 className="text-[1.4rem] mt-8 mb-2 tracking-[-0.025em] font-semibold">
            {release.version}
            <time className="text-faint text-[0.95rem] font-normal" dateTime={release.date}>
              {" "}
              · {formatDate(release.date)}
            </time>
          </h2>
          {release.title !== undefined ? <p className={LEDE}>{release.title}</p> : null}
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
