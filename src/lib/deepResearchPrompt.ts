/**
 * The deep-research drug seeding prompt, as text an admin can paste.
 *
 * `agents/deep-research-drug-seeding.md` is the prompt a research agent gets
 * when seeding a whole new drug monograph (see `docs/deep-research-seeding.md`).
 * Producing a seed has always started with a manual chore: open the file on
 * GitHub, find the two HTML markers, copy exactly the block between them —
 * leaving the operator notes behind — and hand-substitute the drug name. This
 * module does that mechanically so the monograph page can offer it as one
 * click.
 *
 * Two rules from the file are load-bearing and are enforced here rather than
 * trusted:
 *
 *   - **Only the marked block is the prompt.** The surrounding "How to use this
 *     file" preamble and the trailing operator notes describe Kinetix-internal
 *     machinery the research agent cannot see and should not reason about, so
 *     they must not travel with it.
 *   - **The drug placeholder must actually be filled.** A prompt pasted with a
 *     literal `[DRUG NAME]` still reads as a valid request, and the agent will
 *     either ask or invent — which is exactly the failure the one-click flow
 *     exists to remove. A missing placeholder is therefore an error, not a
 *     silently unsubstituted copy.
 *
 * Both throw rather than degrade, and `deepResearchPrompt.test.ts` runs them
 * against the real file, so an edit to the markdown that breaks the extraction
 * fails the suite instead of shipping a subtly wrong clipboard payload.
 */

const PROMPT_START_MARKER = '<!-- PROMPT START -->';
const PROMPT_END_MARKER = '<!-- PROMPT END -->';

/** The placeholder in the prompt's Input section, filled with the drug name. */
export const DRUG_NAME_PLACEHOLDER = '[DRUG NAME]';

/**
 * The pasteable prompt: everything between the `PROMPT START` / `PROMPT END`
 * markers, with the markers themselves and the surrounding operator material
 * removed.
 */
export function extractSeedPrompt(markdown: string): string {
  const startIndex = markdown.indexOf(PROMPT_START_MARKER);
  const endIndex = markdown.indexOf(PROMPT_END_MARKER);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(
      'Deep-research prompt markers not found in agents/deep-research-drug-seeding.md',
    );
  }
  return markdown.slice(startIndex + PROMPT_START_MARKER.length, endIndex).trim();
}

/**
 * Substitute the drug name into the prompt's Input section.
 *
 * The name goes in verbatim — the prompt asks for a substance and any
 * decoration (brackets, quotes) would end up being researched as part of the
 * name. Only the leading/trailing whitespace is trimmed.
 */
export function fillDrugName(prompt: string, drugName: string): string {
  const name = drugName.trim();
  if (!name) throw new Error('A drug name is required to build the seeding prompt');
  if (!prompt.includes(DRUG_NAME_PLACEHOLDER)) {
    throw new Error(
      `Deep-research prompt no longer contains the ${DRUG_NAME_PLACEHOLDER} placeholder`,
    );
  }
  return prompt.split(DRUG_NAME_PLACEHOLDER).join(name);
}

/** In-flight or settled load of the extracted prompt, shared by every caller. */
let templatePromise: Promise<string> | null = null;

/**
 * The extracted prompt, still carrying its placeholder.
 *
 * The markdown is ~46 kB of text no reader of the app ever needs, so it is
 * pulled in by dynamic `import(...)`: Vite emits it as its own chunk, fetched
 * only where the seeding affordance is actually rendered.
 *
 * The result is cached at module scope, which is what lets a caller *warm* the
 * chunk ahead of the interaction that needs it — a clipboard write cannot
 * afford to wait on a network round-trip (see `copyPendingTextToClipboard`).
 * A failed load is not cached, so a lost network is retried on the next press
 * rather than disabling the button for the life of the tab.
 */
export function loadSeedPromptTemplate(): Promise<string> {
  if (!templatePromise) {
    const pending = import('../../agents/deep-research-drug-seeding.md?raw').then((module) =>
      extractSeedPrompt(module.default),
    );
    pending.catch(() => {
      if (templatePromise === pending) templatePromise = null;
    });
    templatePromise = pending;
  }
  return templatePromise;
}

/** Load the prompt markdown and return it ready to paste for `drugName`. */
export async function buildDrugSeedPrompt(drugName: string): Promise<string> {
  return fillDrugName(await loadSeedPromptTemplate(), drugName);
}
