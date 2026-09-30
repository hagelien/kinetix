import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRawComponents,
  canonicalComponent,
  diffCatalogs,
  findDuplicateCids,
  fixtureFieldForParameter,
  isCatalogInSync,
  mergeForRender,
  renderComponent,
  renderComponentsSource,
  sanitizeNameList,
  sanitizeNumber,
  sanitizeRange,
  splitComponentsSource,
  toRawComponent,
  type CatalogDrugRow,
} from './catalogExport';
import { embeddedComponents, type RawComponent } from '../../data/components';

function row(overrides: Partial<CatalogDrugRow> = {}): CatalogDrugRow {
  return {
    pubchemCid: 2118,
    names: { nb: 'Alprazolam', en: 'Alprazolam' },
    parameters: {},
    enzymes: [],
    metabolites: [],
    eliminationRoutes: [],
    ...overrides,
  };
}

describe('sanitizeRange', () => {
  it('keeps the RangeData fields and drops everything else', () => {
    expect(
      sanitizeRange({
        min: 9,
        max: 16,
        unit: 'h',
        note: 'auto-extracted',
        somethingElse: 'x',
      }),
    ).toEqual({ min: 9, max: 16, unit: 'h', note: 'auto-extracted' });
  });

  it('drops derivedFromEntries — the fixture cannot back that provenance', () => {
    const range = sanitizeRange({
      min: 1,
      max: 2,
      unit: 'mg/L',
      derivedFromEntries: true,
    });
    expect(range).toEqual({ min: 1, max: 2, unit: 'mg/L' });
    expect(range).not.toHaveProperty('derivedFromEntries');
  });

  it('carries a legacy bare number as the median', () => {
    expect(sanitizeRange(0.75)).toEqual({ median: 0.75 });
  });

  it('rejects non-finite numbers and blank strings', () => {
    expect(sanitizeRange({ min: NaN, max: Infinity, unit: '   ' })).toBeUndefined();
    expect(sanitizeRange({ median: 1, note: '  ' })).toEqual({ median: 1 });
  });

  it('returns undefined rather than an empty object', () => {
    expect(sanitizeRange({})).toBeUndefined();
    expect(sanitizeRange(null)).toBeUndefined();
    expect(sanitizeRange([1, 2])).toBeUndefined();
  });

  it('drops a free-text qualifier the fixture type cannot hold', () => {
    // Live data really carries these: migration 0078 deliberately preserved a
    // `qualifier: "approximately"` row (tests/integration/migration-0078-
    // qualifier.test.ts). Rendering it would emit a data/components.ts that
    // fails tsc, since RangeData.qualifier is '<' | '>' | '≤' | '≥'.
    expect(
      sanitizeRange({ median: 1.5, unit: 'mg/L', qualifier: 'approximately' }),
    ).toEqual({ median: 1.5, unit: 'mg/L' });
  });

  it('keeps every legitimate comparison operator', () => {
    for (const op of ['<', '>', '≤', '≥']) {
      expect(sanitizeRange({ median: 9, qualifier: op })).toEqual({
        median: 9,
        qualifier: op,
      });
    }
  });

  it('trims text fields', () => {
    expect(sanitizeRange({ median: 1, unit: ' h ', note: ' x ' })).toEqual({
      median: 1,
      unit: 'h',
      note: 'x',
    });
  });
});

describe('sanitizeNumber', () => {
  it('passes a plain number through', () => {
    expect(sanitizeNumber(308.8)).toBe(308.8);
  });

  it('recovers a representative scalar from a range-shaped value', () => {
    expect(sanitizeNumber({ median: 144.21, unit: 'g/mol' })).toBe(144.21);
    expect(sanitizeNumber({ mean: 100 })).toBe(100);
  });

  it('is undefined for unusable input', () => {
    expect(sanitizeNumber(null)).toBeUndefined();
    expect(sanitizeNumber('300')).toBeUndefined();
    expect(sanitizeNumber({ min: 1, max: 2 })).toBeUndefined();
  });
});

describe('sanitizeNameList', () => {
  it('trims, drops blanks, and de-duplicates case-insensitively', () => {
    expect(sanitizeNameList(['CYP3A4', ' cyp3a4 ', '', null, 'CYP2C9'])).toEqual([
      'CYP3A4',
      'CYP2C9',
    ]);
  });

  it('preserves the first-seen spelling and order', () => {
    expect(sanitizeNameList(['Renal', 'renal', 'Biliary'])).toEqual([
      'Renal',
      'Biliary',
    ]);
  });
});

describe('toRawComponent', () => {
  it('maps parameters onto the fixture field names', () => {
    const result = toRawComponent(
      row({
        parameters: {
          molecularWeight: 308.8,
          halfLife: { min: 9, max: 16, unit: 'h' },
          // The three interpretive bands are named differently in the registry
          // and in the fixture; this rename is the whole point of the map.
          therapeuticConcentration: { min: 0.02, max: 0.04, unit: 'mg/L' },
          toxicConcentration: { median: 0.1, unit: 'mg/L' },
          fatalConcentration: { median: 0.3, unit: 'mg/L' },
        },
      }),
    );
    expect(result).toHaveProperty('component');
    const component = (result as { component: RawComponent }).component;
    expect(component.molecularWeight).toBe(308.8);
    expect(component.halfLife).toEqual({ min: 9, max: 16, unit: 'h' });
    expect(component.therapeuticRange).toEqual({
      min: 0.02,
      max: 0.04,
      unit: 'mg/L',
    });
    expect(component.toxicRange).toEqual({ median: 0.1, unit: 'mg/L' });
    expect(component.lethalRange).toEqual({ median: 0.3, unit: 'mg/L' });
  });

  it('ignores parameters the fixture has no field for', () => {
    const result = toRawComponent(
      row({ parameters: { logP: { median: 2.1 }, clearance: { median: 5 } } }),
    );
    const component = (result as { component: RawComponent }).component;
    expect(Object.keys(component).sort()).toEqual(['name', 'nameEn', 'pubchemCid']);
  });

  it('emits metabolism only when a list has content', () => {
    const empty = toRawComponent(row()) as { component: RawComponent };
    expect(empty.component.metabolism).toBeUndefined();

    const populated = toRawComponent(
      row({ enzymes: ['CYP3A4'], eliminationRoutes: ['Renal'] }),
    ) as { component: RawComponent };
    expect(populated.component.metabolism).toEqual({
      enzymes: ['CYP3A4'],
      metabolites: [],
      eliminationRoutes: ['Renal'],
    });
  });

  it('prefers the Norwegian name and keeps an identical English one', () => {
    const result = toRawComponent(
      row({ names: { nb: 'Alprazolam', en: 'Alprazolam' } }),
    ) as { component: RawComponent };
    expect(result.component.name).toBe('Alprazolam');
    expect(result.component.nameEn).toBe('Alprazolam');
  });

  it('falls back to the English name when there is no Norwegian one', () => {
    const result = toRawComponent(row({ names: { en: 'Fentanyl' } })) as {
      component: RawComponent;
    };
    expect(result.component.name).toBe('Fentanyl');
    expect(result.component.nameEn).toBe('Fentanyl');
  });

  it('skips a drug with no pubchem CID rather than inventing one', () => {
    expect(toRawComponent(row({ pubchemCid: null }))).toEqual({
      skipped: { name: 'Alprazolam', reason: 'no-pubchem-cid' },
    });
  });

  it('skips a drug with no usable name', () => {
    expect(toRawComponent(row({ names: { nb: '   ' } }))).toEqual({
      skipped: { name: 'pubchem:2118', reason: 'no-name' },
    });
  });

  it('falls back to any language rather than dropping the drug', () => {
    // `drugs.names` is keyed by arbitrary BCP-47 code. Requiring nb or en would
    // silently exclude a live drug from the offline catalog over a language
    // key, not over missing data.
    const result = toRawComponent(row({ names: { da: 'Kodein' } })) as {
      component: RawComponent;
    };
    expect(result.component.name).toBe('Kodein');
    expect(result.component.nameEn).toBeUndefined();
  });
});

describe('fixtureFieldForParameter', () => {
  it('renames the three interpretive bands', () => {
    expect(fixtureFieldForParameter('therapeuticConcentration')).toBe(
      'therapeuticRange',
    );
    expect(fixtureFieldForParameter('toxicConcentration')).toBe('toxicRange');
    expect(fixtureFieldForParameter('fatalConcentration')).toBe('lethalRange');
  });

  it('passes every other parameter id through unchanged', () => {
    expect(fixtureFieldForParameter('halfLife')).toBe('halfLife');
    expect(fixtureFieldForParameter('molecularWeight')).toBe('molecularWeight');
    expect(fixtureFieldForParameter('logP')).toBe('logP');
  });

  it('reads the fixture keys the committed data actually uses', () => {
    // Guards the seeder: indexing the fixture by registry id returned undefined
    // for all three bands, so seeding dropped them. If this ever regresses, the
    // 68 entries carrying a band stop reaching the database again.
    const withBand = embeddedComponents.find((c) => c.lethalRange);
    expect(withBand).toBeDefined();
    const key = fixtureFieldForParameter('fatalConcentration');
    expect(
      (withBand as unknown as Record<string, unknown>)[key],
    ).toBeDefined();
  });
});

describe('buildRawComponents', () => {
  it('partitions projectable rows from skipped ones', () => {
    const { components, skipped } = buildRawComponents([
      row({ pubchemCid: 1 }),
      row({ pubchemCid: null, names: { nb: 'Nameless CID' } }),
      row({ pubchemCid: 2 }),
    ]);
    expect(components.map((c) => c.pubchemCid)).toEqual([1, 2]);
    expect(skipped).toEqual([
      { name: 'Nameless CID', reason: 'no-pubchem-cid' },
    ]);
  });
});

describe('diffCatalogs', () => {
  const file: RawComponent[] = [
    {
      name: 'Alprazolam',
      pubchemCid: 2118,
      halfLife: { min: 9, max: 16, unit: 'h' },
    },
  ];

  it('reports nothing when the two agree', () => {
    const diff = diffCatalogs(file, [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 9, max: 16, unit: 'h' },
      },
    ]);
    expect(isCatalogInSync(diff)).toBe(true);
    expect(diff.unchanged).toBe(1);
  });

  it('ignores key order and an all-empty metabolism block', () => {
    const diff = diffCatalogs(
      [
        {
          name: 'Alprazolam',
          pubchemCid: 2118,
          metabolism: { enzymes: [], metabolites: [], eliminationRoutes: [] },
          halfLife: { unit: 'h', max: 16, min: 9 },
        },
      ],
      [
        {
          name: 'Alprazolam',
          pubchemCid: 2118,
          halfLife: { min: 9, max: 16, unit: 'h' },
        },
      ],
    );
    expect(isCatalogInSync(diff)).toBe(true);
  });

  it('reports a field-level change', () => {
    const diff = diffCatalogs(file, [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 6, max: 27, unit: 'h' },
      },
    ]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.fields.map((f) => f.field)).toEqual(['halfLife']);
    expect(isCatalogInSync(diff)).toBe(false);
  });

  it('reports drugs present on only one side', () => {
    const diff = diffCatalogs(file, [
      { name: 'Fentanyl', pubchemCid: 3345 },
    ]);
    expect(diff.onlyInDb).toEqual([{ pubchemCid: 3345, name: 'Fentanyl' }]);
    expect(diff.onlyInFile).toEqual([{ pubchemCid: 2118, name: 'Alprazolam' }]);
  });

  it('treats a rename as a field change, not a delete plus an add', () => {
    const diff = diffCatalogs(file, [
      {
        name: 'Alprazolam (renamed)',
        pubchemCid: 2118,
        halfLife: { min: 9, max: 16, unit: 'h' },
      },
    ]);
    expect(diff.onlyInDb).toHaveLength(0);
    expect(diff.onlyInFile).toHaveLength(0);
    expect(diff.changed[0]!.fields).toEqual([
      { field: 'name', file: 'Alprazolam', db: 'Alprazolam (renamed)' },
    ]);
  });

  it('is stable against a round trip through the projection', () => {
    const { components } = buildRawComponents([
      row({
        parameters: { halfLife: { min: 9, max: 16, unit: 'h' } },
      }),
    ]);
    const diff = diffCatalogs(components, components);
    expect(isCatalogInSync(diff)).toBe(true);
  });
});

describe('drift-check convergence', () => {
  // The gate asks one question: "would `catalog:export` change this file?" So
  // it must diff against the MERGE result, not the raw projection. Diffing the
  // raw projection reports everything the merge deliberately preserves as drift
  // a refresh cannot clear — the exporter would say "already up to date" while
  // the check stayed red forever.
  const fixture: RawComponent[] = [
    {
      name: 'Alprazolam',
      pubchemCid: 2118,
      halfLife: { min: 9, max: 16, unit: 'h' },
      lethalRange: { median: 1020, unit: 'mg/kg' }, // never reached the DB
    },
    { name: 'Bare i fixturen', pubchemCid: 999 }, // never seeded
  ];
  const db: RawComponent[] = [
    {
      name: 'Alprazolam',
      pubchemCid: 2118,
      halfLife: { min: 9, max: 16, unit: 'h' },
    },
  ];

  it('does not report preserved fixture-only data as drift', () => {
    const merged = mergeForRender(fixture, db).components;
    expect(isCatalogInSync(diffCatalogs(fixture, merged))).toBe(true);
  });

  it('still reports a genuine database change', () => {
    const changedDb: RawComponent[] = [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 6, max: 27, unit: 'h' },
      },
    ];
    const merged = mergeForRender(fixture, changedDb).components;
    const diff = diffCatalogs(fixture, merged);
    expect(isCatalogInSync(diff)).toBe(false);
    expect(diff.changed[0]!.fields.map((f) => f.field)).toEqual(['halfLife']);
  });

  it('still reports a drug new to the database', () => {
    const merged = mergeForRender(fixture, [
      ...db,
      { name: 'Ny', pubchemCid: 123 },
    ]).components;
    const diff = diffCatalogs(fixture, merged);
    expect(diff.onlyInDb).toEqual([{ pubchemCid: 123, name: 'Ny' }]);
  });

  it('converges — a second check after a refresh is clean', () => {
    const changedDb: RawComponent[] = [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 6, max: 27, unit: 'h' },
      },
      { name: 'Ny', pubchemCid: 123 },
    ];
    // First pass: the refresh the CLI would write.
    const refreshed = mergeForRender(fixture, changedDb).components;
    expect(isCatalogInSync(diffCatalogs(fixture, refreshed))).toBe(false);

    // Second pass: re-run the check with the refreshed file as the fixture.
    const secondMerge = mergeForRender(refreshed, changedDb).components;
    expect(isCatalogInSync(diffCatalogs(refreshed, secondMerge))).toBe(true);
  });
});

describe('canonicalComponent', () => {
  it('drops a note that is only whitespace', () => {
    const canon = canonicalComponent({
      name: 'X',
      pubchemCid: 1,
      halfLife: { median: 2, note: '   ' },
    });
    expect(canon.get('halfLife')).toEqual({ median: 2 });
  });
});

describe('renderComponent', () => {
  it('renders a compact entry in fixture style', () => {
    expect(
      renderComponent({
        name: 'Amfetamin',
        nameEn: 'Amphetamine',
        pubchemCid: 3007,
        molecularWeight: 135.21,
        halfLife: { min: 9, max: 11, unit: 'h', note: 'auto-extracted' },
        metabolism: {
          enzymes: ['CYP2D6'],
          metabolites: [],
          eliminationRoutes: [],
        },
      }),
    ).toBe(
      [
        '  {',
        "    name: 'Amfetamin',",
        "    nameEn: 'Amphetamine',",
        '    pubchemCid: 3007,',
        '    molecularWeight: 135.21,',
        "    halfLife: { min: 9, max: 11, unit: 'h', note: 'auto-extracted' },",
        "    metabolism: { enzymes: ['CYP2D6'], metabolites: [], eliminationRoutes: [] }",
        '  }',
      ].join('\n'),
    );
  });

  it('breaks a long metabolism block across lines', () => {
    const rendered = renderComponent({
      name: 'X',
      pubchemCid: 1,
      metabolism: {
        enzymes: ['CYP3A4', 'CYP3A5', 'CYP3A7', 'CYP2C9', 'CYP2D6', 'CYP1A2'],
        metabolites: ['A really quite long metabolite name here'],
        eliminationRoutes: ['Renal'],
      },
    });
    expect(rendered).toContain('    metabolism: {\n');
    expect(rendered).toContain("      eliminationRoutes: ['Renal']\n");
  });

  it("escapes apostrophes, which Norwegian and metabolite names carry", () => {
    const rendered = renderComponent({
      name: "Epidoxorubicinol, 4'-epiadriamycinol",
      pubchemCid: 1,
    });
    expect(rendered).toContain("name: 'Epidoxorubicinol, 4\\'-epiadriamycinol'");
  });

  it('escapes backslashes before quotes so the output stays parseable', () => {
    const rendered = renderComponent({ name: "a\\b'c", pubchemCid: 1 });
    expect(rendered).toContain("name: 'a\\\\b\\'c'");
  });
});

describe('splitComponentsSource', () => {
  it('keeps the hand-maintained preamble intact', () => {
    const source = 'interface RangeData {}\n\nexport const embeddedComponents: RawComponent[] = [\n  {}\n];\n';
    const { preamble } = splitComponentsSource(source);
    expect(preamble).toBe('interface RangeData {}\n\n');
  });

  it('fails loudly if the file layout changed', () => {
    expect(() => splitComponentsSource('nothing here')).toThrow(
      /file layout changed/,
    );
  });
});

describe('renderComponentsSource', () => {
  it('produces source that round-trips through the diff unchanged', () => {
    const components: RawComponent[] = [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 9, max: 16, unit: 'h', note: "it's fine" },
        metabolism: {
          enzymes: ['CYP3A4'],
          metabolites: [],
          eliminationRoutes: ['Renal'],
        },
      },
    ];
    const source = renderComponentsSource('', components);
    // Evaluating the rendered literal is the strongest available check that the
    // emitted TypeScript is both syntactically valid and semantically identical.
    const literal = source
      .replace('export const embeddedComponents: RawComponent[] = [', '[')
      .replace(/;\n$/, '');
    const parsed = eval(literal) as RawComponent[];
    expect(parsed).toEqual(components);
    expect(isCatalogInSync(diffCatalogs(parsed, components))).toBe(true);
  });

  it('ends with a trailing newline', () => {
    expect(renderComponentsSource('', [{ name: 'X', pubchemCid: 1 }])).toMatch(
      /\n$/,
    );
  });
});

describe('mergeForRender', () => {
  const fileComponents: RawComponent[] = [
    { name: 'Alprazolam', pubchemCid: 2118 },
    { name: 'Amfetamin', pubchemCid: 3007 },
  ];

  it('keeps fixture entries the database has no row for', () => {
    const result = mergeForRender(fileComponents, [
      { name: 'Alprazolam', pubchemCid: 2118, molecularWeight: 308.8 },
    ]);
    expect(result.components.map((c) => c.pubchemCid)).toEqual([2118, 3007]);
    expect(result.retained).toEqual([{ pubchemCid: 3007, name: 'Amfetamin' }]);
    expect(result.dropped).toEqual([]);
  });

  it('drops them only when explicitly pruning', () => {
    const result = mergeForRender(
      fileComponents,
      [{ name: 'Alprazolam', pubchemCid: 2118 }],
      { prune: true },
    );
    expect(result.components.map((c) => c.pubchemCid)).toEqual([2118]);
    expect(result.dropped).toEqual([{ pubchemCid: 3007, name: 'Amfetamin' }]);
    expect(result.retained).toEqual([]);
  });

  it('prefers the database row for entries present in both', () => {
    const result = mergeForRender(fileComponents, [
      { name: 'Alprazolam', pubchemCid: 2118, molecularWeight: 308.8 },
      { name: 'Amfetamin', pubchemCid: 3007 },
    ]);
    expect(result.components[0]!.molecularWeight).toBe(308.8);
  });

  it('preserves existing order and appends new drugs by name', () => {
    const result = mergeForRender(fileComponents, [
      { name: 'Zopiklon', pubchemCid: 5735 },
      { name: 'Alprazolam', pubchemCid: 2118 },
      { name: 'Amfetamin', pubchemCid: 3007 },
      { name: 'Fentanyl', pubchemCid: 3345 },
    ]);
    expect(result.components.map((c) => c.name)).toEqual([
      'Alprazolam',
      'Amfetamin',
      'Fentanyl',
      'Zopiklon',
    ]);
  });

  it('keeps a fixture field value the database has none for', () => {
    // The seeder historically never wrote therapeuticRange/toxicRange/
    // lethalRange (it read the registry ids, which the fixture does not use),
    // so a database seeded before that fix has no value for them. A whole-object
    // replacement would delete curated forensic thresholds.
    const result = mergeForRender(
      [
        {
          name: 'Alprazolam',
          pubchemCid: 2118,
          halfLife: { min: 9, max: 16, unit: 'h' },
          lethalRange: { median: 1020, unit: 'mg/kg', note: 'LD50' },
        },
      ],
      [
        {
          name: 'Alprazolam',
          pubchemCid: 2118,
          halfLife: { min: 6, max: 27, unit: 'h' },
        },
      ],
    );
    expect(result.components[0]).toEqual({
      name: 'Alprazolam',
      pubchemCid: 2118,
      halfLife: { min: 6, max: 27, unit: 'h' }, // DB wins where it has a value
      lethalRange: { median: 1020, unit: 'mg/kg', note: 'LD50' }, // preserved
    });
    expect(result.preservedFields).toEqual([
      { pubchemCid: 2118, name: 'Alprazolam', fields: ['lethalRange'] },
    ]);
  });

  it('drops fixture-only field values when mirroring the database', () => {
    const result = mergeForRender(
      [
        {
          name: 'Alprazolam',
          pubchemCid: 2118,
          lethalRange: { median: 1020, unit: 'mg/kg' },
        },
      ],
      [{ name: 'Alprazolam', pubchemCid: 2118 }],
      { prune: true },
    );
    expect(result.components[0]).toEqual({
      name: 'Alprazolam',
      pubchemCid: 2118,
    });
    expect(result.preservedFields).toEqual([]);
  });

  it('does not reintroduce an all-empty metabolism block', () => {
    const result = mergeForRender(
      [
        {
          name: 'X',
          pubchemCid: 1,
          metabolism: { enzymes: [], metabolites: [], eliminationRoutes: [] },
        },
      ],
      [{ name: 'X', pubchemCid: 1 }],
    );
    expect(result.components[0]).toEqual({ name: 'X', pubchemCid: 1 });
    expect(result.preservedFields).toEqual([]);
  });

  it('takes the database name even when the fixture disagrees', () => {
    const result = mergeForRender(
      [{ name: 'Gammelt navn', pubchemCid: 1, molecularWeight: 100 }],
      [{ name: 'Nytt navn', pubchemCid: 1 }],
    );
    expect(result.components[0]!.name).toBe('Nytt navn');
    expect(result.components[0]!.molecularWeight).toBe(100);
  });

  it('keeps BOTH duplicates when the database has no row for the CID', () => {
    // Collapsing needs a database row to supply the canonical entry. Without
    // one, dropping a synonym would delete a fixture-only entry by the back
    // door — the exact guarantee the default mode makes.
    const result = mergeForRender(
      [
        { name: 'Valproat', pubchemCid: 3121 },
        { name: 'Valproinsyre', pubchemCid: 3121 },
      ],
      [],
    );
    expect(result.components.map((c) => c.name)).toEqual([
      'Valproat',
      'Valproinsyre',
    ]);
    expect(result.retained).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('collapses a duplicate CID in the fixture to the single database row', () => {
    const result = mergeForRender(
      [
        { name: 'Valproat', pubchemCid: 3121 },
        { name: 'Valproinsyre', pubchemCid: 3121 },
      ],
      [{ name: 'Valproinsyre', pubchemCid: 3121, molecularWeight: 144.21 }],
    );
    expect(result.components).toEqual([
      { name: 'Valproinsyre', pubchemCid: 3121, molecularWeight: 144.21 },
    ]);
    expect(result.retained).toEqual([]);
  });

  it('is idempotent — merging a merged catalog changes nothing', () => {
    const db: RawComponent[] = [
      { name: 'Alprazolam', pubchemCid: 2118, molecularWeight: 308.8 },
      { name: 'Fentanyl', pubchemCid: 3345 },
    ];
    const once = mergeForRender(fileComponents, db).components;
    const twice = mergeForRender(once, db).components;
    expect(twice).toEqual(once);
  });
});

describe('findDuplicateCids', () => {
  it('reports entries sharing a CID, with every name involved', () => {
    expect(
      findDuplicateCids([
        { name: 'Valproat', pubchemCid: 3121 },
        { name: 'Alprazolam', pubchemCid: 2118 },
        { name: 'Valproinsyre', pubchemCid: 3121 },
      ]),
    ).toEqual([{ pubchemCid: 3121, names: ['Valproat', 'Valproinsyre'] }]);
  });

  it('is empty for a clean catalog', () => {
    expect(
      findDuplicateCids([
        { name: 'Alprazolam', pubchemCid: 2118 },
        { name: 'Amfetamin', pubchemCid: 3007 },
      ]),
    ).toEqual([]);
  });
});

describe('regenerating the real data/components.ts', () => {
  const SOURCE_PATH = join(__dirname, '..', '..', 'data', 'components.ts');

  it('splits the committed file and re-renders it without semantic loss', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const { preamble } = splitComponentsSource(source);

    // The preamble must still carry the hand-maintained type declarations —
    // regenerating the array must never eat them.
    expect(preamble).toContain('interface RangeData');
    expect(preamble).toContain('export interface RawComponent');

    const rendered = renderComponentsSource(preamble, embeddedComponents);
    expect(rendered.startsWith(preamble)).toBe(true);

    // Evaluate the regenerated array literal and compare it to what the file
    // exports today. This exercises the real 170-entry render — every quote
    // escape, every long metabolism block, every range shape in the catalog.
    const literal = rendered
      .slice(preamble.length)
      .replace('export const embeddedComponents: RawComponent[] = [', '[')
      .replace(/;\n$/, '');
    const reparsed = eval(literal) as RawComponent[];

    expect(reparsed).toHaveLength(embeddedComponents.length);
    expect(reparsed).toEqual(embeddedComponents);
    expect(
      isCatalogInSync(diffCatalogs(reparsed, embeddedComponents)),
    ).toBe(true);
  });

  it('is idempotent — re-rendering the regenerated source is a no-op', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const { preamble } = splitComponentsSource(source);
    const once = renderComponentsSource(preamble, embeddedComponents);
    const twice = renderComponentsSource(
      splitComponentsSource(once).preamble,
      embeddedComponents,
    );
    expect(twice).toBe(once);
  });
});

describe('the committed fixture', () => {
  it('renders back to itself semantically (no drift from re-emitting it)', () => {
    const diff = diffCatalogs(embeddedComponents, embeddedComponents);
    expect(isCatalogInSync(diff)).toBe(true);
  });

  it('carries exactly one known duplicate CID (Valproat / Valproinsyre)', () => {
    // Pre-existing defect, not introduced here: the same substance is entered
    // under two Norwegian synonyms. `seed-drugs.ts` upserts on pubchem_cid, so
    // the database only ever holds one row for it. Asserted rather than fixed
    // because picking the canonical Norwegian name is a terminology call — a
    // `catalog:export` refresh resolves it from the database automatically
    // (see the mergeForRender duplicate-collapse test). Tighten this to zero
    // once the fixture is deduplicated.
    expect(findDuplicateCids(embeddedComponents)).toEqual([
      { pubchemCid: 3121, names: ['Valproat', 'Valproinsyre'] },
    ]);
  });
});
