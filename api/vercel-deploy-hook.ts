/**
 * Vercel deployment webhook receiver (build failures).
 *
 * Build failures are best captured as a discrete `deployment.error` event
 * rather than scraped from the build-log firehose. On failure we file a
 * GitHub `auto-fix` issue carrying the deployment id/url so the fix agent
 * can pull full build logs via the Vercel MCP `get_deployment_build_logs`
 * tool.
 *
 * Configure a Vercel webhook for `deployment.error` (and optionally
 * `deployment.failed`) pointing at `/api/vercel-deploy-hook`; copy its
 * secret into `VERCEL_WEBHOOK_SECRET`. See agents/autofix-setup.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './_lib/validate.js';
import { json } from './_lib/response.js';
import {
  verifyVercelSignature,
  fingerprintIdentity,
  reportError,
} from './_lib/autofix-issues.js';

interface DeploymentWebhook {
  type?: string;
  payload?: {
    name?: string;
    url?: string;
    deployment?: {
      id?: string;
      url?: string;
      name?: string;
      meta?: { githubCommitSha?: string; githubCommitRef?: string };
    };
  };
}

const FAILURE_TYPES = new Set(['deployment.error', 'deployment.failed']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._/@-]+$/;
const SAFE_HOSTNAME = /^[A-Za-z0-9.-]+$/;

function safeIdentifier(
  value: string | undefined,
  fallback = '',
  maxLength = 200,
): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > maxLength) return fallback;
  return SAFE_IDENTIFIER.test(trimmed) ? trimmed : fallback;
}

function safeSha(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : '';
}

/**
 * Characters `git check-ref-format` forbids in a ref: ASCII control codes,
 * space, DEL, and ``~^:?*[\`` .
 */
const INVALID_REF_CHAR = /[\0-\x20\x7f~^:?*[\\]/;

/**
 * The same set, anchored to the edges — what may be stripped off a ref.
 *
 * NOT `String.prototype.trim`, which removes every Unicode space separator.
 * Git forbids none of those: `feature/foo\u00a0` is a branch git will create,
 * and trimming it yields `feature/foo` — a different branch that probably
 * exists. That folds two branches onto one fingerprint and prints the wrong
 * name in the issue.
 *
 * This was the fourth instance of one mistake in this file, and the only one
 * that did not look like a transform: `value?.trim() ?? ''` is the idiom every
 * sanitiser here opens with, so it read as hygiene rather than as a decision.
 * It is hygiene for the other three, because they take arbitrary webhook
 * strings. A ref is an identifier, and altering an identifier to suit a
 * consumer is exactly what the comment on `displayRef` forbids.
 *
 * Stripping is still right for this set: git forbids these characters ANYWHERE
 * in a ref, so they cannot be part of one, and padding on a webhook value is a
 * sloppy producer rather than part of the name.
 */
const REF_EDGE_PADDING = /^[\0-\x20\x7f]+|[\0-\x20\x7f]+$/g;

function trimRef(value: string | undefined): string {
  return (value ?? '').replace(REF_EDGE_PADDING, '');
}

/**
 * The branch, rendered.
 *
 * Asks git's question — "is this a ref name a human could have created?" —
 * rather than matching a narrow allowlist. `SAFE_IDENTIFIER` was written for
 * arbitrary webhook identifiers and is stricter than git: it drops `+`, `#`
 * and every non-ASCII letter, all legal in a branch. Dropping them here left
 * the issue with no branch at all, which matters more now that the issue folds
 * a branch's failures together and agents/error-fixer.md asks the fix agent to
 * go look at that branch's current head.
 *
 * Returns the ref EXACTLY as git spells it, or nothing at all — never a
 * modified version. The one removal is edge padding of characters git
 * forbids anywhere in a ref (see `trimRef`), which therefore cannot have
 * been part of the name.
 * A ref is an identifier: altering one to fit a rendering context produces a
 * different, equally plausible branch name, which is worse than having none,
 * because the fix agent then goes looking for a branch that does not exist.
 * Rendering is `codeSpan`'s job below.
 *
 * Anything that is not a valid ref is dropped rather than escaped. A newline
 * or a space cannot occur in a real branch name, so its presence means the
 * value did not come from git, and that is the case the injection guard exists
 * for — see the `ignore previous instructions` test.
 */
function displayRef(value: string | undefined): string {
  const trimmed = trimRef(value);
  if (!trimmed || trimmed.length > 200) return '';
  if (INVALID_REF_CHAR.test(trimmed)) return '';
  if (trimmed.includes('..') || trimmed.includes('@{')) return '';
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return '';
  if (trimmed.endsWith('.lock')) return '';
  return trimmed;
}

/**
 * Wrap text in a Markdown code span that survives whatever backticks the text
 * contains — the delimiter grows past the longest run inside, and a space is
 * padded in when the text starts or ends with one (CommonMark strips a single
 * leading and trailing space when both are present).
 *
 * Adapting the delimiter rather than stripping the content, because a backtick
 * is legal in a git ref: deleting it would turn ``feature/foo`bar`` into
 * `feature/foobar`, a different branch that may well exist.
 */
function codeSpan(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function safeDeploymentHost(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > 253) return '';
  let host = trimmed;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      host = new URL(trimmed).host;
    }
  } catch {
    return '';
  }
  return SAFE_HOSTNAME.test(host) ? host : '';
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    const secret = process.env.VERCEL_WEBHOOK_SECRET;
    if (!secret) {
      json(res, 503, { error: 'Webhook not configured' });
      return;
    }

    const raw = await readBody(req);
    const sig = req.headers['x-vercel-signature'];
    if (
      !verifyVercelSignature(raw, Array.isArray(sig) ? sig[0] : sig, secret)
    ) {
      json(res, 401, { error: 'Invalid signature' });
      return;
    }

    const event = JSON.parse(raw) as DeploymentWebhook;
    if (!event.type || !FAILURE_TYPES.has(event.type)) {
      json(res, 200, { ignored: true });
      return;
    }

    const dep = event.payload?.deployment ?? {};
    const name = safeIdentifier(dep.name ?? event.payload?.name, 'project');
    const depId = safeIdentifier(dep.id, '', 120);
    const depUrl = safeDeploymentHost(dep.url ?? event.payload?.url);
    const sha = safeSha(dep.meta?.githubCommitSha);
    const ref = displayRef(dep.meta?.githubCommitRef);
    // The ref as git spells it, for the fingerprint ONLY — folding a branch's
    // failures together must not depend on its name surviving a filter written
    // for rendered text. Safe because this value is hashed and never emitted;
    // `ref` above is what reaches the title and body.
    const refKey = trimRef(dep.meta?.githubCommitRef).slice(0, 500);
    const shortSha = sha.slice(0, 7);

    // The title names the same unit the fingerprint dedupes on (see below), so
    // an issue's heading never goes stale against the failures folded into it.
    // The commit that happened to fail first is in the body, not here.
    const scope = ref || shortSha;
    const title = `[auto-fix] Build failed: ${name}${scope ? ` (${scope})` : ''}`.slice(
      0,
      200,
    );
    const body = [
      '**Source:** build (Vercel deployment webhook)',
      `**Event:** \`${event.type}\``,
      `**Project:** \`${name}\``,
      ref ? `**Branch:** ${codeSpan(ref)}` : '',
      sha ? `**Commit:** \`${sha}\`` : '',
      depId ? `**Deployment:** \`${depId}\`` : '',
      depUrl ? `**URL:** https://${depUrl}` : '',
      '',
      '_Pull the failing build logs via the Vercel MCP `get_deployment_build_logs` tool using the deployment id above, find the failing step, and open a fix PR._',
    ]
      .filter(Boolean)
      .join('\n');

    await reportError({
      source: 'build',
      title,
      // Keyed on the BRANCH, not the commit. A build failure is not a
      // recurring condition the way a runtime error is — it is one breakage
      // that stays broken until someone fixes it, and every re-deploy while it
      // is broken is the same breakage at a new sha. Keying on the sha (which
      // survives fingerprint()'s normaliser, being hex rather than a long run
      // of digits) filed a fresh issue for each of those, and since every
      // `auto-fix` issue is picked up by a fix-agent trigger, a fix attempt
      // that failed to build filed another one. The queue grew from the
      // mechanism meant to drain it.
      //
      // Not `['build', name]` either: that is one key for the project's whole
      // lifetime, so the first open issue would silently swallow every later
      // and unrelated build failure. The branch is the unit that closes — when
      // the issue is closed the search below stops matching, so the next
      // failure on that branch files afresh.
      //
      // `fingerprintIdentity`, not `fingerprint`: every part of this key is an
      // identifier, and the volatility normaliser built for error text would
      // merge `release/2025` with `release/2026` and `fix/1234` with
      // `fix/5678` — reintroducing the swallowing this key exists to avoid.
      fingerprint: fingerprintIdentity([
        'build',
        name,
        refKey || shortSha || depId,
      ]),
      body,
    });

    json(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autofix] deploy-hook handler error: ${message}`);
    if (!res.headersSent) json(res, 200, { ok: false });
  }
}
