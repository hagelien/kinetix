/**
 * Shared HTTP path for the scheduled-routine helper scripts.
 *
 * The helpers used to call the Kinetix API with Node's built-in `fetch`. That
 * works locally, but on proxied runners it fails: Node's fetch (undici) does
 * not honor the `HTTPS_PROXY` environment variable on Node < 22.21 and has no
 * env-proxy flag there, so on such runners (e.g. the Codex sandbox on Node 20)
 * every request died with `ENETUNREACH` while the curl-based `kinetix-api.sh`
 * — which does honor the proxy — kept working.
 *
 * Rather than depend on a specific Node version or per-runner env var, these
 * helpers now delegate their HTTP to `scripts/kinetix-api.sh` (curl), the same
 * egress path the rest of the routine already uses. The shell helper reads
 * KINETIX_BASE_URL / KINETIX_TOKEN / KINETIX_AGENT_DRY_RUN from the environment
 * itself, attaches the agent cookie, and returns the response body on stdout.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiScript = path.join(scriptDir, 'kinetix-api.sh');

export interface KinetixApiResult {
  /** true when kinetix-api.sh exited 0 (curl 2xx). */
  ok: boolean;
  /** Response body on success, or the error text (stdout body / stderr) on failure. */
  body: string;
}

/**
 * Perform a Kinetix API request through `scripts/kinetix-api.sh` (curl).
 *
 * @param method  HTTP method, e.g. 'GET' or 'POST'.
 * @param apiPath API path beginning with '/', e.g. '/api/agent-verification-log'.
 * @param body    Optional JSON-serializable body; sent to the shell helper via stdin.
 */
export function kinetixApi(
  method: string,
  apiPath: string,
  body?: unknown,
): KinetixApiResult {
  const hasBody = body !== undefined;
  const args = [apiScript, method, apiPath];
  if (hasBody) args.push('-'); // read request body from stdin

  const res = spawnSync('bash', args, {
    input: hasBody ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, body: String(res.error) };
  }

  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  // kinetix-api.sh uses `curl --fail-with-body`: exit 0 on 2xx (body on
  // stdout); non-zero on HTTP >= 400 (body still on stdout) or a transport
  // error (message on stderr). Surface whichever carries the detail.
  if (res.status === 0) {
    return { ok: true, body: stdout };
  }
  return { ok: false, body: stdout.trim() ? stdout : stderr };
}
