/**
 * Saving while the curator is still typing.
 *
 * The editor stays usable during a save, so the request carries a snapshot
 * that can be out of date by the time it is answered. What must never happen
 * is the answer replacing newer work and then calling it saved — the screen
 * would show a case the curator did not write, marked as filed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { BENZODIAZEPINE_MODULE } from '@/lib/pattern/modules/benzodiazepines';
import { emptyPatternCase, resetPatternCaseStore, usePatternCaseStore } from './patternCaseStore';

const MODULES = [BENZODIAZEPINE_MODULE];

let release: (() => void) | undefined;

beforeEach(() => {
  usePatternCaseStore.setState({
    caseId: null,
    caseName: 'sak',
    data: emptyPatternCase('benzodiazepines'),
    status: 'idle',
    error: null,
    dirty: true,
  });
  vi.stubGlobal('fetch', () => {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return held.then(
      () =>
        ({
          ok: true,
          json: () => Promise.resolve({ id: 3, name: 'sak', createdAt: 'now' }),
          text: () => Promise.resolve(''),
        }) as Response,
    );
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('saving a case', () => {
  it('does not overwrite what was typed while the request was in flight', async () => {
    const store = usePatternCaseStore.getState();
    const saving = store.save(MODULES);

    // The curator keeps working, as the screen invites them to.
    const edited = { ...emptyPatternCase('benzodiazepines'), moduleIds: ['cocaine'] };
    usePatternCaseStore.getState().setData(edited);
    usePatternCaseStore.getState().setName('sak 2');
    release?.();
    await saving;

    const after = usePatternCaseStore.getState();
    expect(after.data).toBe(edited);
    expect(after.caseName).toBe('sak 2');
    // Those keystrokes really are unsaved, and the screen has to keep saying so
    // or the curator walks away from work that exists only in the browser.
    expect(after.dirty).toBe(true);
    // The id is still theirs, though: the case exists now, and forgetting it
    // would file a second copy on the next save.
    expect(after.caseId).toBe(3);
  });

  it('does not hand one case’s new id to the case that replaced it on screen', async () => {
    // Saving case A, then opening case B before the write comes back. The id
    // is real and the write happened, but it belongs to a case nobody is
    // looking at — and pinning it to B would point the next save at A's row.
    const saving = usePatternCaseStore.getState().save(MODULES);
    usePatternCaseStore.getState().startNew('benzodiazepines');
    release?.();
    await saving;

    expect(usePatternCaseStore.getState().caseId).toBeNull();
  });

  it('does not report one case’s failed save on another case’s screen', async () => {
    vi.stubGlobal('fetch', () => {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return held.then(
        () =>
          ({
            ok: false,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve('server said no'),
          }) as Response,
      );
    });

    const saving = usePatternCaseStore.getState().save(MODULES);
    usePatternCaseStore.getState().startNew('benzodiazepines');
    usePatternCaseStore.setState({ status: 'loading' });
    release?.();
    await saving;

    // The refusal belongs to a case nobody is looking at. Showing it here would
    // put one case's error over another — and clearing the status would hand
    // the buttons back while this case's own request is still running.
    expect(usePatternCaseStore.getState().error).toBeNull();
    expect(usePatternCaseStore.getState().status).toBe('loading');
  });

  it('does not send the screen back to a case the curator has left', async () => {
    // The id is real — the case was created — but the caller's only use for it
    // is the address, and putting it there would pull the curator back to the
    // case they had just left and cancel the load they chose.
    const saving = usePatternCaseStore.getState().save(MODULES);
    usePatternCaseStore.getState().startNew('benzodiazepines');
    release?.();

    expect(await saving).toBeNull();
  });

  it('takes the stamped case back when nothing moved under it', async () => {
    const saving = usePatternCaseStore.getState().save(MODULES);
    release?.();
    await saving;

    const after = usePatternCaseStore.getState();
    expect(after.caseId).toBe(3);
    // The case as it was written down — which is the one that was sent, with
    // the registry stamped onto it by the save path rather than by the caller.
    expect(after.data).toEqual({
      ...emptyPatternCase('benzodiazepines'),
      moduleVersions: { benzodiazepines: BENZODIAZEPINE_MODULE.version },
    });
    expect(after.dirty).toBe(false);
  });
});

describe('loading a case', () => {
  it('ignores an answer about a case that is no longer on screen', async () => {
    // Ordinary navigation, not a rare race: `/7` then `/8` before the first
    // GET lands. Applying the late answer leaves case 7 on screen under case
    // 8's address, and saving from there edits the wrong case.
    const holds: Array<() => void> = [];
    const answers: Array<{ id: number; name: string }> = [
      { id: 7, name: 'sak 7' },
      { id: 8, name: 'sak 8' },
    ];
    let served = 0;
    vi.stubGlobal('fetch', () => {
      const answer = answers[served++]!;
      return new Promise<Response>((resolve) => {
        holds.push(() =>
          resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...answer,
                caseData: emptyPatternCase('benzodiazepines'),
                createdAt: 'now',
              }),
            text: () => Promise.resolve(''),
          } as Response),
        );
      });
    });

    const first = usePatternCaseStore.getState().load(7, MODULES);
    const second = usePatternCaseStore.getState().load(8, MODULES);
    // The second request answers first, and the first arrives afterwards.
    holds[1]!();
    await second;
    holds[0]!();
    await first;

    expect(usePatternCaseStore.getState().caseId).toBe(8);
    expect(usePatternCaseStore.getState().caseName).toBe('sak 8');
  });
});

describe('the browser is asked before it takes an unsaved case', () => {
  it('warns while the case is dirty, and stops once it is not', () => {
    // Registered by the store rather than by the screen: navigating to another
    // part of the app unmounts the page, and a reload from there would
    // otherwise discard the only copy without a word.
    // From a filed case, not the dirty draft the suite starts every test on:
    // the guard is about the *transition*, so a store already dirty would
    // register nothing on the next edit and the test would prove nothing.
    usePatternCaseStore.getState().reset();

    const added: string[] = [];
    const removed: string[] = [];
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      added.push(String(type));
      add(type, listener, options);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
      removed.push(String(type));
      remove(type, listener, options);
    });

    usePatternCaseStore.getState().setName('sak');
    expect(added.filter((type) => type === 'beforeunload')).toHaveLength(1);

    usePatternCaseStore.getState().reset();
    expect(removed.filter((type) => type === 'beforeunload')).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('loading normalises what the screen has to edit', () => {
  it('gives an imported exposure an identity of its own', async () => {
    // The id is optional in the case model — an account imported from
    // elsewhere has none — but a screen editing the list in place cannot work
    // with a row that is only its position: remove the first and the second
    // inherits the state of the row that just went.
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 7,
            name: 'sak',
            caseData: {
              ...emptyPatternCase('benzodiazepines'),
              context: {
                ...emptyPatternCase('benzodiazepines').context,
                knownExposures: [
                  { drug: { pubchemCid: 3016 }, certainty: 'reported' },
                  { drug: { pubchemCid: 2519 }, certainty: 'suspected' },
                ],
              },
            },
            createdAt: 'now',
          }),
        text: () => Promise.resolve(''),
      } as Response),
    );

    await usePatternCaseStore.getState().load(7, MODULES);

    const ids = (usePatternCaseStore.getState().data.context.knownExposures ?? []).map(
      (exposure) => exposure.id,
    );
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    // Not an edit: the ids are the screen's way of telling the rows apart, and
    // they are written down by the next save the curator makes anyway.
    expect(usePatternCaseStore.getState().dirty).toBe(false);
  });
});

describe('a case belongs to the person who opened it', () => {
  it('is dropped when a different user signs in on the same tab', async () => {
    // The most user-scoped thing the app holds, in a module-level singleton
    // that outlives a session. Worse than a stale screen: the page skips the
    // fetch for a case it believes it already has, so the endpoint's own
    // ownership check never runs and the next user reads the previous user's
    // case without anything asking whether they may.
    usePatternCaseStore.setState({
      caseId: 7,
      caseName: 'Sak TEST-001',
      data: { ...emptyPatternCase('benzodiazepines'), moduleIds: ['cocaine'] },
      dirty: true,
    });

    resetPatternCaseStore();

    const after = usePatternCaseStore.getState();
    expect(after.caseId).toBeNull();
    expect(after.caseName).toBe('');
    expect(after.dirty).toBe(false);
    expect(after.data.moduleIds).toEqual(['benzodiazepines']);
  });

  it('disowns a load the previous user started', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', () => {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return held.then(
        () =>
          ({
            ok: true,
            json: () =>
              Promise.resolve({
                id: 7,
                name: 'Sak TEST-001',
                caseData: emptyPatternCase('benzodiazepines'),
                createdAt: 'now',
              }),
            text: () => Promise.resolve(''),
          }) as Response,
      );
    });

    const loading = usePatternCaseStore.getState().load(7, MODULES);
    resetPatternCaseStore();
    release?.();
    await loading;

    // The answer is about a case the person who asked for it is no longer
    // signed in to see.
    expect(usePatternCaseStore.getState().caseId).toBeNull();
  });
});
