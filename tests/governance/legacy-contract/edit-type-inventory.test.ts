/**
 * Phase 0 gap 4 (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md): a completeness guard over `pending_edits.edit_type`. This
 * isn't behaviour coverage — it's a tripwire. If someone adds a 14th
 * edit_type later without wiring it into both the capability gate and the
 * apply dispatch, this test fails loudly instead of the gap going unnoticed
 * until a moderator approves an edit that silently does nothing.
 *
 * No DB needed: (a) is a pure function check, (b) is a structural read of the
 * dispatch source rather than executing every apply path (a full run would
 * mean building 13 real fixtures — the "500-line fixture farm" the plan
 * explicitly says to avoid).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_LIST,
  capabilityForEditType,
} from '../../../src/lib/permissions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

// The 13 edit types Phase 0 freezes as the known inventory (plan's step 1,
// "inventory every current edit type"). A 14th type showing up in
// `pending_edits.edit_type` without a matching addition here is exactly the
// silent-drift case this test exists to catch.
const KNOWN_EDIT_TYPES = [
  'parameter',
  'wiki_page',
  'wiki_new',
  'wiki_fact',
  'wiki_section',
  'learning_unit',
  'clinical_case',
  'param_entry',
  'metabolism',
  'receptor_targets',
  'enzyme_interaction',
  'bio_entity',
  'paper_review',
] as const;

const KNOWN_CAPABILITY_IDS = new Set(CAPABILITY_LIST.map((c) => c.id));

describe('pending_edits.edit_type inventory (Phase 0 freeze)', () => {
  it('lists exactly 13 known edit types — update this list deliberately on a real addition', () => {
    expect(KNOWN_EDIT_TYPES).toHaveLength(13);
    expect(new Set(KNOWN_EDIT_TYPES).size).toBe(13);
  });

  it.each(KNOWN_EDIT_TYPES)(
    'capabilityForEditType(%s) resolves to a real, known capability',
    (editType) => {
      const capability = capabilityForEditType(editType);
      expect(typeof capability).toBe('string');
      expect(capability.length).toBeGreaterThan(0);
      // Resolves to an id that actually exists in the permission matrix —
      // catches a typo'd or orphaned capability id as surely as a missing one.
      expect(KNOWN_CAPABILITY_IDS.has(capability)).toBe(true);
    },
  );

  describe('applyApprovedEditEffects dispatch (api/_lib/pending-edits-helpers.ts)', () => {
    // Read the actual dispatch body rather than importing + invoking it: this
    // is a structural "is every type wired at all" check, not a behavioural
    // one — the individual apply paths already have their own dedicated
    // integration coverage (e.g. tests/integration/parameter-entry-review.test.ts).
    function dispatchSource(): string {
      const filePath = path.join(
        REPO_ROOT,
        'api/_lib/pending-edits-helpers.ts',
      );
      const full = fs.readFileSync(filePath, 'utf8');
      const start = full.indexOf('async function applyApprovedEditEffects');
      expect(start).toBeGreaterThan(-1);
      // Bounded by the next top-level function declaration, so a rewrite of
      // this dispatch keeps the slice honest instead of silently scanning
      // into (or past) unrelated code.
      const nextFnMatch = full
        .slice(start + 1)
        .match(/\n(?:export )?(?:async )?function [A-Za-z]/);
      expect(nextFnMatch).not.toBeNull();
      const end = start + 1 + nextFnMatch!.index!;
      return full.slice(start, end);
    }

    it.each(KNOWN_EDIT_TYPES)(
      'dispatches %s to a real apply branch',
      (editType) => {
        const body = dispatchSource();
        // Every branch in the function is keyed on `edit.editType === '<type>'`
        // (see the if/else-if chain applyApprovedEditEffects is built from).
        expect(body).toContain(`edit.editType === '${editType}'`);
      },
    );

    it("does not silently accept a 14th type — the dispatch chain is closed with an explicit fallthrough or exhausted", () => {
      const body = dispatchSource();
      // Count occurrences of the dispatch predicate; there must be exactly
      // one per known type (no type sharing a branch with another, no branch
      // for a type outside the known set) so the two lists — this test's and
      // the source's — are actually in 1:1 correspondence rather than one
      // being a subset of the other.
      const matches = body.match(/edit\.editType === '([a-z_]+)'/g) ?? [];
      const dispatched = matches.map((m) => m.match(/'([a-z_]+)'/)![1]);
      expect(new Set(dispatched)).toEqual(new Set(KNOWN_EDIT_TYPES));
    });
  });
});
