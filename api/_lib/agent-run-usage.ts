/**
 * Write path for `agent_run_usage` (POST /api/agent-run-usage).
 *
 * The capability tier is a subquery on `agents.model_tier` evaluated inside
 * the write, never a request value — the same snapshot rule as
 * `agent_verifications.verifier_tier`. Re-logging an (agent, session) updates
 * only that run's counts, so a retry neither counts the run twice nor moves
 * it: the tier snapshot, workflow and created_at stay those of the first
 * write, even if the identity was reclassified in between.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb } from './db.js';
import type { createAgentRunUsageSchema } from './schemas.js';
import { agentRunUsage, agents } from '../../db/schema.js';

export type AgentRunUsageInput = z.infer<typeof createAgentRunUsageSchema>;

export async function recordAgentRunUsage(args: {
  agentId: number;
  userId: number;
  data: AgentRunUsageInput;
}): Promise<{ id: number; modelTier: string | null } | null> {
  const { agentId, userId, data: d } = args;
  const values = {
    agentId,
    createdBy: userId,
    modelTier: sql`(select ${agents.modelTier} from ${agents} where ${agents.id} = ${agentId})`,
    workflow: d.workflow,
    runtime: d.runtime,
    model: d.model ?? null,
    sessionId: d.sessionId ?? null,
    startedAt: d.startedAt ? new Date(d.startedAt) : null,
    durationMs: d.durationMs ?? null,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheCreationTokens: d.cacheCreationTokens,
    cacheReadTokens: d.cacheReadTokens,
    modelUsage: d.modelUsage ?? null,
    notes: d.notes ?? null,
  };

  const [row] = await getDb()
    .insert(agentRunUsage)
    .values(values)
    .onConflictDoUpdate({
      target: [agentRunUsage.agentId, agentRunUsage.sessionId],
      set: {
        model: values.model,
        durationMs: values.durationMs,
        inputTokens: values.inputTokens,
        outputTokens: values.outputTokens,
        cacheCreationTokens: values.cacheCreationTokens,
        cacheReadTokens: values.cacheReadTokens,
        modelUsage: values.modelUsage,
        notes: values.notes,
      },
    })
    .returning({ id: agentRunUsage.id, modelTier: agentRunUsage.modelTier });

  return row ? { id: row.id, modelTier: row.modelTier ?? null } : null;
}
