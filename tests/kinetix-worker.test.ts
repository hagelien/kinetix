// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertDistinctProfiles,
  assertIdentity,
  loadProfile,
  redact,
  validateProfile,
  workerEnvironment,
} from "../scripts/kinetix-worker.mjs";

const exec = promisify(execFile);
const token = (letter: string) => `kxat_${letter.repeat(43)}`;
const producer = {
  version: 1,
  role: "producer",
  baseUrl: "https://kinetix.invalid",
  token: token("p"),
  agentId: 1,
  userId: 4,
  slug: "terra",
  modelTier: "mid",
  dryRun: false,
};
const reviewer = {
  ...producer,
  role: "reviewer",
  token: token("r"),
  agentId: 2,
  userId: 5,
  slug: "sol",
  modelTier: "flagship",
};
const adjudicator = {
  ...reviewer,
  role: "adjudicator-a",
  token: token("a"),
  agentId: 3,
  userId: 6,
  slug: "fable",
};
let dir: string;
let profileDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kinetix-worker-"));
  profileDir = path.join(dir, ".kinetix", "worker-profiles");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "bin"));
  for (const file of [
    "kinetix-worker.mjs",
    "kinetix-api.sh",
    "download-citation-pdf.sh",
    "kinetix-http.ts",
    "kinetix-log-verification.ts",
    "rejection-scan.ts",
  ]) {
    copyFileSync(
      path.resolve("scripts", file),
      path.join(dir, "scripts", file),
    );
  }
  symlinkSync(
    path.resolve("node_modules"),
    path.join(dir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(dir, ".env"),
    `KINETIX_TOKEN=${token("s")}\nKINETIX_BASE_URL=https://wrong.invalid\nDATABASE_URL=must-not-load\n`,
  );
  for (const profile of [producer, reviewer, adjudicator])
    writeFileSync(
      path.join(profileDir, profile.role + ".json"),
      JSON.stringify(profile),
      { mode: 0o600 },
    );
  // Observe the real shell transport's Cookie argument without printing it.
  writeFileSync(
    path.join(dir, "bin", "curl"),
    `#!/usr/bin/env node
const args=process.argv.slice(2), cookie=args.find(a=>a.startsWith('Cookie:'))||'';
const isProducer=cookie.endsWith('${token("p")}'), isReviewer=cookie.endsWith('${token("r")}'), isLegacy=cookie.endsWith('${token("s")}'), isAdjudicator=cookie.endsWith('${token("a")}');
if(!isProducer&&!isReviewer&&!isLegacy&&!isAdjudicator) process.exit(22);
if(!isLegacy&&(process.env.DATABASE_URL||process.env.JWT_SECRET)) process.exit(23);
const url=args.at(-1),id=isProducer?4:isReviewer?5:isAdjudicator?6:8;
if(url.endsWith('/api/auth?action=me')) console.log(JSON.stringify({user:{id,role:'contributor'}}));
else if(url.endsWith('/api/agents')) console.log(JSON.stringify({agents:[{id:1,slug:'terra',status:'active',agent:{userId:4}},{id:2,slug:'sol',status:'active',agent:{userId:5}},{id:3,slug:'fable',status:'active',agent:{userId:6}}]}));
else if(url.includes('/api/citation-pdf?citationId=')) { const fs=require('node:fs'); fs.writeFileSync(args[args.indexOf('-o')+1],Buffer.from([37,80,68,70,45,id,0,255,128])); process.stdout.write('200'); }
else { const fs=require('node:fs'); const body=args.includes('--data-binary')?fs.readFileSync(0,'utf8'):''; console.log(JSON.stringify({id,userId:id,body,reflected:process.env.KINETIX_TOKEN})); }
`.replace(
      "const args=",
      "const require=(await import('node:module')).createRequire(import.meta.url); const args=",
    ),
  );
  chmodSync(path.join(dir, "bin", "curl"), 0o700);
  // A .mjs entrypoint lets the fake curl use top-level await on every platform.
  const fake = readFileSync(path.join(dir, "bin", "curl"), "utf8");
  writeFileSync(path.join(dir, "bin", "curl.mjs"), fake);
  writeFileSync(
    path.join(dir, "bin", "curl"),
    '#!/usr/bin/env bash\nexec node "' +
      path.join(dir, "bin", "curl.mjs").replaceAll("\\", "/") +
      '" "$@"\n',
  );
  chmodSync(path.join(dir, "bin", "curl"), 0o700);
  env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    KINETIX_TOKEN: token("i"),
    KINETIX_BASE_URL: "https://inherited.invalid",
    KINETIX_AGENT_DRY_RUN: "0",
    DATABASE_URL: "must-not-inherit",
    JWT_SECRET: "must-not-inherit",
    DOTENV_CONFIG_OVERRIDE: "true",
  };
  const inheritedPath = env.PATH || env.Path || "";
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = path.join(dir, "bin") + path.delimiter + inheritedPath;
  const probe = spawnSync(
    process.platform === "win32"
      ? "C:/Program Files/Git/usr/bin/bash.exe"
      : "bash",
    [path.join(dir, "scripts", "kinetix-api.sh"), "GET", "/api/auth?action=me"],
    { env: workerEnvironment(producer, env), encoding: "utf8" },
  );
  if (probe.status !== 0) throw new Error(redact(probe.stderr, producer.token));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  try {
    const r = await exec(
      process.execPath,
      [path.join(dir, "scripts", "kinetix-worker.mjs"), ...args],
      { env: { ...env, ...overrides }, timeout: 20000 },
    );
    return { ...r, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.code };
  }
}

describe("local worker credential separation", () => {
  it("downloads stored PDFs with the selected identity and preserves binary bytes", async () => {
    for (const [role, id] of [
      ["producer", 4],
      ["reviewer", 5],
    ] as const) {
      const output = path.join(dir, role + " paper.pdf");
      const result = await run(["--profile", role, "pdf", "123", output]);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(output)).toEqual(
        Buffer.from([37, 80, 68, 70, 45, id, 0, 255, 128]),
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        path: output,
        byteLength: 9,
      });
    }
    const invalid = await run([
      "--profile",
      "reviewer",
      "pdf",
      "123&admin=true",
      "unused.pdf",
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("Usage: pdf");
  });
  it("replaces inherited credentials, blocks dotenv and removes direct DB access", () => {
    const actual = workerEnvironment(reviewer, {
      KINETIX_TOKEN: token("p"),
      DATABASE_URL: "db",
      JWT_SECRET: "jwt",
      DOTENV_CONFIG_OVERRIDE: "true",
      BASH_ENV: "malicious",
      NODE_OPTIONS: "--inspect",
      PATH: "/bin",
    });
    expect(actual.KINETIX_TOKEN).toBe(reviewer.token);
    expect(actual.KINETIX_BASE_URL).toBe(reviewer.baseUrl);
    for (const key of [
      "DATABASE_URL",
      "JWT_SECRET",
      "DOTENV_CONFIG_OVERRIDE",
      "BASH_ENV",
      "NODE_OPTIONS",
    ])
      expect(actual[key]).toBeUndefined();
    expect(actual.DOTENV_CONFIG_PATH).toMatch(/nul/i);
  });
  it("cannot turn off an inherited or profile dry-run", () => {
    expect(
      workerEnvironment(reviewer, { KINETIX_AGENT_DRY_RUN: "1" })
        .KINETIX_AGENT_DRY_RUN,
    ).toBe("1");
    expect(
      workerEnvironment(
        { ...reviewer, dryRun: true },
        { KINETIX_AGENT_DRY_RUN: "0" },
      ).KINETIX_AGENT_DRY_RUN,
    ).toBe("1");
  });
  it("requires explicit valid profile, origin, token and matching role/tier", () => {
    for (const change of [
      { token: "jwt" },
      { token: token("p") + "\n" },
      { role: "producer" },
      { modelTier: "mid" },
      { baseUrl: "https://example.com/path" },
      { baseUrl: "https://user:pass@example.com" },
      { DATABASE_URL: "db" },
    ]) {
      expect(() =>
        validateProfile({ ...reviewer, ...change }, "reviewer"),
      ).toThrow();
    }
    expect(() => loadProfile("../producer", profileDir)).toThrow();
  });
  it("fails closed without exposing malformed profile contents", () => {
    const empty = path.join(dir, "empty");
    mkdirSync(empty);
    expect(() => loadProfile("reviewer", empty)).toThrow(/No fallback/);
    writeFileSync(
      path.join(empty, "reviewer.json"),
      '{"token":"' + token("x"),
      { mode: 0o600 },
    );
    expect(() => loadProfile("reviewer", empty)).toThrow(/No fallback/);
    try {
      loadProfile("reviewer", empty);
    } catch (e: any) {
      expect(e.message).not.toContain(token("x"));
    }
  });
  it("rejects a token bound to another identity, inactive agent, or wrong slug", () => {
    const user = { id: 5, role: "contributor" },
      agents = [{ id: 2, slug: "sol", status: "active", agent: { userId: 5 } }];
    expect(() => assertIdentity(reviewer, user, agents)).not.toThrow();
    expect(() =>
      assertIdentity(reviewer, { ...user, id: 4 }, agents),
    ).toThrow();
    expect(() =>
      assertIdentity(reviewer, user, [{ ...agents[0], status: "suspended" }]),
    ).toThrow();
    expect(() =>
      assertIdentity(reviewer, user, [{ ...agents[0], slug: "terra" }]),
    ).toThrow();
  });
  it("redacts reflected tokens", () =>
    expect(
      redact("response " + token("p") + " " + token("r"), token("p")),
    ).toBe("response [REDACTED] [REDACTED]"));
  it("rejects overlap in any user, agent or credential identity", () => {
    expect(() => assertDistinctProfiles(producer, reviewer)).not.toThrow();
    for (const key of ["userId", "agentId", "token"] as const) {
      expect(() =>
        assertDistinctProfiles(producer, { ...reviewer, [key]: producer[key] }),
      ).toThrow(/distinct/);
    }
  });
  it("rejects an internally valid duplicate profile before either worker runs", async () => {
    const file = path.join(profileDir, "reviewer.json");
    writeFileSync(
      file,
      JSON.stringify({ ...producer, role: "reviewer", modelTier: "flagship" }),
    );
    try {
      for (const role of ["producer", "reviewer"]) {
        const r = await run(["--profile", role, "check"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("distinct users, agents and tokens");
        expect(r.stdout).toBe("");
        expect(r.stderr).not.toContain("kxat_");
      }
    } finally {
      writeFileSync(file, JSON.stringify(reviewer));
    }
  });
  it("runs concurrent shell API calls as separate identities despite inherited/shared tokens", async () => {
    const results = await Promise.all(
      ["producer", "reviewer"].map((role) =>
        run(["--profile", role, "api", "GET", "/api/example"]),
      ),
    );
    for (const [i, r] of results.entries()) {
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).userId).toBe(i === 0 ? 4 : 5);
      expect(r.stdout + r.stderr).not.toContain("kxat_");
    }
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toContain(token("s"));
  });
  it("routes TypeScript logging through the same selected shell identity", async () => {
    const r = await run([
      "--profile",
      "reviewer",
      "helper",
      "kinetix-log-verification.ts",
      "--target-type",
      "discussion_sweep",
      "--outcome",
      "no_change",
      "--notes",
      "æ ø å",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("verification_log.id=5");
    expect(r.stdout + r.stderr).not.toContain("kxat_");
  });
  it("leaves unprofiled callers using their existing shared dotenv identity", async () => {
    const legacyEnv = workerEnvironment(producer, env);
    for (const key of Object.keys(legacyEnv))
      if (/^(KINETIX_|DOTENV_)/.test(key)) delete legacyEnv[key];
    const r = await exec(
      process.execPath,
      [
        path.join(dir, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(dir, "scripts", "kinetix-log-verification.ts"),
        "--target-type",
        "discussion_sweep",
        "--outcome",
        "no_change",
      ],
      { cwd: dir, env: legacyEnv, timeout: 20000 },
    );
    expect(r.stdout).toContain("verification_log.id=8");
    expect(r.stdout + r.stderr).not.toContain("kxat_");
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toContain(token("s"));
  });
  it("preserves UTF-8 API bodies through the selected profile", async () => {
    const body = JSON.stringify({ notes: "ÆØÅ æøå – μ; ≤ 5 µg/L; 日本語 🧪" });
    const file = path.join(dir, "body.json");
    writeFileSync(file, body, "utf8");
    const r = await run([
      "--profile",
      "reviewer",
      "api",
      "POST",
      "/api/example",
      "@" + file,
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).body).toBe(body);
  });
  it("fails both helper forms when the selected profile is missing", async () => {
    const empty = path.join(dir, "no-home");
    mkdirSync(empty);
    for (const args of [
      ["api", "GET", "/api/example"],
      [
        "helper",
        "kinetix-log-verification.ts",
        "--target-type",
        "discussion_sweep",
        "--outcome",
        "no_change",
      ],
    ]) {
      const r = await run(["--profile", "reviewer", ...args], {
        HOME: empty,
        USERPROFILE: empty,
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("No fallback");
      expect(r.stdout).toBe("");
    }
  });
  it("runs a T3 seat as its own identity, limited to reading, claiming and opining", async () => {
    const check = await run(["--profile", "adjudicator-a", "check"]);
    expect(check.code, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({
      profile: "adjudicator-a",
      userId: 6,
      configuredTier: "flagship",
    });
    const body = "@" + path.join(dir, "body.json");
    writeFileSync(body.slice(1), '{"caseId":1}', "utf8");
    for (const args of [
      ["api", "GET", "/api/agent-adjudication-queue"],
      ["api", "POST", "/api/agent-adjudication-queue?action=claim", body],
      ["api", "POST", "/api/agent-adjudication-opinions", body],
    ]) {
      const r = await run(["--profile", "adjudicator-a", ...args]);
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).userId).toBe(6);
      expect(r.stdout + r.stderr).not.toContain("kxat_");
    }
    for (const args of [
      ["api", "POST", "/api/agent-verifications", body],
      ["api", "PATCH", "/api/agent-adjudication-opinions", body],
      ["api", "DELETE", "/api/example"],
      [
        "helper",
        "kinetix-log-verification.ts",
        "--target-type",
        "discussion_sweep",
        "--outcome",
        "no_change",
      ],
      ["helper", "rejection-scan.ts"],
      ["helper", "kinetix-log-run-usage.ts"],
      ["helper", "kinetix-log-run-usage.ts", "--workflow", "producer"],
      [
        "helper",
        "kinetix-log-run-usage.ts",
        "--workflow",
        "adjudication",
        "--workflow",
        "producer",
      ],
    ]) {
      const r = await run(["--profile", "adjudicator-a", ...args]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("adjudicator profile may only");
      expect(r.stdout).toBe("");
    }
  });
  it("stops every worker when an installed T3 seat duplicates or breaks a profile", async () => {
    const file = path.join(profileDir, "adjudicator-a.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({ ...adjudicator, token: reviewer.token }),
      );
      for (const role of ["producer", "reviewer", "adjudicator-a"]) {
        const r = await run(["--profile", role, "check"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("distinct users, agents and tokens");
        expect(r.stderr).not.toContain("kxat_");
      }
      writeFileSync(file, '{"token":"' + token("x"));
      const r = await run(["--profile", "producer", "check"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("No fallback");
      expect(r.stderr).not.toContain(token("x"));
    } finally {
      writeFileSync(file, JSON.stringify(adjudicator));
    }
    const missingSeat = await run(["--profile", "adjudicator-b", "check"]);
    expect(missingSeat.code).not.toBe(0);
    expect(missingSeat.stderr).toContain("No fallback");
  });
  it("supports dry runs of both helper forms without leaking secrets", async () => {
    for (const args of [
      ["api", "GET", "/api/example"],
      [
        "helper",
        "kinetix-log-verification.ts",
        "--target-type",
        "discussion_sweep",
        "--outcome",
        "no_change",
      ],
    ]) {
      const r = await run(["--profile", "reviewer", "--dry-run", ...args]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain("[dry-run]");
      expect(r.stdout + r.stderr).not.toContain("kxat_");
    }
  });
});
