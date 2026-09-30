/**
 * Record one scheduled run's token usage through the Kinetix API — the last
 * step of every routine, so the tiered rollout's cost can be read per tier and
 * workflow next to its accuracy (scripts/benchmark-agent-tiers.ts).
 *
 * Counts are summed from the runner's own transcript, never self-reported by
 * the model:
 *
 * - Claude Code: the session `*.jsonl` under ~/.claude/projects (or
 *   $CLAUDE_CONFIG_DIR/projects), plus its subagent transcripts. One API
 *   response is written as several lines that repeat the same `usage`, so
 *   usage is de-duplicated by `message.id` — summing lines double-counts.
 * - Codex: the `rollout-*.jsonl` under ~/.codex/sessions (or
 *   $CODEX_HOME/sessions). Its `token_count` events carry a cumulative total,
 *   so the last one is the run's usage. Codex counts cached input inside
 *   `input_tokens`; it is moved to cache reads so both runtimes mean the same.
 *
 * The capability tier is not sent: the server snapshots it from the agent row.
 * Re-running the helper in the same session updates that session's row.
 *
 * Required env:
 *   KINETIX_BASE_URL  — e.g. https://kinetix.app
 *   KINETIX_TOKEN     — revocable agent token (prefix "kxat_")
 *
 * Optional env:
 *   KINETIX_AGENT_DRY_RUN — when "1", prints the row it would send and exits 0.
 *
 * The transcript is the invoking session's own when the runner exposes its id
 * (CLAUDE_CODE_SESSION_ID; CODEX_SESSION_ID or CODEX_THREAD_ID). Otherwise the
 * newest one is used only if no other transcript is active, so a concurrent
 * run on the same machine is never logged under this agent.
 *
 * Usage:
 *   npx tsx scripts/kinetix-log-run-usage.ts \
 *     --workflow <producer|escalation|adjudication|evaluator|extraction|other> \
 *     [--runtime <claude-code|codex>] \
 *     [--transcript <path/to/session.jsonl>] \
 *     [--notes "<one line>"]
 */
import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { kinetixApi } from './kinetix-http';
import { AGENT_RUN_RUNTIMES, AGENT_RUN_WORKFLOWS } from '../api/_lib/schemas';

type Runtime = (typeof AGENT_RUN_RUNTIMES)[number];
type Workflow = (typeof AGENT_RUN_WORKFLOWS)[number];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface RunUsage extends TokenCounts {
  /** The main session's model — the run's headline model. */
  model: string | null;
  sessionId: string | null;
  startedAt: string | null;
  /**
   * The same totals split by the model that spent them, so a subagent on a
   * cheaper model is priced at its own rate rather than the main model's.
   */
  modelUsage: Record<string, TokenCounts>;
  /** Usage records read; zero means the transcript held no usage at all. */
  samples: number;
}

const UNKNOWN_MODEL = 'unknown';

const emptyCounts = (): TokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (obj && typeof obj === 'object')
        out.push(obj as Record<string, unknown>);
    } catch {
      // tolerate a partially written last line
    }
  }
  return out;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * Sum Claude Code usage over a session transcript and its subagent
 * transcripts. `texts[0]` is the main session file; it supplies the session
 * id, start time and model.
 */
export function sumClaudeUsage(texts: string[]): RunUsage {
  const byMessage = new Map<
    string,
    { model: string; usage: Record<string, unknown> }
  >();
  const models = new Map<string, number>();
  let anonymous = 0;
  let sessionId: string | null = null;
  let startedAt: string | null = null;

  texts.forEach((text, fileIndex) => {
    for (const rec of parseLines(text)) {
      if (fileIndex === 0) {
        if (!sessionId && typeof rec.sessionId === 'string')
          sessionId = rec.sessionId;
        if (!startedAt && typeof rec.timestamp === 'string')
          startedAt = rec.timestamp;
      }
      if (rec.type !== 'assistant') continue;
      const message = rec.message as
        | { id?: string; model?: string; usage?: Record<string, unknown> }
        | undefined;
      // A `<synthetic>` message is written locally, not by an API call, so it
      // cost nothing and says nothing about the model.
      if (!message?.usage || message.model === '<synthetic>') continue;
      // Each content block of one response is its own line repeating the
      // response's usage; keep one per message id (the last, most complete).
      byMessage.set(message.id ?? `anon-${anonymous++}`, {
        model: message.model || UNKNOWN_MODEL,
        usage: message.usage,
      });
      if (fileIndex === 0 && message.model) {
        models.set(message.model, (models.get(message.model) ?? 0) + 1);
      }
    }
  });

  const usage: RunUsage = {
    model: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    sessionId,
    startedAt,
    ...emptyCounts(),
    modelUsage: {},
    samples: byMessage.size,
  };
  for (const { model, usage: u } of byMessage.values()) {
    const bucket = (usage.modelUsage[model] ??= emptyCounts());
    const add: TokenCounts = {
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheCreationTokens: count(u.cache_creation_input_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens),
    };
    for (const k of Object.keys(add) as (keyof TokenCounts)[]) {
      bucket[k] += add[k];
      usage[k] += add[k];
    }
  }
  return usage;
}

/** Read a Codex rollout: the last cumulative `token_count` is the run total. */
export function sumCodexUsage(text: string): RunUsage {
  let model: string | null = null;
  let sessionId: string | null = null;
  let startedAt: string | null = null;
  let total: Record<string, unknown> | null = null;

  for (const rec of parseLines(text)) {
    if (!startedAt && typeof rec.timestamp === 'string')
      startedAt = rec.timestamp;
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (rec.type === 'session_meta' && typeof payload.id === 'string') {
      sessionId = payload.id;
    } else if (
      rec.type === 'turn_context' &&
      typeof payload.model === 'string'
    ) {
      model = payload.model;
    } else if (rec.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info as {
        total_token_usage?: Record<string, unknown>;
      } | null;
      if (info?.total_token_usage) total = info.total_token_usage;
    }
  }

  const input = count(total?.input_tokens);
  const cached = Math.min(count(total?.cached_input_tokens), input);
  const counts: TokenCounts = {
    inputTokens: input - cached,
    // OpenAI output_tokens already include reasoning tokens.
    outputTokens: count(total?.output_tokens),
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
  };
  return {
    model,
    sessionId,
    startedAt,
    ...counts,
    modelUsage: total ? { [model ?? UNKNOWN_MODEL]: { ...counts } } : {},
    samples: total ? 1 : 0,
  };
}

export interface TranscriptCandidate {
  file: string;
  mtime: number;
}

function listFiles(
  dir: string,
  match: (name: string) => boolean,
  maxDepth: number,
): TranscriptCandidate[] {
  if (!existsSync(dir)) return [];
  const out: TranscriptCandidate[] = [];
  const walk = (d: string, depth: number): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (entry.isFile() && match(entry.name)) {
        out.push({ file: p, mtime: statSync(p).mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** Another transcript written this recently may belong to a concurrent run. */
export const CONCURRENT_WINDOW_MS = 10 * 60_000;

/**
 * Pick the transcript of the run that invoked the helper.
 *
 * Bound to the invoking session whenever the runner exposes its id (Claude
 * Code sets CLAUDE_CODE_SESSION_ID for its tools; a Codex id is used when
 * present). Without one, the newest transcript is only trusted when no other
 * transcript was written within CONCURRENT_WINDOW_MS: with two runs active on
 * one machine, the newest file may be the other run's, and logging it would
 * charge its tokens to this agent. That case fails instead, asking for
 * --transcript.
 */
export function selectTranscript(args: {
  runtime: Runtime | undefined;
  claude: TranscriptCandidate[];
  codex: TranscriptCandidate[];
  claudeSessionId?: string;
  codexSessionId?: string;
  now: number;
}): { runtime: Runtime; file: string } | { error: string } {
  const { runtime, now } = args;
  // A session id the runner exposed is authoritative: if its transcript is
  // missing, fail rather than fall back to the machine-wide pool, which could
  // hold a concurrent run's transcript.
  const bound: {
    runtime: Runtime;
    id: string;
    list: TranscriptCandidate[];
    match: (f: string) => boolean;
  }[] = [];
  if (runtime !== 'codex' && args.claudeSessionId) {
    const id = args.claudeSessionId;
    bound.push({
      runtime: 'claude-code',
      id,
      list: args.claude,
      match: (f) => path.basename(f) === `${id}.jsonl`,
    });
  }
  if (runtime !== 'claude-code' && args.codexSessionId) {
    const id = args.codexSessionId;
    bound.push({
      runtime: 'codex',
      id,
      list: args.codex,
      match: (f) => path.basename(f).includes(id),
    });
  }
  for (const b of bound) {
    const own = b.list.find((c) => b.match(c.file));
    if (own) return { runtime: b.runtime, file: own.file };
  }
  if (bound.length > 0) {
    return {
      error: `no transcript for the invoking session (${bound
        .map((b) => b.id)
        .join(', ')}); pass --transcript <path>`,
    };
  }
  const pool = [
    ...(runtime === 'codex'
      ? []
      : args.claude.map((c) => ({ ...c, runtime: 'claude-code' as const }))),
    ...(runtime === 'claude-code'
      ? []
      : args.codex.map((c) => ({ ...c, runtime: 'codex' as const }))),
  ].sort((a, b) => b.mtime - a.mtime);
  const [newest, next] = pool;
  if (!newest) {
    return { error: 'no transcript found; pass --transcript <path>' };
  }
  if (next && now - next.mtime < CONCURRENT_WINDOW_MS) {
    return {
      error:
        'several transcripts are active, so this run cannot be told apart from a concurrent one; pass --transcript <path>',
    };
  }
  return { runtime: newest.runtime, file: newest.file };
}

function claudeProjectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
}

function codexSessionsDir(): string {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions');
}

/** Main Claude transcripts sit directly in a project dir (depth 1). */
const claudeTranscripts = () =>
  listFiles(claudeProjectsDir(), (n) => n.endsWith('.jsonl'), 1);
const codexTranscripts = () =>
  listFiles(
    codexSessionsDir(),
    (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    4,
  );

/** Every *.jsonl in the session's sibling directory (subagent transcripts). */
function claudeSidecars(mainFile: string): string[] {
  const dir = mainFile.replace(/\.jsonl$/, '');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function die(msg: string): never {
  console.error(`[kinetix-log-run-usage] ${msg}`);
  process.exit(1);
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (!tok.startsWith('--')) die(`unexpected positional argument: ${tok}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--'))
      die(`flag ${tok} requires a value`);
    out[tok.slice(2)] = next;
    i++;
  }
  return out;
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));

  const workflow = flags['workflow'] as Workflow | undefined;
  if (!workflow || !AGENT_RUN_WORKFLOWS.includes(workflow)) {
    die(`--workflow must be one of ${AGENT_RUN_WORKFLOWS.join('|')}`);
  }
  let runtime = flags['runtime'] as Runtime | undefined;
  if (runtime && !AGENT_RUN_RUNTIMES.includes(runtime)) {
    die(`--runtime must be one of ${AGENT_RUN_RUNTIMES.join('|')}`);
  }

  let transcript = flags['transcript'];
  if (transcript) {
    if (!existsSync(transcript)) die(`transcript not found: ${transcript}`);
    runtime ??= path.basename(transcript).startsWith('rollout-')
      ? 'codex'
      : 'claude-code';
  } else {
    const picked = selectTranscript({
      runtime,
      claude: runtime === 'codex' ? [] : claudeTranscripts(),
      codex: runtime === 'claude-code' ? [] : codexTranscripts(),
      claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
      codexSessionId:
        process.env.CODEX_SESSION_ID ||
        process.env.CODEX_THREAD_ID ||
        undefined,
      now: Date.now(),
    });
    if ('error' in picked) die(picked.error);
    runtime = picked.runtime;
    transcript = picked.file;
  }

  const usage =
    runtime === 'codex'
      ? sumCodexUsage(readFileSync(transcript, 'utf8'))
      : sumClaudeUsage(
          [transcript, ...claudeSidecars(transcript)].map((f) =>
            readFileSync(f, 'utf8'),
          ),
        );
  // A transcript with no usage record is unreadable, not free: posting zeros
  // would enter the report as a priced $0 run and pull cost averages down.
  if (usage.samples === 0) {
    die(`no token usage found in ${transcript}; not logging a zero-cost run`);
  }
  const sessionId =
    usage.sessionId ?? path.basename(transcript).replace(/\.jsonl$/, '');
  const startedMs = usage.startedAt ? Date.parse(usage.startedAt) : NaN;

  const row = {
    workflow,
    runtime,
    model: usage.model ? usage.model.slice(0, 80) : null,
    sessionId: sessionId.slice(0, 128),
    startedAt: Number.isFinite(startedMs)
      ? new Date(startedMs).toISOString()
      : null,
    durationMs: Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelUsage: usage.modelUsage,
    notes: flags['notes'] || null,
  };

  if (process.env.KINETIX_AGENT_DRY_RUN === '1') {
    console.error(
      `[dry-run] agent_run_usage API request: ${JSON.stringify(row)}`,
    );
    return;
  }
  if (!process.env.KINETIX_BASE_URL) die('KINETIX_BASE_URL is required');
  if (!process.env.KINETIX_TOKEN)
    die('KINETIX_TOKEN is required (a kxat_ agent token)');

  const result = kinetixApi('POST', '/api/agent-run-usage', row);
  if (!result.ok) die(`error: ${result.body}`);
  let parsed: { id?: number; modelTier?: string | null };
  try {
    parsed = JSON.parse(result.body) as typeof parsed;
  } catch {
    die(`unexpected non-JSON response: ${result.body.slice(0, 200)}`);
  }
  const total =
    row.inputTokens +
    row.outputTokens +
    row.cacheCreationTokens +
    row.cacheReadTokens;
  console.log(
    `agent_run_usage.id=${parsed.id} tier=${parsed.modelTier ?? 'unclassified'} workflow=${workflow} runtime=${runtime} total_tokens=${total}`,
  );
}

// Run only as a CLI; importing for tests must not read transcripts or post.
// pathToFileURL, not a `file://` template: the local workers run on Windows,
// where the template never equals import.meta.url and the helper would exit 0
// having logged nothing.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
