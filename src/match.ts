import { API_PREFIX, badRequest, type Parsed } from "./routes";
import {
  fetchTmdbSearch,
  trimMovie,
  type RawMovie,
  type TmdbMovie,
} from "./tmdb";

/**
 * Films per call. On Workers Free a request gets 50 subrequests, and cache
 * reads and writes count: a batch of 15 is 15 cache reads, up to 15 TMDB
 * searches and 15 cache writes, plus one fetch of Google's signing keys.
 */
export const MAX_BATCH = 15;

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_BYTES = 16 * 1024;

/** How many TMDB searches run at once; a Worker gets six connections. */
const CONCURRENCY = 6;

/** How long a match is kept, in seconds. A found film doesn't move. */
const FOUND_TTL = 7 * 24 * 60 * 60;
/** Shorter for a miss, which a new TMDB entry could turn into a match. */
const MISSING_TTL = 24 * 60 * 60;

/** A film named by an import, as Letterboxd names it. */
export type MatchFilm = { title: string; year?: number };

export type MatchResponse = { results: (TmdbMovie | null)[] };

/**
 * `{ "films": [{ "title": "…", "year": 2001 }, …] }`, 1–15 of them. Letterboxd
 * gives every film a year; a file from elsewhere might not.
 */
export async function parseMatchBody(
  request: Request,
): Promise<Parsed<MatchFilm[]>> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BODY_BYTES) return badRequest("Body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return badRequest("Body too large");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return badRequest("Body must be JSON");
  }
  const films = (body as { films?: unknown })?.films;
  if (!Array.isArray(films) || films.length < 1 || films.length > MAX_BATCH) {
    return badRequest(`films must be an array of 1-${MAX_BATCH}`);
  }

  const parsed: MatchFilm[] = [];
  for (const film of films) {
    const title =
      typeof film?.title === "string"
        ? film.title.trim().replace(/\s+/g, " ")
        : "";
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
      return badRequest(`each title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    const year = film.year;
    if (
      year !== undefined &&
      !(Number.isInteger(year) && year >= 1870 && year <= 2100)
    ) {
      return badRequest("each year must be a whole year");
    }
    parsed.push({ title, ...(year !== undefined && { year }) });
  }
  return { ok: true, value: parsed };
}

/**
 * A title reduced to what two spellings of it share: case, accents,
 * punctuation and "&" for "and" all fold away. "Amélie" is "amelie", and
 * "Lock, Stock & Two Smoking Barrels" matches "Lock Stock and Two…".
 */
export function normaliseTitle(title: string) {
  return (
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      // Letters and digits in any script: "千と千尋の神隠し" must survive.
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}

function releaseYear(result: RawMovie) {
  const year = result.release_date?.match(/^(\d{4})-/)?.[1];
  return year ? Number(year) : undefined;
}

/**
 * The film TMDB's results name, or nothing. Strict, because a wrong film
 * added silently is worse than one the reader has to search for:
 *
 * - a result whose title or original title matches, in TMDB's order, which
 *   puts the best-known first;
 * - otherwise the only result, when there is exactly one. The search already
 *   matched the query against every translation of the title, within that
 *   year, so a lone answer is the film under another name — the UK's
 *   "Philosopher's Stone" for Letterboxd's "Sorcerer's Stone".
 *
 * A film with no year gets no such allowance: its lone answer could be any
 * year's.
 *
 * The results are every film with any release in the year asked, as
 * Letterboxd's year is a film's first showing anywhere, festival premieres
 * included, and TMDB's is its first release after them: Starve Acre is 2023
 * on Letterboxd, for its London Film Festival premiere, and 2024 on TMDB. So a
 * result's own year may be later than the one asked, but never earlier —
 * that's an older film re-released that year. A lone answer under another
 * name is taken only from the year asked, as the search's reach into later
 * years is for films Letterboxd dates by a premiere, not a second chance.
 */
export function pickMatch(
  results: RawMovie[],
  film: MatchFilm,
): RawMovie | undefined {
  const wanted = normaliseTitle(film.title);
  // All punctuation ("…", "?") folds to nothing, which would match anything.
  if (!wanted) return undefined;
  const inYear = (result: RawMovie) => {
    if (film.year === undefined) return true;
    const year = releaseYear(result);
    return year !== undefined && year >= film.year;
  };
  const exact = results.filter(
    (result) =>
      inYear(result) &&
      ((result.title && normaliseTitle(result.title) === wanted) ||
        (result.original_title &&
          normaliseTitle(result.original_title) === wanted)),
  );
  // A film first released the year asked beats one premiered then.
  const match =
    exact.find((result) => releaseYear(result) === film.year) ?? exact[0];
  if (match) return match;
  if (
    film.year !== undefined &&
    results.length === 1 &&
    releaseYear(results[0]) === film.year
  ) {
    return results[0];
  }
  return undefined;
}

function getMatchCacheKey(origin: string, film: MatchFilm) {
  const url = new URL(`${API_PREFIX}/match`, origin);
  url.searchParams.set("title", normaliseTitle(film.title));
  if (film.year !== undefined) url.searchParams.set("year", String(film.year));
  return url.toString();
}

async function matchOne(
  film: MatchFilm,
  token: string,
  origin: string,
  ctx: ExecutionContext,
): Promise<TmdbMovie | null> {
  const cache = caches.default;
  const cacheKey = new Request(getMatchCacheKey(origin, film));
  const cached = await cache.match(cacheKey);
  if (cached) return ((await cached.json()) as { film: TmdbMovie | null }).film;

  const { results } = await fetchTmdbSearch(
    {
      query: film.title,
      page: 1,
      ...(film.year !== undefined && { year: String(film.year) }),
    },
    token,
  );
  const match = pickMatch(results, film);
  const result = match ? trimMovie(match) : null;
  const ttl = result ? FOUND_TTL : MISSING_TTL;
  ctx.waitUntil(
    cache.put(
      cacheKey,
      Response.json(
        { film: result },
        { headers: { "Cache-Control": `public, max-age=${ttl}` } },
      ),
    ),
  );
  return result;
}

/**
 * Each film's TMDB match, or null, in the order asked. Throws if any search
 * fails: a film TMDB couldn't be asked about isn't a film it doesn't have,
 * and reporting it as missing would quietly leave it out of the import.
 */
export async function matchFilms(
  films: MatchFilm[],
  token: string,
  origin: string,
  ctx: ExecutionContext,
): Promise<MatchResponse> {
  const results: (TmdbMovie | null)[] = new Array(films.length);
  let next = 0;
  const worker = async () => {
    while (next < films.length) {
      const index = next++;
      results[index] = await matchOne(films[index], token, origin, ctx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, films.length) }, worker),
  );
  return { results };
}
