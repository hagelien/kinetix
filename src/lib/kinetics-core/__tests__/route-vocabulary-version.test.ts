/**
 * The route vocabulary is part of the scenario contract Redose pins (`version.ts`: a new route
 * is a MINOR change). This pins the vocabulary to the release that introduced it, so a route
 * added to or removed from `ROUTE_IDS` fails here until `CORE_VERSION` is bumped (and this list
 * with it) — rather than shipping a contract change under an unchanged version.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_IDS } from '../types';
import { CORE_VERSION } from '../version';

/** The route vocabulary each core release defines; the newest entry is the current one. */
const ROUTES_BY_VERSION: ReadonlyArray<[version: string, routes: readonly string[]]> = [
  ['1.10.0', ['oral', 'intranasal', 'iv', 'im', 'sublingual', 'rectal', 'inhalation', 'other']],
  [
    '1.11.0',
    [
      'oral',
      'intranasal',
      'iv',
      'im',
      'subcutaneous',
      'sublingual',
      'buccal',
      'rectal',
      'transdermal',
      'inhalation',
      'other',
    ],
  ],
];

describe('route vocabulary ↔ CORE_VERSION', () => {
  it('the current release is the one that defines the current route vocabulary', () => {
    const [version, routes] = ROUTES_BY_VERSION[ROUTES_BY_VERSION.length - 1]!;
    expect(CORE_VERSION).toBe(version);
    expect([...ROUTE_IDS]).toEqual(routes);
  });

  it('subcutaneous, transdermal and buccal arrived in 1.11.0', () => {
    const before = new Set(ROUTES_BY_VERSION.find(([v]) => v === '1.10.0')![1]);
    const added = ROUTE_IDS.filter((r) => !before.has(r));
    expect(added).toEqual(['subcutaneous', 'buccal', 'transdermal']);
  });
});
