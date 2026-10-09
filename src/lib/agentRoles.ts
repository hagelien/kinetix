/**
 * Which review level (T1–T3) each active agent fills, for the "Agents" wiki
 * guide (`src/components/wiki/builtin/AgentReviewGuide.tsx`).
 *
 * The levels are workflow roles, not stored states
 * (docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md): a
 * mid-tier identity produces and peer-reviews (T1), a flagship identity is the
 * blind verifier (T2), and a flagship identity holding the adjudicator grant
 * sits on the T3 panel. Light-tier and unclassified identities fill none of
 * them — they are never trusted for scientific judgment.
 *
 * Display only. The consensus gate reads the server-owned tier, never this.
 */

export type ReviewLevel = 'T1' | 'T2' | 'T3';

export const REVIEW_LEVELS: readonly ReviewLevel[] = ['T1', 'T2', 'T3'];

/** The slice of a `GET /api/agents` row this grouping needs. */
export interface RosterAgent {
  id: number;
  name: string;
  nameEn: string | null;
  modelTier: string | null;
  adjudicator: boolean;
  recentModel: string | null;
}

export function reviewLevelOf(agent: RosterAgent): ReviewLevel | null {
  if (agent.modelTier === 'flagship') return agent.adjudicator ? 'T3' : 'T2';
  if (agent.modelTier === 'mid') return 'T1';
  return null;
}

export function groupAgentsByReviewLevel(
  agents: readonly RosterAgent[],
): Record<ReviewLevel, RosterAgent[]> {
  const groups: Record<ReviewLevel, RosterAgent[]> = { T1: [], T2: [], T3: [] };
  for (const agent of agents) {
    const level = reviewLevelOf(agent);
    if (level) groups[level].push(agent);
  }
  return groups;
}

const VENDOR_NAMES: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  llama: 'Llama',
  mistral: 'Mistral',
};

/**
 * Turn a reported model id into a readable name:
 * `claude-sonnet-5-5` → `Claude Sonnet 5.5`, `gpt-5.6-sol` → `GPT-5.6 Sol`.
 * Date stamps and context-window suffixes are dropped. An id that does not
 * look like `vendor-…` comes back unchanged.
 */
export function formatModelName(id: string): string {
  const cleaned = id
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .toLowerCase();
  const tokens = cleaned
    .split(/[-_\s]+/)
    .filter((tok) => tok && !/^\d{8}$/.test(tok) && tok !== 'latest');
  const vendor = tokens[0];
  if (!vendor || !VENDOR_NAMES[vendor]) return id.trim();

  const words: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++] as string;
    if (/^\d+(\.\d+)?$/.test(tok)) {
      // Consecutive bare numbers are one version: `5`, `5` → `5.5`.
      const parts = [tok];
      while (i < tokens.length && /^\d+$/.test(tokens[i] as string)) {
        parts.push(tokens[i++] as string);
      }
      const version = parts.join('.');
      // GPT writes its version joined to the vendor name: `GPT-5.6`.
      if (words.length === 1 && words[0] === 'GPT') words[0] = `GPT-${version}`;
      else words.push(version);
      continue;
    }
    words.push(VENDOR_NAMES[tok] ?? tok.charAt(0).toUpperCase() + tok.slice(1));
  }
  return words.join(' ');
}
