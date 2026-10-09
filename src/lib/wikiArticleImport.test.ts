import { describe, expect, it } from "vitest";
import { wikiArticleSchema } from "./wikiArticleImport";
import { z } from 'zod';
import pluginSchema from '../../plugins/kinetix-wiki-import/skills/wiki-article/references/schema.json';
const valid = () => ({
  schemaVersion: "kinetix-wiki-article-v1",
  idempotencyKey: "a",
  articleDigest: "a".repeat(64),
  createdAt: "2026-10-09T00:00:00Z",
  page: { slug: "oralvaeske" },
  sources: [{ key: "S1", type: "doi", identifier: "10.1093/jat/bkae097" }],
  sections: [
    {
      key: "s1",
      heading: "Bakgrunn",
      level: 2,
      facts: [{ key: "f1", statement: "Testpåstand.", sourceKeys: ["S1"] }],
    },
  ],
});
describe("wiki article contract", () => {
  it('ships the same structural schema in the plugin', () => {
    expect(z.toJSONSchema(wikiArticleSchema)).toEqual(pluginSchema);
  });
  it("accepts cited facts and rejects invented approval fields", () => {
    expect(wikiArticleSchema.safeParse(valid()).success).toBe(true);
    expect(
      wikiArticleSchema.safeParse({ ...valid(), autoApprove: true }).success,
    ).toBe(false);
  });
  it("rejects dangling references and duplicate identities", () => {
    const b = valid();
    b.sections[0]!.facts[0]!.sourceKeys = ["missing"];
    expect(wikiArticleSchema.safeParse(b).success).toBe(false);
    b.sections[0]!.facts[0]!.sourceKeys = ["S1"];
    b.sources.push(b.sources[0]!);
    expect(wikiArticleSchema.safeParse(b).success).toBe(false);
  });
  it("rejects unsourced facts and DOI resolver URLs masquerading as DOI identifiers", () => {
    const b = valid();
    b.sections[0]!.facts[0]!.sourceKeys = [];
    expect(wikiArticleSchema.safeParse(b).success).toBe(false);
    b.sections[0]!.facts[0]!.sourceKeys = ["S1"];
    b.sources[0]!.identifier = "https://doi.org/10.1093/jat/bkae097";
    expect(wikiArticleSchema.safeParse(b).success).toBe(false);
  });
});
