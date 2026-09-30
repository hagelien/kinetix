/**
 * The case being worked on (spec §36, plan §10 Phase 1).
 *
 * Its own store rather than a corner of `useSimulatorStore`: the two
 * workspaces share nothing but the word "case", and a forward simulation's
 * state and a pattern case's are structurally different.
 *
 * Not persisted. The other stores keep their settings in `localStorage`, which
 * is right for a text scale and wrong for this: the working copy of a forensic
 * case is casework, and leaving it in a browser on a shared workstation is a
 * decision about where casework may sit — not one a state container should make
 * on its own. The server is where a case is kept, and until it is saved there
 * it is a draft the curator can see they have not filed.
 *
 * There is no `analysis` field either, nor a stored staleness, and both
 * absences are deliberate where spec §36 suggests otherwise.
 *
 * Staleness is a comparison between the case in hand and the registry showing
 * it, so it is a function of the case rather than a fact about the load that
 * fetched it. Held as state, it goes stale the moment a curator ticks another
 * module: the screen would keep warning about a family the case no longer
 * computes from, and stay silent about the unstamped one just added.
 *
 * The analysis is the same argument one step further out: the profile is
 * computed from the case on every render — that is what lets a corrected band
 * reach an old case — so a stored one could only be a copy that disagrees with
 * the case beside it, and `analysisStale` would be a flag maintained to
 * describe a copy nobody needed.
 */
import { create } from 'zustand';

import type { PatternSubstanceModule } from '@/lib/pattern/substanceModules';
import {
  loadPatternCase,
  PatternCaseError,
  savePatternCase,
  type PatternCaseErrorCode,
} from '@/lib/patternCases';
import { PATTERN_CASE_KIND, type PatternCaseData } from '@/types/patternCase';

/**
 * Spec §11.3's convention. A normalisation reference, not a claim that
 * 8.84 mmol/L is a biologically normal creatinine — it is recorded with the
 * case so a cohort standardised at another reference cannot score it (§8.1).
 */
export const DEFAULT_CREATININE_REFERENCE_MMOL_L = 8.84;

/** What a case with nothing else to say about it starts on. */
const DEFAULT_MODULE_ID = 'benzodiazepines';

/**
 * A case with nothing in it yet.
 *
 * It names a module, because a case that names none cannot be opened at all
 * and the schema refuses it — so an empty draft would start life invalid and
 * the screen would open onto a refusal the curator had no hand in.
 */
export function emptyPatternCase(moduleId: string): PatternCaseData {
  return {
    kind: PATTERN_CASE_KIND,
    schemaVersion: 1,
    specimens: [],
    observations: [],
    context: {
      postmortem: false,
      timeOrigin: 'first_specimen_collection',
      fields: {},
    },
    normalization: { creatinineReferenceMmolL: DEFAULT_CREATININE_REFERENCE_MMOL_L },
    moduleIds: [moduleId],
  };
}

/**
 * Give every exposure an identity, for the rows that arrived without one.
 *
 * The id is optional in the case model, because an account imported from
 * elsewhere has none and the schema must accept it. A screen cannot work with
 * that: it edits the list in place, and a row with no identity is only its
 * position — remove the first exposure and the second inherits the state of the
 * row that just went, showing a dose the case does not hold.
 *
 * So the working copy gets ids the stored bytes did not have. They are written
 * down by the next save, which is the point at which the case starts being able
 * to say which row is which.
 */
function withExposureIds(caseData: PatternCaseData): PatternCaseData {
  const exposures = caseData.context.knownExposures;
  if (!exposures?.some((exposure) => exposure.id === undefined)) return caseData;

  const taken = new Set(exposures.map((exposure) => exposure.id).filter(Boolean) as string[]);
  let next = 1;
  return {
    ...caseData,
    context: {
      ...caseData.context,
      knownExposures: exposures.map((exposure) => {
        if (exposure.id !== undefined) return exposure;
        while (taken.has(`exp-${next}`)) next += 1;
        const id = `exp-${next}`;
        taken.add(id);
        return { ...exposure, id };
      }),
    },
  };
}

interface PatternCaseState {
  caseId: number | null;
  caseName: string;
  data: PatternCaseData;
  status: 'idle' | 'loading' | 'saving';
  /**
   * The last failure, as a code the screen can say in Norwegian, with the
   * English prose kept beside it for logs. Cleared by the next attempt.
   */
  error: { code: PatternCaseErrorCode; detail: string } | null;
  /** Whether the working copy differs from what was last written down. */
  dirty: boolean;

  startNew: (moduleId: string) => void;
  cancelLoad: () => void;
  /** Everything this store holds about a case, dropped. See `resetPatternCase`. */
  reset: () => void;
  setName: (name: string) => void;
  setData: (data: PatternCaseData) => void;
  load: (id: number, modules: readonly PatternSubstanceModule[]) => Promise<void>;
  save: (modules: readonly PatternSubstanceModule[]) => Promise<number | null>;
}

const failure = (error: unknown) => ({
  code: error instanceof PatternCaseError ? error.code : ('request_failed' as const),
  detail: error instanceof Error ? error.message : String(error),
});

/**
 * Which case the screen is currently about.
 *
 * Bumped whenever that changes — a load started, a new case begun — and read
 * by every in-flight request on the way back. Without it the store applies
 * whatever answers last: a slow `GET 7` landing after `GET 8` leaves case 7 on
 * screen under case 8's address, and a save of case A completing after the
 * curator opened case B hands A's id to B's content, so the next save writes B
 * over A. Both are ordinary navigation, not rare races.
 *
 * Module-scoped rather than state, because it is not something to render — and
 * because a component reading it could not act on it anyway.
 */
let onScreen = 0;

export const usePatternCaseStore = create<PatternCaseState>((set, get) => ({
  caseId: null,
  caseName: '',
  data: emptyPatternCase(DEFAULT_MODULE_ID),
  status: 'idle',
  error: null,
  dirty: false,

  startNew: (moduleId) => {
    onScreen += 1;
    set({
      caseId: null,
      caseName: '',
      data: emptyPatternCase(moduleId),
      status: 'idle',
      error: null,
      dirty: false,
    });
  },

  /**
   * Give up on whatever is on its way in.
   *
   * The screen has stopped being about the case that was requested — usually
   * by going back to the draft route — and `startNew` is not always the right
   * answer there, because a draft that has not been touched is not something to
   * throw away. But the pending load still has to be disowned: without this,
   * its answer arrives later and installs a saved case over the draft, under an
   * address that names no case at all, from where the next save writes to it.
   */
  cancelLoad: () => {
    onScreen += 1;
    if (get().status === 'loading') set({ status: 'idle' });
  },

  reset: () => {
    onScreen += 1;
    set({
      caseId: null,
      caseName: '',
      data: emptyPatternCase(DEFAULT_MODULE_ID),
      status: 'idle',
      error: null,
      dirty: false,
    });
  },

  setName: (caseName) => set({ caseName, dirty: true }),
  setData: (data) => set({ data, dirty: true }),

  load: async (id, modules) => {
    const generation = (onScreen += 1);
    set({ status: 'loading', error: null });
    try {
      const row = await loadPatternCase(id, modules);
      // Another case took the screen while this one was in flight. Its answer
      // is about a case nobody is looking at, and applying it would leave that
      // case on screen under the other one's address — from where saving edits
      // the wrong case.
      if (generation !== onScreen) return;
      set({
        caseId: row.id,
        caseName: row.name,
        data: withExposureIds(row.caseData),
        status: 'idle',
        dirty: false,
      });
    } catch (error) {
      if (generation !== onScreen) return;
      // The case is left as it was rather than blanked. A failed load that
      // wipes the screen loses whatever the curator had in front of them, and
      // the thing they most need to do next is read the message.
      set({ status: 'idle', error: failure(error) });
    }
  },

  save: async (modules) => {
    const { caseId, caseName, data, status } = get();
    // Not while another case is on its way in. The case in hand belongs to the
    // address the curator has already left, so writing it now would file it
    // under a screen that is about to show something else — and the id coming
    // back would then be pinned to whichever case wins the race.
    if (status === 'loading') return null;
    // Read, not bumped: saving does not change which case the screen is about.
    const generation = onScreen;
    set({ status: 'saving', error: null });
    try {
      const row = await savePatternCase(caseName, data, modules, caseId ?? undefined);
      // The screen moved to another case while this one was being written. The
      // write itself succeeded and the id is real, but it belongs to a case
      // nobody is looking at — and handing it to the case now on screen would
      // point the next save at the wrong row.
      //
      // Null rather than the id, because the caller's only use for it is to put
      // it in the address: returning it would pull the curator back to the case
      // they had just left and cancel the load they chose. The case exists and
      // will be in the picker; nothing is lost but a navigation nobody asked
      // for.
      if (generation !== onScreen) return null;
      // What was sent is not necessarily what is on screen by the time the
      // answer comes back: the editor stays usable while a save is in flight,
      // and a curator who keeps typing would otherwise have those keystrokes
      // replaced by the snapshot the request carried — and the screen would
      // then call the result saved. So the response is applied only to a
      // working copy that has not moved under it.
      const moved = get().data !== data || get().caseName !== caseName;
      set(
        moved
          ? // The id still belongs to the curator: the case exists now, and
            // losing it would file a second copy on the next save. Everything
            // else stays as they left it, dirty included, because the newer
            // edits genuinely are unsaved.
            { caseId: row.id, status: 'idle' }
          : {
              caseId: row.id,
              // The stamped case comes back from the save, so what is on screen
              // is what was written rather than what was handed over.
              data: row.caseData,
              status: 'idle',
              dirty: false,
            },
      );
      return row.id;
    } catch (error) {
      // The same check the success path makes, and for a sharper reason: this
      // failure is about a case nobody is looking at, so reporting it here
      // would put case A's refusal in front of case B — and clearing the status
      // would hand the buttons back while B's own load or save is still
      // running.
      if (generation !== onScreen) return null;
      // Still dirty, deliberately: nothing was written, and a screen that
      // stopped saying so would invite the curator to walk away from work that
      // exists only in the browser.
      set({ status: 'idle', error: failure(error) });
      return null;
    }
  },
}));

/**
 * Drop the case when a different person signs in on this tab.
 *
 * A forensic case is the most user-scoped thing this app holds, and the store
 * is a module-level singleton that outlives a session. Without this, returning
 * to `/modeling/pattern/:caseId` as the next user shows the previous user's
 * case — and shows it *without asking the server*, because the page skips the
 * fetch for a case it believes it already has, so the endpoint's own ownership
 * check never runs. An unsaved draft survives the same way on the bare route,
 * where both ids are null.
 *
 * Bumping the in-flight generation is part of it: a load started by the
 * previous user must not land in the next one's screen.
 */
export function resetPatternCaseStore(): void {
  usePatternCaseStore.getState().reset();
}

/**
 * Ask the browser before it takes an unsaved case with it.
 *
 * Registered here rather than on the screen that edits the case, because the
 * store outlives that screen: navigating to another part of the app unmounts
 * the page, and a reload from there would then discard the only copy of a
 * dirty case without a word. The store is where the case lives, so it is where
 * the warning belongs.
 *
 * Guarded for a non-browser environment — this module is imported by tests and
 * by anything that reads the case types on the server.
 */
if (typeof window !== 'undefined') {
  const warn = (event: BeforeUnloadEvent) => {
    // `preventDefault` is what current browsers read; the assignment is for the
    // older ones. Neither lets the page choose the wording.
    event.preventDefault();
    event.returnValue = '';
  };
  usePatternCaseStore.subscribe((state, previous) => {
    if (state.dirty === previous.dirty) return;
    if (state.dirty) window.addEventListener('beforeunload', warn);
    else window.removeEventListener('beforeunload', warn);
  });
}
