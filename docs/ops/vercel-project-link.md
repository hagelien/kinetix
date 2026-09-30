# Vercel project-link safety

## Why this exists

Kinetix has Git auto-deploy **disabled** (`vercel.json` →
`git.deploymentEnabled: false`), to control cost. Every release is therefore a
`vercel` CLI invocation (the `deploy-production` GitHub Action runs
`vercel pull` → `vercel build --prod` → `vercel deploy --prebuilt --prod`).

The Vercel **project** that receives a CLI deploy is decided entirely by the
resolved link in `.vercel/project.json` — written by `vercel link` locally or
`vercel pull` in CI. It is **not** derived from which git repo you are in. So a
local checkout (or a CI secret) pointing at the wrong project will happily
publish Kinetix into that project and **take over its production domain**.

### The incident this guards against

A Kinetix CLI deploy once landed in the **`ketai`** Vercel project
(deployment built from a `kinetix` commit, `source: cli`). It grabbed ketai's
production aliases, so `ketai.be` served the Kinetix app for ~1h45m until a
later `ketai` git deploy reclaimed the alias. The orphaned deployment kept
running Kinetix functions inside the ketai project and emitted `KINETIX_ERROR`
500s (`/api/drugs`, `/api/wiki/pages`) into ketai's logs — the "kinetix bleeding
into ketai" symptom.

## The guard

`scripts/assert-vercel-project.mjs` reads `.vercel/project.json` and exits
non-zero unless it is linked to the Kinetix project/org:

- project `prj_YhClAx5EPWxmc8U2E8uXqhreKi7U` (kinetix)
- org `team_7I0ncx6USKp2ZDbQur9cKjd8`

It runs automatically in `deploy-production.yml` between `vercel pull` and
`vercel build`, so a misconfigured `VERCEL_PROJECT_ID` secret can never ship.
Run it yourself any time with:

```bash
npm run check:vercel-link
```

## Rules

- **Production deploys go through the `deploy-production` workflow only.** Never
  run a bare `vercel --prod` against this repo.
- Before any local `vercel` command, run `npm run check:vercel-link`.
- If the check fails, re-link and pick the `kinetix` project:

  ```bash
  rm -rf .vercel && vercel link
  ```

## If a Kinetix deploy lands in another project anyway

1. In the **other** project (e.g. ketai), confirm a correct deployment is
   current production again (Vercel → project → Deployments, or its own git
   push). Kinetix losing the alias is not enough — the stray deployment is
   still reachable at its `*.vercel.app` URL.
2. Remove the stray deployment so it stops serving and emitting logs:

   ```bash
   vercel remove <deployment-url> --yes --scope hageliens-projects
   ```

3. Fix the local link (`rm -rf .vercel && vercel link` → kinetix) so the next
   deploy is correct.
