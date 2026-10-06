/**
 * A person's proposal publishes on agent consensus (kinetix-consensus@v2), so
 * nothing a moderator or an agent reads may still say it cannot. The
 * `human_submitted` hold now means only a proposal with no recorded author.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../src/locales/en.json';
import nb from '../../src/locales/nb.json';

type Reasons = {
  review: { consensus: { reason: Record<string, string> }; errors: Record<string, string> };
};

describe('the retired "people never publish on consensus" rule', () => {
  it('is not what the review card says a human_submitted hold means', () => {
    expect((en as Reasons).review.consensus.reason.human_submitted).toMatch(/no recorded author/);
    expect((nb as Reasons).review.consensus.reason.human_submitted).toMatch(/uten registrert forfatter/);
  });

  it('is not what an agent is told when it tries to moderate a person\u2019s edit', () => {
    for (const messages of [en, nb] as Reasons[]) {
      const text = messages.review.errors.agentModerationNotAllowed;
      expect(text).not.toMatch(/stays with a human moderator|ligger hos en menneskelig moderator/);
    }
    expect((en as Reasons).review.errors.agentModerationNotAllowed).toMatch(/publishes once enough agents approve/);
    expect((nb as Reasons).review.errors.agentModerationNotAllowed).toMatch(/publiseres når nok agenter godkjenner/);
  });

  it('is not left in any agent instruction file', () => {
    const retired = [
      /never (?:applied|auto-applied) by (?:agent )?consensus/i,
      /human-submitted\s+edits still wait for a moderator/i,
      /anything submitted by a human\*\*/i,
    ];
    for (const file of readdirSync('agents').filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(`agents/${file}`, 'utf8');
      for (const phrase of retired) {
        expect({ file, match: phrase.exec(text)?.[0] ?? null }).toEqual({ file, match: null });
      }
    }
  });
});
