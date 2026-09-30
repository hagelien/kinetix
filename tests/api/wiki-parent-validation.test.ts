import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/_lib/db.js", () => ({
  getDb: vi.fn(),
}));

import {
  MAX_NESTING_DEPTH,
  validateParentAssignment,
} from "../../api/wiki/pages.ts";

/**
 * Builds a mock db with an `execute` method that returns the pre-scripted
 * ancestor and descendant CTE results.  `validateParentAssignment` issues
 * two parallel `db.execute()` calls:
 *   1. Ancestor CTE → { rows: [{ parent_depth, would_cycle }] }
 *   2. Descendant CTE → { rows: [{ leaf_distance }] }
 * When pageId is null, only the ancestor call is made; the descendant
 * side resolves synchronously from a Promise.resolve in the source.
 */
function makeDb(
  ancestorRow: { parent_depth: number | null; would_cycle: boolean },
  leafDistance = 0,
) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [ancestorRow] })
    .mockResolvedValueOnce({ rows: [{ leaf_distance: leafDistance }] });
  return { execute };
}

describe("validateParentAssignment", () => {
  it("returns ok when parentId is null/undefined", async () => {
    const db = { execute: vi.fn() };
    expect(await validateParentAssignment(db, 5, null)).toEqual({ ok: true });
    expect(await validateParentAssignment(db, 5, undefined)).toEqual({
      ok: true,
    });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects when a page is set as its own parent", async () => {
    const db = { execute: vi.fn() };
    const result = await validateParentAssignment(db, 7, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects when parent does not exist", async () => {
    // MAX(depth) = NULL when the base-case CTE returns no rows (no match for parentId)
    const db = makeDb({ parent_depth: null, would_cycle: false });
    const result = await validateParentAssignment(db, 1, 999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toMatch(/does not exist/i);
    }
  });

  it("accepts a depth-1 parent for a leaf page (depth 2 total)", async () => {
    // parentDepth=1, leafDistance=0 → 1+1+0=2 ≤ MAX_NESTING_DEPTH
    const db = makeDb({ parent_depth: 1, would_cycle: false }, 0);
    expect(await validateParentAssignment(db, 5, 10)).toEqual({ ok: true });
  });

  it("rejects when the parent chain plus this page would exceed MAX_NESTING_DEPTH", async () => {
    // Parent is at depth MAX_NESTING_DEPTH=4, placing a child below pushes to 5.
    const db = makeDb({ parent_depth: 4, would_cycle: false }, 0);
    const result = await validateParentAssignment(db, 5, 40);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/maximum depth/i);
    }
  });

  it("accepts when parentDepth + 1 + leafDistance equals MAX_NESTING_DEPTH", async () => {
    // Parent at depth 2; page has 1 level of children below it.
    // Total: 2 + 1 + 1 = 4 = MAX_NESTING_DEPTH — exactly at the limit.
    const db = makeDb({ parent_depth: 2, would_cycle: false }, 1);
    const result = await validateParentAssignment(db, 5, 20);
    expect(result).toEqual({ ok: true });
  });

  it("rejects cycles (assigning a descendant as parent)", async () => {
    // Ancestor CTE detects that pageId appears in the parent's ancestor chain.
    const db = makeDb({ parent_depth: 1, would_cycle: true });
    const result = await validateParentAssignment(db, 5, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/cycle/i);
  });

  it("uses MAX_NESTING_DEPTH = 4", () => {
    expect(MAX_NESTING_DEPTH).toBe(4);
  });
});
