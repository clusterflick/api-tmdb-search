import { describe, expect, it } from "vitest";
import {
  MAX_CAST,
  MAX_DETAILS_BATCH,
  parseDetailsBody,
  trimDetails,
} from "../src/details";

const post = (body: unknown) =>
  new Request("https://clusterflick.com/api/tmdb/details", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("parseDetailsBody", () => {
  it("accepts TMDB ids", async () => {
    expect(await parseDetailsBody(post({ ids: ["949", "603"] }))).toEqual({
      ok: true,
      value: ["949", "603"],
    });
  });

  it.each([
    ["no ids", {}],
    ["an empty list", { ids: [] }],
    [
      "too many ids",
      { ids: Array.from({ length: MAX_DETAILS_BATCH + 1 }, () => "1") },
    ],
    ["a numeric id", { ids: [949] }],
    ["a site-generated id", { ids: ["heat-1995-a1b2c3"] }],
    ["a path", { ids: ["949/videos"] }],
    ["a negative id", { ids: ["-1"] }],
  ])("rejects %s", async (_, body) => {
    expect(await parseDetailsBody(post(body))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects a body that isn't JSON", async () => {
    expect(await parseDetailsBody(post("ids=949"))).toMatchObject({
      ok: false,
    });
  });
});

describe("trimDetails", () => {
  it("orders cast by billing and cuts it, as the site's pipeline does", () => {
    const cast = Array.from({ length: MAX_CAST + 2 }, (_, i) => ({
      id: 100 + i,
      name: `Actor ${i}`,
      // Arrives out of order.
      order: MAX_CAST + 1 - i,
    }));
    const { cast: trimmed } = trimDetails({ id: 1, credits: { cast } });
    expect(trimmed).toHaveLength(MAX_CAST);
    expect(trimmed[0]).toEqual({ id: "106", name: "Actor 6" });
  });

  it("keeps directors only, once each, ordered by credit id", () => {
    const { directors } = trimDetails({
      id: 1,
      credits: {
        crew: [
          { id: 2, name: "Lana", job: "Director", credit_id: "b" },
          { id: 3, name: "Writer", job: "Screenplay", credit_id: "a" },
          { id: 1, name: "Lilly", job: "Director", credit_id: "a" },
          { id: 2, name: "Lana", job: "Director", credit_id: "c" },
        ],
      },
    });
    expect(directors).toEqual([
      { id: "1", name: "Lilly" },
      { id: "2", name: "Lana" },
    ]);
  });

  it("leaves out what TMDB doesn't know, as Firestore rejects undefined", () => {
    expect(trimDetails({ id: 7, runtime: 0, genres: [] })).toEqual({
      id: "7",
      genres: [],
      directors: [],
      cast: [],
    });
  });
});
