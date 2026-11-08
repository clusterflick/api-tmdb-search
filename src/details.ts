import { API_PREFIX, badRequest, type Parsed } from "./routes";
import { fetchTmdbJson } from "./tmdb";

/**
 * Films per call. On Workers Free a request gets 50 subrequests, and cache
 * reads and writes count: a batch of 15 is 15 cache reads, up to 15 TMDB
 * lookups and 15 cache writes, plus one fetch of Google's signing keys.
 */
export const MAX_DETAILS_BATCH = 15;

/**
 * Top-billed cast returned per film. The site keeps this many for a reader's
 * favourite actors; leading roles are what that means, and the rest is bytes
 * in a document with a 1 MiB limit.
 */
export const MAX_CAST = 5;

const MAX_BODY_BYTES = 4 * 1024;

/** How many TMDB lookups run at once; a Worker gets six connections. */
const CONCURRENCY = 6;

/** How long a film's details are kept, in seconds. Credits barely move. */
const FOUND_TTL = 30 * 24 * 60 * 60;
/** Shorter for an id TMDB doesn't have, in case it's restored. */
const MISSING_TTL = 24 * 60 * 60;
/**
 * Part of every cached answer's key. Bump it whenever the shape below or
 * what goes into it (`MAX_CAST` included) changes, so the old answers
 * aren't served for up to a month after the new ones deploy.
 */
const DETAILS_VERSION = 1;

export type DetailsPerson = { id: string; name: string };

/**
 * What the site's list stats and filters need about a film. Ids are TMDB's,
 * which the site's dataset already uses for genres and people, so details from
 * here and from the dataset agree. Absent fields are left out, as Firestore
 * rejects undefined.
 */
export type FilmDetails = {
  id: string;
  genres: string[];
  directors: DetailsPerson[];
  /** Billing order, cut to `MAX_CAST`. */
  cast: DetailsPerson[];
  /** Minutes. */
  runtime?: number;
  /** ISO 639-1 code of the original language. */
  language?: string;
};

export type DetailsResponse = { results: (FilmDetails | null)[] };

type RawPerson = { id: number; name?: string };

export type RawDetails = {
  id: number;
  genres?: { id: number; name?: string }[];
  runtime?: number | null;
  original_language?: string;
  credits?: {
    cast?: (RawPerson & { order?: number })[];
    crew?: (RawPerson & { job?: string; credit_id?: string })[];
  };
};

/**
 * `{ "ids": ["949", …] }`, 1–15 TMDB film ids. Only digits: the site's own
 * ids for films TMDB doesn't know aren't TMDB's, and anything else would be
 * put into a TMDB path.
 */
export async function parseDetailsBody(
  request: Request,
): Promise<Parsed<string[]>> {
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
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_DETAILS_BATCH) {
    return badRequest(`ids must be an array of 1-${MAX_DETAILS_BATCH}`);
  }
  if (!ids.every((id) => typeof id === "string" && /^\d{1,10}$/.test(id))) {
    return badRequest("each id must be a TMDB film id");
  }
  return { ok: true, value: ids };
}

const toPerson = ({ id, name }: RawPerson): DetailsPerson | undefined =>
  name ? { id: String(id), name } : undefined;

/** The first of each person, in the order given, with a name to show. */
function uniquePeople(people: RawPerson[]) {
  const seen = new Set<number>();
  return people.flatMap((person) => {
    if (seen.has(person.id)) return [];
    seen.add(person.id);
    return toPerson(person) ?? [];
  });
}

/**
 * Directors and cast are picked and ordered as the site's pipeline does
 * (`build-movie-data.js` in clusterflick/scripts): directors by credit id, cast
 * by billing order. A film added from here then reads the same as one taken
 * from the dataset.
 */
export function trimDetails(raw: RawDetails): FilmDetails {
  const crew = raw.credits?.crew ?? [];
  const directors = crew
    .filter(({ job }) => job?.toLowerCase() === "director")
    .sort(
      (a, b) => `${a.credit_id}`.localeCompare(`${b.credit_id}`) || a.id - b.id,
    );
  const cast = [...(raw.credits?.cast ?? [])].sort(
    (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity),
  );
  return {
    id: String(raw.id),
    genres: (raw.genres ?? []).map(({ id }) => String(id)),
    directors: uniquePeople(directors),
    cast: uniquePeople(cast).slice(0, MAX_CAST),
    ...(raw.runtime && { runtime: raw.runtime }),
    ...(raw.original_language && { language: raw.original_language }),
  };
}

function getDetailsCacheKey(origin: string, id: string) {
  const url = new URL(`${API_PREFIX}/details`, origin);
  url.searchParams.set("v", String(DETAILS_VERSION));
  url.searchParams.set("id", id);
  return url.toString();
}

async function detailsForOne(
  id: string,
  token: string,
  origin: string,
  ctx: ExecutionContext,
): Promise<FilmDetails | null> {
  const cache = caches.default;
  const cacheKey = new Request(getDetailsCacheKey(origin, id));
  const cached = await cache.match(cacheKey);
  if (cached) {
    return ((await cached.json()) as { film: FilmDetails | null }).film;
  }

  const raw = await fetchTmdbJson<RawDetails>(`movie/${id}`, token, {
    append_to_response: "credits",
  });
  const result = raw ? trimDetails(raw) : null;
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
 * Each film's details, or null where TMDB has no such film, in the order
 * asked. Throws if any lookup fails: a film TMDB couldn't be asked about isn't
 * a film it doesn't have.
 */
export async function getFilmDetails(
  ids: string[],
  token: string,
  origin: string,
  ctx: ExecutionContext,
): Promise<DetailsResponse> {
  const results: (FilmDetails | null)[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await detailsForOne(ids[index], token, origin, ctx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
  );
  return { results };
}
