#!/usr/bin/env node
/** Per-command credential selection for local scheduled workers. No shared env writes. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, devNull } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tiers = {
  producer: "mid",
  reviewer: "flagship",
  "adjudicator-a": "flagship",
  "adjudicator-b": "flagship",
};
// T1 and T2 must both be installed; a T3 panel seat is optional per machine.
const requiredRoles = ["producer", "reviewer"];
const isAdjudicator = (role) => role.startsWith("adjudicator-");
const roleList = Object.keys(tiers).join(" | ");
const defaultDirectory = path.join(homedir(), ".kinetix", "worker-profiles");
const helpers = new Set([
  "kinetix-log-verification.ts",
  "kinetix-log-run-usage.ts",
  "rejection-scan.ts",
]);
// A T3 seat reads anything but writes only its claim and its opinion
// (agents/drug-db-adjudication.md §0, §3a): no peer verdicts or content edits.
const adjudicatorHelpers = new Set(["kinetix-log-run-usage.ts"]);
const adjudicatorWrites = new Set([
  "/api/agent-adjudication-queue?action=claim",
  "/api/agent-adjudication-opinions",
]);
const keys = new Set([
  "version",
  "role",
  "baseUrl",
  "token",
  "agentId",
  "userId",
  "slug",
  "modelTier",
  "dryRun",
]);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

export function validateProfile(profile, role) {
  if (
    !Object.hasOwn(tiers, role) ||
    !profile ||
    typeof profile !== "object" ||
    Object.keys(profile).some((key) => !keys.has(key)) ||
    profile.version !== 1 ||
    profile.role !== role ||
    profile.modelTier !== tiers[role] ||
    !positiveId(profile.agentId) ||
    !positiveId(profile.userId) ||
    typeof profile.slug !== "string" ||
    !/^[a-z0-9-]+$/.test(profile.slug) ||
    typeof profile.token !== "string" ||
    !/^kxat_[A-Za-z0-9_-]{32,128}$/.test(profile.token) ||
    typeof profile.dryRun !== "boolean"
  ) {
    throw new Error(
      "Invalid worker profile; credentials and identity must be configured explicitly.",
    );
  }
  let url;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    /* handled below */
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    profile.baseUrl !== url.origin
  ) {
    throw new Error(
      "Worker baseUrl must be an HTTPS origin without a path or credentials.",
    );
  }
  return profile;
}

export function loadProfile(role, directory = defaultDirectory) {
  if (!Object.hasOwn(tiers, role))
    throw new Error(`Select --profile ${roleList}.`);
  try {
    const file = path.join(directory, `${role}.json`);
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8192 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error();
    return validateProfile(JSON.parse(readFileSync(file, "utf8")), role);
  } catch {
    // JSON parser and filesystem errors can include fragments of secret input.
    throw new Error(
      "Worker profile is missing, unreadable, or invalid. No fallback credentials were used.",
    );
  }
}

export function workerEnvironment(
  profile,
  inherited = process.env,
  dryRun = false,
) {
  // Deliberately omit DB/admin credentials, shell startup hooks, NODE_OPTIONS,
  // inherited KINETIX_*, and dotenv override settings. Preserve OS/proxy plumbing.
  const allowed =
    /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|appdata|localappdata|programfiles|programfiles\(x86\)|programw6432|lang|lc_[a-z_]+|https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs|claude_code_agent_hooks_disabled|codex_home|claude_config_dir|claude_code_session_id|codex_session_id|codex_thread_id)$/i;
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => allowed.test(key)),
  );
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  if (process.platform === "win32") {
    const gitBin = path.join(
      inherited.ProgramFiles || "C:\\Program Files",
      "Git",
      "usr",
      "bin",
    );
    if (existsSync(path.join(gitBin, "bash.exe")))
      env[pathKey] = `${gitBin}${path.delimiter}${env[pathKey] || ""}`;
  }
  return {
    ...env,
    KINETIX_BASE_URL: profile.baseUrl,
    KINETIX_TOKEN: profile.token,
    KINETIX_AGENT_DRY_RUN:
      dryRun || profile.dryRun || inherited.KINETIX_AGENT_DRY_RUN === "1"
        ? "1"
        : "0",
    KINETIX_WORKER_PROFILE: profile.role,
    DOTENV_CONFIG_PATH: devNull,
    DOTENV_CONFIG_QUIET: "true",
  };
}

export function redact(text, token) {
  return String(text ?? "")
    .split(token)
    .join("[REDACTED]")
    .replace(/kxat_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function assertDistinctProfiles(...profiles) {
  for (const key of ["userId", "agentId", "token"]) {
    if (
      new Set(profiles.map((profile) => profile[key])).size !== profiles.length
    )
      throw new Error(
        "Worker profiles must use distinct users, agents and tokens. Stopping.",
      );
  }
}

function profilePresent(role, directory) {
  try {
    lstatSync(path.join(directory, `${role}.json`));
    return true;
  } catch (error) {
    // Anything but a clean "absent" is treated as present so loadProfile fails closed.
    return error?.code !== "ENOENT";
  }
}

/**
 * Load the selected profile plus every installed peer and require all of them
 * to be distinct identities. The T1/T2 pair is always required; an installed
 * T3 seat is checked too, so no worker can run on another seat's credentials.
 */
export function loadProfiles(role, directory = defaultDirectory) {
  const selected = loadProfile(role, directory);
  const peers = Object.keys(tiers)
    .filter(
      (peer) =>
        peer !== role &&
        (requiredRoles.includes(peer) || profilePresent(peer, directory)),
    )
    .map((peer) => loadProfile(peer, directory));
  assertDistinctProfiles(selected, ...peers);
  return selected;
}

// The usage helper keeps the last --workflow it sees, so require exactly one
// and make it "adjudication": T3 cost rows must not land in another workflow.
function pinsAdjudicationWorkflow(args) {
  const values = args.flatMap((arg, i) =>
    arg === "--workflow" ? [args[i + 1]] : [],
  );
  return values.length === 1 && values[0] === "adjudication";
}

export function assertRoleCommand(role, kind, args) {
  if (!isAdjudicator(role)) return;
  const [first, second] = args;
  if (
    (kind === "helper" &&
      (!adjudicatorHelpers.has(first) || !pinsAdjudicationWorkflow(args))) ||
    (kind === "api" &&
      first !== "GET" &&
      !(first === "POST" && adjudicatorWrites.has(second)))
  ) {
    throw new Error(
      "An adjudicator profile may only read, claim a case seat, post its opinion and log run usage.",
    );
  }
}

function command(kind, args) {
  if (kind === "pdf") {
    if (
      args.length !== 2 ||
      !/^[1-9][0-9]*$/.test(args[0]) ||
      !Number.isSafeInteger(Number(args[0])) ||
      !args[1] ||
      args[1].startsWith("-")
    ) {
      throw new Error("Usage: pdf POSITIVE_CITATION_ID OUTPUT_FILE");
    }
    // The existing downloader handles binary bytes and strips auth before its
    // allowlisted Blob redirect. Never run PDF bytes through UTF-8/redaction.
    return [
      "bash",
      [
        path.join(root, "scripts", "download-citation-pdf.sh"),
        args[0],
        path.resolve(root, args[1]).replaceAll("\\", "/"),
      ],
    ];
  }
  if (kind === "api") {
    const [method, apiPath, body, ...extra] = args;
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      typeof apiPath !== "string" ||
      !/^\/api\/[A-Za-z0-9/?=&%._+:-]+$/.test(apiPath) ||
      (body !== undefined && body !== "-" && !body.startsWith("@")) ||
      extra.length
    ) {
      throw new Error("Usage: api METHOD /api/path [@body.json|-]");
    }
    return ["bash", [path.join(root, "scripts", "kinetix-api.sh"), ...args]];
  }
  if (kind === "helper" && helpers.has(args[0])) {
    return [
      process.execPath,
      [
        path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(root, "scripts", args[0]),
        ...args.slice(1),
      ],
    ];
  }
  throw new Error(
    "Use check, api, pdf, or helper (kinetix-log-verification.ts / kinetix-log-run-usage.ts / rejection-scan.ts).",
  );
}

function execute(kind, args, env, input) {
  const [executable, argv] = command(kind, args);
  const result = spawnSync(executable, argv, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error)
    throw new Error(
      "Worker helper could not run (check Bash, Node and local dependencies).",
    );
  return result;
}

export function assertIdentity(profile, user, agents) {
  const agent = agents?.find((item) => item.id === profile.agentId);
  if (
    user?.id !== profile.userId ||
    !["contributor", "editor"].includes(user?.role) ||
    !agent ||
    agent.agent?.userId !== user.id ||
    agent.slug !== profile.slug ||
    agent.status !== "active"
  ) {
    throw new Error(
      "Authenticated identity does not match the configured active worker. Stopping.",
    );
  }
}

function checkIdentity(profile, env) {
  const read = (apiPath) => {
    const result = execute("api", ["GET", apiPath], {
      ...env,
      KINETIX_AGENT_DRY_RUN: "0",
    });
    if (result.status !== 0)
      throw new Error("Worker identity check failed; no task command was run.");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("Worker identity response was invalid.");
    }
  };
  const { user } = read("/api/auth?action=me");
  const { agents } = read("/api/agents");
  assertIdentity(profile, user, agents);
  return {
    profile: profile.role,
    agentId: profile.agentId,
    userId: user.id,
    slug: profile.slug,
    role: user.role,
    configuredTier: profile.modelTier,
    identityVerified: true,
  };
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "--profile")
    throw new Error(`Select --profile ${roleList} on EVERY command.`);
  const role = argv[1];
  let rest = argv.slice(2);
  const dryRun = rest[0] === "--dry-run";
  if (dryRun) rest = rest.slice(1);
  const [kind, ...args] = rest;
  const profile = loadProfiles(role);
  const env = workerEnvironment(profile, process.env, dryRun);
  if (kind === "check") {
    if (args.length || dryRun)
      throw new Error(
        "check is a read-only LIVE identity check; omit --dry-run and extra arguments.",
      );
    console.log(JSON.stringify(checkIdentity(profile, env)));
    return 0;
  }
  command(kind, args); // Validate arguments before any network request.
  assertRoleCommand(role, kind, args);
  // Resolve files here and stream bytes. Native Windows -> MSYS argument
  // handling can reinterpret an @C:\\... argument before Bash sees it.
  let input;
  if (kind === "api" && args[2]) {
    input = readFileSync(
      args[2] === "-" ? 0 : path.resolve(root, args[2].slice(1)),
    );
    args[2] = "-";
  }
  if (env.KINETIX_AGENT_DRY_RUN !== "1") checkIdentity(profile, env);
  const result = execute(kind, args, env, input);
  if (
    kind === "pdf" &&
    result.status === 0 &&
    env.KINETIX_AGENT_DRY_RUN !== "1"
  ) {
    const output = path.resolve(root, args[1]);
    const bytes = readFileSync(output);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error(
        "Stored citation response is not a PDF; do not read or attest it.",
      );
    }
    console.log(
      JSON.stringify({
        path: output,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  }
  process.stdout.write(redact(result.stdout, profile.token));
  process.stderr.write(redact(result.stderr, profile.token));
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[kinetix-worker] ${error.message}`);
    process.exitCode = 1;
  }
}
