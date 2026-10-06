/**
 * A person's proposal publishes on agent consensus (kinetix-consensus@v2), so
 * nothing a moderator or an agent reads may still say it cannot. The
 * `human_submitted` hold now means only a proposal with no recorded author.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../src/locales/en.json';
import nb from '../../src/locales/nb.json';
import { KINETIX_POLICY_ID, KINETIX_POLICY_VERSION } from '../../src/lib/assurance/policy.js';

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
      'api/agent-verifications-queue.ts',
      'api/_lib/source-quote-gate.ts',
    ];
    const retired = [
      /human'?s? (?:proposal|edit) (?:never publishes|always waits)/i,
      /agent verdicts on human work[\s\S]{0,120}never publish/i,
      /their\s+(?:\*\s+)?proposal goes to a person in any case/i,
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

  it('names the current policy version where operators read it', () => {
    const permissions = readFileSync('src/lib/permissions.ts', 'utf8');
    expect(permissions).toContain(`knowledge-governance policy (${KINETIX_POLICY_ID}@${KINETIX_POLICY_VERSION})`);
  });

  // Repository-wide rather than a hand-kept file list: the retired rule kept
  // turning up in places a list did not name. A line may still mention it if
  // it marks it retired (struck through, "retired", or naming v2), or is about
  // something that still holds (a clinical case, an unattributed proposal, a
  // dispute, or an agent moderating from /review).
  it('is not stated as current anywhere in the code, docs, prompts or tests', () => {
    const roots = ['api', 'src', 'docs', 'agents', 'tests', 'AGENTS.md'];
    const self = 'tests/api/human-consensus-copy.test.ts';
    const states = [
      /(?:human|person)[^.\n]{0,60}\b(?:never|always|cannot)\b[^.\n]{0,60}(?:auto-?appl|auto-?publish|agent consensus|generic-hold|by consensus)/i,
      /`human-authored` rule (?:then )?(?:never fires|requires)/i,
      /consensus never stands in for (?:a|the) moderator/i,
      /human[^.\n]{0,30}non-auto-apply/i,
      /anything a human submitted/i,
      /human (?:proposals?|edits?|submissions?) can auto-?publish/i,
      /human'?s? (?:proposal|edit|work|change) is (?:moderated|decided) by a human/i,
      /consensus auto-apply path\s+(?:\/\/\s*)?enforces the same rule/i,
      /only on the agents' own (?:output|work)/i,
    ];
    const stillHolds = /~~|retired|hold for human review|requiresHumanReview|\bv2\b|\bv3\b|clinical|unattributed|no recorded author|dispute|moderat(?:e|ing) (?:a|one)|\/review|superseded/i;
    const offenders: string[] = [];
    const walk = (path: string) => {
      const entries = statSync(path).isDirectory()
        ? readdirSync(path).map((name) => `${path}/${name}`)
        : [path];
      for (const entry of entries) {
        if (entry.includes('node_modules')) continue;
        if (statSync(entry).isDirectory()) {
          walk(entry);
          continue;
        }
        if (!/\.(?:ts|tsx|md)$/.test(entry) || entry === self) continue;
        readFileSync(entry, 'utf8')
          .split('\n')
          .forEach((line, n) => {
            if (states.some((re) => re.test(line)) && !stillHolds.test(line)) {
              offenders.push(`${entry}:${n + 1}: ${line.trim()}`);
            }
          });
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
