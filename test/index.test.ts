import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { handleRequest } from "../src/index";
import { otherPrivateKey, signToken, TEST_KEYS } from "./helpers";

const SEARCH_RESPONSE = {
  page: 1,
  total_pages: 12,
  total_results: 230,
  results: [
    {
      id: 438631,
      title: "Dune",
      original_title: "Dune",
      release_date: "2021-09-15",
      poster_path: "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
      overview: "Paul Atreides…",
      popularity: 100,
      vote_average: 7.8,
    },
    {
      id: 841,
      title: "Dune",
      original_title: "Dune",
      release_date: "",
      poster_path: null,
      overview: "",
    },
  ],
};

let fetchSpy: MockInstance<typeof fetch>;
let testCount = 0;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  testCount += 1;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A query no other test uses, so cached responses don't leak between tests. */
const uniqueQuery = () => `film ${testCount}`;

const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };

async function call(
  path: string,
  {
    token,
    method = "GET",
    limits = {},
  }: {
    token?: string;
    method?: string;
    limits?: { user?: typeof allow; ip?: typeof allow };
  } = {},
) {
  const request = new Request(`https://clusterflick.com${path}`, {
    method,
    headers: {
      "CF-Connecting-IP": "203.0.113.1",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  const testEnv = {
    ...env,
    USER_LIMIT: limits.user ?? allow,
    IP_LIMIT: limits.ip ?? allow,
  } as unknown as Env;
  const ctx = createExecutionContext();
  const response = await handleRequest(request, testEnv, ctx, TEST_KEYS);
  await waitOnExecutionContext(ctx);
  return response;
}

function respondWith(body: unknown, status = 200) {
  fetchSpy.mockResolvedValue(Response.json(body, { status }));
}

describe("request order", () => {
  it("404s movie details, which aren't offered", async () => {
    const response = await call("/api/tmdb/movie/129", {
      token: await signToken(),
    });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s an unknown path before anything else", async () => {
    const response = await call("/api/tmdb/tv/1399", { method: "POST" });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("405s %s", async (method) => {
    const response = await call("/api/tmdb/search?q=dune", { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("400s bad params before checking the token", async () => {
    const response = await call("/api/tmdb/search?q=");
    expect(response.status).toBe(400);
  });
});

describe("auth", () => {
  it("401s without a token", async () => {
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`);
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("401s a malformed token", async () => {
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: "not-a-jwt",
    });
    expect(response.status).toBe(401);
  });

  it("401s a token signed by another key", async () => {
    const token = await signToken({}, await otherPrivateKey());
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token,
    });
    expect(response.status).toBe(401);
  });

  const now = Math.floor(Date.now() / 1000);
  it.each([
    ["expired", { exp: now - 10 }],
    ["for another project", { aud: "another-project" }],
    ["from another issuer", { iss: "https://securetoken.google.com/other" }],
    ["with an empty subject", { sub: "" }],
    ["issued in the future", { iat: now + 600 }],
    ["authenticated in the future", { auth_time: now + 600 }],
    ["without an auth time", { auth_time: undefined }],
  ])("401s a token %s", async (_, claims) => {
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: await signToken(claims),
    });
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("403s an unverified email", async () => {
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: await signToken({ email_verified: false }),
    });
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("rate limits", () => {
  it.each([
    ["user", { user: deny }],
    ["IP", { ip: deny }],
  ])("429s when the %s limit is hit", async (_, limits) => {
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: await signToken(),
      limits,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keys the limits by uid and IP", async () => {
    const user = { limit: vi.fn(allow.limit) };
    const ip = { limit: vi.fn(allow.limit) };
    respondWith(SEARCH_RESPONSE);
    await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: await signToken({ sub: "uid-42" }),
      limits: { user, ip },
    });
    expect(user.limit).toHaveBeenCalledWith({ key: "uid-42" });
    expect(ip.limit).toHaveBeenCalledWith({ key: "203.0.113.1" });
  });
});

describe("search", () => {
  it("calls TMDB with our token and returns trimmed results", async () => {
    respondWith(SEARCH_RESPONSE);
    const response = await call(
      `/api/tmdb/search?q=${uniqueQuery()}&year=2021`,
      { token: await signToken() },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(await response.json()).toEqual({
      page: 1,
      totalPages: 5,
      totalResults: 230,
      results: [
        {
          id: "438631",
          title: "Dune",
          year: "2021",
          releaseDate: "2021-09-15",
          posterPath: "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
          overview: "Paul Atreides…",
        },
        { id: "841", title: "Dune" },
      ],
    });

    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://api.themoviedb.org/3/search/movie?language=en-GB&region=GB&include_adult=false&query=film+${testCount}&page=1&year=2021`,
    );
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer test-tmdb-token",
    );
  });

  it("serves a repeat search from the cache, even to another user", async () => {
    respondWith(SEARCH_RESPONSE);
    const query = uniqueQuery();
    await call(`/api/tmdb/search?q=${query}`, { token: await signToken() });
    const response = await call(
      `/api/tmdb/search?q=${query.toUpperCase()}&page=1`,
      { token: await signToken({ sub: "user-2" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect((await response.json()) as object).toHaveProperty("totalResults");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still applies rate limits to cached responses", async () => {
    respondWith(SEARCH_RESPONSE);
    const query = uniqueQuery();
    await call(`/api/tmdb/search?q=${query}`, { token: await signToken() });
    const response = await call(`/api/tmdb/search?q=${query}`, {
      token: await signToken(),
      limits: { user: deny },
    });
    expect(response.status).toBe(429);
  });

  it("returns 502 and caches nothing when TMDB fails", async () => {
    const query = uniqueQuery();
    respondWith({ status_message: "Too many requests" }, 429);
    const failed = await call(`/api/tmdb/search?q=${query}`, {
      token: await signToken(),
    });
    expect(failed.status).toBe(502);

    respondWith(SEARCH_RESPONSE);
    const retried = await call(`/api/tmdb/search?q=${query}`, {
      token: await signToken(),
    });
    expect(retried.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns 502 when TMDB can't be reached", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Network error"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(`/api/tmdb/search?q=${uniqueQuery()}`, {
      token: await signToken(),
    });
    expect(response.status).toBe(502);
  });
});
