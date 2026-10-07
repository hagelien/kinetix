import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
// Standalone JS runner deliberately has no tsx/jsdom import in its parent process.
// @ts-expect-error Operational .mjs has no declaration file.
import {
  acquisitionCommand,
  publicEnvironment,
} from "../scripts/kinetix-fulltext.mjs";

it("removes secrets, dotenv overrides and code-injection hooks from the child environment", () => {
  const env = publicEnvironment({
    PATH: "bin",
    TEMP: "tmp",
    HTTPS_PROXY: "https://proxy.example",
    NODE_USE_ENV_PROXY: "1",
    KINETIX_TOKEN: "secret",
    KINETIX_BASE_URL: "https://private",
    DATABASE_URL: "secret",
    JWT_SECRET: "secret",
    RANDOM_NEW_SECRET: "secret",
    NODE_OPTIONS: "--import=evil",
    BASH_ENV: "evil",
    ENV: "evil",
    DOTENV_CONFIG_PATH: ".env",
    DOTENV_CONFIG_OVERRIDE: "true",
    NPM_CONFIG_USERCONFIG: "evil",
  });
  expect(env).toMatchObject({
    PATH: "bin",
    TEMP: "tmp",
    HTTPS_PROXY: "https://proxy.example",
    NODE_USE_ENV_PROXY: "1",
    DOTENV_CONFIG_QUIET: "true",
  });
  expect(JSON.stringify(env)).not.toMatch(/secret|evil|private|\.env/);
  expect(Object.keys(env).some((key) => key.startsWith("KINETIX_"))).toBe(
    false,
  );
});

it("only dispatches explicit acquisition commands, never arbitrary helpers or flags", () => {
  expect(acquisitionCommand(["check"])).toBeNull();
  expect(
    acquisitionCommand(["pmc", "PMC3584707", "--pmid", "21346758"]),
  ).toEqual([
    "scripts/fetch-pmc-full-text.ts",
    "PMC3584707",
    "--pmid",
    "21346758",
  ]);
  expect(acquisitionCommand(["discover", "32838982"])).toEqual([
    "scripts/discover-full-text.ts",
    "32838982",
  ]);
  for (const args of [
    [],
    ["check", "extra"],
    ["api", "POST"],
    ["helper", "other.ts"],
    ["pmc", "../script.ts"],
    ["pmc", "PMC0"],
    ["pmc", "PMC1", "--import", "evil"],
    ["discover", "123", "--eval", "evil"],
  ])
    expect(() => acquisitionCommand(args)).toThrow("Usage:");
});

it("checks the installed runtime from a foreign cwd with no profiles or API credentials", () => {
  const script = resolve("scripts/kinetix-fulltext.mjs");
  const result = spawnSync(process.execPath, [script, "check"], {
    cwd: resolve("tests"),
    env: publicEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({
    status: "ready",
    readInFull: false,
    root: resolve("."),
  });
  expect(Object.keys(receipt.hashes)).toHaveLength(7);
  for (const hash of Object.values(receipt.hashes))
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
});
