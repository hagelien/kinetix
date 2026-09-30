/**
 * The build-time environment `import.meta.env` exposes, declared for EVERY program that
 * typechecks this repository — not just the Vite one.
 *
 * It lives here rather than in `src/vite-env.d.ts` because `src/lib/kinetics-core/registry.ts`
 * reads `import.meta.env.VITE_DERIVED_REGISTRY_ENABLED` and is imported by three different
 * programs: the app (`tsconfig.json`), the maintenance CLIs (`tsconfig.scripts.json`) and the
 * migration path. Only the first pulls in `vite/client`, so a direct read did not typecheck for
 * the others — which is what pushed that flag into an aliased `const meta = import.meta` read,
 * and an aliased read is invisible to Vite's static replacement (see the note on
 * `derivedRegistryRolloutEnabled`). Declaring the shape in one place that every config includes
 * removes the reason to alias.
 *
 * Shapes match `vite/client` exactly (`env` non-optional) so the declarations merge rather than
 * conflict where both are in scope.
 */
interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  /** Rollout switch for the catalog-DERIVED registry tier (CV-5). Absent ⇒ reviewed tier only. */
  readonly VITE_DERIVED_REGISTRY_ENABLED?: string;
  /** Build version stamped into a run manifest. */
  readonly VITE_APP_VERSION?: string;
  /** `full` selects the remote KineLab compute engine; anything else stays on the lite engine. */
  readonly VITE_KINELAB_COMPUTE_MODE?: string;
  /** Address the landing page offers for account requests. Absent ⇒ no address is shown. */
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
