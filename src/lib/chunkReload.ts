/**
 * Recover from stale-chunk dynamic-import failures after a deploy.
 *
 * Production bundles use content-hashed chunk filenames (e.g.
 * `ReviewPage-B2dlShm8.js`). When a new version ships, those hashes change. A
 * browser still running the previous `index.html` — a tab left open across the
 * deploy, or a stale cached document — requests the old chunk on the next lazy
 * navigation. That file no longer exists, so Vercel's SPA rewrite
 * (`/((?!api/).*) -> /index.html`) serves `index.html` with a `text/html` MIME
 * type, and the dynamic import rejects with:
 *   "Failed to fetch dynamically imported module"
 *   "Expected a JavaScript-or-Wasm module script but the server responded with
 *    a MIME type of text/html".
 *
 * Vite fires a cancelable `vite:preloadError` window event for exactly this
 * case (every lazy `import()` goes through its preload helper). Reloading pulls
 * the fresh `index.html` with current chunk names, which resolves the
 * navigation. A short-lived sessionStorage timestamp stops a genuinely broken
 * or offline load from reloading in a loop, while still letting a later deploy
 * in the same long-lived tab recover.
 */

const RELOAD_AT_KEY = 'kinetix:chunk-reload-at';

// Suppress a follow-up reload only if one happened very recently. A stale
// chunk hit minutes later (the next deploy) should still trigger a fresh
// reload, so we key off elapsed time rather than a sticky boolean flag.
const RELOAD_SUPPRESS_MS = 10_000;

function readLastReloadAt(win: Window): number {
  try {
    return Number(win.sessionStorage.getItem(RELOAD_AT_KEY)) || 0;
  } catch {
    // sessionStorage access can throw in some privacy modes — treat as "never".
    return 0;
  }
}

function writeLastReloadAt(win: Window, at: number): void {
  try {
    win.sessionStorage.setItem(RELOAD_AT_KEY, String(at));
  } catch {
    // Ignore storage failures; we still attempt the reload below.
  }
}

export function installChunkReloadHandler(win: Window = window): void {
  win.addEventListener('vite:preloadError', (event) => {
    const now = Date.now();
    if (now - readLastReloadAt(win) < RELOAD_SUPPRESS_MS) {
      // We just reloaded for this and it failed again — likely offline or a
      // genuinely missing chunk. Let the error surface instead of looping.
      return;
    }

    writeLastReloadAt(win, now);
    // Tell Vite we are handling the failure so it doesn't re-throw the error.
    event.preventDefault();
    win.location.reload();
  });
}
