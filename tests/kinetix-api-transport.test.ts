import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const apiScript = path.resolve("scripts/kinetix-api.sh").replaceAll("\\", "/");
const gitRoot = path.join(
  process.env.ProgramFiles ?? "C:/Program Files",
  "Git",
);
const bash =
  process.platform === "win32" && existsSync(path.join(gitRoot, "bin/bash.exe"))
    ? path.join(gitRoot, "bin/bash.exe")
    : "bash";
const sample = JSON.stringify({
  rationaleMd:
    "Balasubramaniam-artikkelen kunne ikke leses i fulltekst i dette miljøet; PDF-forespørsel er opprettet.",
  comments: "ÆØÅ æøå – μ-opioidreseptor; ≤ 5 µg/L; 日本語 🧪",
});

describe("scheduled-agent HTTP transport", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let requests = 0;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "kinetix-transport-"));
    server = createServer((req, res) => {
      requests++;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (req.url === "/fail") res.statusCode = 409;
        res.end(
          JSON.stringify({
            hex: Buffer.concat(chunks).toString("hex"),
            method: req.method,
            url: req.url,
            contentType: req.headers["content-type"],
            runSession: req.headers["x-kinetix-run-session"] ?? null,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
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

  async function request(
    bodyArg?: string,
    input?: string,
    options: {
      method?: string;
      apiPath?: string;
      dryRun?: boolean;
      powershell?: boolean;
      /** Runner session env; the host's own is cleared unless set here. */
      sessionEnv?: Record<string, string>;
    } = {},
  ) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const args = [
          apiScript,
          options.method ?? "POST",
          options.apiPath ?? "/echo",
        ];
        if (bodyArg !== undefined) args.push(bodyArg);
        const executable = options.powershell
          ? path.join(
              process.env.SystemRoot!,
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            )
          : bash;
        const commandArgs = options.powershell
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); $env:TEST_JSON | & $env:TEST_BASH $env:TEST_API POST /echo -",
            ]
          : args;
        const child = spawn(executable, commandArgs, {
          cwd: directory,
          env: {
            ...process.env,
            // Keep the host's native curl first: the Windows argv boundary is
            // precisely what this regression must exercise.
            PATH: [
              ...(process.platform === "win32"
                ? [path.join(process.env.SystemRoot!, "System32")]
                : []),
              process.env.PATH,
              ...(process.platform === "win32"
                ? [path.join(gitRoot, "usr/bin")]
                : []),
            ].join(path.delimiter),
            KINETIX_BASE_URL: baseUrl,
            KINETIX_TOKEN: "kxat_test-not-a-real-token",
            KINETIX_AGENT_DRY_RUN: options.dryRun ? "1" : "0",
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
            TEST_BASH: bash,
            TEST_API: apiScript,
            TEST_JSON: sample,
            CLAUDE_CODE_SESSION_ID: "",
            CODEX_SESSION_ID: "",
            CODEX_THREAD_ID: "",
            ...options.sessionEnv,
          },
          stdio: "pipe",
          timeout: 10_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input, "utf8");
      },
    );
  }

  it("preserves UTF-8 JSON bytes from stdin through the real curl request", async () => {
    const result = await request("-", sample);
    expect(result.code, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hex).toBe(Buffer.from(sample, "utf8").toString("hex"));
    expect(response.contentType).toBe("application/json; charset=utf-8");
  });

  it("preserves UTF-8 JSON bytes from a file through the real curl request", async () => {
    const file = path.join(directory, "body.json");
    writeFileSync(file, sample, "utf8");
    // Use Git Bash's path spelling; its Windows startup can expand @C:/...
    // as a response file before the script gets its arguments.
    const bashPath = file
      .replaceAll("\\", "/")
      .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const result = await request(`@${bashPath}`);
    expect(result.code, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hex).toBe(Buffer.from(sample, "utf8").toString("hex"));
  });

  it("streams reviews larger than the Windows command-line limit without trimming bytes", async () => {
    const large =
      JSON.stringify({ reviewMarkdown: "æøå μ ≤\n".repeat(8000) }) + "\n\n";
    const result = await request("-", large);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hex).toBe(
      Buffer.from(large, "utf8").toString("hex"),
    );
  });

  it.runIf(process.platform === "win32")(
    "preserves the documented PowerShell UTF-8 pipeline",
    async () => {
      const result = await request("-", undefined, { powershell: true });
      expect(result.code, result.stderr).toBe(0);
      // PowerShell Write-Output adds a line ending; the JSON text is unchanged.
      const body = Buffer.from(JSON.parse(result.stdout).hex, "hex").toString(
        "utf8",
      );
      expect(JSON.parse(body)).toEqual(JSON.parse(sample));
    },
  );

  it("keeps GET requests bodyless and preserves query parameters", async () => {
    const result = await request(undefined, undefined, {
      method: "GET",
      apiPath: "/echo?drugId=12&parameter=tmax",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      method: "GET",
      url: "/echo?drugId=12&parameter=tmax",
      hex: "",
    });
  });

  it("keeps HTTP failures nonzero and returns their body", async () => {
    const result = await request("-", sample, { apiPath: "/fail" });
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).hex).toBe(
      Buffer.from(sample, "utf8").toString("hex"),
    );
  });

  it("prints UTF-8 in dry runs without sending a request or exposing the token", async () => {
    const before = requests;
    const result = await request("-", sample, { dryRun: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`[dry-run-body] ${sample}`);
    expect(result.stderr).not.toContain("kxat_test-not-a-real-token");
    expect(requests).toBe(before);
  });

  it("sends no run session header outside a runner session", async () => {
    const result = await request(undefined, undefined, { method: "GET" });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).runSession).toBeNull();
  });

  it("sends the runner session id so the server can stamp the run (#214)", async () => {
    const claude = await request(undefined, undefined, {
      method: "GET",
      sessionEnv: {
        CLAUDE_CODE_SESSION_ID: "0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f",
        CODEX_THREAD_ID: "codex-thread",
      },
    });
    expect(claude.code, claude.stderr).toBe(0);
    // The same precedence kinetix-log-run-usage.ts uses for the transcript.
    expect(JSON.parse(claude.stdout).runSession).toBe(
      "0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f",
    );

    const codex = await request(undefined, undefined, {
      method: "GET",
      sessionEnv: { CODEX_THREAD_ID: "codex-thread" },
    });
    expect(JSON.parse(codex.stdout).runSession).toBe("codex-thread");
  });

  it("does not send a session id the server would refuse", async () => {
    for (const bad of ["a b", "x".repeat(129), "bad\r\nX-Injected: 1"]) {
      const result = await request(undefined, undefined, {
        method: "GET",
        sessionEnv: { CLAUDE_CODE_SESSION_ID: bad },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).runSession).toBeNull();
    }
  });

  it("names the run session in a dry run", async () => {
    const result = await request(undefined, undefined, {
      method: "GET",
      dryRun: true,
      sessionEnv: { CODEX_SESSION_ID: "codex-session" },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("run-session=codex-session");
  });

  it("refuses a missing body file before contacting the server", async () => {
    const before = requests;
    const result = await request("@/missing-kinetix-test-body.json");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("body file not found");
    expect(requests).toBe(before);
  });
});
