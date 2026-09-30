import { describe, expect, it } from "vitest";
import { canReadWikiPageStatus } from "../../api/_lib/wiki-access.ts";

describe("canReadWikiPageStatus", () => {
  it("keeps published pages public", () => {
    expect(canReadWikiPageStatus("published", null)).toBe(true);
    expect(canReadWikiPageStatus("published", { role: "contributor" })).toBe(true);
  });

  it("hides draft pages from anonymous, authenticated, and contributor requests", () => {
    expect(canReadWikiPageStatus("draft", null)).toBe(false);
    expect(canReadWikiPageStatus("draft", { role: "authenticated" })).toBe(false);
    expect(canReadWikiPageStatus("draft", { role: "contributor" })).toBe(false);
  });

  it("allows editors and admins to read draft pages", () => {
    expect(canReadWikiPageStatus("draft", { role: "editor" })).toBe(true);
    expect(canReadWikiPageStatus("draft", { role: "admin" })).toBe(true);
  });

  it("fails closed for unexpected status values", () => {
    expect(canReadWikiPageStatus("archived", { role: "admin" })).toBe(false);
    expect(canReadWikiPageStatus(undefined, { role: "admin" })).toBe(false);
  });
});
