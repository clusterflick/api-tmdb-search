/**
 * The Worker's own API: a search, and a batch match for imports. Their input
 * is validated and translated into TMDB requests we build ourselves; nothing
 * from the request's path or query string is passed through to TMDB.
 */

export const API_PREFIX = "/api/tmdb";

export type Endpoint = "search" | "match";

/** Each endpoint answers one method; anything else is a 405. */
export const ENDPOINT_METHODS: Record<Endpoint, string> = {
  search: "GET",
  match: "POST",
};

export type Search = { query: string; year?: string; page: number };

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; status: 400; error: string };

const MAX_QUERY_LENGTH = 100;
/** TMDB pages hold 20 results; past 100 a reader should refine the search. */
export const MAX_PAGE = 5;

export function badRequest(error: string) {
  return { ok: false, status: 400, error } as const;
}

export function matchEndpoint(url: URL): Endpoint | null {
  if (url.pathname === `${API_PREFIX}/search`) return "search";
  if (url.pathname === `${API_PREFIX}/match`) return "match";
  return null;
}

export function parseSearch(params: URLSearchParams): Parsed<Search> {
  const query = (params.get("q") ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    return badRequest(`q must be 1-${MAX_QUERY_LENGTH} characters`);
  }

  const year = params.get("year") || undefined;
  if (year !== undefined && !/^\d{4}$/.test(year)) {
    return badRequest("year must be 4 digits");
  }

  const pageParam = params.get("page") || "1";
  const page = Number(pageParam);
  if (!/^\d+$/.test(pageParam) || page < 1 || page > MAX_PAGE) {
    return badRequest(`page must be 1-${MAX_PAGE}`);
  }

  return { ok: true, value: { query, year, page } };
}

/**
 * The search as a canonical public URL: the same request always gives the same
 * key, whatever order or casing it arrived in. Never includes anything about
 * the user, since cached responses are shared between them.
 */
export function getSearchCacheKey(origin: string, search: Search) {
  const url = new URL(`${API_PREFIX}/search`, origin);
  url.searchParams.set("page", String(search.page));
  url.searchParams.set("q", search.query);
  if (search.year) url.searchParams.set("year", search.year);
  url.searchParams.sort();
  return url.toString();
}
