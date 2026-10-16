import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARKER_TTL_MS,
  markerDir,
  markerPath,
  planRelog,
  readMarker,
  consumeMarker,
  RELOG_WINDOW_MS,
  safeSessionId,
  writeMarker,
} from '../../scripts/lib/run-usage-marker.mjs';
import { closingInferenceMarker } from '../../scripts/kinetix-log-run-usage.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'run-usage-marker-'));

const marker = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  sessionId: 'sess-1',
  workflow: 'producer',
  runtime: 'claude-code',
  transcript: '/home/r/.claude/projects/p/sess-1.jsonl',
  notes: null,
  cwd: '/repo',
  loggedAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

describe('markerDir', () => {
  it('sits under the Claude config dir, outside the repository', () => {
    expect(markerDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe(
      path.join('/cfg', 'kinetix-run-usage'),
    );
    expect(markerDir({})).toBe(
      path.join(os.homedir(), '.claude', 'kinetix-run-usage'),
    );
    expect(
      markerDir({ CLAUDE_CONFIG_DIR: '/cfg', KINETIX_RUN_USAGE_MARKER_DIR: '/x' }),
    ).toBe('/x');
  });
});

describe('safeSessionId', () => {
  it('keeps a session id from naming a path outside the marker dir', () => {
    expect(safeSessionId('0b6f-11aa')).toBe('0b6f-11aa');
    expect(safeSessionId('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeSessionId('..')).toBeNull();
    expect(safeSessionId('  ')).toBeNull();
    expect(safeSessionId(42)).toBeNull();
    expect(path.dirname(markerPath('../../x', { KINETIX_RUN_USAGE_MARKER_DIR: '/m' })!)).toBe(path.normalize('/m'));
  });
});

describe('writeMarker / readMarker', () => {
  it('round-trips a marker keyed by the session id', () => {
    const env = { KINETIX_RUN_USAGE_MARKER_DIR: tmp() };
    const file = writeMarker('sess-1', marker(), { env });
    expect(file).toBe(path.join(env.KINETIX_RUN_USAGE_MARKER_DIR, 'sess-1.json'));
    expect(readMarker('sess-1', env)).toEqual(marker());
    expect(readMarker('sess-2', env)).toBeNull();
    // No temporary file is left behind.
    expect(readdirSync(env.KINETIX_RUN_USAGE_MARKER_DIR)).toEqual(['sess-1.json']);
  });

  it('reads an unparseable or foreign-version marker as no marker', () => {
    const dir = tmp();
    const env = { KINETIX_RUN_USAGE_MARKER_DIR: dir };
    writeFileSync(path.join(dir, 'torn.json'), '{"version":1,"sess');
    writeFileSync(
      path.join(dir, 'old.json'),
      JSON.stringify(marker({ version: 0 })),
    );
    writeFileSync(
      path.join(dir, 'partial.json'),
      JSON.stringify({ ...marker(), transcript: undefined }),
    );
    expect(readMarker('torn', env)).toBeNull();
    expect(readMarker('old', env)).toBeNull();
    expect(readMarker('partial', env)).toBeNull();
  });

  it('prunes stale markers when a new one is written', () => {
    const dir = tmp();
    const env = { KINETIX_RUN_USAGE_MARKER_DIR: dir };
    const now = Date.now();
    writeMarker('stale', marker(), { env });
    writeMarker('fresh', marker(), { env });
    const old = (now - MARKER_TTL_MS - 60_000) / 1000;
    utimesSync(path.join(dir, 'stale.json'), old, old);
    writeMarker('new', marker(), { env, now });
    expect(existsSync(path.join(dir, 'stale.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'fresh.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'new.json'))).toBe(true);
  });
});

describe('planRelog', () => {
  // Five minutes after the marker was logged: the closing turn.
  const NOW = Date.parse('2026-10-14T10:05:00.000Z');

  it('re-logs a marked Claude Code session with the flags it logged with', () => {
    expect(
      planRelog({ session_id: 'sess-1' }, marker({ notes: 'cycle 7' }), NOW),
    ).toEqual({
      relog: true,
      cwd: '/repo',
      args: [
        '--workflow',
        'producer',
        '--runtime',
        'claude-code',
        '--transcript',
        '/home/r/.claude/projects/p/sess-1.jsonl',
        '--notes',
        'cycle 7',
      ],
    });
  });

  it('omits --notes when the run logged none', () => {
    const plan = planRelog({ session_id: 'sess-1' }, marker(), NOW);
    expect(plan.relog && plan.args).not.toContain('--notes');
  });

  it('does nothing for a session without a marker (developer sessions)', () => {
    expect(planRelog({ session_id: 'dev' }, null, NOW)).toEqual({
      relog: false,
      reason: 'no marker',
    });
  });

  it('does nothing without a usable session id', () => {
    expect(planRelog(null, marker(), NOW).relog).toBe(false);
    expect(planRelog({}, marker(), NOW).relog).toBe(false);
    expect(planRelog('garbage', marker(), NOW).relog).toBe(false);
  });

  it('leaves a non-Claude Code marker alone', () => {
    expect(
      planRelog({ session_id: 'sess-1' }, marker({ runtime: 'codex' }), NOW).relog,
    ).toBe(false);
  });

  it('refuses a marker logged longer ago than the closing turn can be', () => {
    // A follow-up or resumed session long after the run must not fold its
    // work into the logged run.
    const later = Date.parse('2026-10-14T10:00:00.000Z') + RELOG_WINDOW_MS + 1;
    expect(planRelog({ session_id: 'sess-1' }, marker(), later)).toEqual({
      relog: false,
      reason: 'marker expired',
    });
  });
});

describe('consumeMarker', () => {
  it('hands the marker out once and removes it', () => {
    const env = { KINETIX_RUN_USAGE_MARKER_DIR: tmp() };
    writeMarker('sess-1', marker(), { env });

    expect(consumeMarker('sess-1', env)).toEqual(marker());
    // The next Stop in the same session is later work, not the run's.
    expect(consumeMarker('sess-1', env)).toBeNull();
    expect(readMarker('sess-1', env)).toBeNull();
  });

  it('returns null when there is no marker', () => {
    expect(consumeMarker('none', { KINETIX_RUN_USAGE_MARKER_DIR: tmp() })).toBeNull();
  });
});

describe('closingInferenceMarker', () => {
  const base = {
    runtime: 'claude-code' as const,
    isRelog: false,
    runnerSessionId: 'runner-id',
    sessionId: 'transcript-id',
    workflow: 'producer' as const,
    transcript: '/t/transcript-id.jsonl',
    notes: null,
    cwd: '/repo',
    now: new Date('2026-10-14T10:00:00.000Z'),
  };

  it('keys the marker by the id the Stop hook is given', () => {
    expect(closingInferenceMarker(base)).toEqual({
      key: 'runner-id',
      marker: {
        version: 1,
        sessionId: 'transcript-id',
        workflow: 'producer',
        runtime: 'claude-code',
        transcript: '/t/transcript-id.jsonl',
        notes: null,
        cwd: '/repo',
        loggedAt: '2026-10-14T10:00:00.000Z',
      },
    });
    expect(
      closingInferenceMarker({ ...base, runnerSessionId: undefined })?.key,
    ).toBe('transcript-id');
  });

  it('writes none for Codex (no Stop hook) or for the hook’s own re-log', () => {
    expect(closingInferenceMarker({ ...base, runtime: 'codex' })).toBeNull();
    expect(closingInferenceMarker({ ...base, isRelog: true })).toBeNull();
  });
});

describe('relog-run-usage Stop hook', () => {
  const runHook = (stdin: string, env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [path.resolve('.claude/hooks/relog-run-usage.mjs')],
      {
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, KINETIX_RUN_USAGE_RELOG: '', ...env },
        timeout: 60_000,
      },
    );

  it('exits 0 silently for a session without a marker', () => {
    const result = runHook(JSON.stringify({ session_id: 'dev-session' }), {
      KINETIX_RUN_USAGE_MARKER_DIR: tmp(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits 0 on a malformed payload', () => {
    const result = runHook('not json', { KINETIX_RUN_USAGE_MARKER_DIR: tmp() });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('re-runs the logger on the marked transcript and still exits 0 when it fails', () => {
    const dir = tmp();
    const transcript = path.join(dir, 'sess-1.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-10-14T10:00:00.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 50 },
        },
      }),
    );
    const env = { KINETIX_RUN_USAGE_MARKER_DIR: path.join(dir, 'markers') };
    const fresh = () =>
      marker({ transcript, cwd: process.cwd(), loggedAt: new Date().toISOString() });
    writeMarker('sess-1', fresh(), { env });
    const stdin = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: transcript,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });

    const dry = runHook(stdin, { ...env, KINETIX_AGENT_DRY_RUN: '1' });
    expect(dry.status).toBe(0);
    // Nothing on stdout: a Stop hook's stdout could be read as a decision.
    expect(dry.stdout).toBe('');
    expect(dry.stderr).toContain('[dry-run] agent_run_usage API request');
    expect(dry.stderr).toContain('"sessionId":"sess-1"');
    // Consumed: a later Stop in the same session re-logs nothing.
    expect(readMarker('sess-1', env)).toBeNull();
    const again = runHook(stdin, { ...env, KINETIX_AGENT_DRY_RUN: '1' });
    expect(again.status).toBe(0);
    expect(again.stderr).toBe('');

    writeMarker('sess-1', fresh(), { env });

    const failing = runHook(stdin, {
      ...env,
      KINETIX_AGENT_DRY_RUN: '',
      KINETIX_BASE_URL: '',
      KINETIX_TOKEN: '',
    });
    expect(failing.status).toBe(0);
    expect(failing.stdout).toBe('');
    expect(failing.stderr).toContain('exit 1');
    // Two logger runs through tsx: allow for a loaded CI runner.
  }, 120_000);
});
