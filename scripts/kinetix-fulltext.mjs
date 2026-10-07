/** Public-source acquisition only. No worker profiles, API credentials or dotenv. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sources = [
  "scripts/kinetix-fulltext.mjs",
  "scripts/fetch-pmc-full-text.ts",
  "scripts/discover-full-text.ts",
  "scripts/fulltext/pmc.ts",
  "scripts/fulltext/discovery.ts",
  "scripts/fetch-pubchem-record.ts",
  "scripts/fulltext/pubchem.ts",
];

export function publicEnvironment(inherited = process.env) {
  // An allowlist, not a blacklist of today's secret names. Proxy/TLS settings
  // are operator-owned plumbing. Never forward NODE_OPTIONS or shell hooks.
  const allowed =
    /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|appdata|localappdata|programfiles|programfiles\(x86\)|programw6432|lang|lc_[a-z_]+|https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs|node_use_env_proxy)$/i;
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(([key]) => allowed.test(key)),
    ),
    DOTENV_CONFIG_PATH: devNull,
    DOTENV_CONFIG_QUIET: "true",
  };
}

export function acquisitionCommand(args) {
  if (args.length === 1 && args[0] === "check") return null;
  if (args[0] === "discover" && args.length === 2 && /^[1-9]\d*$/.test(args[1]))
    return ["scripts/discover-full-text.ts", args[1]];
  if (
    args[0] === "pubchem" &&
    args.length === 2 &&
    /^[1-9]\d{0,11}$/.test(args[1])
  )
    return ["scripts/fetch-pubchem-record.ts", args[1]];
  if (
    args[0] === "pmc" &&
    /^PMC[1-9]\d*$/i.test(args[1] ?? "") &&
    (args.length === 2 ||
      (args.length === 4 && args[2] === "--pmid" && /^[1-9]\d*$/.test(args[3])))
  )
    return ["scripts/fetch-pmc-full-text.ts", ...args.slice(1)];
  throw new Error(
    "Usage: kinetix-fulltext.mjs check | discover PMID | pmc PMCID [--pmid PMID] | pubchem CID",
  );
}

export function runtimeReceipt() {
  const hashes = Object.fromEntries(
    sources.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
  // Resolve from this installation, not the caller's cwd or a network installer.
  const tsx = require.resolve("tsx/cli");
  const jsdom = require.resolve("jsdom");
  return {
    status: "ready",
    root,
    node: process.version,
    tsx,
    jsdom,
    hashes,
    readInFull: false,
  };
}

export function main(args = process.argv.slice(2)) {
  const command = acquisitionCommand(args);
  let runtime;
  try {
    runtime = runtimeReceipt();
  } catch {
    throw new Error(
      "Full-text runtime incomplete: install the reviewed helper files and existing tsx/jsdom dependencies. No network request was made; do not classify this as unavailable literature.",
    );
  }
  if (!command) {
    console.log(JSON.stringify(runtime, null, 2));
    return 0;
  }
  const result = spawnSync(
    process.execPath,
    [runtime.tsx, path.join(root, command[0]), ...command.slice(1)],
    {
      cwd: root,
      env: publicEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 100_000, // PMC: at most three 25-second source requests plus parsing.
    },
  );
  if (result.error)
    throw new Error(
      "Public acquisition process failed or timed out; source availability is unresolved.",
    );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Public acquisition failed",
    );
    process.exitCode = 1;
  }
}
