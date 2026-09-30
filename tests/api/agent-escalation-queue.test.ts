import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getUserFromRequestMock, resolveActiveAgentMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    resolveActiveAgentMock: vi.fn(),
  }));

vi.mock("../../api/_lib/db.js", () => ({
  getDb: getDbMock,
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock("../../api/_lib/agent-verifications.js", () => ({
  resolveActiveAgent: resolveActiveAgentMock,
  verificationTargetVersion: vi.fn(),
}));

import handler, {
  ESCALATION_REASON_RANK,
  mergeEscalationCandidates,
  selectEscalationBatch,
  type EscalationReasonCode,
} from "../../api/agent-escalation-queue";
import type { AgentVerificationTargetType } from "../../db/schema";

function createRequest(url: string, method = "GET"): IncomingMessage {
  return { method, url, headers: { host: "localhost" } } as IncomingMessage;
}

function createResponse() {
  const state = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        res.headersSent = true;
        return res;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? "";
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

describe("mergeEscalationCandidates", () => {
  it("collapses repeated (targetType, targetId) rows into one entry carrying every reason", () => {
    const merged = mergeEscalationCandidates([
      { targetType: "pending_edit", targetId: 1, reasonCode: "weak_concordance" },
      { targetType: "pending_edit", targetId: 1, reasonCode: "open_dispute" },
      { targetType: "pending_edit", targetId: 2, reasonCode: "admin_flag" },
    ]);
    expect(merged).toHaveLength(2);
    const first = merged.find((m) => m.targetId === 1);
    expect(first?.reasonCodes).toEqual(["open_dispute", "weak_concordance"]);
  });

  it("keeps distinct target types with the same numeric id separate", () => {
    const merged = mergeEscalationCandidates([
      { targetType: "pending_edit", targetId: 5, reasonCode: "admin_flag" },
      { targetType: "drug_parameter_revision", targetId: 5, reasonCode: "admin_flag" },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("sorts each item's own reasonCodes by severity, most severe first", () => {
    const merged = mergeEscalationCandidates([
      { targetType: "pending_edit", targetId: 1, reasonCode: "reviewer_rejection_history" },
      { targetType: "pending_edit", targetId: 1, reasonCode: "absent_concordance" },
    ]);
    expect(merged[0]?.reasonCodes).toEqual([
      "absent_concordance",
      "reviewer_rejection_history",
    ]);
  });
});

describe("selectEscalationBatch", () => {
  const item = (
    targetId: number,
    reasonCodes: EscalationReasonCode[],
    targetType: AgentVerificationTargetType = "pending_edit",
  ) => ({ targetType, targetId, reasonCodes });

  it("orders by the most severe reason each item carries", () => {
    const items = [
      item(1, ["weak_concordance"]),
      item(2, ["open_dispute"]),
      item(3, ["reviewer_rejection_history"]),
    ];
    const batch = selectEscalationBatch(items, 10);
    expect(batch.map((i) => i.targetId)).toEqual([2, 3, 1]);
  });

  it("ranks a multi-reason item by its best (lowest-rank) reason", () => {
    const items = [
      item(1, ["weak_concordance", "admin_flag"]), // best: admin_flag
      item(2, ["absent_concordance"]),
    ];
    const batch = selectEscalationBatch(items, 10);
    // admin_flag outranks absent_concordance (see ESCALATION_REASON_RANK).
    expect(batch.map((i) => i.targetId)).toEqual([1, 2]);
  });

  it("tie-breaks equal-rank items by ascending target id, deterministically", () => {
    const items = [
      item(30, ["open_dispute"]),
      item(10, ["open_dispute"]),
      item(20, ["open_dispute"]),
    ];
    expect(selectEscalationBatch(items, 10).map((i) => i.targetId)).toEqual([
      10, 20, 30,
    ]);
  });

  it("truncates to the requested limit after ranking, not before", () => {
    const items = [
      item(1, ["weak_concordance"]),
      item(2, ["open_dispute"]),
      item(3, ["admin_flag"]),
    ];
    const batch = selectEscalationBatch(items, 2);
    expect(batch.map((i) => i.targetId)).toEqual([2, 3]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(selectEscalationBatch([item(1, ["open_dispute"])], 0)).toEqual([]);
  });
});

describe("ESCALATION_REASON_RANK", () => {
  it("ranks every documented trigger in the stated urgency order", () => {
    expect(ESCALATION_REASON_RANK.open_dispute).toBeLessThan(
      ESCALATION_REASON_RANK.admin_flag,
    );
    expect(ESCALATION_REASON_RANK.admin_flag).toBeLessThan(
      ESCALATION_REASON_RANK.absent_concordance,
    );
    expect(ESCALATION_REASON_RANK.absent_concordance).toBeLessThan(
      ESCALATION_REASON_RANK.reviewer_rejection_history,
    );
    expect(ESCALATION_REASON_RANK.reviewer_rejection_history).toBeLessThan(
      ESCALATION_REASON_RANK.weak_concordance,
    );
  });
});

describe("GET /api/agent-escalation-queue route — auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-GET method", async () => {
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-escalation-queue", "POST"), res);
    expect(state.statusCode).toBe(405);
  });

  it("rejects an unauthenticated caller", async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-escalation-queue"), res);
    expect(state.statusCode).toBe(401);
  });

  it("rejects a caller with no active agent identity", async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: "contributor" });
    resolveActiveAgentMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-escalation-queue"), res);
    expect(state.statusCode).toBe(403);
  });
});
