import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import approvalsHandler from "../../api/approvals.js";
import agentFocusHandler from "../../api/agent-focus.js";
import agentRunUsageHandler from "../../api/agent-run-usage.js";
import agentVerificationLogHandler from "../../api/agent-verification-log.js";
import agentVerificationsHandler from "../../api/agent-verifications.js";
import citationPdfHandler from "../../api/citation-pdf.js";
import citationPdfShareHandler from "../../api/citation-pdf-share.js";
import drugsHandler from "../../api/drugs.js";
import jobStartHandler from "../../api/jobs/start.js";
import learnAttemptsHandler from "../../api/learn-attempts.js";
import methodsHandler from "../../api/methods.js";
import notificationsHandler from "../../api/notifications.js";
import paperExtractionsHandler from "../../api/paper-extractions.js";
import parameterApplicabilityHandler from "../../api/drug-parameter-applicability.js";
import parameterPriorityFlagsHandler from "../../api/parameter-priority-flags.js";
import pdfInboxHandler from "../../api/pdf-inbox.js";
import pendingEditsHandler from "../../api/pending-edits.js";
import preferencesHandler from "../../api/preferences.js";
import referenceConcentrationsHandler from "../../api/reference-concentrations.js";
import referencesResolveHandler from "../../api/references-resolve.js";
import referencesHandler from "../../api/references.js";
import simulatorCasesHandler from "../../api/simulator/cases.js";

function request(
  method: string,
  url: string,
  headers: Record<string, string>,
): IncomingMessage {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  queueMicrotask(() => req.end("{}"));
  return req;
}

function response(): ServerResponse & {
  body: string;
  statusCodeWritten: number | null;
} {
  let headersSent = false;
  return {
    body: "",
    statusCodeWritten: null,
    get headersSent() {
      return headersSent;
    },
    writeHead(status: number) {
      this.statusCodeWritten = status;
      headersSent = true;
      return this as ServerResponse;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this as ServerResponse;
    },
  } as ServerResponse & { body: string; statusCodeWritten: number | null };
}

async function expectCrossOriginRejected(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  url: string,
) {
  const req = request(method, url, {
    host: "kinetix.no",
    origin: "https://evil.example",
  });
  const res = response();

  await handler(req, res);

  expect(res.statusCodeWritten).toBe(403);
  expect(JSON.parse(res.body)).toEqual({
    error: "Cross-origin API request rejected",
    code: "cross_origin_request_rejected",
  });
}

describe("write route origin checks", () => {
  it("rejects a cross-origin PDF-inbox attach before auth lookup", async () => {
    // Linking a bulk-dropped PDF to a citation is a cookie-authenticated
    // write, so it needs the same origin guard every other write carries.
    await expectCrossOriginRejected(
      pdfInboxHandler,
      "POST",
      "/api/pdf-inbox?id=1&citationId=2",
    );
  });

  it("rejects a cross-origin PDF-inbox discard before auth lookup", async () => {
    await expectCrossOriginRejected(
      pdfInboxHandler,
      "DELETE",
      "/api/pdf-inbox?id=1",
    );
  });

  it("rejects cross-origin notification updates before auth lookup", async () => {
    await expectCrossOriginRejected(
      notificationsHandler,
      "PATCH",
      "/api/notifications",
    );
  });

  it("rejects cross-origin preference updates before auth lookup", async () => {
    await expectCrossOriginRejected(
      preferencesHandler,
      "PATCH",
      "/api/preferences",
    );
  });

  it("rejects cross-origin reference writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      referencesHandler,
      "POST",
      "/api/references",
    );
  });

  it("rejects cross-origin catalog writes before admin/editor auth lookup", async () => {
    await expectCrossOriginRejected(drugsHandler, "POST", "/api/drugs");
    await expectCrossOriginRejected(drugsHandler, "PATCH", "/api/drugs?id=1");
    await expectCrossOriginRejected(methodsHandler, "POST", "/api/methods");
    await expectCrossOriginRejected(
      methodsHandler,
      "PATCH",
      "/api/methods?id=1",
    );
  });

  it("rejects cross-origin pending-edit review updates before auth lookup", async () => {
    await expectCrossOriginRejected(
      pendingEditsHandler,
      "PATCH",
      "/api/pending-edits?id=1",
    );
  });

  it("rejects cross-origin approval stamps before auth lookup", async () => {
    await expectCrossOriginRejected(approvalsHandler, "POST", "/api/approvals");
  });

  it("rejects cross-origin Learn attempt writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      learnAttemptsHandler,
      "POST",
      "/api/learn-attempts",
    );
  });

  it("rejects cross-origin agent verification-log writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      agentVerificationLogHandler,
      "POST",
      "/api/agent-verification-log",
    );
  });

  it("rejects cross-origin agent run-usage writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      agentRunUsageHandler,
      "POST",
      "/api/agent-run-usage",
    );
  });

  it("rejects cross-origin agent verification writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      agentVerificationsHandler,
      "POST",
      "/api/agent-verifications",
    );
  });

  it("rejects cross-origin agent focus updates before auth lookup", async () => {
    await expectCrossOriginRejected(
      agentFocusHandler,
      "PUT",
      "/api/agent-focus",
    );
  });

  it("rejects cross-origin external citation helper writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      referencesResolveHandler,
      "POST",
      "/api/references-resolve",
    );
    await expectCrossOriginRejected(
      citationPdfHandler,
      "POST",
      "/api/citation-pdf?citationId=1",
    );
    await expectCrossOriginRejected(
      citationPdfShareHandler,
      "POST",
      "/api/citation-pdf-share?citationId=1",
    );
  });

  it("rejects cross-origin full-compute job starts before auth lookup", async () => {
    await expectCrossOriginRejected(jobStartHandler, "POST", "/api/jobs/start");
  });

  it("rejects cross-origin saved simulator case writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      simulatorCasesHandler,
      "POST",
      "/api/simulator/cases",
    );
    await expectCrossOriginRejected(
      simulatorCasesHandler,
      "PUT",
      "/api/simulator/cases?id=1",
    );
  });

  it("rejects cross-origin reference concentration writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      referenceConcentrationsHandler,
      "POST",
      "/api/reference-concentrations",
    );
    await expectCrossOriginRejected(
      referenceConcentrationsHandler,
      "PATCH",
      "/api/reference-concentrations?id=1",
    );
  });

  it("rejects cross-origin priority flag writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      parameterPriorityFlagsHandler,
      "POST",
      "/api/parameter-priority-flags",
    );
    await expectCrossOriginRejected(
      parameterPriorityFlagsHandler,
      "PATCH",
      "/api/parameter-priority-flags?id=1",
    );
  });

  it("rejects cross-origin parameter applicability writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      parameterApplicabilityHandler,
      "PUT",
      "/api/drug-parameter-applicability",
    );
    await expectCrossOriginRejected(
      parameterApplicabilityHandler,
      "DELETE",
      "/api/drug-parameter-applicability?drugId=1&parameter=bioavailability",
    );
  });

  it("rejects cross-origin paper extraction queue writes before auth lookup", async () => {
    await expectCrossOriginRejected(
      paperExtractionsHandler,
      "POST",
      "/api/paper-extractions?citationId=1",
    );
    await expectCrossOriginRejected(
      paperExtractionsHandler,
      "POST",
      "/api/paper-extractions?action=claim",
    );
    await expectCrossOriginRejected(
      paperExtractionsHandler,
      "PATCH",
      "/api/paper-extractions?id=1",
    );
  });
});
