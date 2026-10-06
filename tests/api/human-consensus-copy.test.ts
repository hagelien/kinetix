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

  it('is not stated as a contract in the governance source', () => {
    // Comments that describe an invariant are what the next change to it reads
    // first; one still stating the retired rule invites restoring it.
    const files = [
      'src/lib/assurance/policy.ts',
      'src/lib/assurance/projection.ts',
      'api/_lib/agent-verifications.ts',
      'api/agent-verifications.ts',
      'api/_lib/unquoted-edit-return.ts',
      'api/_lib/knowledge-governance/actor-context.ts',
      'api/_lib/knowledge-governance/policy-shadow.ts',
      'api/_lib/knowledge-governance/dossier.ts',
    ];
    const retired = [
      /human'?s? (?:proposal|edit) (?:never publishes|always waits)/i,
      /only an agent-submitted edit can be\s+(?:\*\s+)?published/i,
      /consensus never stands in for (?:a|the) moderator/i,
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of retired) {
        expect({ file, match: phrase.exec(text)?.[0] ?? null }).toEqual({ file, match: null });
      }
    }
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
