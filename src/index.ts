import type { JWTVerifyGetKey } from "jose";
import {
  AuthError,
  FIREBASE_JWKS,
  getBearerToken,
  verifyFirebaseToken,
} from "./auth";
import { getCacheKey, matchRoute } from "./routes";
import { fetchFromTmdb } from "./tmdb";

/**
 * How long a trimmed response is kept, in seconds. Results change slowly,
 * though queries are long-tail so hits will be rare.
 */
const CACHE_TTL = 60 * 60;

function json(body: unknown, status: number, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

function error(message: string, status: number, headers: HeadersInit = {}) {
  return json({ error: message }, status, headers);
}

/**
 * Every step fails fast, in this order: route, params, token, rate limits,
 * cache, TMDB. The cache sits behind auth and the limits, so cached answers
 * still count against them.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  keys: JWTVerifyGetKey = FIREBASE_JWKS,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = matchRoute(url);
  if (!matched.ok && matched.status === 404) {
    return error(matched.error, 404);
  }
  if (request.method !== "GET") {
    return error("Method not allowed", 405, { Allow: "GET" });
  }
  if (!matched.ok) return error(matched.error, matched.status);
  const { search } = matched;

  const token = getBearerToken(request);
  if (!token) return error("Sign in required", 401);
  let uid;
  try {
    uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
  } catch (e) {
    if (e instanceof AuthError) return error(e.message, e.status);
    throw e;
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [userLimit, ipLimit] = await Promise.all([
    env.USER_LIMIT.limit({ key: uid }),
    env.IP_LIMIT.limit({ key: ip }),
  ]);
  if (!userLimit.success || !ipLimit.success) {
    return error("Too many requests", 429, { "Retry-After": "60" });
  }

  // Only the reader's own browser may keep a copy; the shared one is ours.
  const clientHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": `private, max-age=${CACHE_TTL}`,
  };
  const cache = caches.default;
  const cacheKey = new Request(getCacheKey(url.origin, search));
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: clientHeaders });
  }

  let body;
  try {
    body = await fetchFromTmdb(search, env.TMDB_TOKEN);
  } catch (e) {
    console.error("TMDB request failed", e);
    return error("TMDB unavailable", 502);
  }

  const response = json(body, 200, clientHeaders);
  ctx.waitUntil(
    cache.put(
      cacheKey,
      json(body, 200, { "Cache-Control": `public, max-age=${CACHE_TTL}` }),
    ),
  );
  return response;
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
} satisfies ExportedHandler<Env>;
