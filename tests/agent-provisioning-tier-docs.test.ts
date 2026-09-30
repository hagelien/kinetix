import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The provisioning guides must route a tier change through the admin UI.
 *
 * `agents.model_tier` decides which identities can supply the flagship approval
 * a high-risk edit requires, so the admin control for it carries a confirmation
 * step before anything is promoted to `flagship`. A guide that tells an operator
 * to reach for `PATCH /api/admin` instead walks the canonical workflow straight
 * past that safeguard — and for a while the guides went further, asserting that
 * no such field existed at all, which was true when they were written and is not
 * now.
 *
 * Documentation that misdescribes a safety control is the failure this pins: the
 * endpoint stays documented for scripted provisioning, but the UI is what a
 * one-off change is pointed at, and no guide may claim the field is missing.
 */

const GUIDES = [
  'agents/adding-a-new-agent.md',
  'agents/remote-routine-setup.md',
] as const;

/** Phrasings that asserted the admin UI had no model-tier control. */
const ABSENCE_CLAIMS = [
  /no field (?:for it )?in the admin/i,
  /not in the admin UI/i,
  /admin agents UI yet/i,
];

describe('agent provisioning guides — model tier', () => {
  for (const guide of GUIDES) {
    const text = readFileSync(resolve(process.cwd(), guide), 'utf8');

    it(`${guide} does not claim the admin UI lacks a tier field`, () => {
      for (const claim of ABSENCE_CLAIMS) {
        expect(text).not.toMatch(claim);
      }
    });

    it(`${guide} points a tier change at Admin → Agents`, () => {
      expect(text).toMatch(/Admin → Agents/);
      expect(text).toMatch(/Model tier/);
    });

    it(`${guide} still documents the endpoint as the scripted alternative`, () => {
      // Keeping it documented matters as much as demoting it: bulk provisioning
      // has no UI, and an operator who cannot find the endpoint reaches for a
      // raw UPDATE, which bypasses the API's validation as well as its prompt.
      expect(text).toMatch(/PATCH \/api\/admin\?resource=agents/);
      expect(text).toMatch(/scripted/i);
    });
  }

  describe('the SQL provisioning step', () => {
    const text = readFileSync(
      resolve(process.cwd(), 'agents/adding-a-new-agent.md'),
      'utf8',
    );
    // Every fenced SQL block that writes the agents row.
    const inserts = [...text.matchAll(/```sql\n([\s\S]*?)```/g)]
      .map(([, body]) => body ?? '')
      .filter((body) => /INSERT INTO agents/.test(body));

    it('has SQL blocks that insert the agents row', () => {
      expect(inserts.length).toBeGreaterThan(0);
    });

    it('inserts the row unclassified rather than with a guessed tier', () => {
      // The tier belongs to the Routine's model, which is not chosen until
      // Step 4. A tier written here is a guess, it skips the admin form's
      // confirmation, and the one guess that matters — a cheap model typed as
      // flagship — is the hole the consensus gate exists to close. NULL is the
      // fail-safe: it never satisfies the flagship requirement.
      for (const body of inserts) {
        expect(body).toMatch(/model_tier/);
        // The statement itself, with `--` commentary dropped: prose may well
        // name the tier the agent ends up on, what must not appear is a tier
        // literal being written by the INSERT.
        const statement = body.replace(/--[^\n]*/g, '');
        expect(statement).not.toMatch(/'(flagship|mid|light|<tier>)'/);
        expect(statement).toMatch(/NULL/);
      }
    });

    it('sends the reader to the confirmed form for the assignment', () => {
      expect(text).toMatch(/Leave `model_tier` NULL here/);
      expect(text).toMatch(/Admin → Agents → New agent/);
    });
  });
});
