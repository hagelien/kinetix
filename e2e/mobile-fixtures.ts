import type { Page } from "@playwright/test";
import type { DrugRow, MethodRow } from "../src/lib/drugApi";
import type { ParameterSummary } from "../src/lib/parameterEntryAggregation";
import type { WikiPageFull } from "../src/lib/wikiApi";

/**
 * Synthetic, local-only fixtures for the M00 mobile characterization suite.
 * These values are UI test inputs, not pharmacological reference data. No
 * request is forwarded to a server, including unsupported API calls/writes.
 */
export const MOBILE_FIXTURE_DATE = "2026-10-23T08:00:00.000Z";
export const MOBILE_REFERENCE = {
  id: 910001,
  drugId: 900001,
  type: "freetext",
  identifier: "Synthetic mobile audit reference — not scientific evidence",
  metadata: {
    title: "Synthetic mobile audit reference — not scientific evidence",
    authors: ["Fixture Author"],
    journal: "UI fixture",
    year: 2026,
    volume: null,
    pages: null,
  },
  createdAt: MOBILE_FIXTURE_DATE,
  createdBy: null,
  needsFullReview: false,
};

function summary(min: number, max: number, unit: string): ParameterSummary {
  return {
    representative: (min + max) / 2,
    iqrLow: min,
    iqrHigh: max,
    min,
    max,
    unit,
    entryCount: 1,
    pooledCount: 1,
    contributingCitationIds: [MOBILE_REFERENCE.id],
    byMatrix: [],
    points: [
      {
        matrix: null,
        low: min,
        high: max,
        representative: (min + max) / 2,
        qualifier: null,
        citationId: MOBILE_REFERENCE.id,
        entryId: 920001,
        unit,
      },
    ],
    normalizedToWholeBlood: false,
  };
}

type MobileDrug = DrugRow & {
  bloodDetectionWindow?: { min: number; max: number; unit: string };
  oralFluidDetectionWindow?: { min: number; max: number; unit: string };
  urineDetectionWindow?: { min: number; max: number; unit: string };
};

function makeDrug(id: number, suffix: string): MobileDrug {
  const first = id === 900001;
  return {
    id,
    slug: `mobile-${suffix.toLowerCase()}`,
    monographSlug: `mobile-${suffix.toLowerCase()}`,
    names: { nb: `Mobiltest ${suffix}`, en: `Mobiltest ${suffix}` },
    nameShort: null,
    aliases: [`Søvnprøve ${suffix}`, `Mobile fixture ${suffix}`],
    // No synthetic ID is advertised as a real PubChem compound.
    pubchemCid: null,
    molecularWeight: first ? 200 : 300,
    halfLife: { min: first ? 2 : 5, max: first ? 4 : 8, unit: "h" },
    volumeOfDistribution: { min: 1, max: 2, unit: "L/kg" },
    bioavailability: { min: 60, max: 80, unit: "%" },
    proteinBinding: { min: 25, max: 50, unit: "%" },
    bloodPlasmaRatio: { min: 0.8, max: 1.2 },
    tmax: { min: 1, max: 2, unit: "h" },
    pKa: null,
    therapeuticConcentration: { min: 0.1, max: 0.3, unit: "mg/L" },
    toxicConcentration: first ? { min: 0.8, max: 1.2, unit: "mg/L" } : null,
    fatalConcentration: null,
    popularityScore: 1_000_000 - id,
    searchKey: null,
    metabolism: null,
    receptorTargets: [],
    ionizationConstants: [],
    bloodDetectionWindow: { min: 8, max: 12, unit: "h" },
    oralFluidDetectionWindow: { min: 12, max: 24, unit: "h" },
    urineDetectionWindow: { min: 24, max: 48, unit: "h" },
    parameterSummaries: {
      halfLife: summary(first ? 2 : 5, first ? 4 : 8, "h"),
      bloodDetectionWindow: summary(8, 12, "h"),
      oralFluidDetectionWindow: summary(12, 24, "h"),
      urineDetectionWindow: summary(24, 48, "h"),
    },
    createdAt: MOBILE_FIXTURE_DATE,
    updatedAt: MOBILE_FIXTURE_DATE,
  };
}

export const MOBILE_DRUGS = [makeDrug(900001, "A"), makeDrug(900002, "B")];
export const MOBILE_DRUG_NAMES = MOBILE_DRUGS.map((drug) => drug.names.en);

// The existing ethanol workflow resolves its engine identity through CID 702.
// Keep that lookup separate from the two-drug synthetic catalog: it supplies
// identity only, never invented pharmacokinetic values to the scientific model.
export const MOBILE_ETHANOL: DrugRow = {
  id: 990702,
  slug: "ethanol",
  monographSlug: null,
  names: { nb: "Etanol", en: "Ethanol" },
  nameShort: null,
  aliases: ["EtOH"],
  pubchemCid: 702,
  molecularWeight: 46.07,
  halfLife: null,
  volumeOfDistribution: null,
  bioavailability: null,
  proteinBinding: null,
  bloodPlasmaRatio: null,
  tmax: null,
  pKa: null,
  popularityScore: 0,
  searchKey: null,
  createdAt: MOBILE_FIXTURE_DATE,
  updatedAt: MOBILE_FIXTURE_DATE,
};

const SECTIONS = [
  "pd",
  "pk",
  "metabolism",
  "medical_use",
  "non_medical_use",
  "effects",
  "toxicity",
  "analytical",
  "forensic",
];

function makePage(drug: MobileDrug): WikiPageFull {
  return {
    id: drug.id + 10000,
    slug: drug.monographSlug!,
    title: drug.names.nb!,
    pageType: "drug_monograph",
    drugCid: drug.id,
    status: "published",
    updatedAt: MOBILE_FIXTURE_DATE,
    updatedBy: null,
    content: {
      version: 2,
      sections: Object.fromEntries(
        SECTIONS.map((section) => [
          section,
          {
            body: {
              type: "doc",
              content: [
                {
                  type: "fact",
                  attrs: {
                    factId: `mobile-${section}`,
                    referenceIds: [MOBILE_REFERENCE.id],
                  },
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: `Syntetisk testtekst: ${section}. Ikke faglig dokumentasjon.`,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ]),
      ),
    },
    contentHtml:
      "<p>Syntetisk monografi for mobiltest. Ikke faglig dokumentasjon.</p>" +
      SECTIONS.map(
        (section) =>
          `<section data-monograph-section="${section}">` +
          `<h2 data-monograph-section-title="${section}">${section}</h2>` +
          `<div class="monograph-fact" data-fact-id="mobile-${section}"><p>Syntetisk testtekst: ${section}. ` +
          "Oppgitt usikkerhet, prøvegrunnlag og kilder skal forbli lesbare på små skjermer. " +
          "Dette er kun testdata, ikke dokumentasjon om et legemiddel." +
          `<sup class="footnote-marker" data-reference-id="${MOBILE_REFERENCE.id}"><a>[1]</a></sup>` +
          "</p></div></section>",
      ).join(""),
  };
}

export const MOBILE_PAGES = MOBILE_DRUGS.map(makePage);

const METHOD: MethodRow = {
  id: 930001,
  code: "MOBILE01",
  name: "Synthetic restricted method",
  description: "Synthetic method fixture, no laboratory data",
  matrices: ["blood"],
  volumeMl: 1,
  methodType: "confirmatory",
  componentCount: 2,
  drugIds: MOBILE_DRUGS.map((drug) => drug.id),
  pubchemCids: [],
};

function parameterEntries(drug: MobileDrug) {
  return Object.entries(drug.parameterSummaries ?? {}).map(
    ([parameter, value], index) => ({
      id: 920001 + index,
      parameter,
      low: value.min,
      high: value.max,
      median: value.representative,
      qualifier: null,
      categoricalValue: null,
      unit: value.unit,
      route: null,
      matrix: null,
      scenario: null,
      n: 12,
      comments: "Syntetiske testdata, ikke faglig dokumentasjon.",
      observationContext: "Fiktivt datagrunnlag for layouttest.",
      sourceQuote: "Syntetisk sitat for mobiltest.",
      origin: "contributor",
      citationId: MOBILE_REFERENCE.id,
      citation: MOBILE_REFERENCE,
    }),
  );
}

export interface MobileApiAudit {
  /** Method and same-origin URL only; no request bodies or credentials. */
  requests: string[];
  unhandled: string[];
  mutations: string[];
}

export async function mockMobileApi(
  page: Page,
  options: { role?: "anonymous" | "admin"; catalogSize?: number } = {},
): Promise<MobileApiAudit> {
  const role = options.role ?? "anonymous";
  const admin = role === "admin";
  const audit: MobileApiAudit = { requests: [], unhandled: [], mutations: [] };
  const catalog = [...MOBILE_DRUGS];
  for (let index = 2; index < (options.catalogSize ?? 2); index++) {
    catalog.push(makeDrug(900001 + index, String(index + 1).padStart(3, "0")));
  }
  const matchesQuery = (text: string, query: string | null) =>
    !query || text.toLocaleLowerCase().includes(query.toLocaleLowerCase());

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const params = url.searchParams;
    const path = url.pathname;
    const key = `${request.method()} ${path}${url.search}`;
    audit.requests.push(key);
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() !== "GET") {
      audit.mutations.push(key);
      return reply({ error: "mobile_fixture_write_blocked" }, 405);
    }
    if (path === "/api/auth" && params.get("action") === "me") {
      return admin
        ? reply({
            user: {
              id: 990001,
              email: "mobile-fixture@example.test",
              username: "mobile-fixture",
              role: "admin",
              displayName: "Synthetic audit admin",
              enabledConcentrationUnits: ["µmol/L", "mg/L"],
              notificationSettings: null,
              favoriteParameters: [],
              groups: [],
            },
          })
        : reply({ error: "Not authenticated" }, 401);
    }
    if (path === "/api/permissions") return reply({ overrides: {} });
    if (path === "/api/recent-changes") return reply({ changes: [] });
    if (path === "/api/admin" && params.get("resource") === "nav-visibility") {
      return reply({ hiddenItems: [], updatedAt: null, updatedBy: null });
    }
    if (path === "/api/drugs") {
      const selected = [...catalog, MOBILE_ETHANOL].find(
        (drug) =>
          String(drug.id) === (params.get("id") ?? params.get("wikiDrugId")) ||
          drug.slug === params.get("slug") ||
          (drug.pubchemCid !== null &&
            String(drug.pubchemCid) === params.get("cid")),
      );
      if (
        params.has("id") ||
        params.has("wikiDrugId") ||
        params.has("slug") ||
        params.has("cid")
      ) {
        return selected
          ? reply({ drug: selected })
          : reply({ error: "Drug not found" }, 404);
      }
      const ids = params.get("ids")?.split(",").map(Number);
      const drugs = catalog.filter(
        (drug) =>
          (!ids || ids.includes(drug.id)) &&
          matchesQuery(
            [...Object.values(drug.names), ...(drug.aliases ?? [])].join(" "),
            params.get("q"),
          ),
      );
      return reply({
        drugs: drugs.slice(0, Number(params.get("limit") ?? 1000)),
      });
    }
    if (path === "/api/wiki/pages") {
      const selected = MOBILE_PAGES.find(
        (entry) =>
          entry.slug === params.get("slug") ||
          String(entry.drugCid) === params.get("drugCid"),
      );
      if (params.has("slug"))
        return selected
          ? reply({ page: selected })
          : reply({ error: "Not found" }, 404);
      if (params.has("drugCid")) return reply({ page: selected ?? null });
      return reply({
        pages: MOBILE_PAGES,
        total: MOBILE_PAGES.length,
        hasMore: false,
      });
    }
    if (path === "/api/wiki/search") {
      return reply({
        results: MOBILE_PAGES.filter((entry) =>
          matchesQuery(entry.title, params.get("q")),
        ),
      });
    }
    if (path === "/api/methods") {
      if (!admin) return reply({ methods: [], gated: true });
      if (params.has("drugId"))
        return reply({
          methods: [
            {
              ...METHOD,
              lor: 0.1,
              mkk: 0.2,
              lod: 0.05,
              unit: "mg/L",
              measurementUncertainty: 10,
            },
          ],
        });
      if (params.has("id"))
        return reply({
          method: {
            ...METHOD,
            createdAt: MOBILE_FIXTURE_DATE,
            updatedAt: MOBILE_FIXTURE_DATE,
            components: MOBILE_DRUGS.map((drug, index) => ({
              drugId: drug.id,
              lor: 0.1,
              mkk: 0.2,
              lod: 0.05,
              unit: "mg/L",
              measurementUncertainty: 10,
              sortOrder: index,
              slug: drug.slug,
              names: drug.names,
              nameShort: null,
              pubchemCid: null,
              molecularWeight: drug.molecularWeight,
            })),
          },
        });
      return reply({ methods: [METHOD], gated: false });
    }
    if (path === "/api/drug-indicators")
      return reply({
        comments: {},
        refs: {
          halfLife: [MOBILE_REFERENCE.id],
          urineDetectionWindow: [MOBILE_REFERENCE.id],
        },
      });
    if (path === "/api/verification-levels")
      return reply({
        levels: {
          halfLife: { level: 0, disputed: false },
          "mobile-pk": { level: 0, disputed: false },
        },
      });
    if (path === "/api/parameter-entries") {
      return reply({
        items: parameterEntries(
          catalog.find((drug) => String(drug.id) === params.get("drugId")) ??
            MOBILE_DRUGS[0]!,
        ).filter(
          (entry) =>
            !params.has("parameter") ||
            entry.parameter === params.get("parameter"),
        ),
      });
    }
    if (path === "/api/references") {
      if (params.get("view") === "usage")
        return reply({
          usage: [
            {
              kind: "drug",
              id: MOBILE_DRUGS[0]!.id,
              slug: "mobile-a",
              names: MOBILE_DRUGS[0]!.names,
              href: "/wiki/mobile-a/chemistry",
            },
          ],
        });
      if (params.get("view") === "index")
        return reply({
          groups: [
            {
              kind: "drug",
              key: "drug-900001",
              id: 900001,
              slug: "mobile-a",
              names: MOBILE_DRUGS[0]!.names,
              href: "/wiki/mobile-a/chemistry",
              references: [MOBILE_REFERENCE],
              totalReferences: 1,
            },
          ],
          buckets: [{ key: "drug-900001", label: "Mobiltest A", count: 1 }],
          groupBy: "drug",
          bucket: null,
          page: 1,
          pageSize: 50,
          totalPages: 1,
          totalReferences: 1,
          matchedReferences: 1,
          totalRows: 1,
          rangeStart: 1,
          rangeEnd: 1,
        });
      if (params.has("id")) return reply({ reference: MOBILE_REFERENCE });
      if (params.get("view") === "search")
        return reply({
          references: matchesQuery(MOBILE_REFERENCE.identifier, params.get("q"))
            ? [
                {
                  ...MOBILE_REFERENCE,
                  matchRank: 3,
                  matchSource: "metadata",
                  reviewSnippet: null,
                },
              ]
            : [],
        });
      return reply({ references: [MOBILE_REFERENCE] });
    }
    if (path === "/api/reference-concentrations") {
      if (params.has("drugIds")) return reply({ itemsByDrugId: {} });
      return reply({ items: [] });
    }
    if (path === "/api/pm-concentrations") {
      if (!admin) return reply({ sources: [], distributions: [], gated: true });
      return reply({
        gated: false,
        sources: [
          {
            key: "mobile-fixture",
            citation: MOBILE_REFERENCE.identifier,
            shortLabel: "Synthetic cohort",
            heading: "Synthetic cohort for UI testing",
            matrix: "whole_blood",
            unit: "mg/L",
            description: "No patient or laboratory records.",
            caveats: ["Synthetic data; not scientific evidence."],
          },
        ],
        distributions: [
          {
            sourceKey: "mobile-fixture",
            drugId: 900001,
            pubchemCid: null,
            analyte: "Mobiltest A",
            n: 20,
            loq: 0.01,
            mean: 0.2,
            median: 0.1,
            p90: 0.4,
            p95: 0.6,
            p975: null,
            tcPlasma: null,
            medianOverTc: null,
            anomaly: null,
            undrawable: [],
            printed: {},
            reviewNote: null,
          },
        ],
      });
    }
    if (path === "/api/lab-detection-times")
      return reply({
        source: {
          title: "",
          documentId: "",
          version: "",
          approvedFrom: "",
          unit: "",
          classification: "",
        },
        preamble: "",
        rows: [],
        gated: true,
      });
    if (path === "/api/pending-edits")
      return admin
        ? reply(
            params.get("countOnly") === "true"
              ? { count: 0 }
              : { pendingEdits: [] },
          )
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/parameter-priority-flags")
      return admin
        ? reply({ flags: [] })
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/notifications")
      return admin
        ? reply({ notifications: [], unreadCount: 0 })
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/simulator/cases")
      return admin
        ? reply({ cases: [] })
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/paper-reviews") return reply({ review: null });
    if (path === "/api/pdf-requests" && params.get("countOnly") === "true")
      return admin
        ? reply({ count: 0 })
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/pdf-inbox" && params.get("countOnly") === "1")
      return admin
        ? reply({ count: 0 })
        : reply({ error: "Not authenticated" }, 401);
    if (path === "/api/drug-discussions") return reply({ discussions: [] });

    audit.unhandled.push(key);
    return reply(
      { error: "mobile_fixture_unhandled_endpoint", request: key },
      501,
    );
  });
  return audit;
}
