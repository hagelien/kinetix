/**
 * §23 and §25 — what must NOT be here, and what must.
 *
 * These two sections are the extraction's scope boundaries in both directions,
 * and neither is a phase, so nothing in the plan forces anyone to check them.
 *
 * §23 is a list of eight things to deliberately *not* build. Each is a
 * reasonable-sounding feature that would be easy to add in passing — a trust
 * score, a signature field, an admin-editable policy — and each would change
 * what the engine is. A "do not build this" decision that nobody re-reads is a
 * decision that expires quietly, so the ones that leave a trace in the code are
 * asserted here.
 *
 * §25 is the inventory of what the reusable artifact must ultimately provide.
 * Asserted as a checklist against real exports rather than prose, so a
 * capability cannot be lost to a refactor without a test naming it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from 'assurance-core';
import * as store from '../../../api/_lib/knowledge-governance/store/postgres.js';
import { governanceClient } from '../../../api/_lib/knowledge-governance/sdk/client.js';
import { KNOWLEDGE_TARGET_REGISTRY_EXPORTS } from './registry-exports.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST_DIR = path.join(ROOT, 'src/lib/assurance');
const SERVER_DIR = path.join(ROOT, 'api/_lib/knowledge-governance');
const CORE_DIST = path.join(ROOT, 'node_modules/assurance-core/dist');

/**
 * Every file the governance layer is made of, comments stripped.
 *
 * Three sources, because the layer is now assembled from three places: the
 * Kinetix host policy in `src/lib/assurance/`, the server layer under `api/`,
 * and the core, which left this repository and arrives as a dependency. The
 * core is scanned as the JavaScript it actually ships — a §23 ban that held in
 * the package's source but not in what npm delivered would be a ban in name
 * only.
 *
 * Each source throws when it is missing rather than contributing nothing. Every
 * assertion below is of the form "no file contains X", so a silently empty
 * corpus would turn all eight of them green at once.
 */
function governanceCode(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const walk = (dir: string, ext: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, ext);
      else if (entry.name.endsWith(ext)) {
        out.push({
          name: path.relative(ROOT, full),
          body: strip(fs.readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(HOST_DIR, '.ts');
  walk(SERVER_DIR, '.ts');
  walk(CORE_DIST, '.js');
  return out;
}

describe('§23 — the deferred decisions stayed deferred', () => {
  it('scans a real corpus, so the absences below mean something', () => {
    const files = governanceCode();
    expect(files.length).toBeGreaterThan(30);
    // Comment stripping keeps code: a stripper that emptied every file would
    // make every "does not contain" assertion below pass.
    expect(files.some((f) => f.body.includes('export function policy'))).toBe(true);
    // All three sources are present. The core's is the one that can vanish
    // without a syntax error — an uninstalled dependency — so name it.
    for (const prefix of ['src/lib/assurance/', 'api/_lib/knowledge-governance/', 'node_modules/assurance-core/']) {
      expect(
        files.some((f) => f.name.startsWith(prefix)),
        `corpus is missing ${prefix}`,
      ).toBe(true);
    }
  });

  it('23.2 — exposes no universal numeric trust score', () => {
    // The plan's wording is "Avoid. Preserve multi-dimensional assurance." The
    // temptation is real: one number is easier to sort a queue by. But
    // "two agents agreed and no human looked" and "one flagship model approved"
    // cannot both survive being collapsed onto a scale, and a gate that reads
    // the collapsed number can no longer tell them apart.
    //
    // Kinetix's own 0–3 VerificationLevel is not a counter-example: it is a
    // host *projection* of the profile, produced in `kinetix/projection.ts`,
    // and the core neither produces nor reads it.
    for (const name of Object.keys(core)) {
      expect(name, `core exports ${name}`).not.toMatch(
        /trustScore|TrustScore|reputation|Reputation|confidenceScore/,
      );
    }
    // The profile is still plural, which is the property the ban protects.
    const profile = core.EMPTY_ASSURANCE_PROFILE as Record<string, unknown>;
    expect(Object.keys(profile).length).toBeGreaterThan(6);
    for (const dimension of [
      'explicitApprovals',
      'independentApprovers',
      'humanApprovals',
      'agentApprovals',
      'approvalCapabilities',
      'humanApprovalCapabilities',
      'disputingAssessors',
      'disputesOpen',
    ]) {
      expect(profile).toHaveProperty(dimension);
    }
  });

  it('23.3 — the policy is code, not data an admin can edit at runtime', () => {
    // "Code-first versioned policy is safer initially." What that rules out is
    // a policy assembled from a table at request time, which would make the
    // rules unreviewable and unversionable. A policy set here is built by a
    // function, frozen, and named by a version string that decision records
    // carry.
    const policy = core.KINETIX_APPLY_POLICY ?? null;
    expect(policy).toBeNull(); // host policy is NOT on the core barrel
    for (const file of governanceCode()) {
      // Nothing loads rules from anywhere. A `kg_policies` table would be the
      // shape of the thing being deferred.
      expect(file.body, `${file.name} loads policy rules`).not.toMatch(
        /kgPolicies\b|from\s+['"].*policy-store/,
      );
    }
  });

  it('23.4 — no per-actor reputation is accumulated anywhere', () => {
    for (const file of governanceCode()) {
      expect(file.body, `${file.name} scores an actor`).not.toMatch(
        /actorScore|reputationOf|scoreActor|actorRating/,
      );
    }
  });

  it('23.5 — assessments carry no cryptographic signature', () => {
    // "Could be useful across organizations, unnecessary for single-host
    // Kinetix first." A signature column added speculatively would be a field
    // nothing verifies, which is worse than no signature: it looks like a
    // guarantee.
    for (const file of governanceCode()) {
      expect(file.body, `${file.name} signs something`).not.toMatch(
        /\bsignature\b|\bsignAssessment\b|createSign\(/,
      );
    }
  });

  it('23.6 — the governance layer ships no UI', () => {
    for (const file of governanceCode()) {
      expect(file.body, `${file.name} imports a UI framework`).not.toMatch(
        /from\s+['"](react|react-dom|@tiptap[^'"]*)['"]/,
      );
      expect(file.body, `${file.name} contains JSX`).not.toMatch(/<\/[A-Z]\w*>/);
    }
  });

  it('23.7 — only governance history is append-only, not host knowledge', () => {
    // "Only governance history needs append-only semantics." The distinction
    // is visible in what the layer writes: `kg_audit_events` records governance
    // acts, and no host table is turned into an event stream beside it.
    for (const file of governanceCode()) {
      expect(file.body, `${file.name} event-sources a host table`).not.toMatch(
        /wikiPageEvents|drugEvents|hostEventStream/,
      );
    }
  });

  it('23.8 — nothing lets an agent modify publication policy', () => {
    // The sharpest of the eight. An agent that can move the bar it is judged
    // against is not being governed.
    for (const file of governanceCode()) {
      expect(file.body, `${file.name} mutates policy`).not.toMatch(
        /updatePolicy|setPolicyRules|learnPolicy|policy\s*=\s*await/,
      );
    }
  });
});

describe('§25 — every reusable capability is actually present', () => {
  /**
   * The plan's fifteen bullets, each bound to the export that provides it.
   *
   * Written as a table rather than fifteen `it`s so a missing capability reads
   * as one line of a list rather than a scroll of near-identical tests — and so
   * the list stays legible next to §25 itself.
   */
  const CAPABILITIES: ReadonlyArray<[string, () => unknown]> = [
    ['actor-neutral governance contracts', () => core.snapshotActor],
    ['target adapter registry', () => KNOWLEDGE_TARGET_REGISTRY_EXPORTS.register],
    ['immutable proposal versioning', () => store.appendVersion],
    ['evidence attachment model', () => store.linkEvidence],
    ['independent review packets', () => KNOWLEDGE_TARGET_REGISTRY_EXPORTS.sealReviewPacket],
    ['immutable assessments and supersession', () => store.reviseAssessment],
    ['assurance profiles', () => core.tallyAssurance],
    ['dispute lifecycle', () => store.openDispute],
    ['deterministic versioned policy evaluation', () => core.policy],
    ['capability-aware publication requirements', () => core.approvalWithCapability],
    ['audit history', () => store.recordAuditEvent],
    ['migration/reconciliation primitives', () => store.findByLegacy],
    ['optional Postgres persistence', () => store.ensureSpace],
    ['optional agent SDK', () => governanceClient],
  ];

  for (const [capability, resolve] of CAPABILITIES) {
    it(`provides: ${capability}`, () => {
      expect(typeof resolve()).toBe('function');
    });
  }

  it('does NOT yet provide the optional HTTP API, and says so', () => {
    // The fifteenth bullet. §15.5 puts `api/governance-*.ts` under "later" and
    // adds that generic routes "should not replace current Kinetix routes
    // during initial migration", so its absence is the plan being followed —
    // but an inventory that quietly omitted the one missing item would be an
    // inventory nobody could trust. This fails the day somebody adds one, and
    // the fix is to move it into the table above.
    const routes = fs
      .readdirSync(path.join(ROOT, 'api'))
      .filter((f) => f.startsWith('governance-'));
    expect(routes).toEqual([]);
  });
});
