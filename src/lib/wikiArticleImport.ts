import { z } from "zod";

const key = z.string().trim().min(1).max(80);
const source = z
  .object({
    key,
    type: z.enum(["pmid", "doi", "url"]),
    identifier: z.string().trim().min(1).max(2000),
    metadata: z
      .object({
        title: z.string().trim().min(1).max(2000).optional(),
        authors: z.array(z.string().max(300)).max(200).optional(),
        journal: z.string().max(500).optional(),
        year: z.number().int().min(1500).max(2200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const valid =
      s.type === "pmid"
        ? /^[1-9]\d{0,11}$/.test(s.identifier)
        : s.type === "doi"
          ? /^10\.\d{4,9}\/\S+$/i.test(s.identifier)
          : /^https?:\/\/[^\s]+$/i.test(s.identifier);
    if (!valid)
      ctx.addIssue({
        code: "custom",
        path: ["identifier"],
        message: "Invalid source identifier",
      });
  });

export const wikiArticleSchema = z
  .object({
    schemaVersion: z.literal("kinetix-wiki-article-v1"),
    idempotencyKey: z.string().trim().min(1).max(200),
    articleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime({ offset: true }),
    page: z
      .object({
        slug: z.string().trim().min(1).max(300),
        id: z.number().int().positive().optional(),
      })
      .strict(),
    sources: z.array(source).min(1).max(200),
    sections: z
      .array(
        z
          .object({
            key,
            sectionId: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
              .optional(),
            heading: z.string().trim().min(1).max(500),
            level: z.union([z.literal(2), z.literal(3)]),
            facts: z
              .array(
                z
                  .object({
                    key,
                    statement: z.string().trim().min(1).max(2000),
                    sourceKeys: z.array(key).min(1).max(20),
                    // Locators are evidence notes, never an assertion that a paper was read.
                    evidence: z
                      .array(
                        z
                          .object({
                            sourceKey: key,
                            locator: z.string().trim().min(1).max(500),
                          })
                          .strict(),
                      )
                      .max(20)
                      .optional(),
                  })
                  .strict(),
              )
              .max(500),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    blockedCandidates: z
      .array(
        z
          .object({
            sectionKey: key,
            statement: z.string().trim().min(1).max(2000),
            reason: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) issue(`Duplicate ${label}`);
    };
    unique(
      bundle.sources.map((s) => s.key),
      "source key",
    );
    unique(
      bundle.sections.map((s) => s.key),
      "section key",
    );
    unique(
      bundle.sections.flatMap((s) => (s.sectionId ? [s.sectionId] : [])),
      "sectionId",
    );
    const facts = bundle.sections.flatMap((s) => s.facts);
    if (facts.length < 1 || facts.length > 500) issue("Expected 1–500 facts");
    unique(
      facts.map((f) => f.key),
      "fact key",
    );
    const sources = new Set(bundle.sources.map((s) => s.key));
    for (const fact of facts) {
      unique(fact.sourceKeys, "sourceKeys");
      if (fact.sourceKeys.some((k) => !sources.has(k)))
        issue(`Unknown source on ${fact.key}`);
      if (fact.evidence?.some((e) => !fact.sourceKeys.includes(e.sourceKey)))
        issue(`Uncited evidence on ${fact.key}`);
    }
    const sections = new Set(bundle.sections.map((s) => s.key));
    if (bundle.blockedCandidates?.some((b) => !sections.has(b.sectionKey)))
      issue("Unknown blocked section");
  });

export type WikiArticleBundle = z.infer<typeof wikiArticleSchema>;

export interface WikiArticlePlan {
  fingerprint: string;
  pageId: number;
  title: string;
  sections: Array<{
    key: string;
    sectionId: string;
    heading: string;
    level: number;
    create: boolean;
    facts: WikiArticleBundle["sections"][number]["facts"];
  }>;
  factCount: number;
  newSectionCount: number;
  blockedCount: number;
}
