import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// Publication boundary: reviewed shared prose only. Never scan/glob the repo.
// Each source has an explicit runtime projection below; no dependency crawling.
export const PUBLIC_INSTRUCTION_PATHS = [
  "agents/drug-db-escalation.md",
  "agents/drug-db-maintainer.md",
  "agents/peer-verification-protocol.md",
  "agents/fulltext-acquisition.md",
  "agents/kinectics_science_paper_review_agent_instructions.md",
] as const;

export const INSTRUCTION_BUNDLE_FILE = "agent-instructions.json";
export const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Source prose stays canonical; publication selects only runtime material. */
export function projectPublicInstruction(file: string, source: string): string {
  let content = source;
  if (file === "agents/drug-db-maintainer.md") {
    const wanted = ["0", "1", "4", "8", "9", "11"];
    const headings = [...source.matchAll(/^## (?:(\d+)\.|Reference index)/gm)];
    const sections = wanted.map((number) => {
      const index = headings.findIndex((h) => h[1] === number);
      if (index < 0)
        throw new Error(
          `Missing required public maintainer section: ${number}`,
        );
      return source
        .slice(headings[index]!.index, headings[index + 1]?.index)
        .trim();
    });
    const factSupport = source.match(
      /^### How many references a fact needs\n[\s\S]*?(?=^### )/m,
    )?.[0];
    if (!factSupport)
      throw new Error("Missing required public fact-support guidance.");
    sections.splice(
      3,
      0,
      "## 6. Writing rules — fact support (extract)\n\n" + factSupport.trim(),
    );
    content =
      "# Maintainer guidance for the T2 reviewer\n\nRuntime sections 0, 1, 4, 8, 9 and 11, plus section 6's fact-support rule, from the canonical maintainer instructions. References to producer actions in sections 2, 3, 5 and 7 do not authorize those actions in this T2 routine. Operator setup is outside this extract. The T2 routine determines the permitted actions.\n\n" +
      sections.join("\n\n");
    content = content.replace(
      /^You are spawned fresh by a Claude Code Routine[^\n]*\n/m,
      "",
    );
    // Section 9's usage step names the producer workflow and the producer
    // worker profile. A T2 reviewer following it would log its run under the
    // mid-tier producer identity, so the bundle keeps only the end-of-cycle
    // paragraph rules; T2 records usage as its own section 5 says.
    const usageStep =
      /^\*\*First, record this run's token usage\*\*[\s\S]*?^Then emit one concise paragraph/m;
    if (!usageStep.test(content))
      throw new Error(
        "Review the T2 projection of the maintainer usage step after it changes.",
      );
    content = content.replace(
      usageStep,
      "Record this run's token usage as the T2 routine's own end-of-cycle step says, then emit one concise paragraph",
    );
  }
  if (file === "agents/drug-db-escalation.md") {
    const boundary = content.indexOf(
      "## Not yet available (tracked follow-up)",
    );
    if (boundary < 0)
      throw new Error(
        "Review the T2 public projection after its planning boundary changes.",
      );
    content = content.slice(0, boundary).trim();
  }
  if (file === "agents/peer-verification-protocol.md") {
    for (const heading of [
      "Self-review (opt-in, per agent)",
      "Closing the loop — resolving disputes on your own work",
      "Where it fits in the broader picture",
      "The unified dispute feed (`GET /api/disputes`)",
    ]) {
      const start = content.indexOf("## " + heading);
      if (start < 0)
        throw new Error(
          "Review the public peer protocol projection after its section boundaries change.",
        );
      const end = content.indexOf("\n## ", start + 3);
      content =
        content.slice(0, start) + (end < 0 ? "" : content.slice(end + 1));
    }
  }
  // Internal references are context, not permission to publish their targets.
  const privateReferences: Record<string, string> = {
    "agents/remote-routine-setup.md":
      "operator setup guidance (outside the public runtime instructions)",
    "agents/drug-db-adjudication.md":
      "the separate adjudication workflow (outside this T2 routine)",
    "agents/comment-and-fact-evaluator.md": "the separate evaluator routine",
    "docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md":
      "the internal cost-architecture rationale",
  };
  for (const [privatePath, description] of Object.entries(privateReferences)) {
    content = content.replaceAll("`" + privatePath + "`", description);
  }
  for (const match of content.matchAll(
    /(?:agents|docs)\/[A-Za-z0-9_./-]+\.md/g,
  )) {
    if (!(PUBLIC_INSTRUCTION_PATHS as readonly string[]).includes(match[0])) {
      throw new Error(
        `Unreviewed instruction reference in public guidance: ${file}`,
      );
    }
  }
  return content.trimEnd() + "\n";
}

export function buildPublicInstructionBundle(
  root: string,
  sourceCommit?: string,
) {
  const realRoot = realpathSync(root);
  const documents = PUBLIC_INSTRUCTION_PATHS.map((file) => {
    const fullPath = path.join(realRoot, file);
    const stat = lstatSync(fullPath);
    const relative = path.relative(realRoot, realpathSync(fullPath));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Public instruction must be an ordinary repository file: ${file}`,
      );
    }
    const bytes = readFileSync(fullPath);
    // Fatal decoding prevents publishing silently replaced/mangled characters.
    const source = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/\r\n/g, "\n");
    if (
      !source.startsWith("# ") ||
      !source.trim() ||
      bytes.length > 1024 * 1024
    ) {
      throw new Error(
        `Missing, invalid or oversized public instruction: ${file}`,
      );
    }
    const content = projectPublicInstruction(file, source);
    // Defense in depth for later edits. Variable names and placeholder examples
    // are fine; concrete credentials are not. Errors never echo matching text.
    if (
      /kxat_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s/@]+:[^\s/@]+@/i.test(
        content,
      )
    ) {
      throw new Error(`Possible credential in public instruction: ${file}`);
    }
    return {
      path: file,
      byteLength: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
      content,
    };
  });
  // A single response contains the whole consistent set: consumers never race
  // a deploy between a mutable manifest request and separate document fetches.
  const revision = sha256(
    JSON.stringify(documents.map(({ path, sha256 }) => [path, sha256])),
  );
  return {
    format: "kinetix-agent-instructions",
    schemaVersion: 1,
    revision,
    sourceCommit:
      sourceCommit && /^[0-9a-f]{40}$/.test(sourceCommit) ? sourceCommit : null,
    documents,
  };
}

/** Emit a static asset as part of the ordinary Vite release build. No DB/auth. */
export function publicAgentInstructions(): Plugin {
  let root: string;
  return {
    name: "public-agent-instructions",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle() {
      const bundle = buildPublicInstructionBundle(
        root,
        process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA,
      );
      this.emitFile({
        type: "asset",
        fileName: INSTRUCTION_BUNDLE_FILE,
        source: JSON.stringify(bundle),
      });
    },
  };
}
