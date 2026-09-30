/**
 * Atomic-fact splice for topic pages (#310 phase 2 / #348).
 *
 * Drug monographs use the v2 envelope (`sections[id].body`) and the
 * `applyFactOp` helper in `monographContent.ts` walks that structured
 * tree. Topic pages stay flat — a v1 TipTap doc with headings
 * carrying `data-section-id` attributes — so we splice fact nodes
 * directly into `doc.content`, anchored on the heading whose
 * `sectionId` matches the pending edit's `sectionId`.
 *
 * Section body for splice purposes is the slice of top-level nodes
 * between the matching heading (exclusive) and the next sectioned
 * heading (exclusive) — or the end of the doc, whichever comes first.
 */

import type { TipTapDoc } from "./monographContent.js";
import { isFactNode, type MonographFactNode } from "./monographContent.js";

export type TopicFactOperation = "add" | "replace" | "remove" | "reorder";

function asNode(value: unknown): {
  type?: string;
  attrs?: { sectionId?: unknown; [k: string]: unknown } | null;
} | null {
  if (!value || typeof value !== "object") return null;
  return value as {
    type?: string;
    attrs?: { sectionId?: unknown; [k: string]: unknown } | null;
  };
}

/**
 * Locate the index of the heading carrying `sectionId` and the index
 * of the next sectioned heading. Throws if the section can't be found.
 * The section body is `content.slice(headingIdx + 1, nextIdx)`.
 */
function locateSection(
  content: unknown[],
  sectionId: string,
): { headingIdx: number; nextIdx: number } {
  let headingIdx = -1;
  for (let i = 0; i < content.length; i += 1) {
    const node = asNode(content[i]);
    if (
      node?.type === "heading" &&
      node.attrs &&
      node.attrs.sectionId === sectionId
    ) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) {
    throw new Error(`Section "${sectionId}" not found on topic page`);
  }
  let nextIdx = content.length;
  for (let i = headingIdx + 1; i < content.length; i += 1) {
    const node = asNode(content[i]);
    if (
      node?.type === "heading" &&
      node.attrs &&
      typeof node.attrs.sectionId === "string" &&
      node.attrs.sectionId.length > 0
    ) {
      nextIdx = i;
      break;
    }
  }
  return { headingIdx, nextIdx };
}

/**
 * Apply an atomic-fact op to a topic-page TipTap doc and return a new
 * doc. Throws on locator/contract violations — `applyApprovedWikiFact`
 * maps these to 404/400 responses.
 *
 * `position` is interpreted only for the `reorder` op — it's the
 * destination index among **fact nodes** inside the section body
 * (0 = first fact, fact-count = after last fact). Non-fact nodes
 * (admin-authored paragraphs, lists, etc.) keep their absolute slots
 * within the section so reordering doesn't shuffle prose around the
 * facts. For other ops, `position` is ignored.
 */
export function applyTopicFactOp(
  doc: TipTapDoc,
  op: TopicFactOperation,
  locator: { sectionId: string; factId?: string; position?: number },
  fact: MonographFactNode | null,
): TipTapDoc {
  const content = ((doc.content ?? []) as unknown[]).slice();
  const { headingIdx, nextIdx } = locateSection(content, locator.sectionId);

  if (op === "add") {
    if (!fact) throw new Error("add op requires a fact node");
    // A queued `add` can reach approval after an admin published the same
    // fact by hand, so an unconditional splice would leave the section
    // carrying the factId twice. Resolve the anchor the way `replace` and
    // `remove` do on this engine — scoped to the section, since a topic
    // doc addresses facts by (sectionId, factId) — and upsert in place
    // when it is already occupied.
    const occupiedIdx = findFactIndex(
      content,
      headingIdx,
      nextIdx,
      fact.attrs.factId,
    );
    if (occupiedIdx !== -1) {
      content[occupiedIdx] = fact;
      return { ...doc, content };
    }
    // Append at the end of the section body — i.e. just before the next
    // sectioned heading (or at end of doc).
    content.splice(nextIdx, 0, fact);
    return { ...doc, content };
  }

  if (op === "replace") {
    if (!fact) throw new Error("replace op requires a fact node");
    if (!locator.factId)
      throw new Error("replace op requires a factId locator");
    const targetIdx = findFactIndex(
      content,
      headingIdx,
      nextIdx,
      locator.factId,
    );
    if (targetIdx === -1) {
      throw new Error(
        `Fact "${locator.factId}" not found in section "${locator.sectionId}"`,
      );
    }
    content[targetIdx] = fact;
    return { ...doc, content };
  }

  if (op === "remove") {
    if (!locator.factId) throw new Error("remove op requires a factId locator");
    const targetIdx = findFactIndex(
      content,
      headingIdx,
      nextIdx,
      locator.factId,
    );
    if (targetIdx === -1) {
      throw new Error(
        `Fact "${locator.factId}" not found in section "${locator.sectionId}"`,
      );
    }
    content.splice(targetIdx, 1);
    return { ...doc, content };
  }

  if (op === "reorder") {
    if (!locator.factId)
      throw new Error("reorder op requires a factId locator");
    if (
      typeof locator.position !== "number" ||
      !Number.isInteger(locator.position) ||
      locator.position < 0
    ) {
      throw new Error("reorder op requires a non-negative integer position");
    }
    // Slot-anchored fact reorder. We split the section body into:
    //   - leadingProse: non-fact nodes between heading and the first fact
    //   - slots[k]:     { fact, trailingProse }  — one per fact in order,
    //                    where trailingProse is the run of non-fact nodes
    //                    after fact k and before fact k+1 (or before
    //                    nextIdx for the last slot)
    // Reordering keeps `leadingProse` and every `trailingProse` block
    // anchored at their slot positions; only the `fact` identities
    // rotate. This was the implicit promise of the test "non-fact
    // siblings stay anchored" but the previous splice-based
    // implementation only happened to satisfy the all-trailing-prose
    // case — a paragraph BETWEEN two facts shifted out of its slot.
    const leadingProse: unknown[] = [];
    const slots: Array<{ fact: unknown; trailingProse: unknown[] }> = [];
    for (let i = headingIdx + 1; i < nextIdx; i += 1) {
      const node = content[i];
      if (isFactNode(node)) {
        slots.push({ fact: node, trailingProse: [] });
      } else if (slots.length === 0) {
        leadingProse.push(node);
      } else {
        slots[slots.length - 1]!.trailingProse.push(node);
      }
    }
    const sourceSlotIdx = slots.findIndex(
      (s) => isFactNode(s.fact) && s.fact.attrs.factId === locator.factId,
    );
    if (sourceSlotIdx === -1) {
      throw new Error(
        `Fact "${locator.factId}" not found in section "${locator.sectionId}"`,
      );
    }
    const targetSlotIdx = Math.min(locator.position, slots.length - 1);
    if (sourceSlotIdx !== targetSlotIdx) {
      const factsInOrder = slots.map((s) => s.fact);
      const [moved] = factsInOrder.splice(sourceSlotIdx, 1);
      factsInOrder.splice(targetSlotIdx, 0, moved);
      // Reassign fact identities to slots; the slot's trailingProse
      // stays put.
      for (let k = 0; k < slots.length; k += 1) {
        slots[k]!.fact = factsInOrder[k]!;
      }
    }
    const newSection: unknown[] = [...leadingProse];
    for (const s of slots) {
      newSection.push(s.fact);
      newSection.push(...s.trailingProse);
    }
    const rebuilt: unknown[] = [
      ...content.slice(0, headingIdx + 1),
      ...newSection,
      ...content.slice(nextIdx),
    ];
    return { ...doc, content: rebuilt };
  }

  throw new Error(`Unsupported fact operation "${op}"`);
}

function findFactIndex(
  content: unknown[],
  headingIdx: number,
  nextIdx: number,
  factId: string,
): number {
  for (let i = headingIdx + 1; i < nextIdx; i += 1) {
    const node = content[i];
    if (isFactNode(node) && node.attrs.factId === factId) return i;
  }
  return -1;
}
