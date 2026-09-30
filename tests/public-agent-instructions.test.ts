// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPublicInstructionBundle,
  PUBLIC_INSTRUCTION_PATHS,
  sha256,
  projectPublicInstruction,
} from "../scripts/lib/public-agent-instructions";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kinetix-public-instructions-"));
  roots.push(root);
  for (const file of PUBLIC_INSTRUCTION_PATHS) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      file === "agents/fulltext-acquisition.md"
        ? "# Shared guidance\r\n\r\nÆØÅ μ ≤ 🧪\r\n"
        : readFileSync(file, "utf8"),
    );
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("public instruction publication boundary", () => {
  it("retains complete scientific appraisal, acquisition, Method and logging guidance", () => {
    const bundle = buildPublicInstructionBundle(process.cwd());
    for (const file of PUBLIC_INSTRUCTION_PATHS.slice(3)) {
      expect(bundle.documents.find((d) => d.path === file)!.content).toBe(
        readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd() + "\n",
      );
    }
    const file = "agents/drug-db-maintainer.md";
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const projected = projectPublicInstruction(file, source);
    for (const number of ["1", "4", "8"]) {
      const section = source
        .match(new RegExp("^## " + number + "\\.[\\s\\S]*?(?=^## )", "m"))![0]
        .trim();
      expect(projected).toContain(section);
    }
    // Section 9 keeps its end-of-cycle paragraph rules, but not the producer's
    // usage-logging command: a T2 reviewer following it would log its run
    // under the mid-tier producer identity and workflow.
    const section9 = source.match(/^## 9\.[\s\S]*?(?=^## )/m)![0].trim();
    const paragraphRules = section9.slice(
      section9.indexOf("one concise paragraph (no headings"),
    );
    expect(projected).toContain(paragraphRules);
    expect(section9).toContain("--profile producer");
    expect(projected).not.toContain("--profile producer");
    expect(projected).not.toContain("--workflow producer");
    expect(projected).toContain(
      "Record this run's token usage as the T2 routine's own end-of-cycle step says",
    );
    expect(projected).toContain(
      source
        .match(/^### How many references a fact needs\n[\s\S]*?(?=^### )/m)![0]
        .trim(),
    );
    expect(projected).toContain("## 11. Writing rules — paper reviews");
  });
  it("publishes only the reviewed allowlist, with verifiable Unicode contents and one revision", () => {
    const root = fixture();
    const privateText = "kxat_" + "x".repeat(43);
    writeFileSync(path.join(root, ".env"), privateText);
    writeFileSync(
      path.join(root, "agents", "local-codex-workers.md"),
      privateText,
    );
    const bundle = buildPublicInstructionBundle(root, "a".repeat(40));
    expect(bundle.documents.map((d) => d.path)).toEqual([
      ...PUBLIC_INSTRUCTION_PATHS,
    ]);
    expect(bundle.documents.map((d) => d.path)).toEqual([
      "agents/drug-db-escalation.md",
      "agents/drug-db-maintainer.md",
      "agents/peer-verification-protocol.md",
      "agents/fulltext-acquisition.md",
      "agents/kinectics_science_paper_review_agent_instructions.md",
    ]);
    for (const excluded of [
      "AGENTS.md",
      "agents/remote-routine-setup.md",
      "agents/adding-a-new-agent.md",
      "agents/local-codex-workers.md",
      "agents/cross-agent-learning-protocol.md",
      "docs/superpowers/",
      ".env",
      "worker-profiles/",
      "test-results/",
    ]) {
      expect(JSON.stringify(bundle)).not.toContain(excluded);
    }
    expect(
      bundle.documents.find((d) => d.path === "agents/fulltext-acquisition.md")
        ?.content,
    ).toContain("ÆØÅ μ ≤ 🧪");
    expect(JSON.stringify(bundle)).not.toContain(privateText);
    expect(bundle.sourceCommit).toBe("a".repeat(40));
    expect(Object.keys(bundle).sort()).toEqual([
      "documents",
      "format",
      "revision",
      "schemaVersion",
      "sourceCommit",
    ]);
    for (const doc of bundle.documents) {
      expect(Object.keys(doc).sort()).toEqual([
        "byteLength",
        "content",
        "path",
        "sha256",
      ]);
      expect(doc.byteLength).toBe(Buffer.byteLength(doc.content, "utf8"));
      expect(doc.sha256).toBe(sha256(doc.content));
    }
    expect(bundle.revision).toBe(
      sha256(JSON.stringify(bundle.documents.map((d) => [d.path, d.sha256]))),
    );
    expect(buildPublicInstructionBundle(root)).toEqual({
      ...bundle,
      sourceCommit: null,
    });
    writeFileSync(
      path.join(root, PUBLIC_INSTRUCTION_PATHS[3]),
      "# Changed guidance\n",
    );
    expect(buildPublicInstructionBundle(root).revision).not.toBe(
      bundle.revision,
    );
  });
  it("fails the build on missing, truncated or invalid UTF-8 selected guidance", () => {
    const root = fixture(),
      selected = path.join(root, PUBLIC_INSTRUCTION_PATHS[3]);
    writeFileSync(selected, "");
    expect(() => buildPublicInstructionBundle(root)).toThrow(/invalid/);
    writeFileSync(selected, Buffer.from([0xff]));
    expect(() => buildPublicInstructionBundle(root)).toThrow();
    rmSync(selected);
    expect(() => buildPublicInstructionBundle(root)).toThrow();
  });
  it("rejects concrete credentials without echoing their values", () => {
    const root = fixture(),
      secret = "kxat_" + "x".repeat(43);
    writeFileSync(
      path.join(root, PUBLIC_INSTRUCTION_PATHS[3]),
      "# Shared\n" + secret,
    );
    try {
      buildPublicInstructionBundle(root);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(String(error)).toContain("Possible credential");
      expect(String(error)).not.toContain(secret);
    }
  });
  it("publishes the real selected documents and excludes the asset from SPA fallback", () => {
    const bundle = buildPublicInstructionBundle(process.cwd());
    expect(bundle.documents.every((d) => d.byteLength > 1000)).toBe(true);
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    const fallback = config.rewrites.find(
      (r: { destination: string }) => r.destination === "/index.html",
    );
    const match = new RegExp("^" + fallback.source + "$");
    expect(match.test("/agent-instructions.json")).toBe(false);
    expect(match.test("/agent-instructions/AGENTS.md")).toBe(false);
    expect(match.test("/agent-instructions/../../.env")).toBe(false);
    expect(match.test("/modeling")).toBe(true);
    expect(
      config.headers.find(
        (r: { source: string }) => r.source === "/agent-instructions.json",
      ).headers,
    ).toContainEqual({ key: "Cache-Control", value: "no-store" });
  });
  it("omits internal planning/setup sections and refuses newly linked private guidance", () => {
    const bundle = buildPublicInstructionBundle(process.cwd());
    const maintainer = bundle.documents.find(
      (d) => d.path === "agents/drug-db-maintainer.md",
    )!.content;
    expect(maintainer).toContain("## 4. The Method");
    expect(maintainer).not.toContain("## 2. The cycle");
    expect(maintainer).not.toContain("clones this repo");
    expect(bundle.documents[0].content).not.toContain("## Not yet available");
    const root = fixture();
    writeFileSync(
      path.join(root, "agents/fulltext-acquisition.md"),
      "# Runtime\nRead `docs/private-plan.md` now.\n",
    );
    expect(() => buildPublicInstructionBundle(root)).toThrow(
      /Unreviewed instruction reference/,
    );
  });
});
