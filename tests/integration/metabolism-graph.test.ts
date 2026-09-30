/**
 * The module-scoped graph against real SQL (plan §7.3, §10).
 *
 * The whole thing is a recursive CTE, so a mocked query builder would test
 * nothing that can fail. The property that matters is that the walk reaches
 * upstream as well as down: `A → M ← B` is where a downstream-only enumeration
 * silently loses the substance that was actually administered.
 *
 * What this endpoint no longer reports is completeness. The per-substance
 * markers were withdrawn (2026-08-24) as an assertion nobody made, and the
 * profile states the residual outright instead — so the graph is the recorded
 * edges and nothing more, which is exactly what the caveat tells the reader.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { drugMetabolites } from '../../db/schema.js';
import { getModuleMetabolismGraph } from '../../api/_lib/metabolismGraphStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

/** `A → M ← B`: an assumed parent, an observed metabolite, and a second source. */
async function seedForkedLineage() {
  const a = await seedDrug(db, { slug: 'a-parent', names: { nb: 'A' }, pubchemCid: 101 });
  const m = await seedDrug(db, {
    slug: 'm-metabolite',
    names: { nb: 'M' },
    pubchemCid: 102,
    substanceClass: 'metabolite',
  });
  const b = await seedDrug(db, { slug: 'b-other', names: { nb: 'B' }, pubchemCid: 103 });
  await db.insert(drugMetabolites).values([
    { parentDrugId: a, metaboliteDrugId: m, metaboliteName: 'M' },
    { parentDrugId: b, metaboliteDrugId: m, metaboliteName: 'M' },
  ]);
  return { a, m, b };
}

describe('the walk reaches both ways', () => {
  it('finds a second source that no downstream walk would reach', async () => {
    await seedForkedLineage();

    // Seeded from the assumed parent alone. B is not downstream of A — it is a
    // precursor of A's metabolite — and it is the substance the case may
    // actually have been fed by.
    const graph = await getModuleMetabolismGraph(db, [101]);

    expect(graph.nodes.map((n) => n.drug.pubchemCid).sort((x, y) => x - y)).toEqual([
      101, 102, 103,
    ]);
    expect(graph.edges).toEqual([
      { from: { pubchemCid: 101 }, to: { pubchemCid: 102 } },
      { from: { pubchemCid: 103 }, to: { pubchemCid: 102 } },
    ]);
  });

  it('keeps walking past the first step in both directions', async () => {
    // B → X → M, plus M → N downstream: the neighbourhood is transitive, so a
    // source two edges up is still found and a metabolite two edges down is
    // still described.
    const m = await seedDrug(db, { slug: 'm', names: { nb: 'M' }, pubchemCid: 202 });
    const x = await seedDrug(db, { slug: 'x', names: { nb: 'X' }, pubchemCid: 203 });
    const b = await seedDrug(db, { slug: 'b', names: { nb: 'B' }, pubchemCid: 204 });
    const n = await seedDrug(db, { slug: 'n', names: { nb: 'N' }, pubchemCid: 205 });
    await db.insert(drugMetabolites).values([
      { parentDrugId: x, metaboliteDrugId: m, metaboliteName: 'M' },
      { parentDrugId: b, metaboliteDrugId: x, metaboliteName: 'X' },
      { parentDrugId: m, metaboliteDrugId: n, metaboliteName: 'N' },
    ]);

    const graph = await getModuleMetabolismGraph(db, [202]);

    expect(graph.nodes.map((n2) => n2.drug.pubchemCid).sort((p, q) => p - q)).toEqual([
      202, 203, 204, 205,
    ]);
  });

  it('does not loop forever on a cycle', async () => {
    // Interconversion is real chemistry, and a recursive CTE that did not
    // dedupe would spin on it.
    const p = await seedDrug(db, { slug: 'p', names: { nb: 'P' }, pubchemCid: 301 });
    const q = await seedDrug(db, { slug: 'q', names: { nb: 'Q' }, pubchemCid: 302 });
    await db.insert(drugMetabolites).values([
      { parentDrugId: p, metaboliteDrugId: q, metaboliteName: 'Q' },
      { parentDrugId: q, metaboliteDrugId: p, metaboliteName: 'P' },
    ]);

    const graph = await getModuleMetabolismGraph(db, [301]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
  });

  it('answers an empty graph for a substance the catalog does not carry', async () => {
    // A module may legitimately name a substance nobody has entered. The walk's
    // answer is a neighbourhood without it, not an error raised here.
    expect(await getModuleMetabolismGraph(db, [999999])).toEqual({ nodes: [], edges: [] });
    expect(await getModuleMetabolismGraph(db, [])).toEqual({ nodes: [], edges: [] });
  });
});

describe('the substance class comes from the catalog, unmodified', () => {
  it('reports it as stored, including when nobody has classified it', async () => {
    await seedDrug(db, { slug: 'unclassified', names: { nb: 'U' }, pubchemCid: 401 });
    await seedDrug(db, {
      slug: 'a-metabolite',
      names: { nb: 'M' },
      pubchemCid: 402,
      substanceClass: 'metabolite',
    });

    const graph = await getModuleMetabolismGraph(db, [401, 402]);
    const byCid = new Map(graph.nodes.map((n) => [n.drug.pubchemCid, n]));

    // `drug` is the column default, and the engine reads administrability
    // rather than inferring it: an unclassified substance defaults to
    // administered, which raises an ambiguity that may be unnecessary but never
    // suppresses one that is real.
    expect(byCid.get(401)!.substanceClass).toBe('drug');
    expect(byCid.get(402)!.substanceClass).toBe('metabolite');
  });
});

describe('an edge this graph cannot express is left out of it', () => {
  it('omits a free-text metabolite, which has no substance to be a node', async () => {
    const a = await seedDrug(db, { slug: 'a', names: { nb: 'A' }, pubchemCid: 501 });
    await db.insert(drugMetabolites).values({
      parentDrugId: a,
      metaboliteDrugId: null,
      metaboliteName: 'Noe ukjent',
    });

    const graph = await getModuleMetabolismGraph(db, [501]);

    // An unlinked row names a substance the catalog does not carry, so there is
    // nothing for the walk to reason about — the same silent gap as a
    // metabolite nobody entered at all, and the same one the profile's caveat
    // discloses.
    expect(graph.nodes.map((n) => n.drug.pubchemCid)).toEqual([501]);
    expect(graph.edges).toEqual([]);
  });

  it('omits a linked substance that has no PubChem CID', async () => {
    // Identity here is the CID, so a catalog row without one cannot be named to
    // the client at all — the edge is as invisible as an unlinked one.
    const a = await seedDrug(db, { slug: 'a', names: { nb: 'A' }, pubchemCid: 601 });
    const anonymous = await seedDrug(db, { slug: 'anon', names: { nb: 'Anon' } });
    await db
      .insert(drugMetabolites)
      .values({ parentDrugId: a, metaboliteDrugId: anonymous, metaboliteName: 'Anon' });

    const graph = await getModuleMetabolismGraph(db, [601]);

    expect(graph.nodes.map((n) => n.drug.pubchemCid)).toEqual([601]);
    expect(graph.edges).toEqual([]);
  });
});
