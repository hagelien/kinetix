import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import {
  CrossOriginRequestError,
  RequestBodyTooLargeError,
} from './validate.js';
import { isDatabaseUnavailableError } from './db-errors.js';

export function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  init?: { headers?: OutgoingHttpHeaders },
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...(init?.headers ?? {}),
  });
  res.end(JSON.stringify(data));
}

export function publicCacheHeaders(options?: {
  sMaxAge?: number;
  staleWhileRevalidate?: number;
}): OutgoingHttpHeaders {
  const sMaxAge = options?.sMaxAge ?? 60;
  const staleWhileRevalidate = options?.staleWhileRevalidate ?? 600;

  return {
    'Cache-Control':
      `public, max-age=0, s-maxage=${sMaxAge}, ` +
      `stale-while-revalidate=${staleWhileRevalidate}`,
  };
}

export function noStoreHeaders(): OutgoingHttpHeaders {
  return {
    'Cache-Control': 'no-store',
  };
}

export function error(
  res: ServerResponse,
  status: number,
  message: string,
  code?: string,
): void {
  // `code` is a stable, locale-independent identifier the client can map
  // to a translated string at the React boundary (AGENTS.md i18n rule).
  // `message` stays English prose for log/debug surfaces and as a
  // fallback when the client doesn't recognise the code.
  json(res, status, code ? { error: message, code } : { error: message });
}

/**
 * Wrap a handler with top-level error catching so uncaught exceptions
 * (e.g. missing env vars) return proper JSON errors instead of Vercel's HTML error page.
 */
export function withErrorHandling(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        if (!res.headersSent) {
          error(res, 413, 'Request body too large');
        }
        return;
      }
      if (err instanceof CrossOriginRequestError) {
        if (!res.headersSent) {
          error(
            res,
            403,
            'Cross-origin API request rejected',
            'cross_origin_request_rejected',
          );
        }
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      // Log full error including cause (drizzle puts the real PG error there)
      // and stack, so we can actually debug failures in function logs.
      const cause = (err as { cause?: unknown })?.cause;
      const stack = err instanceof Error ? err.stack : undefined;
      // Database unavailability (connection failure, endpoint down, or the
      // stored Neon credentials no longer authenticating) is an infrastructure
      // outage, not an application bug: the driver nests it under `cause`, so
      // check both the top-level error and its cause. Surface it as a 503 so
      // clients treat it as transient, and tag the log record as
      // `infrastructure` so the drain skips filing an auto-fix issue no bot can
      // resolve (see api/vercel-log-drain.ts).
      const dbUnavailable =
        isDatabaseUnavailableError(err) || isDatabaseUnavailableError(cause);
      const status = dbUnavailable ? 503 : 500;
      // Single-line, stable-marker record so the Vercel log drain
      // (api/vercel-log-drain.ts) can pick this out of the firehose and file
      // an auto-fix issue. The KINETIX_ERROR prefix is the contract — keep it
      // in sync with ERROR_LOG_MARKER in api/_lib/autofix-issues.ts.
      console.error(
        'KINETIX_ERROR ' +
          JSON.stringify({
            level: 'error',
            route: req.url ?? null,
            method: req.method ?? null,
            status,
            category: dbUnavailable ? 'infrastructure' : 'application',
            message,
            cause:
              cause instanceof Error
                ? { message: cause.message, stack: cause.stack }
                : (cause ?? null),
            stack: stack ?? null,
            ts: new Date().toISOString(),
          }),
      );
      // Return JSON error if headers not yet sent. Keep the body generic —
      // never leak raw SQL / driver messages to the client. `code` is a stable
      // identifier the client maps to a translated message at the React
      // boundary (AGENTS.md i18n rule).
      if (!res.headersSent) {
        if (dbUnavailable) {
          error(
            res,
            503,
            'Service temporarily unavailable',
            'service_unavailable',
          );
        } else {
          error(res, 500, 'Internal server error');
        }
      }
    }
  };
}
