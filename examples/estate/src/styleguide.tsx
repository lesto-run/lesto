/**
 * `/styleguide` — the estate design system as a living gallery.
 *
 * A static, prerendered page (no islands) that renders every primitive in
 * `ui/components.tsx` against the `ui/styles.ts` tokens, so the playground has one
 * place to see the whole visual language and a worked example of composing the
 * component library into a real page.
 */

import type { ReactNode } from "react";

import {
  Badge,
  Button,
  Hero,
  ListingGrid,
  Main,
  Section,
  SignInPanel,
  SiteHeader,
  Swatch,
} from "./ui/components";

/** The brand palette, surfaced as named swatches. */
const PALETTE: ReadonlyArray<{ name: string; color: string }> = [
  { name: "Ink", color: "#1a1a1a" },
  { name: "Muted", color: "#555555" },
  { name: "Accent", color: "#1f6feb" },
  { name: "Line", color: "#eeeeee" },
];

export function StyleGuidePage(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Style Guide"
          sub="The estate design system — one living gallery of every primitive."
        />

        <Section title="Color">
          {PALETTE.map((token) => (
            <span key={token.name} style={{ marginRight: "1rem" }}>
              <Swatch color={token.color} name={`${token.name} ${token.color}`} />
            </span>
          ))}
        </Section>

        <Section title="Typography">
          <h1>Heading 1</h1>
          <h2>Heading 2</h2>
          <p>Body text — the default paragraph voice.</p>
          <p className="copy">Muted copy — used for supporting prose in a constrained measure.</p>
        </Section>

        <Section title="Buttons">
          <Button href="/mls">Solid link</Button>{" "}
          <Button variant="ghost" href="/about">
            Ghost link
          </Button>{" "}
          <Button>Solid button</Button>
        </Section>

        <Section title="Badges">
          <Badge>new</Badge> <Badge>beta</Badge> <Badge>luxury</Badge>
        </Section>

        <Section title="Listing card">
          <ListingGrid />
        </Section>

        <Section title="Sign-in panel">
          <SignInPanel signedIn={false} demoEmail="jade@example.com" demoPassword="demo" />
        </Section>
      </Main>
    </>
  );
}
