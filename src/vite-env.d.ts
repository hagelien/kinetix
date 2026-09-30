/// <reference types="vite/client" />

// `ImportMetaEnv` / `ImportMeta` are declared in `src/types/import-meta-env.d.ts`, which every
// tsconfig includes — the app, the maintenance CLIs and the migration path all typecheck code that
// reads `import.meta.env`, and only this program pulls in `vite/client`.

// Raw markdown imports. `docs/simulator-mechanics.md` is imported this way by
// `SimulatorMechanicsPage`, so the document in the repo IS the published page — there is
// no second copy of the prose to fall out of step with the engine it describes.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
