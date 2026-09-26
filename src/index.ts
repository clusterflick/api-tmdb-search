import type { JWTVerifyGetKey } from "jose";
import {
  AuthError,
  FIREBASE_JWKS,
  getBearerToken,
  verifyFirebaseToken,
} from "./auth";
import { matchFilms, parseMatchBody, type MatchFilm } from "./match";
import {
  ENDPOINT_METHODS,
  getSearchCacheKey,
  matchEndpoint,
  parseSearch,
  type Search,
} from "./routes";
import { fetchFromTmdb } from "./tmdb";

/**
 * How long a search is kept, in seconds. Results change slowly, though
 * queries are long-tail so hits will be rare.
 */
const SEARCH_TTL = 60 * 60;

function json(body: unknown, status: number, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

function error(message: string, status: number, headers: HeadersInit = {}) {
  return json({ error: message }, status, headers);
}

function tmdbUnavailable(e: unknown) {
  console.error("TMDB request failed", e);
  return error("TMDB unavailable", 502);
}

type ParsedRequest =
  | { endpoint: "search"; search: Search }
  | { endpoint: "match"; films: MatchFilm[] };

/**
 * Every step fails fast, in this order: route, method, input, token, rate
 * limits, then the endpoint's own work. The cache sits behind auth and the
 * limits, so cached answers still count against them.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  keys: JWTVerifyGetKey = FIREBASE_JWKS,
): Promise<Response> {
  const url = new URL(request.url);
  const endpoint = matchEndpoint(url);
  if (!endpoint) return error("Not found", 404);
  const method = ENDPOINT_METHODS[endpoint];
  if (request.method !== method) {
    return error("Method not allowed", 405, { Allow: method });
  }

  let parsed: ParsedRequest;
  if (endpoint === "search") {
    const search = parseSearch(url.searchParams);
    if (!search.ok) return error(search.error, search.status);
    parsed = { endpoint, search: search.value };
  } else {
    const films = await parseMatchBody(request);
    if (!films.ok) return error(films.error, films.status);
    parsed = { endpoint, films: films.value };
  }

  const token = getBearerToken(request);
  if (!token) return error("Sign in required", 401);
  let uid;
  try {
    uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
  } catch (e) {
    if (e instanceof AuthError) return error(e.message, e.status);
    throw e;
  }

  // Search and import each have their own per-reader limit, so a big import
  // can't lock a reader out of searching or the other way round.
  const userLimit = endpoint === "search" ? env.USER_LIMIT : env.MATCH_LIMIT;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [userAllowed, ipAllowed] = await Promise.all([
    userLimit.limit({ key: uid }),
    env.IP_LIMIT.limit({ key: ip }),
  ]);
  if (!userAllowed.success || !ipAllowed.success) {
    return error("Too many requests", 429, { "Retry-After": "60" });
  }

  return parsed.endpoint === "search"
    ? handleSearch(parsed.search, url, env, ctx)
    : handleMatch(parsed.films, url, env, ctx);
}

async function handleSearch(
  search: Search,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
) {
  // Only the reader's own browser may keep a copy; the shared one is ours.
  const clientHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": `private, max-age=${SEARCH_TTL}`,
  };
  const cache = caches.default;
  const cacheKey = new Request(getSearchCacheKey(url.origin, search));
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: clientHeaders });
  }

  let body;
  try {
    body = await fetchFromTmdb(search, env.TMDB_TOKEN);
  } catch (e) {
    return tmdbUnavailable(e);
  }

  ctx.waitUntil(
    cache.put(
      cacheKey,
      json(body, 200, { "Cache-Control": `public, max-age=${SEARCH_TTL}` }),
    ),
  );
  return json(body, 200, clientHeaders);
}

async function handleMatch(
  films: MatchFilm[],
  url: URL,
  env: Env,
  ctx: ExecutionContext,
) {
  try {
    const body = await matchFilms(films, env.TMDB_TOKEN, url.origin, ctx);
    // Each film is cached here, and an import doesn't ask twice.
    return json(body, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return tmdbUnavailable(e);
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
} satisfies ExportedHandler<Env>;
