/**
 * The demo's content: a handful of luxury listings.
 *
 * In a real app these come from `@keel/content-store` (markdown built into the
 * DB) or the ORM. Here they are an in-memory constant — the example is about
 * the *site shape* (static `/` + dynamic `/mls`, one origin, one session), not
 * the data layer.
 */

export interface Listing {
  readonly id: string;
  readonly title: string;
  readonly neighborhood: string;
  /** Price in whole dollars. */
  readonly price: number;
  readonly beds: number;
  readonly baths: number;
}

export const LISTINGS: readonly Listing[] = [
  {
    id: "bel-air-glen",
    title: "Bel Air Glen Estate",
    neighborhood: "Bel Air",
    price: 42_000_000,
    beds: 7,
    baths: 9,
  },
  {
    id: "malibu-cliff",
    title: "Malibu Cliffside",
    neighborhood: "Malibu",
    price: 28_500_000,
    beds: 5,
    baths: 6,
  },
  {
    id: "bh-flats",
    title: "Beverly Hills Flats",
    neighborhood: "Beverly Hills",
    price: 18_900_000,
    beds: 6,
    baths: 7,
  },
];

/** Find one listing by id, or `undefined`. */
export function findListing(id: string): Listing | undefined {
  return LISTINGS.find((listing) => listing.id === id);
}

/** Format a price the way the marketing copy wants it: `$42,000,000`. */
export function formatPrice(price: number): string {
  return `$${price.toLocaleString("en-US")}`;
}
