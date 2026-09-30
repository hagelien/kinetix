/**
 * Drug-monograph content envelope (v2).
 *
 * Drug monograph pages store their TipTap content as a tagged v2 object:
 *
 *   { version: 2, sections: { [sectionId]: { body, fields? } } }
 *
 * Each section/field `body` is a complete TipTap doc so the per-section
 * editors (Phase 1c) can mount them directly. Topic pages keep the legacy
 * free-form `{ type: 'doc', ... }` shape (v1); helpers here treat both
 * shapes transparently.
 */

import {
  MONOGRAPH_SECTIONS,
  isMonographSectionId,
  getMonographField,
  isMergedMonographFieldId,
  MERGED_MONOGRAPH_FIELD_IDS,
} from './monographSections.js';
import type { MonographSectionId } from './monographSections.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TipTapDoc {
  type: 'doc';
  content?: unknown[];
}

export interface MonographFieldContentV2 {
  body?: TipTapDoc;
  /**
   * Citation ids attached to this field, used by the atomic-fact pipeline in
   * later phases to track which references back the field's claim. Absent on
   * fields authored before #284 lands.
   */
  refs?: number[];
}

export interface MonographSectionContentV2 {
  body?: TipTapDoc;
  fields?: Partial<Record<string, MonographFieldContentV2>>;
}

export interface MonographContentV2 {
  version: 2;
  sections: Partial<Record<MonographSectionId, MonographSectionContentV2>>;
}

// ─── Construction ────────────────────────────────────────────────────────────

export function emptyTipTapDoc(): TipTapDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function emptyMonographContentV2(): MonographContentV2 {
  return { version: 2, sections: {} };
}

// ─── Detection ───────────────────────────────────────────────────────────────

export function isMonographContentV2(
  value: unknown,
): value is MonographContentV2 {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; sections?: unknown };
  return (
    v.version === 2 &&
    typeof v.sections === 'object' &&
    v.sections !== null &&
    !Array.isArray(v.sections)
  );
}

export function isTipTapDoc(value: unknown): value is TipTapDoc {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; content?: unknown };
  return (
    v.type === 'doc' && (v.content === undefined || Array.isArray(v.content))
  );
}

/**
 * `true` for a doc with no meaningful content. Treats the canonical empty
 * shape `{ type: 'doc', content: [{ type: 'paragraph' }] }` as empty so we
 * don't render headings for sections an author never touched.
 */
export function isTipTapDocEmpty(doc: TipTapDoc | null | undefined): boolean {
  if (!doc) return true;
  const content = doc.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every(isEmptyNode);
}

function isEmptyNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === 'paragraph') {
    if (!Array.isArray(n.content) || n.content.length === 0) return true;
    return n.content.every(isEmptyNode);
  }
  if (n.type === 'text') {
    return typeof n.text !== 'string' || n.text.trim() === '';
  }
  return false;
}

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Wrap a legacy v1 free-form TipTap doc as a v2 envelope, placing the entire
 * existing body under the first remaining section (`pd`). Issue #396 removed
 * the original `summary` landing zone along with `key_facts` and `chemistry`;
 * legacy v1 content lands in `pd` as a parking spot until an author
 * redistributes paragraphs to the correct sections.
 *
 * Idempotent: if `content` is already v2, it is returned normalized.
 */
export function wrapV1AsV2(content: unknown): MonographContentV2 {
  if (isMonographContentV2(content))
    return normalizeMonographContentV2(content);
  if (isTipTapDoc(content) && !isTipTapDocEmpty(content)) {
    return {
      version: 2,
      sections: { pd: { body: content } },
    };
  }
  return emptyMonographContentV2();
}

/**
 * Merge retired sub-category field bodies into their parent section.
 *
 * Issue #458 removed sub-categories such as `effects.psychiatric` and
 * `analytical.matrix_blood` as authoring targets. Existing monographs may
 * still carry fact bodies under those legacy fields; normalize them into the
 * section body so they keep rendering, remain editable, and get persisted in
 * the simpler shape on the next approved edit/save. Fields removed by #396
 * are intentionally not in MERGED_MONOGRAPH_FIELD_IDS, so old parameter-table
 * slots stay hidden.
 */
export function normalizeMonographContentV2(
  content: MonographContentV2,
): MonographContentV2 {
  const next: MonographContentV2 = { version: 2, sections: {} };
  for (const section of MONOGRAPH_SECTIONS) {
    const stored = content.sections[section.id];
    if (!stored) continue;

    const mergedContent: unknown[] = [];
    if (stored.body && !isTipTapDocEmpty(stored.body)) {
      mergedContent.push(...(stored.body.content ?? []));
    }

    const fields = stored.fields ?? {};
    for (const fieldId of MERGED_MONOGRAPH_FIELD_IDS[section.id] ?? []) {
      const field = fields[fieldId];
      if (field?.body && !isTipTapDocEmpty(field.body)) {
        mergedContent.push(...(field.body.content ?? []));
      }
    }

    const remainingFields: Partial<Record<string, MonographFieldContentV2>> =
      {};
    for (const [fieldId, field] of Object.entries(fields)) {
      if (!field) continue;
      if (isMergedMonographFieldId(section.id, fieldId)) continue;
      if (!getMonographField(section.id, fieldId)) continue;
      remainingFields[fieldId] = field;
    }

    const normalizedSection: MonographSectionContentV2 = {};
    if (mergedContent.length > 0) {
      normalizedSection.body = { type: 'doc', content: mergedContent };
    }
    if (Object.keys(remainingFields).length > 0) {
      normalizedSection.fields = remainingFields;
    }
    if (normalizedSection.body || normalizedSection.fields) {
      next.sections[section.id] = normalizedSection;
    }
  }
  return next;
}

// ─── Read helpers ────────────────────────────────────────────────────────────

export function getSectionBody(
  content: MonographContentV2,
  sectionId: MonographSectionId,
): TipTapDoc | null {
  const section = normalizeMonographContentV2(content).sections[sectionId];
  if (!section?.body) return null;
  return isTipTapDocEmpty(section.body) ? null : section.body;
}

export function getFieldBody(
  content: MonographContentV2,
  sectionId: MonographSectionId,
  fieldId: string,
): TipTapDoc | null {
  const field = content.sections[sectionId]?.fields?.[fieldId];
  if (!field?.body) return null;
  return isTipTapDocEmpty(field.body) ? null : field.body;
}

/**
 * Yield non-empty section/field bodies in the declared section order from
 * `MONOGRAPH_SECTIONS`. Used by server-side render and plaintext extraction
 * to walk content deterministically.
 */
export interface MonographBodyChunk {
  sectionId: MonographSectionId;
  /** Field id when the chunk belongs to a sub-field; undefined for the section body itself. */
  fieldId?: string;
  body: TipTapDoc;
}

export function iterateSectionBodies(
  content: MonographContentV2,
): MonographBodyChunk[] {
  const out: MonographBodyChunk[] = [];
  const normalized = normalizeMonographContentV2(content);
  for (const section of MONOGRAPH_SECTIONS) {
    const stored = normalized.sections[section.id];
    if (!stored) continue;
    if (stored.body && !isTipTapDocEmpty(stored.body)) {
      out.push({ sectionId: section.id, body: stored.body });
    }
    if (stored.fields) {
      // Walk fields in the schema-declared order so output is deterministic
      // and stable across edits (object key order would be insertion order).
      for (const field of section.fields) {
        const stored = content.sections[section.id]?.fields?.[field.id];
        if (stored?.body && !isTipTapDocEmpty(stored.body)) {
          out.push({
            sectionId: section.id,
            fieldId: field.id,
            body: stored.body,
          });
        }
      }
    }
  }
  return out;
}

// ─── Write helpers (immutable) ───────────────────────────────────────────────

export function setSectionBody(
  content: MonographContentV2,
  sectionId: MonographSectionId,
  body: TipTapDoc | null,
): MonographContentV2 {
  const normalized = normalizeMonographContentV2(content);
  const next: MonographContentV2 = {
    version: 2,
    sections: { ...normalized.sections },
  };
  const existing = next.sections[sectionId] ?? {};
  if (body === null || isTipTapDocEmpty(body)) {
    const { body: _drop, ...rest } = existing;
    void _drop;
    next.sections[sectionId] = rest;
  } else {
    next.sections[sectionId] = { ...existing, body };
  }
  return next;
}

export function setFieldBody(
  content: MonographContentV2,
  sectionId: MonographSectionId,
  fieldId: string,
  body: TipTapDoc | null,
): MonographContentV2 {
  const next: MonographContentV2 = {
    version: 2,
    sections: { ...content.sections },
  };
  const section = { ...(next.sections[sectionId] ?? {}) };
  const fields = { ...(section.fields ?? {}) };
  if (body === null || isTipTapDocEmpty(body)) {
    delete fields[fieldId];
  } else {
    fields[fieldId] = { ...(fields[fieldId] ?? {}), body };
  }
  if (Object.keys(fields).length === 0) {
    delete section.fields;
  } else {
    section.fields = fields;
  }
  next.sections[sectionId] = section;
  return next;
}

/**
 * `true` when the v2 envelope has no non-empty body anywhere. Useful for the
 * editor's save guard (don't submit an entirely empty monograph).
 */
export function isMonographContentEmpty(content: MonographContentV2): boolean {
  return (
    iterateSectionBodies(normalizeMonographContentV2(content)).length === 0
  );
}

/**
 * Whether a monograph page's stored content is more than the empty stub.
 *
 * `contentPlaintext.trim().length > 0` alone would miss a doc whose plaintext
 * cache is stale, and a naive `content.length > 0` fallback would count the
 * canonical empty shape the TipTap editor writes on save — `{ type: 'doc',
 * content: [{ type: 'paragraph' }] }` — as content, silently flipping a
 * caller's empty/non-empty judgement to the wrong side. Checks both the v2
 * monograph envelope and the legacy free-form doc.
 */
export function monographHasContent(row: {
  content: unknown;
  contentPlaintext: string | null;
}): boolean {
  if (row.contentPlaintext && row.contentPlaintext.trim().length > 0) return true;
  const content = row.content;
  if (isMonographContentV2(content)) return !isMonographContentEmpty(content);
  if (isTipTapDoc(content)) return !isTipTapDocEmpty(content);
  return false;
}

// ─── Atomic facts (issue #284) ───────────────────────────────────────────────

/**
 * A single atomic fact, stored as a top-level node inside a section's body.
 * Each fact carries a stable `factId` (UUID) so subsequent edits/removals
 * can target it precisely, plus the citation ids backing the claim.
 *
 * The node is shaped as a TipTap `fact` node containing a single paragraph;
 * the TipTap extension that registers the schema-side definition lands with
 * the editor work in Phase 2c. For now the helpers operate on plain JSON.
 */
export interface MonographFactNode {
  type: 'fact';
  attrs: {
    factId: string;
    referenceIds: number[];
  };
  content: unknown[];
}

export function isFactNode(node: unknown): node is MonographFactNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as { type?: unknown; attrs?: unknown };
  if (n.type !== 'fact') return false;
  if (!n.attrs || typeof n.attrs !== 'object') return false;
  const a = n.attrs as { factId?: unknown; referenceIds?: unknown };
  return typeof a.factId === 'string' && Array.isArray(a.referenceIds);
}

/**
 * True when a section body contains at least one non-fact, non-empty
 * top-level child — i.e. it carries grandfathered v1 prose that #303
 * hard mode can't author from. A pure fact list (every top-level
 * child is a `fact` node) returns false; a mixed body returns true
 * because the prose paragraphs around the facts are still legacy
 * content. Used by the section editor to decide whether to surface
 * the legacy-prose banner.
 */
export function hasLegacyProse(doc: TipTapDoc | null | undefined): boolean {
  if (!doc) return false;
  const top = Array.isArray(doc.content) ? doc.content : [];
  for (const node of top) {
    if (isFactNode(node)) continue;
    if (!node || typeof node !== 'object') continue;
    const n = node as { type?: unknown; content?: unknown };
    // Empty paragraphs (the seed doc TipTap inserts) are not "prose"
    // worth banning — they exist for cursor placement only.
    if (n.type === 'paragraph') {
      const inner = Array.isArray(n.content) ? n.content : [];
      const hasText = inner.some((child) => {
        if (!child || typeof child !== 'object') return false;
        const c = child as { type?: unknown; text?: unknown };
        return (
          c.type === 'text' &&
          typeof c.text === 'string' &&
          c.text.trim() !== ''
        );
      });
      if (hasText) return true;
      continue;
    }
    // Any other top-level node (heading, list, table, image, …) is
    // legacy structured prose by definition.
    return true;
  }
  return false;
}

/**
 * Build a fact node wrapping a plain-text statement plus its citations.
 * The `factId` is required so callers stay in control of identity (for
 * deterministic tests, server-side ids, etc.); production callers will
 * typically pass `crypto.randomUUID()`.
 */
export function createFactNode(opts: {
  factId: string;
  statement: string;
  referenceIds: number[];
  content?: unknown[];
}): MonographFactNode {
  const content =
    opts.content && opts.content.length > 0
      ? cloneJsonArray(opts.content)
      : [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: opts.statement }],
          },
        ];
  return {
    type: 'fact',
    attrs: {
      factId: opts.factId,
      referenceIds: [...opts.referenceIds],
    },
    content,
  };
}

function cloneJsonArray(value: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(value)) as unknown[];
}

/**
 * Where a fact lives within a v2 envelope. Returned by `findFactInContent`
 * so callers can verify existence before applying replace/remove.
 */
export interface FactLocation {
  sectionId: MonographSectionId;
  /** Set when the fact lives inside a section field rather than the section body. */
  fieldId?: string;
  /** 0-indexed position within the body's content array. */
  index: number;
}

export function findFactInContent(
  content: MonographContentV2,
  factId: string,
): FactLocation | null {
  for (const [sectionId, section] of Object.entries(content.sections)) {
    if (!section) continue;
    if (!isMonographSectionId(sectionId)) continue;
    if (section.body) {
      const idx = findFactIndexInDoc(section.body, factId);
      if (idx >= 0) {
        return { sectionId: sectionId as MonographSectionId, index: idx };
      }
    }
    if (section.fields) {
      for (const [fieldId, field] of Object.entries(section.fields)) {
        if (!field?.body) continue;
        if (
          !getMonographField(sectionId, fieldId) &&
          !isMergedMonographFieldId(sectionId, fieldId)
        ) {
          continue;
        }
        const idx = findFactIndexInDoc(field.body, factId);
        if (idx >= 0) {
          return {
            sectionId: sectionId as MonographSectionId,
            fieldId,
            index: idx,
          };
        }
      }
    }
  }
  return null;
}

function findFactIndexInDoc(doc: TipTapDoc, factId: string): number {
  if (!Array.isArray(doc.content)) return -1;
  return doc.content.findIndex(
    (n) => isFactNode(n) && n.attrs.factId === factId,
  );
}

/**
 * Append a fact to a section body. If the section has no body yet, one is
 * created with the fact as its only child. Returns a new envelope; the
 * input is not mutated.
 */
export function appendFactToSection(
  content: MonographContentV2,
  sectionId: MonographSectionId,
  fact: MonographFactNode,
): MonographContentV2 {
  const normalized = normalizeMonographContentV2(content);
  const next: MonographContentV2 = {
    version: 2,
    sections: { ...normalized.sections },
  };
  const existing = next.sections[sectionId] ?? {};
  const body: TipTapDoc = existing.body
    ? { ...existing.body, content: [...(existing.body.content ?? [])] }
    : { type: 'doc', content: [] };
  body.content = [...(body.content ?? []), fact];
  next.sections[sectionId] = { ...existing, body };
  return next;
}

/**
 * Append a fact to a section field's body (e.g. effects.cardiovascular).
 * Creates the field and its body if they don't exist yet.
 */
export function appendFactToField(
  content: MonographContentV2,
  sectionId: MonographSectionId,
  fieldId: string,
  fact: MonographFactNode,
): MonographContentV2 {
  const next: MonographContentV2 = {
    version: 2,
    sections: { ...content.sections },
  };
  const section = { ...(next.sections[sectionId] ?? {}) };
  const fields = { ...(section.fields ?? {}) };
  const field = { ...(fields[fieldId] ?? {}) };
  const body: TipTapDoc = field.body
    ? { ...field.body, content: [...(field.body.content ?? [])] }
    : { type: 'doc', content: [] };
  body.content = [...(body.content ?? []), fact];
  field.body = body;
  fields[fieldId] = field;
  section.fields = fields;
  next.sections[sectionId] = section;
  return next;
}

/**
 * Replace the fact identified by `factId` with `nextFact`. Throws if no
 * matching fact exists — callers should `findFactInContent` first to
 * surface a friendly "this fact has been removed" message at the API/UI.
 *
 * Throws if `nextFact.attrs.factId !== factId`. The factId is the stable
 * anchor that subsequent replace/remove pending edits target; silently
 * rewriting it during a replacement would invalidate any other pending
 * edits referencing the old id. Callers must build the replacement via
 * `createFactNode({ factId: <existing id>, ... })`.
 */
export function replaceFactInSection(
  content: MonographContentV2,
  factId: string,
  nextFact: MonographFactNode,
): MonographContentV2 {
  if (nextFact.attrs.factId !== factId) {
    throw new Error(
      `replaceFactInSection: replacement factId "${nextFact.attrs.factId}" does not match target "${factId}"`,
    );
  }
  return mutateFact(content, factId, (doc, idx) => {
    const newContent = [...(doc.content ?? [])];
    newContent[idx] = nextFact;
    return newContent;
  });
}

/**
 * Remove the fact identified by `factId`. Throws if it cannot be found.
 */
export function removeFactFromSection(
  content: MonographContentV2,
  factId: string,
): MonographContentV2 {
  return mutateFact(content, factId, (doc, idx) => {
    const newContent = [...(doc.content ?? [])];
    newContent.splice(idx, 1);
    return newContent;
  });
}

function mutateFact(
  content: MonographContentV2,
  factId: string,
  mutate: (doc: TipTapDoc, index: number) => unknown[],
): MonographContentV2 {
  const normalized = normalizeMonographContentV2(content);
  const loc = findFactInContent(normalized, factId);
  if (!loc) {
    throw new Error(`Fact not found: ${factId}`);
  }

  const next: MonographContentV2 = {
    version: 2,
    sections: { ...normalized.sections },
  };
  const section = { ...(next.sections[loc.sectionId] ?? {}) };
  if (loc.fieldId) {
    const fields = { ...(section.fields ?? {}) };
    const field = { ...(fields[loc.fieldId] ?? {}) };
    if (!field.body) throw new Error('Fact location lost field body');
    const newBody: TipTapDoc = {
      ...field.body,
      content: mutate(field.body, loc.index),
    };
    if (Array.isArray(newBody.content) && newBody.content.length === 0) {
      delete field.body;
    } else {
      field.body = newBody;
    }
    if (!field.body && (!field.refs || field.refs.length === 0)) {
      delete fields[loc.fieldId];
    } else {
      fields[loc.fieldId] = field;
    }
    if (Object.keys(fields).length === 0) {
      delete section.fields;
    } else {
      section.fields = fields;
    }
  } else {
    if (!section.body) throw new Error('Fact location lost section body');
    const newBody: TipTapDoc = {
      ...section.body,
      content: mutate(section.body, loc.index),
    };
    if (Array.isArray(newBody.content) && newBody.content.length === 0) {
      delete section.body;
    } else {
      section.body = newBody;
    }
  }
  next.sections[loc.sectionId] = section;
  return next;
}

/**
 * Collect every citation id referenced from a monograph content envelope.
 * Walks fact node `attrs.referenceIds`, inline `footnote` mark/node
 * `attrs.referenceId`, and the v2 field-level `refs` arrays. Accepts
 * either a v2 envelope or a legacy free-form TipTap doc; returns an
 * empty Set for any other shape.
 *
 * Used by the references API (`api/references.ts`) to hide citations
 * that were created during a cancelled "add fact" flow but never linked
 * to anything (#304).
 */
export function extractCitationIds(content: unknown): Set<number> {
  const out = new Set<number>();
  if (!content || typeof content !== 'object') return out;
  if (isMonographContentV2(content)) {
    // Skip section keys that are no longer in `MONOGRAPH_SECTIONS` (e.g.
    // the three sections removed by #396) and field keys that are no
    // longer declared on the section (e.g. the PK parameter fields
    // removed alongside them). Their bodies are hidden by the renderer
    // and the schema-driven plaintext extractor, so the citations API
    // must not surface refs that live exclusively inside those orphaned
    // bodies either.
    const normalized = normalizeMonographContentV2(content);
    for (const [sectionId, section] of Object.entries(normalized.sections)) {
      if (!section) continue;
      if (!isMonographSectionId(sectionId)) continue;
      if (section.body) walkDocForCitations(section.body, out);
      if (section.fields) {
        for (const [fieldId, field] of Object.entries(section.fields)) {
          if (!field) continue;
          if (!getMonographField(sectionId, fieldId)) continue;
          if (Array.isArray(field.refs)) {
            for (const id of field.refs) {
              if (typeof id === 'number' && Number.isFinite(id)) out.add(id);
            }
          }
          if (field.body) walkDocForCitations(field.body, out);
        }
      }
    }
    return out;
  }
  if (isTipTapDoc(content)) {
    walkDocForCitations(content, out);
  }
  return out;
}

function walkDocForCitations(doc: TipTapDoc, out: Set<number>): void {
  if (!Array.isArray(doc.content)) return;
  walkNodesForCitations(doc.content, out);
}

function walkNodesForCitations(nodes: unknown[], out: Set<number>): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as {
      type?: unknown;
      attrs?: unknown;
      content?: unknown;
      marks?: unknown;
    };
    if (n.type === 'fact' && n.attrs && typeof n.attrs === 'object') {
      const refs = (n.attrs as { referenceIds?: unknown }).referenceIds;
      if (Array.isArray(refs)) {
        for (const id of refs) {
          if (typeof id === 'number' && Number.isFinite(id)) out.add(id);
        }
      }
    }
    if (n.type === 'footnote' && n.attrs && typeof n.attrs === 'object') {
      const id = (n.attrs as { referenceId?: unknown }).referenceId;
      if (typeof id === 'number' && Number.isFinite(id)) out.add(id);
    }
    if (Array.isArray(n.marks)) {
      for (const mark of n.marks) {
        if (!mark || typeof mark !== 'object') continue;
        const m = mark as { type?: unknown; attrs?: unknown };
        if (m.type === 'footnote' && m.attrs && typeof m.attrs === 'object') {
          const id = (m.attrs as { referenceId?: unknown }).referenceId;
          if (typeof id === 'number' && Number.isFinite(id)) out.add(id);
        }
      }
    }
    if (Array.isArray(n.content)) walkNodesForCitations(n.content, out);
  }
}

/** Operations supported by the wiki_fact pending-edit type. */
export type FactOperation = 'add' | 'replace' | 'remove' | 'reorder';

export interface FactOpTarget {
  sectionId: MonographSectionId;
  /** Optional sub-field within the section (e.g. effects.cardiovascular). */
  fieldId?: string;
  /** Required for `replace` and `remove`; ignored for `add`. */
  factId?: string;
}

/**
 * Single dispatch point for the three wiki_fact operations. Centralized so
 * the API approval handler doesn't have to repeat the per-op argument
 * checks and so unit tests can exercise the merge logic without touching
 * the database layer.
 */
export function applyFactOp(
  content: MonographContentV2,
  op: FactOperation,
  target: FactOpTarget,
  fact: MonographFactNode | null,
): MonographContentV2 {
  const normalized = normalizeMonographContentV2(content);
  if (op === 'add') {
    if (!fact) throw new Error('applyFactOp: add requires a fact node');
    // A queued `add` can reach approval after an admin published the same
    // fact by hand. Appending blind leaves the page carrying the factId
    // twice, and nothing downstream deduplicates. Resolve the anchor the
    // way `replace` and `remove` already do on this engine — page-wide on
    // factId — and upsert when it is occupied.
    //
    // The existing node is replaced where it sits rather than moved into
    // `target.sectionId`: if an admin filed it under a different section
    // they chose that placement, and relocating it silently would discard
    // an editorial decision the proposal never saw. Placement moves are
    // what `reorder` is for.
    if (findFactInContent(normalized, fact.attrs.factId)) {
      return replaceFactInSection(normalized, fact.attrs.factId, fact);
    }
    return appendFactToSection(normalized, target.sectionId, fact);
  }
  if (op === 'replace') {
    if (!fact) throw new Error('applyFactOp: replace requires a fact node');
    if (!target.factId)
      throw new Error('applyFactOp: replace requires target.factId');
    return replaceFactInSection(normalized, target.factId, fact);
  }
  if (op === 'remove') {
    if (!target.factId)
      throw new Error('applyFactOp: remove requires target.factId');
    return removeFactFromSection(normalized, target.factId);
  }
  if (op === 'reorder') {
    // Monograph reorder is a documented follow-up — see #358 and the
    // matching loose-thread issue. The schema accepts the op so the
    // pending_edits.factOperation enum stays consistent with topic
    // pages, but the monograph splice deliberately refuses it until
    // the PK-monograph editor UI grows a reorder affordance.
    throw new Error(
      'applyFactOp: reorder is not supported on drug-monograph pages yet (see #358 follow-up); it works on topic pages via applyTopicFactOp',
    );
  }
  throw new Error(`applyFactOp: unsupported op "${op as string}"`);
}
