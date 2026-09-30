import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  CONVERSATION_INGESTION_SCHEMA_VERSION,
  parseConversationIngestion,
  renderWarning,
} from './conversationIngestion';

const DIGEST = 'a'.repeat(64);

function source(over: Record<string, unknown> = {}) {
  return {
    key: 'S1',
    type: 'pmid',
    identifier: '2719903',
    metadata: {
      title:
        'The bioavailability and pharmacokinetics of morphine after intravenous, oral and buccal administration in healthy volunteers.',
      journal: 'Br J Clin Pharmacol',
      year: 1989,
    },
    verification: {
      readInFull: true,
      locator: 'Results, p. 501',
      evidenceSummary:
        'Absolute bioavailability of morphine from an oral aqueous solution was 23.9% in six healthy volunteers.',
      reviewMarkdown:
        'Crossover bioavailability study in six healthy volunteers; differential radioimmunoassay.',
      reviewConfidence: 'medium',
    },
    ...over,
  };
}

// Parameters whose registry spec declares requiresMinMax (src/lib/drugParameters.ts):
// an entry backing one of these needs both low and high, not a lone median.
const REQUIRES_MIN_MAX = new Set([
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
]);

function parameterItem(over: Record<string, unknown> = {}) {
  const merged = {
    type: 'parameter_observation',
    target: { drugName: 'Morphine', pubchemCid: 5288826 },
    parameter: 'bioavailability',
    median: 0.239,
    unit: 'fraction',
    n: 6,
    sourceKey: 'S1',
    context: {
      analyte: 'morphine',
      route: 'oral',
      formulation: 'aqueous solution',
      population: 'healthy volunteers',
      species: 'Homo sapiens',
      studyDesign: 'crossover',
      studyArm: 'oral solution',
      derivation: { kind: 'reported' },
    },
    editSummary: 'Absolutt oral biotilgjengelighet fra vandig løsning.',
    ...over,
  };
  // Fill in a narrow low/high bracket around the median for a requiresMinMax
  // parameter, unless the caller already supplied its own (explicitly, or by
  // omitting median to test the shape/invariant rules directly).
  const untyped = merged as Record<string, unknown>;
  if (
    REQUIRES_MIN_MAX.has(untyped.parameter as string) &&
    untyped.low === undefined &&
    untyped.high === undefined &&
    typeof untyped.median === 'number'
  ) {
    return {
      ...merged,
      low: untyped.median - Math.abs(untyped.median) * 0.1,
      high: untyped.median + Math.abs(untyped.median) * 0.1,
    };
  }
  return merged;
}

function bundle(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: CONVERSATION_INGESTION_SCHEMA_VERSION,
    idempotencyKey: 'conv-2026-08-06-morphine-01',
    mode: 'auto',
    conversationDigest: DIGEST,
    createdAt: '2026-08-06T10:00:00Z',
    sources: [source()],
    items: [parameterItem()],
    ...over,
  };
}

/** The first error, for tests that assert on a single specific failure. */
function errorsOf(result: ReturnType<typeof parseConversationIngestion>) {
  return result.ok ? [] : result.errors;
}

describe('parseConversationIngestion — envelope', () => {
  it('accepts a minimal well-formed bundle', () => {
    const result = parseConversationIngestion(bundle());
    expect(errorsOf(result)).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
    expect(result.data.sources[0]!.identifier).toBe('2719903');
  });

  it('names the invented shape instead of drowning it in key errors', () => {
    // The shape a chat model actually produced when it had no contract to
    // follow — the failure this validator exists to make loud.
    const result = parseConversationIngestion({
      kinetix_import_version: '1.0',
      action: 'upsert_wiki_content',
      review_required: true,
      topic: { slug: 'interpretation-of-morphine-codeine-and-glucuronides' },
      interpretation_en: { summary: 'The findings establish exposure…' },
      confidence: { codeine_related_exposure: 'high' },
    });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]).toContain('is not a');
    expect(errorsOf(result)[0]).toContain('kinetix_import_version');
    expect(errorsOf(result)[0]).toContain('example-bundle.json');
  });

  it('rejects unrecognized top-level keys', () => {
    const result = parseConversationIngestion(
      bundle({ decision_rules: [{ rule_id: 'x' }] }),
    );
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/decision_rules/);
  });

  it('rejects a wrong schemaVersion', () => {
    const result = parseConversationIngestion(
      bundle({ schemaVersion: 'kinetix-conversation-ingestion-v2' }),
    );
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/schemaVersion/);
  });

  it('requires a 64-char hex conversation digest', () => {
    const result = parseConversationIngestion(
      bundle({ conversationDigest: 'not-a-digest' }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/hex digest/);
  });

  it('rejects a bundle with neither items nor blockedCandidates', () => {
    const result = parseConversationIngestion(
      bundle({ items: [], sources: [] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/neither items nor blocked/);
  });

  it('accepts a bundle that only reports blockers', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [],
        sources: [],
        blockedCandidates: [
          {
            summary:
              'Marked predominance of morphine glucuronides over codeine-related analytes favours a morphine source beyond codeine metabolism.',
            blocker:
              'No primary source resolved that quantifies the discriminating ratio; interpretation rests on conversation reasoning only.',
          },
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.ok && result.data.blockedCandidates).toHaveLength(1);
  });
});

describe('parseConversationIngestion — privacy invariant', () => {
  it('refuses a raw conversation', () => {
    const result = parseConversationIngestion(
      bundle({ conversation: [{ role: 'user', content: 'hei' }] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/forbidden key "conversation"/);
  });

  it('refuses an embedded case example', () => {
    const result = parseConversationIngestion(
      bundle({
        caseExample: { measurements: [{ analyte: 'morphine', value: 0.055 }] },
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/forbidden key "caseExample"/);
  });

  it('refuses a national identity number anywhere in the document', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [
          parameterItem({
            comments: 'Avdøde 01019012345, obduksjon utført ved OUS.',
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/national identity number/);
  });

  it('warns about a day-precision date but still parses', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [parameterItem({ comments: 'Prøve tatt 12.03.2024.' })],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/day-precision date/);
  });

  it('does not flag the bundle timestamp as a date leak', () => {
    const result = parseConversationIngestion(bundle());
    expect(result.warnings.join('\n')).not.toMatch(/day-precision date/);
  });
});

describe('parseConversationIngestion — sources', () => {
  it('normalizes a prefixed PMID and lowercases a DOI', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ identifier: 'PMID: 2719903' }),
          source({
            key: 'S2',
            type: 'doi',
            identifier: 'https://doi.org/10.1016/J.FORSCIINT.2021.111094',
          }),
        ],
        items: [parameterItem(), parameterItem({ sourceKey: 'S2' })],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.data.sources[0]!.identifier).toBe('2719903');
    expect(result.data.sources[1]!.identifier).toBe(
      '10.1016/j.forsciint.2021.111094',
    );
  });

  it('rejects an identifier that is not the type it claims', () => {
    const result = parseConversationIngestion(
      bundle({ sources: [source({ identifier: 'Hoskin et al. 1989' })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/not a valid PMID/);
  });

  it('has no freetext source type — an unresolvable source cannot back an item', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source({ type: 'freetext', identifier: 'Baselt, 12th ed.' })],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate source keys', () => {
    const result = parseConversationIngestion(
      bundle({ sources: [source(), source()] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/duplicate source key/);
  });

  it('refuses a parameter observation citing a source that was not read in full', () => {
    // A parameter observation is written straight into the aggregate, and this
    // path has no queued form of that write — so an unread source is still
    // fatal here, unlike for a wiki fact.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({
            verification: {
              ...source().verification,
              readInFull: false,
            },
            pdfRequestNeeded: true,
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/readInFull: false/);
    expect(errorsOf(result).join('\n')).toMatch(/parameter_observation may not/);
    expect(errorsOf(result).join('\n')).toMatch(/blockedCandidates/);
  });

  it('refuses an item citing an undeclared source key', () => {
    const result = parseConversationIngestion(
      bundle({ items: [parameterItem({ sourceKey: 'S9' })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/"S9" is not declared/);
  });

  it('warns about a declared but uncited source', () => {
    const result = parseConversationIngestion(
      bundle({ sources: [source(), source({ key: 'S2' })] }),
    );
    expect(result.warnings.join('\n')).toMatch(/never cited/);
  });

  it('warns when a PDF request is paired with a full-text attestation', () => {
    const result = parseConversationIngestion(
      bundle({ sources: [source({ pdfRequestNeeded: true })] }),
    );
    expect(result.warnings.join('\n')).toMatch(/pdfRequestNeeded/);
  });
});

describe('parseConversationIngestion — parameter observations', () => {
  it('enforces the live registry unit', () => {
    const result = parseConversationIngestion(
      bundle({ items: [parameterItem({ unit: 'percent' })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/not valid for bioavailability/);
  });

  it('enforces registry bounds', () => {
    const result = parseConversationIngestion(
      bundle({ items: [parameterItem({ median: 23.9 })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/outside the allowed range/);
  });

  it('rejects an unknown parameter id', () => {
    const result = parseConversationIngestion(
      bundle({ items: [parameterItem({ parameter: 'morphineCodeineRatio' })] }),
    );
    expect(result.ok).toBe(false);
  });

  it('requires a matrix for a matrix-relevant parameter', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [
          parameterItem({
            parameter: 'therapeuticConcentration',
            median: undefined,
            low: 0.01,
            high: 0.12,
            unit: 'mg/L',
            scenario: 'living_therapeutic',
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/biological matrix is required/);
  });

  it('rejects a matrix on a matrix-independent parameter', () => {
    const result = parseConversationIngestion(
      bundle({ items: [parameterItem({ matrix: 'whole_blood' })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/matrix-independent/);
  });

  it('enforces the shared value invariants', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [parameterItem({ median: undefined, low: 0.5, high: 0.2 })],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/low cannot be greater/);
  });

  it('rejects a censored entry carrying a range', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [
          parameterItem({
            median: undefined,
            low: 0.1,
            high: 0.3,
            qualifier: '<',
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/single threshold value/);
  });

  it('warns when the drug is identified by name alone', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [parameterItem({ target: { drugName: 'Morphine' } })],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(/name only/);
  });

  it('warns when a derived value records no assumptions', () => {
    const result = parseConversationIngestion(
      bundle({
        items: [
          parameterItem({
            context: {
              ...parameterItem().context,
              derivation: { kind: 'calculated', equation: 'AUCpo/AUCiv' },
            },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(/no assumptions/);
  });
});

describe('parseConversationIngestion — corroboration', () => {
  function secondSource(over: Record<string, unknown> = {}) {
    return source({
      key: 'S2',
      identifier: '10201674',
      metadata: { journal: 'Anesthesiology', year: 1999 },
      ...over,
    });
  }

  it('warns when a parameter rests on a single source', () => {
    const result = parseConversationIngestion(bundle());
    expect(result.warnings.join('\n')).toMatch(/at least two independent sources/);
    expect(result.warnings.join('\n')).toMatch(/bioavailability for Morphine/);
  });

  it('is satisfied by a second observation citing a different source', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, n: 5, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('is not satisfied by two arms of the same paper', () => {
    // Two study arms are two observations but one reading of one dataset — the
    // whole point of the rule is that a second dataset has to exist.
    const result = parseConversationIngestion(
      bundle({
        items: [parameterItem(), parameterItem({ median: 0.224 })],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(/across 2 observations/);
  });

  it('counts papers, not source keys', () => {
    // The same paper declared twice — once by PMID, once by the DOI it lists as
    // an alt id — is two bundle keys and one citation.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ altIds: { doi: '10.1111/j.1365-2125.1989.tb05399.x' } }),
          secondSource({
            type: 'doi',
            identifier: '10.1111/j.1365-2125.1989.tb05399.x',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts papers when the stronger handle is the alternate one', () => {
    // Declared by DOI with the PMID in altIds, against the same paper declared
    // by that PMID. `normalizeSource` drops the winning handle from the row it
    // returns, so identity has to be read from what the bundle declared.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({
            type: 'doi',
            identifier: '10.1111/j.1365-2125.1989.tb05399.x',
            altIds: { pmid: '2719903' },
          }),
          secondSource({ identifier: '2719903' }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts papers when two sources share an alternate handle of one type', () => {
    // canonicalCitationHandle drops an alt sharing the winner's type, so a
    // label reachable at two URLs has to be linked from the declared handles.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({
            type: 'url',
            identifier: 'https://example.org/label-a',
            altIds: { url: 'https://example.org/label-b' },
          }),
          secondSource({
            type: 'url',
            identifier: 'https://example.org/label-b',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts a resolver URL as the paper it resolves to', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ type: 'doi', identifier: '10.1111/j.1365-2125.1989.tb05399.x' }),
          secondSource({
            type: 'url',
            identifier: 'https://doi.org/10.1111/j.1365-2125.1989.tb05399.x',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts a resolver URL declared as a DOI as that DOI', () => {
    // `type: "doi"` with the doi.org address as its identifier passes the DOI
    // shape check, tracking parameter and all — the resolver has to be read
    // from the raw value, not from the handle's declared type.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({
            type: 'doi',
            identifier:
              'https://doi.org/10.1111/j.1365-2125.1989.tb05399.x?utm_source=x',
          }),
          secondSource({
            type: 'doi',
            identifier: '10.1111/j.1365-2125.1989.tb05399.x',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts two fragments of one document as one source', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ type: 'url', identifier: 'https://example.org/paper#results' }),
          secondSource({
            type: 'url',
            identifier: 'https://example.org/paper#table-2',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('keeps two URLs apart when they differ by more than a fragment', () => {
    // A query string can select a different article, so it stays identity.
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ type: 'url', identifier: 'https://example.org/paper?id=1' }),
          secondSource({
            type: 'url',
            identifier: 'https://example.org/paper?id=2',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('counts a PubMed URL as the PMID it resolves to', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source(),
          secondSource({
            type: 'url',
            identifier: 'https://pubmed.ncbi.nlm.nih.gov/2719903/',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('counts a PMC article URL as the article its PMCID names', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [
          source({ altIds: { pmcid: 'PMC1379730' } }),
          secondSource({
            type: 'url',
            identifier: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1379730/',
          }),
        ],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2' }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(
      /"S1" and "S2" resolve to the same citation/,
    );
  });

  it('keeps one drug id apart from itself when it claims two CIDs', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem({
            target: { drugId: 7, pubchemCid: 5288826, drugName: 'Morphine' },
          }),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            target: { drugId: 7, pubchemCid: 5462328, drugName: 'Morphine' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n').match(/rests on a single source/g)).toHaveLength(2);
  });

  it('does not let a unit family that cannot convert stand in as corroboration', () => {
    // L/h and L/h/kg differ by a body weight no entry carries, so downstream
    // aggregation keeps only one of them — the pair is one usable source.
    const clearance = (over: Record<string, unknown> = {}) =>
      parameterItem({ parameter: 'clearance', median: 60, unit: 'L/h', ...over });
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          clearance(),
          clearance({ median: 0.9, unit: 'L/h/kg', sourceKey: 'S2' }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    // The L/h side is left single-sourced; the L/h/kg side never reaches the
    // aggregate at all, which is worth saying rather than asking for a third.
    expect(warned).toMatch(/clearance for Morphine rests on a single source/);
    expect(warned).toMatch(
      /reported in "L\/h\/kg", which does not convert to the parameter's canonical "L\/h"/,
    );
  });

  it('names a unit that cannot reach the aggregate however many sources back it', () => {
    const dose = (over: Record<string, unknown> = {}) =>
      parameterItem({
        parameter: 'fatalDose',
        median: 5,
        unit: 'mg/kg/day',
        ...over,
      });
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [dose(), dose({ median: 7, sourceKey: 'S2' })],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned).toMatch(/no observation in this unit reaches the aggregate/);
    expect(warned).not.toMatch(/rests on a single source/);
  });

  it('pools units that differ only by scale', () => {
    const dose = (over: Record<string, unknown> = {}) =>
      parameterItem({ parameter: 'fatalDose', median: 200, unit: 'mg', ...over });
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [dose(), dose({ median: 0.5, unit: 'g', sourceKey: 'S2' })],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('does not let context text containing the key delimiter collide', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem({
            context: {
              ...parameterItem().context,
              species: 'Homo sapiens|morphine',
              analyte: 'parent',
            },
          }),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: {
              ...parameterItem().context,
              species: 'Homo sapiens',
              analyte: 'morphine|parent',
            },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n').match(/rests on a single source/g)).toHaveLength(2);
  });

  it('keeps contradictory drug identifiers apart instead of merging them', () => {
    // One CID claimed by two confirmed drug ids is contradictory data, not a
    // crosswalk: trusting it would pool two registry drugs into one pair.
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem({
            target: { drugId: 7, pubchemCid: 5288826, drugName: 'Morphine' },
          }),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            target: { drugId: 8, pubchemCid: 5288826, drugName: 'Morphine' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n').match(/rests on a single source/g)).toHaveLength(2);
  });

  it('does not let a metabolite corroborate its parent drug', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: {
              ...parameterItem().context,
              analyte: 'morphine-6-glucuronide',
            },
          }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned).toMatch(/morphine\) for Morphine rests on a single source/);
    expect(warned).toMatch(/morphine-6-glucuronide\) for Morphine/);
  });

  it('does not split on salt form, which two studies of one quantity may differ on', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem({
            context: { ...parameterItem().context, saltOrForm: 'morphine sulfate' },
          }),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: {
              ...parameterItem().context,
              saltOrForm: 'morphine sulfate pentahydrate',
            },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('does not let another species stand in as corroboration', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: { ...parameterItem().context, species: 'Rattus norvegicus' },
          }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned).toMatch(/bioavailability \(Homo sapiens\) for Morphine/);
    expect(warned).toMatch(/bioavailability \(Rattus norvegicus\) for Morphine/);
  });

  it('folds spellings of one species rather than splitting on them', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: { ...parameterItem().context, species: 'humans' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('does not split on species one of the two observations left unstated', () => {
    const { species: _species, ...context } = parameterItem().context;
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({ median: 0.34, sourceKey: 'S2', context }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('reconciles drug targets that carry different identifier forms', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem({
            target: { drugId: 7, pubchemCid: 5288826, drugName: 'Morphine' },
          }),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            target: { pubchemCid: 5288826, drugName: 'Morphine' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('keeps two drugs apart when one display name covers both', () => {
    // A name is not identity: two confirmed CIDs under one label are two drugs.
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            target: { pubchemCid: 5462328, drugName: 'Morphine' },
          }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned.match(/rests on a single source/g)).toHaveLength(2);
  });

  it('does not let another route corroborate a route-dependent parameter', () => {
    // The registry defines bioavailability as ORAL bioavailability; a buccal
    // value is a different quantity, not a second reading of the same one.
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.187,
            sourceKey: 'S2',
            context: { ...parameterItem().context, route: 'buccal' },
          }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned).toMatch(/bioavailability \(oral\) for Morphine/);
    expect(warned).toMatch(/bioavailability \(buccal\) for Morphine/);
  });

  it('folds spellings of one route rather than splitting on them', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            median: 0.34,
            sourceKey: 'S2',
            context: { ...parameterItem().context, route: 'per oral' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('pools routes for a parameter that is a property of the drug', () => {
    // Half-life is not route-specific the way bioavailability is — an oral and
    // an intravenous study are two readings of one quantity.
    const halfLife = (over: Record<string, unknown> = {}) =>
      parameterItem({
        parameter: 'halfLife',
        median: 2.5,
        unit: 'h',
        ...over,
      });
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          halfLife(),
          halfLife({
            median: 2.9,
            sourceKey: 'S2',
            context: { ...parameterItem().context, route: 'intravenous' },
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/two independent sources/);
  });

  it('does not let a different parameter or scenario stand in as corroboration', () => {
    const result = parseConversationIngestion(
      bundle({
        sources: [source(), secondSource()],
        items: [
          parameterItem(),
          parameterItem({
            parameter: 'halfLife',
            median: 2.5,
            unit: 'h',
            sourceKey: 'S2',
          }),
        ],
      }),
    );
    const warned = result.warnings.join('\n');
    expect(warned).toMatch(/bioavailability for Morphine rests on a single source/);
    expect(warned).toMatch(/halfLife for Morphine rests on a single source/);
  });
});

describe('parseConversationIngestion — wiki facts', () => {
  function wikiFact(over: Record<string, unknown> = {}) {
    return {
      type: 'wiki_fact',
      target: {
        pageType: 'monograph',
        drug: { drugName: 'Morphine', pubchemCid: 5288826 },
        sectionId: 'forensic',
      },
      operation: 'add',
      statement:
        'Graden av postmortal omfordeling av morfin påvirkes av forråtnelsesgrad, likets leie ved funn, administrasjonsvei og forsøk på gjenoppliving.',
      sourceKeys: ['S1'],
      editSummary: 'Ny setning om variabler som påvirker C/P-forholdet.',
      ...over,
    };
  }

  it('accepts a well-formed additive monograph fact', () => {
    const result = parseConversationIngestion(
      bundle({ mode: 'monograph', items: [wikiFact()] }),
    );
    expect(errorsOf(result)).toEqual([]);
  });

  it('accepts a fact citing a source that was not read in full, and warns', () => {
    // The claim the assistant could not verify. It is no longer forced out of
    // the bundle: Kinetix carries it across as a review-queue proposal, and the
    // warning is what tells the operator it will not be published.
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [wikiFact()],
        sources: [
          source({
            verification: { ...source().verification, readInFull: false },
            pdfRequestNeeded: true,
          }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /cites "S1", which was not read in full/,
    );
    expect(result.ok && result.warningDetails.map((w) => w.code)).toContain(
      'item_unverified_sources',
    );
  });

  it('warns only for the unread sources a fact actually cites', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [wikiFact({ sourceKeys: ['S1', 'S2'] })],
        sources: [
          source(),
          source({
            key: 'S2',
            identifier: '9061094',
            verification: { ...source().verification, readInFull: false },
          }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    const unverified = result.warningDetails.find(
      (w) => w.code === 'item_unverified_sources',
    );
    expect(unverified?.params).toMatchObject({ keys: '"S2"', count: 1 });
  });

  it('does not warn when every cited source was read in full', () => {
    const result = parseConversationIngestion(
      bundle({ mode: 'monograph', items: [wikiFact()] }),
    );
    expect(result.warningDetails.map((w) => w.code)).not.toContain(
      'item_unverified_sources',
    );
  });

  it('rejects a factId on an add', () => {
    const result = parseConversationIngestion(
      bundle({ mode: 'monograph', items: [wikiFact({ factId: 'abc-123' })] }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/minted by Kinetix/);
  });

  it('requires a factId on replace and remove', () => {
    for (const operation of ['replace', 'remove'] as const) {
      const result = parseConversationIngestion(
        bundle({
          mode: 'monograph',
          items: [
            wikiFact({
              operation,
              ...(operation === 'remove' ? { statement: undefined } : {}),
            }),
          ],
        }),
      );
      expect(errorsOf(result).join('\n')).toMatch(/requires the exact factId/);
    }
  });

  it('rejects a statement on a remove', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [wikiFact({ operation: 'remove', factId: 'abc-123' })],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/must not carry a statement/);
  });

  it('rejects an unknown monograph section id', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [
          wikiFact({
            target: { ...wikiFact().target, sectionId: 'forensic_toxicology' },
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/not a monograph section id/);
  });

  it('requires a resolved page for a topic fact', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'wiki',
        items: [
          wikiFact({
            target: { pageType: 'topic', sectionId: 'tolkning' },
          }),
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/blockedCandidate, not an item/);
  });

  it('warns when a statement bundles several sentences', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [
          wikiFact({
            statement:
              'Morfin gjennomgår glukuronidering. Hovedmetabolitten er morfin-3-glukuronid.',
          }),
        ],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(/more than one sentence/);
  });

  it('warns when a replace carries no observed revision', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [wikiFact({ operation: 'replace', factId: 'abc-123' })],
      }),
    );
    expect(result.warnings.join('\n')).toMatch(/observedRevisionId/);
  });
});

describe('the shipped example bundle', () => {
  // The example is what a chat model actually copies its shape from, so it has
  // to stay valid — and clean. A warning in the canonical example teaches the
  // warned-about habit.
  it('validates with no errors and no warnings', () => {
    const raw = readFileSync(
      '.claude/skills/kinetix/reference/example-bundle.json',
      'utf8',
    );
    const result = parseConversationIngestion(JSON.parse(raw));
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('parseConversationIngestion — mode scope', () => {
  it('refuses a wiki fact in parameters mode', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'parameters',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine' },
              sectionId: 'pk',
            },
            operation: 'add',
            statement: 'Morfin har lav oral biotilgjengelighet.',
            sourceKeys: ['S1'],
            editSummary: 'test',
          },
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/not allowed in mode/);
  });

  it('refuses a parameter observation in wiki mode', () => {
    const result = parseConversationIngestion(bundle({ mode: 'wiki' }));
    expect(errorsOf(result).join('\n')).toMatch(/not allowed in mode/);
  });

  it('restricts monograph mode to monograph pages', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        items: [
          {
            type: 'wiki_fact',
            target: { pageType: 'topic', pageId: 12, sectionId: 'tolkning' },
            operation: 'add',
            statement: 'Testsetning.',
            sourceKeys: ['S1'],
            editSummary: 'test',
          },
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/restricts wiki facts/);
  });
});

describe('parseConversationIngestion — one paper, one attestation', () => {
  it('refuses two keys for one paper that disagree about readInFull', () => {
    // Left to run, this is settled by two rules that do not agree: routing
    // reads the key the item cites, the appraisal write takes the first key's.
    // Depending on declaration order a fact publishes while its stored review
    // says `readInFull: false`, or a verified claim is queued needlessly.
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        sources: [
          source({ key: 'S1', verification: { ...source().verification, readInFull: false } }),
          // Same PMID, declared again as read.
          source({ key: 'S2' }),
        ],
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'add',
            statement: 'En påstand.',
            sourceKeys: ['S2'],
            editSummary: 'Test.',
          },
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/disagree about readInFull/);
  });

  it('sees through a handle alias, not just an identical identifier', () => {
    // Declared by PMID under one key and by the same paper's DOI under the
    // other — one citation row, so one attestation.
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        sources: [
          source({
            key: 'S1',
            altIds: { doi: '10.1111/j.1365-2125.1989.tb05536.x' },
            verification: { ...source().verification, readInFull: false },
          }),
          source({
            key: 'S2',
            type: 'doi',
            identifier: '10.1111/j.1365-2125.1989.tb05536.x',
          }),
        ],
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'add',
            statement: 'En påstand.',
            sourceKeys: ['S2'],
            editSummary: 'Test.',
          },
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(/disagree about readInFull/);
  });

  it('allows two different papers to disagree, which is ordinary', () => {
    const result = parseConversationIngestion(
      bundle({
        mode: 'monograph',
        sources: [
          source({ key: 'S1' }),
          source({
            key: 'S2',
            identifier: '9061094',
            verification: { ...source().verification, readInFull: false },
          }),
        ],
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'add',
            statement: 'En påstand.',
            sourceKeys: ['S1', 'S2'],
            editSummary: 'Test.',
          },
        ],
      }),
    );
    expect(errorsOf(result)).toEqual([]);
  });
});

describe('parseConversationIngestion — unverified sources by item type', () => {
  it('refuses a topic-page fact citing a source that was not read in full', () => {
    // A whole new page is too much unverified content to hand a reviewer as one
    // checkbox, so the relaxation is scoped to wiki facts on existing pages.
    const result = parseConversationIngestion(
      bundle({
        mode: 'wiki',
        sources: [
          source({
            verification: { ...source().verification, readInFull: false },
          }),
        ],
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Ny side',
            slug: 'ny-side',
            categories: [],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [{ statement: 'En påstand.', sourceKeys: ['S1'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );
    expect(errorsOf(result).join('\n')).toMatch(
      /topic_page_proposal may not/,
    );
  });
});

describe('warnings carry codes as well as prose', () => {
  it('renders every code, and renders it the same way the CLI prints it', () => {
    // Every warning a Norwegian admin can see in ordinary use has to be
    // translatable, so each one carries a code; the rendered array stays
    // byte-identical so the CLI and its tests are unaffected.
    const res = parseConversationIngestion(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Ny side',
            slug: 'ny-side',
            categories: [],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [{ statement: 'En påstand.', sourceKeys: ['S1'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    expect(res.warningDetails.length).toBe(res.warnings.length);
    expect(res.warningDetails.map((w) => w.code)).toContain('new_topic_page');
    for (const [i, detail] of res.warningDetails.entries()) {
      expect(renderWarning(detail)).toBe(res.warnings[i]);
      expect(detail.where.length).toBeGreaterThan(0);
    }
  });
});
