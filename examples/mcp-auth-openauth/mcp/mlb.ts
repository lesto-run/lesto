/**
 * A tiny client for the public MLB Stats API (`statsapi.mlb.com`, no auth, no key) — the live
 * data the governed app serves. Each function takes an injectable `fetch` so the app routes can
 * run on Node and on the edge unchanged (and a test could stub it); the shapes here are the few
 * fields the demo needs, parsed defensively against the (large) real responses.
 *
 * This is ordinary domain code behind the MCP server — the point of the example is that an
 * agent reaches it through the SAME OAuth-gated `@lesto/mcp` governance as everything else.
 */

const MLB_API = "https://statsapi.mlb.com/api/v1";

/** MLB's stable division ids → readable names (used to label standings). */
const DIVISIONS: Record<number, string> = {
  200: "AL West",
  201: "AL East",
  202: "AL Central",
  203: "NL West",
  204: "NL East",
  205: "NL Central",
};

/** League code → MLB league id (AL = American, NL = National). */
const LEAGUES: Record<string, number> = { AL: 103, NL: 104 };

/** A player the search matched. */
export interface PlayerHit {
  id: number;
  name: string;
  position: string;
}

/** Search players by (partial) name — e.g. "Bobby Witt" → his id + position. */
export async function searchPlayers(query: string, f: typeof fetch = fetch): Promise<PlayerHit[]> {
  const res = await f(`${MLB_API}/people/search?names=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`MLB player search failed (${res.status})`);

  const body = (await res.json()) as {
    people?: { id: number; fullName: string; primaryPosition?: { abbreviation?: string } }[];
  };

  return (body.people ?? []).map((p) => ({
    id: p.id,
    name: p.fullName,
    position: p.primaryPosition?.abbreviation ?? "—",
  }));
}

/** A player's season hitting line — the headline stats. */
export interface SeasonHitting {
  season: string;
  games: number;
  homeRuns: number;
  rbi: number;
  avg: string;
  ops: string;
  hits: number;
  stolenBases: number;
}

/** One player's regular-season hitting stats for a season, or `undefined` if they have none. */
export async function playerSeasonHitting(
  playerId: number,
  season: string,
  f: typeof fetch = fetch,
): Promise<SeasonHitting | undefined> {
  const res = await f(`${MLB_API}/people/${playerId}/stats?stats=season&season=${season}&group=hitting`);
  if (!res.ok) throw new Error(`MLB player stats failed (${res.status})`);

  const body = (await res.json()) as {
    stats?: { splits?: { stat?: Record<string, unknown> }[] }[];
  };
  const stat = body.stats?.[0]?.splits?.[0]?.stat;
  if (stat === undefined) return undefined;

  const num = (key: string): number => Number(stat[key] ?? 0);
  const str = (key: string): string => String(stat[key] ?? "—");

  return {
    season,
    games: num("gamesPlayed"),
    homeRuns: num("homeRuns"),
    rbi: num("rbi"),
    avg: str("avg"),
    ops: str("ops"),
    hits: num("hits"),
    stolenBases: num("stolenBases"),
  };
}

/** One team's spot in its division. */
export interface TeamStanding {
  rank: number;
  team: string;
  wins: number;
  losses: number;
  gamesBack: string;
}

/** A division's ordered standings. */
export interface DivisionStandings {
  division: string;
  teams: TeamStanding[];
}

/** Regular-season standings for a league (`AL`/`NL`), grouped by division and ranked. */
export async function leagueStandings(
  league: string,
  season: string,
  f: typeof fetch = fetch,
): Promise<DivisionStandings[]> {
  const leagueId = LEAGUES[league.toUpperCase()];
  if (leagueId === undefined) throw new Error(`Unknown league "${league}" (use AL or NL)`);

  const res = await f(
    `${MLB_API}/standings?leagueId=${leagueId}&season=${season}&standingsTypes=regularSeason`,
  );
  if (!res.ok) throw new Error(`MLB standings failed (${res.status})`);

  const body = (await res.json()) as {
    records?: {
      division?: { id?: number };
      teamRecords?: {
        team?: { name?: string };
        wins?: number;
        losses?: number;
        gamesBack?: string;
        divisionRank?: string;
      }[];
    }[];
  };

  return (body.records ?? []).map((record) => ({
    division: DIVISIONS[record.division?.id ?? 0] ?? "Division",
    teams: (record.teamRecords ?? []).map((t) => ({
      rank: Number(t.divisionRank ?? 0),
      team: t.team?.name ?? "?",
      wins: t.wins ?? 0,
      losses: t.losses ?? 0,
      gamesBack: t.gamesBack ?? "-",
    })),
  }));
}
