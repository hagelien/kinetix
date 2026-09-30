/**
 * Reviewer acknowledgements of grade-D models (§5.1).
 *
 * The grade policy admits a D to a reviewer class and to nobody else, and only "through a recorded
 * acknowledgement, in a labelled review workspace" (`renderDisposition`). The policy branch has
 * existed since the gate was written; nothing recorded an acknowledgement, so no caller ever passed
 * `acknowledged` and the branch was unreachable — a reviewer got `acknowledge-in-review-workspace`,
 * which the render gate treats as not-renderable, and the model was shown to nobody at all. This is
 * the missing record.
 *
 * **Per model, per EVIDENCE VERSION, per viewer** — all three, because each guards a different way
 * the record could outlive what it attested:
 *
 *  - per model, because acknowledging one model's evidence says nothing about another's;
 *  - per evidence version, the key `acknowledgementVersionFor` derives from the COMPLETE assessment
 *    set behind the grade. Two weaker keys both fail: a release checksum hashes
 *    `{version, definitions}` and the artifact's `derivedGrades` sit deliberately outside it, so a
 *    regeneration changing only grade facts leaves it identical; and the disclosed policy shows only
 *    dimensions below B, so completeness moving from A to B changes the model without changing
 *    anything disclosed. Hashing every dimension the scorer produced catches both, and a scorer
 *    change with it;
 *  - per viewer, keyed on the user id, because the acknowledgement is an act by a named reviewer.
 *    Browser storage is shared by everyone using the profile, so without the id a second reviewer
 *    (or a logged-out visitor who then signs in) would silently inherit the first one's decision.
 *
 * **What this is not.** A browser-local record is not an audit trail: it does not survive a cleared
 * profile, does not follow a reviewer to another machine, and is not readable by anyone but its
 * author. That is sufficient for the gate — the policy asks whether THIS viewer has acknowledged —
 * but a durable, auditable record of who accepted what belongs server-side, and is deliberately not
 * claimed here.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getStoredValue, removeStoredValues, setStoredValue } from '@/lib/storage';

const ACKNOWLEDGEMENT_KEY = 'kinetix.model-acknowledgements';

/** One reviewer's acceptance of one model, as its evidence stood when they accepted it. */
export interface ModelAcknowledgement {
  modelId: string;
  /** The evidence fingerprint the acknowledgement was made against (`acknowledgementVersionFor`). */
  version: string;
  /** The acknowledging user's id, or `null` when no user was signed in. */
  userId: number | null;
  /** ISO timestamp, so the record can say when as well as what. */
  at: string;
}

interface ModelAcknowledgementState {
  acknowledgements: Record<string, ModelAcknowledgement>;
  acknowledge: (modelId: string, version: string, userId: number | null) => void;
  withdraw: (modelId: string, version: string, userId: number | null) => void;
  /** Drop every record. Used on sign-out so a decision does not outlive its session. */
  clear: () => void;
}

/**
 * The composite key.
 *
 * Built with `JSON.stringify` rather than a joined separator so no component can forge another's
 * boundary: a model id that happened to contain the separator character could otherwise produce the
 * same key as a different (model, evidence version, viewer) triple and inherit its acknowledgement.
 */
export function acknowledgementKey(
  modelId: string,
  version: string,
  userId: number | null,
): string {
  return JSON.stringify([modelId, version, userId]);
}

export const useModelAcknowledgementStore = create<ModelAcknowledgementState>()(
  persist(
    (set) => ({
      acknowledgements: {},
      acknowledge: (modelId, version, userId) =>
        set((state) => ({
          acknowledgements: {
            ...state.acknowledgements,
            [acknowledgementKey(modelId, version, userId)]: {
              modelId,
              version,
              userId,
              at: new Date().toISOString(),
            },
          },
        })),
      withdraw: (modelId, version, userId) =>
        set((state) => {
          const key = acknowledgementKey(modelId, version, userId);
          if (!(key in state.acknowledgements)) return state;
          const next = { ...state.acknowledgements };
          delete next[key];
          return { acknowledgements: next };
        }),
      clear: () => set({ acknowledgements: {} }),
    }),
    {
      name: ACKNOWLEDGEMENT_KEY,
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) => getStoredValue(name),
        setItem: (name, value) => setStoredValue(name, value),
        removeItem: (name) => removeStoredValues(name),
      })),
    },
  ),
);

/** Whether this viewer has an acknowledgement on record for this model and this evidence. */
export function hasAcknowledgement(
  acknowledgements: Record<string, ModelAcknowledgement>,
  modelId: string,
  version: string,
  userId: number | null,
): boolean {
  return acknowledgementKey(modelId, version, userId) in acknowledgements;
}
