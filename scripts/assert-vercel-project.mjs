#!/usr/bin/env node
// Guard against deploying Kinetix into the wrong Vercel project.
//
// Kinetix has Git auto-deploy disabled (vercel.json -> git.deploymentEnabled:
// false), so every release is a `vercel` CLI invocation. The Vercel project that
// receives the deploy is decided entirely by the resolved link in
// `.vercel/project.json` (written by `vercel link` locally, or `vercel pull` in
// CI) -- NOT by which repo you are sitting in. A checkout linked to the wrong
// project will silently publish this app there and take over that project's
// production domain. That is exactly how a Kinetix build once landed in the
// `ketai` Vercel project and hijacked ketai.be until a later ketai git deploy
// reclaimed the alias.
//
// This check fails loudly BEFORE any `vercel build` / `vercel deploy` runs so
// the mistake cannot reach production. See docs/ops/vercel-project-link.md.
//
// Project/org IDs are not secrets -- they appear in deployment URLs and in
// `.vercel/project.json`. Override via env (EXPECTED_VERCEL_PROJECT_ID /
// EXPECTED_VERCEL_ORG_ID) only for a deliberate fork or project rename.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_PROJECT_ID =
  process.env.EXPECTED_VERCEL_PROJECT_ID || 'prj_YhClAx5EPWxmc8U2E8uXqhreKi7U';
const EXPECTED_ORG_ID =
  process.env.EXPECTED_VERCEL_ORG_ID || 'team_7I0ncx6USKp2ZDbQur9cKjd8';

const LINK_PATH = resolve(process.cwd(), '.vercel', 'project.json');

function fail(message) {
  console.error(`\n✖ Vercel project-link check failed.\n\n${message}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(LINK_PATH, 'utf8');
} catch {
  fail(
    `No .vercel/project.json found at ${LINK_PATH}.\n` +
      `This repo deploys to the "kinetix" project (${EXPECTED_PROJECT_ID}).\n` +
      `Link it first:  vercel link        (local)\n` +
      `            or:  vercel pull --yes  (CI)`,
  );
}

let link;
try {
  link = JSON.parse(raw);
} catch (err) {
  fail(`.vercel/project.json is not valid JSON: ${err.message}`);
}

const { projectId, orgId } = link;

if (projectId !== EXPECTED_PROJECT_ID || orgId !== EXPECTED_ORG_ID) {
  fail(
    `This checkout is linked to the WRONG Vercel project.\n\n` +
      `  expected project: ${EXPECTED_PROJECT_ID} (kinetix)\n` +
      `  expected org:     ${EXPECTED_ORG_ID}\n` +
      `  found project:    ${projectId ?? '(none)'}\n` +
      `  found org:        ${orgId ?? '(none)'}\n\n` +
      `Deploying now would publish Kinetix into another project and could\n` +
      `hijack that project's production domain. Re-link before continuing:\n\n` +
      `  rm -rf .vercel && vercel link   # then select the "kinetix" project`,
  );
}

console.log(`✓ Vercel project-link OK -- kinetix (${projectId}).`);
