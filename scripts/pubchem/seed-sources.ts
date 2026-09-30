/**
 * Which repo files still key a substance by this PubChem CID.
 *
 * These files are not documentation of the database, they are *inputs* to it,
 * and every one of them is keyed by CID. So retiring a CID from the catalog —
 * by merging the row away or by correcting the number — does not retire the
 * substance: it frees the number, and the next seed run uses it.
 *
 * What a stale entry costs depends on the file:
 *
 *   `data/components.ts`               `seed:drugs` upserts on `pubchem_cid`.
 *                                      Also the offline fallback catalog, so an
 *                                      entry here is REPOINTED, never deleted —
 *                                      deleting it drops the substance out of
 *                                      degraded mode altogether.
 *   PM concentration datasets          kept OUTSIDE the repository and passed
 *                                      via `--file`, so NOT scanned here:
 *                                      `seed:pm-concentrations` resolves by CID
 *                                      and CREATES a drug it cannot find —
 *                                      check the external file by hand.
 *   `resources/pm-am-ratios-*`         `seed:pm-am-ratios` resolves by CID and
 *                                      SKIPS what it cannot find, reporting it
 *                                      as missing. So a stale entry does not
 *                                      resurrect the row, it silently stops
 *                                      attaching the PM/AM observation to the
 *                                      surviving one — a hole rather than a
 *                                      duplicate, and only on a fresh seed.
 *   `data/substanceClasses.ts`         the seed for `drugs.substance_class`,
 *                                      applied by `seed-drugs.ts` at insert
 *                                      time. This one does not resurrect a row
 *                                      — it MIS-CLASSIFIES one, and only on a
 *                                      fresh database, which is why it can sit
 *                                      wrong indefinitely without anything
 *                                      noticing. Losing the entry gives the
 *                                      substance the default `drug` class, and
 *                                      that file's own header says what that
 *                                      costs: administration-only parameters
 *                                      become writable and the gap queue
 *                                      re-serves work that cannot be done.
 *
 * Every `resources/*.json` dataset is scanned, not an enumerated list of the
 * ones that exist today, because the next dataset dropped in that directory is
 * keyed the same way and nobody adding it will think to widen a scanner.
 * Example fixtures are excluded: they are not seed inputs.
 *
 * Analytical methods are not listed: they are maintained in the database only
 * (served by `/api/methods`), so no repo file seeds a method membership by CID.
 *
 * Imported rather than grepped, for the `data/` modules: reading the parsed
 * structure asks the exact question, where a regex over the source could be
 * fooled by any other number in the same range.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBSTANCE_CLASS_BY_PUBCHEM_CID } from '../../data/substanceClasses.js';

// `import.meta.url`, not `__dirname`. The package is `"type": "module"` and the
// other seven path-resolving scripts here all use this form; `tsx` happens to
// shim `__dirname` for TypeScript sources, so the CJS spelling works today, but
// it works by grace of the runner rather than by the module system. Anything
// that runs this file without that shim — plain `node --experimental-strip-types`,
// a bundler, a different loader — gets a ReferenceError at module evaluation,
// before either CLI reaches its preflight.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface SeedSource {
  /** Repo-relative path, for the message a human has to act on. */
  file: string;
  /** What the entry is called there, when the file names it. */
  label?: string;
}

/**
 * Scanned rather than imported, for the resource files: they are large, they
 * are data rather than modules, and a regex anchored on the `pubchemCid` key
 * cannot mistake a molecular weight or a method code for an identity.
 */
export function seedSourcesFor(
  cid: number,
  embedded: readonly { pubchemCid?: number | null; name: string }[],
): SeedSource[] {
  const out: SeedSource[] = [];
  const hit = embedded.find((c) => c.pubchemCid === cid);
  if (hit) out.push({ file: 'data/components.ts', label: hit.name });

  if (SUBSTANCE_CLASS_BY_PUBCHEM_CID[cid]) {
    out.push({
      file: 'data/substanceClasses.ts',
      label: SUBSTANCE_CLASS_BY_PUBCHEM_CID[cid]!.substanceClass,
    });
  }

  const resources = path.join(ROOT, 'resources');
  if (fs.existsSync(resources)) {
    const key = new RegExp(`"pubchemCid"\\s*:\\s*${cid}\\b`);
    for (const file of fs
      .readdirSync(resources)
      .filter((f) => f.endsWith('.json') && !f.includes('.example.'))
      .sort()) {
      if (key.test(fs.readFileSync(path.join(resources, file), 'utf8'))) {
        out.push({ file: `resources/${file}` });
      }
    }
  }
  return out;
}

/** One sentence naming every file that has to be reconciled, and what to do. */
export function seedSourceRefusal(
  cid: number,
  sources: readonly SeedSource[],
  repointTo: string,
): string {
  const named = sources
    .map((s) => (s.label ? `${s.file} ("${s.label}")` : s.file))
    .join(', ');
  return (
    `CID ${cid} is still keyed in ${named}. Repoint those at ${repointTo} first — ` +
    'this frees the number, and the next seed run would use it to recreate, ' +
    'mis-describe, or silently drop what you are removing. ' +
    '`seed:pm-concentrations` creates a drug for a CID it cannot find, so a ' +
    'stale entry there rebuilds the row unconditionally; `seed:pm-am-ratios` ' +
    'instead skips a CID it cannot find, so a stale entry there leaves the ' +
    'PM/AM observation unattached; a stale `substanceClasses` entry leaves the ' +
    'corrected substance with the default `drug` class on the next fresh seed.'
  );
}
