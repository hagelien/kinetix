/**
 * Pre-cycle learning input for the shared cross-agent lessons ledger
 * (see agents/cross-agent-learning-protocol.md).
 *
 * Emits a single JSON object:
 *   {
 *     priorLedger: string | null,   // agent_notes of the most recent
 *                                    // rejection_review row — the standing
 *                                    // cumulative ledger to carry forward.
 *     rejections:  Row[]            // every agent-submitted edit rejected
 *                                    // since the ledger watermark.
 *   }
 *
 * Two deliberate changes from the original per-agent scan:
 *   1. Rejections from ALL agents feed the ledger (join `agents`), not just
 *      the agent currently running — a lesson learned from one agent's
 *      rejection must benefit every agent.
 *   2. The prior ledger is returned so the cycle rewrites the FULL merged
 *      ledger rather than dropping older lessons once the watermark advances.
 *
 * The helper reads through /api/agent-rejection-scan with the revocable
 * KINETIX_TOKEN, so scheduled LLM routines do not need direct DATABASE_URL
 * access.
 */
import 'dotenv/config';
import { kinetixApi } from './kinetix-http';

const baseUrl = process.env.KINETIX_BASE_URL;
if (!baseUrl) {
  console.error('[rejection-scan] KINETIX_BASE_URL is required');
  process.exit(1);
}

const token = process.env.KINETIX_TOKEN;
if (!token) {
  console.error('[rejection-scan] KINETIX_TOKEN is required (a kxat_ agent token)');
  process.exit(1);
}

// Delegate the HTTP to scripts/kinetix-api.sh (curl) so the request uses the
// same proxied egress path as the rest of the routine — see scripts/kinetix-http.ts.
const result = kinetixApi('GET', '/api/agent-rejection-scan');
if (!result.ok) {
  console.error(`[rejection-scan] error: ${result.body}`);
  process.exit(1);
}

console.log(result.body);
