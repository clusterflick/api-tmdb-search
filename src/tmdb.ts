import { MAX_PAGE, type Search } from "./routes";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_HOSTNAME = "api.themoviedb.org";
const UPSTREAM_TIMEOUT_MS = 8000;

/**
 * Sent on every search, whatever was asked. No `region`: it swaps each
 * result's release date for that country's, so Spirited Away (2001) came back
 * as its 2003 UK release, a year neither the dataset nor Letterboxd uses.
 */
const FIXED_PARAMS = {
  language: "en-GB",
  include_adult: "false",
};

/**
 * A film as the site stores it: `id`, `title`, `year` and `posterPath` are
 * what a list entry keeps, so a result can be added without another lookup.
 */
export type TmdbMovie = {
  id: string;
  title: string;
  originalTitle?: string;
  year?: string;
  releaseDate?: string;
  posterPath?: string;
  overview?: string;
};

export type TmdbSearchResponse = {
  page: number;
  totalPages: number;
  totalResults: number;
  results: TmdbMovie[];
};

type RawMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
  overview?: string;
};

type RawSearch = {
  page: number;
  total_pages: number;
  total_results: number;
  results: RawMovie[];
};

export function buildUpstreamUrl(search: Search) {
  const url = new URL(`${TMDB_BASE}/search/movie`);
  for (const [key, value] of Object.entries(FIXED_PARAMS)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("query", search.query);
  url.searchParams.set("page", String(search.page));
  if (search.year) url.searchParams.set("year", search.year);
  // Belt and braces: the URL is fixed apart from validated params, but
  // nothing should ever leave for another host with our token on it.
  if (url.hostname !== TMDB_HOSTNAME || url.protocol !== "https:") {
    throw new Error(`Refusing to fetch ${url.origin}`);
  }
  return url;
}

// Leaves absent fields out rather than null, as Firestore rejects undefined
// and the client can spread these straight into a list entry.
function trimMovie(raw: RawMovie): TmdbMovie {
  const year = raw.release_date?.match(/^(\d{4})-/)?.[1];
  return {
    id: String(raw.id),
    title: raw.title ?? raw.original_title ?? "",
    ...(raw.original_title &&
      raw.original_title !== raw.title && {
        originalTitle: raw.original_title,
      }),
    ...(year && { year }),
    ...(raw.release_date && { releaseDate: raw.release_date }),
    ...(raw.poster_path && { posterPath: raw.poster_path }),
    ...(raw.overview && { overview: raw.overview }),
  };
}

function trimSearch(raw: RawSearch): TmdbSearchResponse {
  return {
    page: raw.page,
    totalPages: Math.min(raw.total_pages, MAX_PAGE),
    totalResults: raw.total_results,
    results: raw.results.map(trimMovie),
  };
}

export async function fetchFromTmdb(
  search: Search,
  token: string,
): Promise<TmdbSearchResponse> {
  const response = await fetch(buildUpstreamUrl(search), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TMDB responded ${response.status}`);

  return trimSearch(await response.json());
}
