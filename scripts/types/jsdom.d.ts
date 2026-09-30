/*
 * Minimal ambient declaration for `jsdom`, which ships no types of its own.
 *
 * Same treatment `src/types/plotly.d.ts` gives its untyped dependency, and for
 * the same reason: declaring the surface actually used costs nothing and keeps
 * a types-only package out of the dependency tree. `jsdom` is imported by
 * exactly one file — scripts/farmakologiportalen/parse.ts — which uses nothing
 * but `new JSDOM(html).window.document`, so that is all this declares.
 *
 * Scoped to scripts/: `scripts/` is outside the root tsconfig's `include`
 * (see tsconfig.scripts.json), and `jsdom` never reaches shipped code — the
 * dependency audit in scripts/dependency-audit-scan.ts says so explicitly.
 *
 * If @types/jsdom is ever added, delete this file: two declarations of the
 * same module would conflict.
 */
declare module 'jsdom' {
  export interface ConstructorOptions {
    url?: string;
    contentType?: string;
    includeNodeLocations?: boolean;
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
    serialize(): string;
  }
}
