/**
 * The §5.1 acknowledgement record.
 *
 * These cases pin the three scoping rules, because each one is a way a reviewer's
 * decision could silently admit a curve it was never made about — which is the
 * failure mode the gate exists to prevent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgementKey,
  hasAcknowledgement,
  useModelAcknowledgementStore,
} from './modelAcknowledgementStore';

const VERSION = 'evidence-fingerprint-1';

const records = () => useModelAcknowledgementStore.getState().acknowledgements;

describe('modelAcknowledgementStore', () => {
  beforeEach(() => {
    useModelAcknowledgementStore.getState().clear();
  });

  it('records an acknowledgement this viewer can then be asked about', () => {
    useModelAcknowledgementStore.getState().acknowledge('thc-derived-v1', VERSION, 7);
    expect(hasAcknowledgement(records(), 'thc-derived-v1', VERSION, 7)).toBe(true);
  });

  it('does not carry across models', () => {
    useModelAcknowledgementStore.getState().acknowledge('thc-derived-v1', VERSION, 7);
    expect(hasAcknowledgement(records(), 'mdma-derived-v1', VERSION, 7)).toBe(false);
  });

  it('does not survive a change to the evidence it was given for', () => {
    // The load-bearing one. A regenerated artifact can change the grade facts, and a
    // scorer change can change the grade, without either touching the release
    // checksum — `derivedGrades` sits deliberately outside it. Keying on the
    // evidence fingerprint means the reviewer is asked again rather than assumed to
    // still agree with a disclosure they never saw.
    useModelAcknowledgementStore.getState().acknowledge('thc-derived-v1', VERSION, 7);
    expect(
      hasAcknowledgement(records(), 'thc-derived-v1', 'evidence-fingerprint-2', 7),
    ).toBe(false);
  });

  it('does not carry from one reviewer to another on a shared browser', () => {
    useModelAcknowledgementStore.getState().acknowledge('thc-derived-v1', VERSION, 7);
    expect(hasAcknowledgement(records(), 'thc-derived-v1', VERSION, 9)).toBe(false);
    expect(hasAcknowledgement(records(), 'thc-derived-v1', VERSION, null)).toBe(false);
  });

  it('withdraws cleanly, and withdrawing an absent record is a no-op', () => {
    const store = useModelAcknowledgementStore.getState();
    store.acknowledge('thc-derived-v1', VERSION, 7);
    store.withdraw('thc-derived-v1', VERSION, 7);
    expect(hasAcknowledgement(records(), 'thc-derived-v1', VERSION, 7)).toBe(false);

    const before = records();
    store.withdraw('never-acknowledged', VERSION, 7);
    expect(records()).toBe(before);
  });

  it('records the acting user and the moment, not just the fact', () => {
    useModelAcknowledgementStore.getState().acknowledge('thc-derived-v1', VERSION, 7);
    const record = records()[acknowledgementKey('thc-derived-v1', VERSION, 7)];
    expect(record).toMatchObject({ modelId: 'thc-derived-v1', version: VERSION, userId: 7 });
    expect(Number.isNaN(Date.parse(record!.at))).toBe(false);
  });

  it('cannot be forged by a model id that imitates the key separator', () => {
    // The keys are JSON-encoded rather than joined, so no component value can
    // impersonate a different (model, evidence version, viewer) triple by containing the
    // separator. A joined key would make these two collide.
    expect(acknowledgementKey('a", "b', VERSION, 7)).not.toBe(
      acknowledgementKey('a', `b", "${VERSION}`, 7),
    );
  });
});
