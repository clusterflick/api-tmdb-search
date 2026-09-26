import { describe, expect, it } from "vitest";
import {
  MAX_BATCH,
  normaliseTitle,
  parseMatchBody,
  pickMatch,
} from "../src/match";

const post = (body: unknown) =>
  new Request("https://clusterflick.com/api/tmdb/match", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("parseMatchBody", () => {
  it("accepts films with and without a year, tidying titles", async () => {
    expect(
      await parseMatchBody(
        post({
          films: [
            { title: "  Amélie  ", year: 2001 },
            { title: "Heat\n  (Director's Cut)" },
          ],
        }),
      ),
    ).toEqual({
      ok: true,
      value: [
        { title: "Amélie", year: 2001 },
        { title: "Heat (Director's Cut)" },
      ],
    });
  });

  it.each([
    ["not JSON", "films"],
    ["no films", {}],
    ["an empty batch", { films: [] }],
    [
      "too many films",
      { films: Array.from({ length: MAX_BATCH + 1 }, () => ({ title: "x" })) },
    ],
    ["a film with no title", { films: [{ year: 2001 }] }],
    ["a blank title", { films: [{ title: "   " }] }],
    ["a title that isn't text", { films: [{ title: 42 }] }],
    ["a title over 200 characters", { films: [{ title: "a".repeat(201) }] }],
    ["a year as text", { films: [{ title: "Heat", year: "1995" }] }],
    ["a fractional year", { films: [{ title: "Heat", year: 1995.5 }] }],
    ["an impossible year", { films: [{ title: "Heat", year: 95 }] }],
    ["an oversized body", { films: [{ title: "x" }], pad: "a".repeat(17000) }],
  ])("rejects %s", async (_, body) => {
    expect(await parseMatchBody(post(body))).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("normaliseTitle", () => {
  it.each([
    ["Amélie", "Le Fabuleux Destin d'Amélie Poulain", false],
    ["Amélie", "amelie", true],
    [
      "Lock, Stock & Two Smoking Barrels",
      "Lock Stock and Two Smoking Barrels",
      true,
    ],
    ["Se7en", "Seven", false],
    ["WALL·E", "WALL-E", true],
    ["Up", "Up!", true],
    ["千と千尋の神隠し", "千と千尋の神隠し", true],
    ["千と千尋の神隠し", "ハウルの動く城", false],
  ])("%s vs %s", (a, b, same) => {
    expect(normaliseTitle(a) === normaliseTitle(b)).toBe(same);
  });
});

describe("pickMatch", () => {
  const film = (
    id: number,
    title: string,
    year?: number,
    original = title,
  ) => ({
    id,
    title,
    original_title: original,
    ...(year && { release_date: `${year}-06-01` }),
  });

  it("takes the first result whose title matches", () => {
    expect(
      pickMatch(
        [film(1, "Heat Wave", 1995), film(949, "Heat", 1995), film(2, "Heat")],
        { title: "Heat", year: 1995 },
      )?.id,
    ).toBe(949);
  });

  it("matches on the original title", () => {
    expect(
      pickMatch([film(12, "Spirited Away", 2001, "千と千尋の神隠し")], {
        title: "千と千尋の神隠し",
      })?.id,
    ).toBe(12);
  });

  it("takes a lone result under another title when the year was given", () => {
    expect(
      pickMatch([film(671, "Harry Potter and the Philosopher's Stone", 2001)], {
        title: "Harry Potter and the Sorcerer's Stone",
        year: 2001,
      })?.id,
    ).toBe(671);
  });

  it("doesn't take a lone result without a year to pin it", () => {
    expect(
      pickMatch([film(671, "Harry Potter and the Philosopher's Stone")], {
        title: "Harry Potter and the Sorcerer's Stone",
      }),
    ).toBeUndefined();
  });

  it("finds nothing among several results that don't match", () => {
    expect(
      pickMatch([film(1, "Up in the Air", 2009), film(2, "Upgrade", 2018)], {
        title: "Up",
        year: 2009,
      }),
    ).toBeUndefined();
  });

  it("takes a film TMDB dates later than a premiere Letterboxd dates it by", () => {
    expect(
      pickMatch([film(933090, "Starve Acre", 2024)], {
        title: "Starve Acre",
        year: 2023,
      })?.id,
    ).toBe(933090);
  });

  it("prefers a film first released the year asked to one premiered then", () => {
    expect(
      pickMatch([film(1, "Heat", 1996), film(949, "Heat", 1995)], {
        title: "Heat",
        year: 1995,
      })?.id,
    ).toBe(949);
  });

  it("doesn't take an older film re-released the year asked", () => {
    expect(
      pickMatch([film(1, "Nosferatu", 1922)], {
        title: "Nosferatu",
        year: 2024,
      }),
    ).toBeUndefined();
  });

  it("doesn't take a lone result under another title from a later year", () => {
    expect(
      pickMatch([film(1, "Fast X", 2023)], {
        title: "The Furious",
        year: 2022,
      }),
    ).toBeUndefined();
  });

  it("doesn't take a result with no date when the year was given", () => {
    expect(
      pickMatch([film(1, "Heat")], { title: "Heat", year: 1995 }),
    ).toBeUndefined();
  });

  it("doesn't let a title of only punctuation match anything", () => {
    expect(pickMatch([film(1, "?")], { title: "…" })).toBeUndefined();
  });

  it("finds nothing in no results", () => {
    expect(pickMatch([], { title: "Heat", year: 1995 })).toBeUndefined();
  });
});
