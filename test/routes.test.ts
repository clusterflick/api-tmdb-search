import { describe, expect, it } from "vitest";
import { getCacheKey, matchRoute } from "../src/routes";
import { buildUpstreamUrl } from "../src/tmdb";

const ORIGIN = "https://clusterflick.com";
const match = (path: string) => matchRoute(new URL(path, ORIGIN));

describe("matchRoute", () => {
  it.each([
    "/api/tmdb",
    "/api/tmdb/",
    "/api/tmdb/search/",
    "/api/tmdb/movie/603",
    "/api/tmdb/movie/603/recommendations",
    "/api/tmdb/tv/1399",
    "/api/tmdb/3/search/movie",
    "/api/tmdb/configuration",
  ])("rejects %s as not found", (path) => {
    expect(match(path)).toMatchObject({ ok: false, status: 404 });
  });

  it.each([
    ["no query", "/api/tmdb/search"],
    ["an empty query", "/api/tmdb/search?q="],
    ["a blank query", "/api/tmdb/search?q=%20%20"],
    ["a query over 100 characters", `/api/tmdb/search?q=${"a".repeat(101)}`],
    ["a two-digit year", "/api/tmdb/search?q=dune&year=24"],
    ["a non-numeric year", "/api/tmdb/search?q=dune&year=abcd"],
    ["page 0", "/api/tmdb/search?q=dune&page=0"],
    ["page 6", "/api/tmdb/search?q=dune&page=6"],
    ["a fractional page", "/api/tmdb/search?q=dune&page=1.5"],
    ["a negative page", "/api/tmdb/search?q=dune&page=-1"],
  ])("rejects %s as a bad request", (_, path) => {
    expect(match(path)).toMatchObject({ ok: false, status: 400 });
  });

  it("normalises the query and defaults the page", () => {
    expect(match("/api/tmdb/search?q=%20%20The%20%20%20MATRIX%20")).toEqual({
      ok: true,
      search: { query: "the matrix", year: undefined, page: 1 },
    });
  });

  it("accepts a year and page", () => {
    expect(match("/api/tmdb/search?q=dune&year=2024&page=5")).toEqual({
      ok: true,
      search: { query: "dune", year: "2024", page: 5 },
    });
  });

  it("ignores params it doesn't know", () => {
    expect(
      match("/api/tmdb/search?q=dune&include_adult=true&api_key=x"),
    ).toEqual({
      ok: true,
      search: { query: "dune", year: undefined, page: 1 },
    });
  });
});

describe("getCacheKey", () => {
  it("gives the same key however the request was written", () => {
    const a = match("/api/tmdb/search?year=2024&q=DUNE%20%20part%20two");
    const b = match("/api/tmdb/search?q=dune+part+two&page=1&year=2024");
    if (!a.ok || !b.ok) throw new Error("expected both to match");
    expect(getCacheKey(ORIGIN, a.search)).toBe(getCacheKey(ORIGIN, b.search));
    expect(getCacheKey(ORIGIN, a.search)).toBe(
      "https://clusterflick.com/api/tmdb/search?page=1&q=dune+part+two&year=2024",
    );
  });
});

describe("buildUpstreamUrl", () => {
  it("builds a search on TMDB with the fixed params", () => {
    const url = buildUpstreamUrl({
      query: "dune",
      year: "2024",
      page: 2,
    });
    expect(url.origin).toBe("https://api.themoviedb.org");
    expect(url.pathname).toBe("/3/search/movie");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      language: "en-GB",
      region: "GB",
      include_adult: "false",
      query: "dune",
      page: "2",
      year: "2024",
    });
  });
});
