// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The production database (Neon project "kinetix") lives in AWS eu-central-1,
// Frankfurt. Every getDb() query is its own HTTPS round trip to Neon, and a
// request makes many of them in sequence, so the functions have to run next to
// the database. Without a `regions` entry Vercel placed them in sfo1, which put
// ~150 ms of trans-Atlantic latency on every single query. fra1 is Vercel's
// Frankfurt region (AWS eu-central-1). If the database ever moves, move this
// with it rather than deleting the pin.
describe("vercel.json function region", () => {
  it("pins serverless functions to the database's region (fra1)", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.regions).toEqual(["fra1"]);
  });
});
