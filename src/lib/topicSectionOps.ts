/**
 * Section-header CRUD splice for topic pages (#310 phase 3 / #349).
 *
 * Phase 2 (#348) introduced the heading-anchored sectionId model; this
 * file extends it with `wiki_section` operations that mutate the
 * heading list itself: add, edit (rename), reorder, remove.
 *
 * The section model: a topic page is a flat v1 TipTap doc whose
 * top-level nodes are either pre-heading prose, a `heading` carrying
 * `data-section-id` (a section break), or section-body nodes living
 * between two sectioned headings. Operating on sections means moving
 * heading + body slice as a single unit so existing facts inside the
 * section keep their anchors after the splice.
 */

import { isValidTopicSectionId, mintUniqueSectionId } from "./topicSections.js";
import type { TipTapDoc } from "./monographContent.js";

export type TopicSectionOperation = "add" | "edit" | "reorder" | "remove";

interface TipTapNodeShape {
  type?: string;
  attrs?: { sectionId?: unknown; level?: unknown; [k: string]: unknown } | null;
  content?: unknown[];
  text?: string;
}

function asNode(value: unknown): TipTapNodeShape | null {
  if (!value || typeof value !== "object") return null;
  return value as TipTapNodeShape;
}

function isSectionedHeading(value: unknown): boolean {
  const node = asNode(value);
  return Boolean(
    node?.type === "heading" &&
    node.attrs &&
    typeof node.attrs.sectionId === "string" &&
    node.attrs.sectionId.length > 0,
  );
}

function getSectionId(value: unknown): string | null {
  const node = asNode(value);
  if (!node || node.type !== "heading" || !node.attrs) return null;
  const id = node.attrs.sectionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Layout of a topic-page doc by section. `preamble` holds any nodes
 * before the first sectioned heading (admin-authored intro prose);
 * `sections` is one entry per sectioned heading carrying its heading
 * node plus the body slice up to (but not including) the next
 * sectioned heading.
 */
interface SectionLayout {
  preamble: unknown[];
  sections: Array<{
    sectionId: string;
    heading: unknown;
    body: unknown[];
  }>;
}

function layoutFromContent(content: unknown[]): SectionLayout {
  const preamble: unknown[] = [];
  const sections: SectionLayout["sections"] = [];
  let current: SectionLayout["sections"][number] | null = null;

  for (const raw of content) {
    if (isSectionedHeading(raw)) {
      if (current) sections.push(current);
      current = {
        sectionId: getSectionId(raw)!,
        heading: raw,
        body: [],
      };
    } else if (current) {
      current.body.push(raw);
    } else {
      preamble.push(raw);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function layoutToContent(layout: SectionLayout): unknown[] {
  const out: unknown[] = [...layout.preamble];
  for (const section of layout.sections) {
    out.push(section.heading);
    out.push(...section.body);
  }
  return out;
}

function clamp(position: number, max: number): number {
  if (!Number.isFinite(position) || position < 0) return 0;
  if (position > max) return max;
  return Math.floor(position);
}

function makeHeadingNode(args: {
  text: string;
  level: number;
  sectionId: string;
}): unknown {
  return {
    type: "heading",
    attrs: { level: args.level, sectionId: args.sectionId },
    content: [{ type: "text", text: args.text }],
  };
}

function setHeadingText(heading: unknown, text: string): unknown {
  const node = asNode(heading);
  if (!node) return heading;
  return {
    ...node,
    content: [{ type: "text", text }],
  };
}

export interface AddSectionInput {
  headingText: string;
  /** TipTap heading level. Topic pages typically use h2 / h3. */
  headingLevel: number;
  /** Insertion index in the section list (0-based). */
  position: number;
}

export interface EditSectionInput {
  sectionId: string;
  headingText: string;
}

export interface ReorderSectionInput {
  sectionId: string;
  /** New index in the section list (0-based). */
  position: number;
}

export interface RemoveSectionInput {
  sectionId: string;
}

/**
 * Add a fresh section heading at the given position. The new
 * sectionId is minted from the heading text and reserved against the
 * doc's existing ids so it never collides with a live section. The
 * minted id is returned so the caller (approval handler) can record
 * it in the revision summary.
 */
export function applyAddSection(
  doc: TipTapDoc,
  input: AddSectionInput,
): { doc: TipTapDoc; sectionId: string } {
  if (!input.headingText.trim()) {
    throw new Error("add section: headingText must not be empty");
  }
  if (![1, 2, 3, 4, 5, 6].includes(input.headingLevel)) {
    throw new Error(`add section: invalid headingLevel ${input.headingLevel}`);
  }
  const content = ((doc.content ?? []) as unknown[]).slice();
  const layout = layoutFromContent(content);
  const taken = new Set(layout.sections.map((s) => s.sectionId));
  const sectionId = mintUniqueSectionId(input.headingText, taken);
  const heading = makeHeadingNode({
    text: input.headingText,
    level: input.headingLevel,
    sectionId,
  });
  const idx = clamp(input.position, layout.sections.length);
  layout.sections.splice(idx, 0, { sectionId, heading, body: [] });
  return {
    doc: { ...doc, content: layoutToContent(layout) },
    sectionId,
  };
}

/**
 * Rename an existing section heading. The sectionId is preserved so
 * any facts anchored against it stay reachable.
 */
export function applyEditSection(
  doc: TipTapDoc,
  input: EditSectionInput,
): TipTapDoc {
  if (!input.headingText.trim()) {
    throw new Error("edit section: headingText must not be empty");
  }
  if (!isValidTopicSectionId(input.sectionId)) {
    throw new Error(`edit section: invalid sectionId "${input.sectionId}"`);
  }
  const content = ((doc.content ?? []) as unknown[]).slice();
  const layout = layoutFromContent(content);
  const target = layout.sections.find((s) => s.sectionId === input.sectionId);
  if (!target) {
    throw new Error(`edit section: section "${input.sectionId}" not found`);
  }
  target.heading = setHeadingText(target.heading, input.headingText);
  return { ...doc, content: layoutToContent(layout) };
}

/**
 * Move a section to a new position. The body slice travels with the
 * heading so facts inside the section remain anchored.
 */
export function applyReorderSection(
  doc: TipTapDoc,
  input: ReorderSectionInput,
): TipTapDoc {
  if (!isValidTopicSectionId(input.sectionId)) {
    throw new Error(`reorder section: invalid sectionId "${input.sectionId}"`);
  }
  const content = ((doc.content ?? []) as unknown[]).slice();
  const layout = layoutFromContent(content);
  const idx = layout.sections.findIndex((s) => s.sectionId === input.sectionId);
  if (idx === -1) {
    throw new Error(`reorder section: section "${input.sectionId}" not found`);
  }
  const moved = layout.sections.splice(idx, 1)[0];
  if (!moved) {
    throw new Error(
      `reorder section: section "${input.sectionId}" disappeared`,
    );
  }
  const targetIdx = clamp(input.position, layout.sections.length);
  layout.sections.splice(targetIdx, 0, moved);
  return { ...doc, content: layoutToContent(layout) };
}

/**
 * Remove a section heading. Refuses if the section body is non-empty
 * — child facts must be removed first via the wiki_fact flow. This
 * is the conservative resolution from the #349 design discussion;
 * a future "remove + reject child facts" flow can relax it.
 */
export function applyRemoveSection(
  doc: TipTapDoc,
  input: RemoveSectionInput,
): TipTapDoc {
  if (!isValidTopicSectionId(input.sectionId)) {
    throw new Error(`remove section: invalid sectionId "${input.sectionId}"`);
  }
  const content = ((doc.content ?? []) as unknown[]).slice();
  const layout = layoutFromContent(content);
  const idx = layout.sections.findIndex((s) => s.sectionId === input.sectionId);
  if (idx === -1) {
    throw new Error(`remove section: section "${input.sectionId}" not found`);
  }
  const section = layout.sections[idx];
  if (section && section.body.length > 0) {
    throw new Error(
      `remove section: section "${input.sectionId}" is not empty; remove its facts first`,
    );
  }
  layout.sections.splice(idx, 1);
  return { ...doc, content: layoutToContent(layout) };
}

/**
 * Strip every fact node from the named section's body, leaving any
 * non-fact prose anchored. Used by the #360 cascade-remove path so
 * `applyRemoveSection` can run after the cascade — without this, a
 * section that contains only facts would still trigger the
 * "section is not empty" guard because the body slice still has
 * those nodes. After clearing, applyRemoveSection refuses only if
 * non-fact prose remains.
 */
export function clearSectionFacts(
  doc: TipTapDoc,
  sectionId: string,
): TipTapDoc {
  if (!isValidTopicSectionId(sectionId)) {
    throw new Error(`clear section facts: invalid sectionId "${sectionId}"`);
  }
  const content = ((doc.content ?? []) as unknown[]).slice();
  const layout = layoutFromContent(content);
  const target = layout.sections.find((s) => s.sectionId === sectionId);
  if (!target) {
    throw new Error(`clear section facts: section "${sectionId}" not found`);
  }
  target.body = target.body.filter((node) => {
    const n = asNode(node);
    return n?.type !== "fact";
  });
  return { ...doc, content: layoutToContent(layout) };
}

/**
 * Test helper: count how many top-level body nodes a section carries.
 * Exposed so callers (the API guard, the UI confirmation) can show
 * "section has N items" without re-running the layout walk.
 */
export function countSectionBodyNodes(
  doc: TipTapDoc | null | undefined,
  sectionId: string,
): number {
  if (!doc) return 0;
  const layout = layoutFromContent(((doc.content ?? []) as unknown[]).slice());
  return (
    layout.sections.find((s) => s.sectionId === sectionId)?.body.length ?? 0
  );
}
