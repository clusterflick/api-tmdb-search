import { describe, expect, it } from "vitest";
import { getSearchCacheKey, matchEndpoint, parseSearch } from "../src/routes";
import { buildUpstreamUrl } from "../src/tmdb";

const ORIGIN = "https://clusterflick.com";
const search = (query: string) =>
  parseSearch(new URL(`/api/tmdb/search${query}`, ORIGIN).searchParams);

describe("matchEndpoint", () => {
  it.each([
    "/api/tmdb",
    "/api/tmdb/",
    "/api/tmdb/search/",
    "/api/tmdb/match/",
    "/api/tmdb/movie/603",
    "/api/tmdb/movie/603/recommendations",
    "/api/tmdb/tv/1399",
    "/api/tmdb/3/search/movie",
    "/api/tmdb/configuration",
  ])("finds nothing at %s", (path) => {
    expect(matchEndpoint(new URL(path, ORIGIN))).toBeNull();
  });

  it.each([
    ["/api/tmdb/search", "search"],
    ["/api/tmdb/search?q=dune", "search"],
    ["/api/tmdb/match", "match"],
  ])("finds %s", (path, endpoint) => {
    expect(matchEndpoint(new URL(path, ORIGIN))).toBe(endpoint);
  });
});

describe("parseSearch", () => {
  it.each([
    ["no query", ""],
    ["an empty query", "?q="],
    ["a blank query", "?q=%20%20"],
    ["a query over 100 characters", `?q=${"a".repeat(101)}`],
    ["a two-digit year", "?q=dune&year=24"],
    ["a non-numeric year", "?q=dune&year=abcd"],
    ["page 0", "?q=dune&page=0"],
    ["page 6", "?q=dune&page=6"],
    ["a fractional page", "?q=dune&page=1.5"],
    ["a negative page", "?q=dune&page=-1"],
  ])("rejects %s", (_, query) => {
    expect(search(query)).toMatchObject({ ok: false, status: 400 });
  });

  it("normalises the query and defaults the page", () => {
    expect(search("?q=%20%20The%20%20%20MATRIX%20")).toEqual({
      ok: true,
      value: { query: "the matrix", year: undefined, page: 1 },
    });
  });

  it("accepts a year and page", () => {
    expect(search("?q=dune&year=2024&page=5")).toEqual({
      ok: true,
      value: { query: "dune", year: "2024", page: 5 },
    });
  });

  it("ignores params it doesn't know", () => {
    expect(search("?q=dune&include_adult=true&api_key=x")).toEqual({
      ok: true,
      value: { query: "dune", year: undefined, page: 1 },
    });
  });
});

describe("getSearchCacheKey", () => {
  it("gives the same key however the request was written", () => {
    const a = search("?year=2024&q=DUNE%20%20part%20two");
    const b = search("?q=dune+part+two&page=1&year=2024");
    if (!a.ok || !b.ok) throw new Error("expected both to parse");
    expect(getSearchCacheKey(ORIGIN, a.value)).toBe(
      getSearchCacheKey(ORIGIN, b.value),
    );
    expect(getSearchCacheKey(ORIGIN, a.value)).toBe(
      "https://clusterflick.com/api/tmdb/search?page=1&q=dune+part+two&year=2024",
    );
  });
});

describe("buildUpstreamUrl", () => {
  it("builds a search on TMDB with the fixed params", () => {
    const url = buildUpstreamUrl({ query: "dune", year: "2024", page: 2 });
    expect(url.origin).toBe("https://api.themoviedb.org");
    expect(url.pathname).toBe("/3/search/movie");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      language: "en-GB",
      include_adult: "false",
      query: "dune",
      page: "2",
      year: "2024",
    });
  });

  it("can filter to a primary release year", () => {
    const url = buildUpstreamUrl({
      query: "amélie",
      page: 1,
      primaryReleaseYear: 2001,
    });
    expect(url.searchParams.get("primary_release_year")).toBe("2001");
    expect(url.searchParams.has("year")).toBe(false);
  });
});
