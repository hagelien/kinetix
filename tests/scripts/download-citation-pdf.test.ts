import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const script = path
  .resolve("scripts/download-citation-pdf.sh")
  .replaceAll("\\", "/");
const gitRoot = path.join(
  process.env.ProgramFiles ?? "C:/Program Files",
  "Git",
);
const bash =
  process.platform === "win32" && existsSync(path.join(gitRoot, "bin/bash.exe"))
    ? path.join(gitRoot, "bin/bash.exe")
    : "bash";

const PDF_BYTES = "%PDF-1.7\nstored citation body\n%%EOF\n";
const TOKEN = "kxat_test_token";

type Recorded = { url: string; cookie: string | undefined };

describe("download-citation-pdf.sh", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let recorded: Recorded[] = [];
  // Set per test: how the stub Kinetix (and any non-Blob redirect target)
  // should answer the next request.
  let respond: (url: string) => { status: number; headers?: Record<string, string>; body?: string };

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "kinetix-pdf-download-"));
    server = createServer((req, res) => {
      recorded.push({ url: req.url ?? "", cookie: req.headers.cookie });
      const answer = respond(req.url ?? "");
      res.statusCode = answer.status;
      for (const [name, value] of Object.entries(answer.headers ?? {})) {
        res.setHeader(name, value);
      }
      res.end(answer.body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    recorded = [];
    respond = () => ({ status: 500 });
  });

  function run(args: string[]) {
    return new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(bash, [script, ...args], {
          env: {
            ...process.env,
            KINETIX_BASE_URL: baseUrl,
            KINETIX_TOKEN: TOKEN,
            KINETIX_AGENT_DRY_RUN: "0",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({ code: code ?? -1, stdout, stderr }),
        );
      },
    );
  }

  // Regression: the curl invocation used doubled continuation backslashes, so
  // bash escaped the backslash instead of the newline. curl was handed "\" as
  // its URL and the following option lines ran as separate commands, which
  // made every real (non-dry-run) download fail before reaching Kinetix.
  it("performs the authenticated request and emits the proxied PDF", async () => {
    respond = () => ({
      status: 200,
      headers: { "Content-Type": "application/pdf" },
      body: PDF_BYTES,
    });

    const result = await run(["4242"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(PDF_BYTES);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/api/citation-pdf?citationId=4242");
    expect(recorded[0].cookie).toBe(`__Host-kinetix-auth=${TOKEN}`);
  });

  it("writes the PDF to the requested output path", async () => {
    respond = () => ({
      status: 200,
      headers: { "Content-Type": "application/pdf" },
      body: PDF_BYTES,
    });
    const target = path.join(directory, "citation-4242.pdf");

    const result = await run(["4242", target]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(target, "utf8")).toBe(PDF_BYTES);
  });

  it("refuses a redirect that does not point at private Blob storage", async () => {
    respond = () => ({
      status: 302,
      headers: { Location: `${baseUrl}/exfiltrate` },
    });

    const result = await run(["4242"]);

    expect(result.code).toBe(22);
    expect(result.stderr).toContain("invalid PDF redirect");
    // The redirect is never followed, so the agent credential cannot reach
    // another host.
    expect(recorded).toHaveLength(1);
  });

  // Regression: the allowlist was a bash `case` glob over the whole URL, and
  // that pattern's `*` matches `/` too — so a Location on an attacker's host
  // with the Blob domain anywhere in its PATH satisfied it. The helper would
  // have fetched attacker-chosen bytes and handed them to the review and
  // extraction agents as the stored paper, which is fabricated provenance for
  // whatever facts those agents then file against the citation.
  it.each([
    [
      "the Blob domain in the path of another host",
      "https://evil.example/x.blob.vercel-storage.com/payload",
    ],
    [
      "the Blob domain as userinfo",
      "https://abc.blob.vercel-storage.com@evil.example/payload",
    ],
    [
      "the Blob domain in the query string",
      "https://evil.example/p?a=.blob.vercel-storage.com/x",
    ],
    [
      "the Blob domain in the fragment",
      "https://evil.example/p#.blob.vercel-storage.com/x",
    ],
    [
      "the Blob domain as a prefix of a longer host",
      "https://abc.blob.vercel-storage.com.evil.example/payload",
    ],
    ["a look-alike host", "https://evil-blob.vercel-storage.com/payload"],
    ["the bare Blob domain", "https://blob.vercel-storage.com/payload"],
    ["a plaintext Blob host", "http://abc.blob.vercel-storage.com/payload"],
  ])("refuses a redirect with %s", async (_label, location) => {
    respond = () => ({ status: 302, headers: { Location: location } });

    const result = await run(["4242"]);

    expect(result.code).toBe(22);
    expect(result.stderr).toContain("invalid PDF redirect");
    expect(result.stdout).toBe("");
    // Only the authenticated Kinetix request was made; the redirect target was
    // never contacted.
    expect(recorded).toHaveLength(1);
  });

  it("reports a failed Kinetix request without emitting PDF bytes", async () => {
    respond = () => ({ status: 404, body: "citation not found" });

    const result = await run(["4242"]);

    expect(result.code).toBe(22);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("citation not found");
    expect(result.stderr).toContain("failed with HTTP 404");
  });

  it("does not make a request in dry-run mode", async () => {
    const child = await new Promise<{ code: number; stderr: string }>(
      (resolve, reject) => {
        const proc = spawn(bash, [script, "4242"], {
          env: {
            ...process.env,
            KINETIX_BASE_URL: baseUrl,
            KINETIX_TOKEN: TOKEN,
            KINETIX_AGENT_DRY_RUN: "1",
          },
        });
        let stderr = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => (stderr += chunk));
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      },
    );

    expect(child.code).toBe(0);
    expect(child.stderr).toContain("[dry-run]");
    expect(recorded).toHaveLength(0);
  });
});
