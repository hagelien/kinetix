import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_WINDOW_MS,
  selectTranscript,
  sumClaudeUsage,
  sumCodexUsage,
} from '../../scripts/kinetix-log-run-usage.ts';

const jsonl = (...records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join('\n');

const assistant = (
  id: string,
  usage: Record<string, number>,
  model = 'claude-sonnet-5',
) => ({
  type: 'assistant',
  sessionId: 'sess-main',
  timestamp: '2026-09-28T10:00:05.000Z',
  message: { id, model, usage },
});

describe('sumClaudeUsage', () => {
  it('counts each API response once even when its content blocks repeat the usage', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 100,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 5000,
    };
    const main = jsonl(
      {
        type: 'user',
        sessionId: 'sess-main',
        timestamp: '2026-09-28T10:00:00.000Z',
      },
      // One response written as three lines (thinking, text, tool_use).
      assistant('msg_1', usage),
      assistant('msg_1', usage),
      assistant('msg_1', usage),
      assistant('msg_2', {
        input_tokens: 1,
        output_tokens: 20,
        cache_read_input_tokens: 6000,
      }),
    );
    const counts = {
      inputTokens: 11,
      outputTokens: 120,
      cacheCreationTokens: 1000,
      cacheReadTokens: 11000,
    };
    expect(sumClaudeUsage([main])).toEqual({
      model: 'claude-sonnet-5',
      sessionId: 'sess-main',
      startedAt: '2026-09-28T10:00:00.000Z',
      ...counts,
      modelUsage: { 'claude-sonnet-5': counts },
      samples: 2,
    });
  });

  it('adds subagent transcripts but takes identity from the main session', () => {
    const main = jsonl(
      assistant('msg_1', { input_tokens: 5, output_tokens: 50 }),
    );
    const sub = jsonl({
      type: 'assistant',
      sessionId: 'sess-sub',
      timestamp: '2026-09-28T09:00:00.000Z',
      message: {
        id: 'msg_s1',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 7, output_tokens: 70 },
      },
    });
    const usage = sumClaudeUsage([main, sub]);
    expect(usage).toMatchObject({
      sessionId: 'sess-main',
      model: 'claude-sonnet-5',
      startedAt: '2026-09-28T10:00:05.000Z',
      inputTokens: 12,
      outputTokens: 120,
    });
    // Each model's share is kept apart so the subagent is priced at its own rate.
    expect(usage.modelUsage).toEqual({
      'claude-sonnet-5': {
        inputTokens: 5,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      'claude-haiku-4-5': {
        inputTokens: 7,
        outputTokens: 70,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    });
  });

  it('ignores synthetic (local, unbilled) messages and tolerates a torn last line', () => {
    const main =
      jsonl(
        assistant('msg_1', { output_tokens: 3 }, '<synthetic>'),
        assistant('msg_2', { output_tokens: 4 }),
      ) + '\n{"type":"assistant","mess';
    expect(sumClaudeUsage([main])).toMatchObject({
      model: 'claude-sonnet-5',
      outputTokens: 4,
      samples: 1,
    });
  });

  it('reports no samples for a transcript without usage', () => {
    expect(
      sumClaudeUsage([jsonl({ type: 'user', sessionId: 's' })]).samples,
    ).toBe(0);
  });
});

describe('sumCodexUsage', () => {
  const tokenCount = (input: number, cached: number, output: number) => ({
    type: 'event_msg',
    timestamp: '2026-09-28T10:05:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 10,
          total_tokens: input + output,
        },
      },
    },
  });

  it('takes the last cumulative total and moves cached input to cache reads', () => {
    const text = jsonl(
      {
        type: 'session_meta',
        timestamp: '2026-09-28T10:00:00.000Z',
        payload: { id: 'rollout-uuid' },
      },
      { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      tokenCount(1000, 600, 50),
      { type: 'event_msg', payload: { type: 'token_count', info: null } },
      tokenCount(5000, 4000, 300),
    );
    const counts = {
      inputTokens: 1000,
      outputTokens: 300,
      cacheCreationTokens: 0,
      cacheReadTokens: 4000,
    };
    expect(sumCodexUsage(text)).toEqual({
      model: 'gpt-5.6-terra',
      sessionId: 'rollout-uuid',
      startedAt: '2026-09-28T10:00:00.000Z',
      ...counts,
      modelUsage: { 'gpt-5.6-terra': counts },
      samples: 1,
    });
  });

  it('reports no samples when no token_count was written, so the CLI refuses to log', () => {
    expect(
      sumCodexUsage(jsonl({ type: 'session_meta', payload: { id: 'x' } })),
    ).toMatchObject({ samples: 0, modelUsage: {} });
  });
});

describe('kinetix-log-run-usage CLI', () => {
  const runCli = (fileName: string, contents: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'run-usage-'));
    const file = path.join(dir, fileName);
    writeFileSync(file, contents);
    return spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('scripts/kinetix-log-run-usage.ts'),
        '--workflow',
        'producer',
        '--transcript',
        file,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KINETIX_AGENT_DRY_RUN: '1' },
      },
    );
  };

  it('fails instead of logging a zero-cost run when the transcript has no usage', () => {
    const result = runCli(
      'rollout-empty.jsonl',
      jsonl({ type: 'session_meta', payload: { id: 'x' } }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no token usage found');
  });

  it('sends per-model usage for a readable transcript', () => {
    const result = runCli(
      'session.jsonl',
      jsonl(assistant('msg_1', { input_tokens: 5, output_tokens: 50 })),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"modelUsage":{"claude-sonnet-5"');
  });
});

describe('selectTranscript', () => {
  const now = 1_800_000_000_000;
  const mine = { file: '/p/proj/sess-mine.jsonl', mtime: now - 60_000 };
  const other = { file: '/p/proj/sess-other.jsonl', mtime: now - 1_000 };
  const old = { file: '/p/proj/sess-old.jsonl', mtime: now - 86_400_000 };

  it('reads the invoking session even when a concurrent one is newer', () => {
    expect(
      selectTranscript({
        runtime: undefined,
        claude: [mine, other],
        codex: [],
        claudeSessionId: 'sess-mine',
        now,
      }),
    ).toEqual({ runtime: 'claude-code', file: mine.file });
  });

  it('binds a Codex run by the id in its rollout name', () => {
    const rollout = {
      file: '/c/2026/09/29/rollout-2026-09-29T10-00-00-abc123.jsonl',
      mtime: now - 60_000,
    };
    expect(
      selectTranscript({
        runtime: 'codex',
        claude: [],
        codex: [rollout, { file: '/c/rollout-x-zzz.jsonl', mtime: now }],
        codexSessionId: 'abc123',
        now,
      }),
    ).toEqual({ runtime: 'codex', file: rollout.file });
  });

  it('fails rather than guess when two transcripts are active and no id is known', () => {
    const picked = selectTranscript({
      runtime: undefined,
      claude: [mine],
      codex: [{ file: '/c/rollout-a.jsonl', mtime: now - 2_000 }],
      now,
    });
    expect(picked).toHaveProperty('error');
    expect((picked as { error: string }).error).toContain('--transcript');
  });

  it('uses the newest transcript when no other one is active', () => {
    expect(
      selectTranscript({
        runtime: undefined,
        claude: [other, old],
        codex: [],
        now,
      }),
    ).toEqual({ runtime: 'claude-code', file: other.file });
    // A transcript last written just outside the window is not concurrent.
    expect(
      selectTranscript({
        runtime: undefined,
        claude: [
          other,
          { file: '/p/proj/b.jsonl', mtime: now - CONCURRENT_WINDOW_MS - 1 },
        ],
        codex: [],
        now,
      }),
    ).toEqual({ runtime: 'claude-code', file: other.file });
  });

  it('fails rather than fall back when the invoking session transcript is missing', () => {
    // Runtime inferred (the documented commands omit --runtime), and only one
    // other transcript on the machine: the concurrency guard alone would
    // accept it, so the bound session id must be what refuses.
    expect(
      selectTranscript({
        runtime: undefined,
        claude: [other],
        codex: [],
        claudeSessionId: 'sess-missing',
        now,
      }),
    ).toHaveProperty('error');
    expect(
      selectTranscript({
        runtime: undefined,
        claude: [],
        codex: [{ file: '/c/rollout-x-abc.jsonl', mtime: now }],
        codexSessionId: 'missing-id',
        now,
      }),
    ).toHaveProperty('error');
  });

  it('fails when the named runtime has no transcript for the session', () => {
    expect(
      selectTranscript({
        runtime: 'claude-code',
        claude: [other],
        codex: [],
        claudeSessionId: 'sess-missing',
        now,
      }),
    ).toHaveProperty('error');
  });
});
