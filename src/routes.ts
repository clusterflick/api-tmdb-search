/**
 * The Worker's own API: a single search endpoint. Its params are validated and
 * translated into a TMDB request we build ourselves; nothing from the
 * request's path or query string is passed through to TMDB.
 */

export const API_PREFIX = "/api/tmdb";

export type Search = { query: string; year?: string; page: number };

export type RouteResult =
  | { ok: true; search: Search }
  | { ok: false; status: 400 | 404; error: string };

const MAX_QUERY_LENGTH = 100;
/** TMDB pages hold 20 results; past 100 a reader should refine the search. */
export const MAX_PAGE = 5;

function normaliseQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseSearch(params: URLSearchParams): RouteResult {
  const query = normaliseQuery(params.get("q") ?? "");
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `q must be 1-${MAX_QUERY_LENGTH} characters`,
    };
  }

  const year = params.get("year") || undefined;
  if (year !== undefined && !/^\d{4}$/.test(year)) {
    return { ok: false, status: 400, error: "year must be 4 digits" };
  }

  const pageParam = params.get("page") || "1";
  const page = Number(pageParam);
  if (!/^\d+$/.test(pageParam) || page < 1 || page > MAX_PAGE) {
    return {
      ok: false,
      status: 400,
      error: `page must be 1-${MAX_PAGE}`,
    };
  }

  return { ok: true, search: { query, year, page } };
}

export function matchRoute(url: URL): RouteResult {
  if (url.pathname === `${API_PREFIX}/search`) {
    return parseSearch(url.searchParams);
  }
  return { ok: false, status: 404, error: "Not found" };
}

/**
 * The search as a canonical public URL: the same request always gives the same
 * key, whatever order or casing it arrived in. Never includes anything about
 * the user, since cached responses are shared between them.
 */
export function getCacheKey(origin: string, search: Search) {
  const url = new URL(`${API_PREFIX}/search`, origin);
  url.searchParams.set("page", String(search.page));
  url.searchParams.set("q", search.query);
  if (search.year) url.searchParams.set("year", search.year);
  url.searchParams.sort();
  return url.toString();
}
