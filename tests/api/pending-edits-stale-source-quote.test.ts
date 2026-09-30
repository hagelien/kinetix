import { describe, expect, it } from 'vitest';

import {
  proposalContentRevised,
  withoutStaleEntryQuote,
  withoutStaleSourceQuote,
} from '../../api/pending-edits.ts';
import { SOURCE_QUOTE_EVIDENCE_FIELDS } from '../../src/lib/parameterEntries.ts';
import { DOSE_CONTEXT_FIELD_KEYS } from '../../src/lib/entryDoseContext.ts';

/**
 * A `parameter` proposal keeps its source quote in `proposedMeta`, because a
 * NumericRange has nowhere to put one — and the review card resubmits
 * `proposedValue` alone, leaving `proposedMeta` untouched. So without this rule,
 * revising the value leaves the previous sentence attached to it, and
 * `highRiskEditLacksSourceQuote` sees a non-empty quote: a changed
 * calculation-driving value could auto-publish behind words describing the
 * number it used to be.
 *
 * A quote is evidence for a specific value. When the value moves and nobody
 * supplies new evidence, the honest state is none — which also holds the edit
 * for a human rather than publishing it, so the rule fails safe.
 */
describe('withoutStaleSourceQuote', () => {
  const meta = { sourceQuote: 'Half-life was 9 h.', editSummary: 'x' };

  it('drops the quote when the payload was revised and none was supplied', () => {
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: true,
        suppliedMeta: undefined,
        storedMeta: meta,
      }),
    ).toEqual({ editSummary: 'x' });
  });

  // The bypass this rule actually shipped with. The handler's `suppliedMeta`
  // falls back to the STORED meta when a PATCH omits one, so passing that here
  // hands this function the old quote and it reads the server's own
  // carry-forward as the author supplying a replacement — inert on exactly the
  // path it exists for, since the review card sends `proposedValue` alone.
  // Pinned as a unit rule: only a genuinely supplied meta counts.
  it('does not treat the carried-forward meta as a supplied replacement', () => {
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: true,
        // What the handler must pass: the REQUEST's meta, absent here.
        suppliedMeta: undefined,
      }),
    ).toEqual({ editSummary: 'x' });
    // …and what it must not: the stored meta, which always carries the quote.
    // With the stored row to compare against, that echo is recognised for what
    // it is and the quote still goes.
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: true,
        suppliedMeta: meta,
        storedMeta: meta,
      }),
    ).toEqual({ editSummary: 'x' });
  });

  // The second half of the same bypass, and the one a real client trips. A
  // PATCH that reads the edit, changes `proposedValue` and sends the whole
  // object back supplies `proposedMeta` — with the stored quote inside it.
  // Presence alone cannot tell that apart from an author writing a new
  // sentence; comparison can. Echoing what is already stored asserts nothing.
  it('drops a supplied quote that merely echoes the stored one', () => {
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: true,
        suppliedMeta: { sourceQuote: 'Half-life was 9 h.' },
        storedMeta: meta,
      }),
    ).toEqual({ editSummary: 'x' });
  });

  // …including an echo that only rewraps the sentence, which is what a
  // re-paste out of a PDF produces. The schema stores both in the same
  // canonical form, so a raw comparison would call this a replacement and then
  // store the very sentence it had decided was superseded.
  it('sees through re-wrapped whitespace to the same stored sentence', () => {
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: true,
        suppliedMeta: { sourceQuote: '  Half-life was\n  9 h.  ' },
        storedMeta: meta,
      }),
    ).toEqual({ editSummary: 'x' });
  });

  it('keeps the quote when the payload was not revised', () => {
    // A meta-only rewrite, or a plain resubmit: the value the sentence backs is
    // unchanged, so the sentence still backs it.
    expect(
      withoutStaleSourceQuote(meta, {
        payloadRevised: false,
        suppliedMeta: undefined,
        storedMeta: meta,
      }),
    ).toEqual(meta);
  });

  it('keeps a replacement the revision supplies itself', () => {
    const supplied = { sourceQuote: 'Half-life was 11 h.' };
    expect(
      withoutStaleSourceQuote(
        { ...meta, ...supplied },
        { payloadRevised: true, suppliedMeta: supplied, storedMeta: meta },
      ),
    ).toEqual({ sourceQuote: 'Half-life was 11 h.', editSummary: 'x' });
  });

  // An explicit null is the author saying "there is no quote for this value",
  // which is a statement, not silence — it must survive rather than being
  // treated as an absent key and stripped.
  it('keeps an explicitly null quote the revision supplies', () => {
    const supplied = { sourceQuote: null };
    expect(
      withoutStaleSourceQuote(
        { ...meta, ...supplied },
        { payloadRevised: true, suppliedMeta: supplied, storedMeta: meta },
      ),
    ).toEqual({ sourceQuote: null, editSummary: 'x' });
  });

  it('leaves meta without a quote, and non-object meta, alone', () => {
    expect(
      withoutStaleSourceQuote(
        { editSummary: 'x' },
        { payloadRevised: true, suppliedMeta: undefined, storedMeta: undefined },
      ),
    ).toEqual({ editSummary: 'x' });
    expect(
      withoutStaleSourceQuote(null, {
        payloadRevised: true,
        suppliedMeta: undefined,
        storedMeta: meta,
      }),
    ).toBeNull();
  });
});

/**
 * The `param_entry` sibling. Its quote lives INSIDE the payload
 * (`proposed_value.input.quote`), so a client resubmitting a revised payload
 * sends the quote explicitly — presence alone cannot distinguish "the author
 * re-affirmed this sentence" from "the author edited the number in a JSON
 * dialog and left the rest alone". Comparison can: a quote identical to the
 * stored one, on a payload that otherwise moved, was not re-authored.
 */
describe('withoutStaleEntryQuote', () => {
  const QUOTE = 'The mean terminal half-life was 9 h.';
  const prev = {
    op: 'create',
    input: { parameter: 'halfLife', median: 9, unit: 'h', quote: QUOTE },
  };

  it('drops an unchanged quote when the reading moved', () => {
    const next = {
      op: 'create',
      input: { parameter: 'halfLife', median: 11, unit: 'h', quote: QUOTE },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual({
      op: 'create',
      input: { parameter: 'halfLife', median: 11, unit: 'h' },
    });
  });

  it('drops an unchanged quote when the citation moved', () => {
    const withCitation = {
      op: 'create',
      input: { parameter: 'halfLife', median: 9, unit: 'h', citationId: 5, quote: QUOTE },
    };
    const next = {
      op: 'create',
      input: { parameter: 'halfLife', median: 9, unit: 'h', citationId: 7, quote: QUOTE },
    };
    expect(withoutStaleEntryQuote(next, withCitation)).toEqual({
      op: 'create',
      input: { parameter: 'halfLife', median: 9, unit: 'h', citationId: 7 },
    });
  });

  // The schema collapses whitespace on the way in, so a raw comparison here
  // would read a re-wrapped copy of the same sentence — a re-paste out of a
  // two-column PDF, say — as a replacement, let it through, and then normalize
  // it back to the very sentence it had decided was superseded. Two rules for
  // one question, and the gap between them is a stale quote surviving.
  it('sees through re-wrapped whitespace to the same sentence', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'halfLife',
        median: 11,
        unit: 'h',
        quote: '  The mean terminal\n  half-life was 9 h.  ',
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual({
      op: 'create',
      input: { parameter: 'halfLife', median: 11, unit: 'h' },
    });
  });

  // Curator notes are commentary about the observation, not part of what the
  // sentence attests — and the update's own SQL deliberately excludes them. A
  // whole-payload comparison here would disagree with that: a contributor
  // fixing a typo would lose the provenance, the proposal would be held as
  // unquoted, and a later human approval would store NULL.
  it('keeps the quote when only a non-evidence field moved', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'halfLife',
        median: 9,
        unit: 'h',
        comments: 'Typo fixed.',
        quote: QUOTE,
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual(next);
  });

  it('keeps a quote the author rewrote, whatever else moved with it', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'halfLife',
        median: 11,
        unit: 'h',
        quote: 'Corrected: the mean was 11 h.',
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual(next);
  });

  it('keeps the quote when nothing else moved', () => {
    // A resubmit that changes nothing is not a revision, so the sentence still
    // backs the reading it was written for.
    expect(withoutStaleEntryQuote(prev, prev)).toEqual(prev);
  });

  it('handles an update payload and leaves other shapes alone', () => {
    const prevUpdate = { op: 'update', patch: { median: 9, unit: 'h', quote: QUOTE } };
    const nextUpdate = { op: 'update', patch: { median: 11, unit: 'h', quote: QUOTE } };
    expect(withoutStaleEntryQuote(nextUpdate, prevUpdate)).toEqual({
      op: 'update',
      patch: { median: 11, unit: 'h' },
    });
    // A delete, a wiki_fact payload, or anything unrecognised passes through.
    expect(withoutStaleEntryQuote({ op: 'delete' }, prev)).toEqual({ op: 'delete' });
    expect(withoutStaleEntryQuote(null, prev)).toBeNull();
  });
});

/**
 * The evidence list itself. It is applied in three places — the update's SQL,
 * the proposal-revision check, and these tests — so it is named once and pinned
 * here: a field silently joining or leaving it changes what provenance means.
 */
describe('SOURCE_QUOTE_EVIDENCE_FIELDS', () => {
  it('is every dimension a quote attests to, and nothing else', () => {
    expect([...SOURCE_QUOTE_EVIDENCE_FIELDS]).toEqual([
      'citationId',
      'unit',
      'low',
      'high',
      'median',
      'qualifier',
      'categoricalValue',
      'route',
      'matrix',
      'scenario',
      'n',
      'observationContext',
      // Structured dose context (Cmax release B): which dose, regimen,
      // formulation and population the reading was made under is part of
      // which reading it is. Joined as a block from `DOSE_CONTEXT_FIELD_KEYS`.
      ...DOSE_CONTEXT_FIELD_KEYS,
    ]);
    // The exclusion that matters: notes are commentary, not evidence.
    expect([...SOURCE_QUOTE_EVIDENCE_FIELDS]).not.toContain('comments');
  });
});

/**
 * The split this issue (#1257) makes: `observationContext` holds facts about
 * the READING (fasted/fed, dose, assay method, …) and is evidence a quote
 * attests to, exactly like `unit` or `median`; `comments` stays curator
 * commentary about the row and stays outside the evidence list, unchanged.
 * Both halves are pinned here because a regression in either direction is
 * silent: adding `observationContext` back to `comments`'s side would let a
 * curator change what a reading IS without the quote noticing again, and
 * treating `comments` as evidence would strip a good quote on a typo fix.
 */
describe('observationContext is evidence, comments is not (#1257)', () => {
  const QUOTE = 'Fasted, single dose, healthy volunteers: Cmax was 30 mg/L.';
  const prev = {
    op: 'create',
    input: {
      parameter: 'therapeuticConcentration',
      median: 30,
      unit: 'mg/L',
      observationContext: 'Fasted, single dose, healthy volunteers.',
      quote: QUOTE,
    },
  };

  it('(a) drops the quote when only observationContext changes', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fed, single dose, healthy volunteers.',
        quote: QUOTE,
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual({
      op: 'create',
      input: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fed, single dose, healthy volunteers.',
      },
    });
  });

  it('(b) keeps the quote when only comments changes', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fasted, single dose, healthy volunteers.',
        comments: 'Double-checked against table 3.',
        quote: QUOTE,
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual(next);
  });

  // (c) The asymmetry `isCreate` exists for: on an UPDATE, an omitted
  // observationContext preserves the stored row's value, so it is correctly
  // read as unchanged. On a CREATE, there is no stored row to preserve from —
  // insertParameterEntryRow writes an omission as NULL — so a create revision
  // that drops the field while echoing its quote HAS changed what gets
  // written, and must drop the quote exactly as case (a) does.
  it('(c) drops the quote when a create revision OMITS observationContext entirely', () => {
    const next = {
      op: 'create',
      input: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        quote: QUOTE,
      },
    };
    expect(withoutStaleEntryQuote(next, prev)).toEqual({
      op: 'create',
      input: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
      },
    });
  });

  // …and the mirror, pinning that an UPDATE's omission still preserves: the
  // same shape as (c) but op: 'update'/patch must behave oppositely.
  it('(d) keeps the quote when an update revision omits observationContext (nothing to preserve from differs)', () => {
    const updatePrev = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fasted, single dose, healthy volunteers.',
        quote: QUOTE,
      },
    };
    const next = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        quote: QUOTE,
      },
    };
    expect(withoutStaleEntryQuote(next, updatePrev)).toEqual(next);
  });

  // The `liveEntry` parameter exists for exactly this gap: omission on an
  // UPDATE inherits the LIVE ROW at write time (`updateParameterEntryRow`),
  // never the prior proposal. A revision that drops the field must compare
  // against what it will ACTUALLY become, not against what an earlier
  // submission happened to say — otherwise a live row that already disagrees
  // with the prior proposal lets a stale quote sail through unnoticed.
  it('(e) drops the quote when an update revision omits observationContext and the LIVE row disagrees with the prior proposal', () => {
    const updatePrev = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fasted, single dose, healthy volunteers.',
        quote: QUOTE,
      },
    };
    const next = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        quote: QUOTE,
      },
    };
    // The live row holds a DIFFERENT context than what the prior proposal
    // claimed — perhaps a direct write landed between the two submissions.
    const liveEntry = { observationContext: 'Fed, single dose.' };
    expect(withoutStaleEntryQuote(next, updatePrev, liveEntry)).toEqual({
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
      },
    });
  });

  // …and the mirror: when the live row agrees with what the prior proposal
  // claimed, omitting the field on revision really is a no-op, and the quote
  // survives.
  it('(f) keeps the quote when an update revision omits observationContext and the LIVE row agrees with the prior proposal', () => {
    const updatePrev = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        observationContext: 'Fasted, single dose, healthy volunteers.',
        quote: QUOTE,
      },
    };
    const next = {
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        median: 30,
        unit: 'mg/L',
        quote: QUOTE,
      },
    };
    const liveEntry = {
      observationContext: 'Fasted, single dose, healthy volunteers.',
    };
    expect(withoutStaleEntryQuote(next, updatePrev, liveEntry)).toEqual(next);
  });
});

/**
 * What feeds `payloadRevised` above, and the half of the rule that protects
 * legitimate work rather than blocking bad work.
 *
 * `pendingEditPayloadFingerprint` answers "did anything about this proposal
 * change?" — it covers the whole of `proposedMeta` — and that is the right
 * question for `revisedAt`, which measures an upheld dispute. It is the wrong
 * one for the quote: reworded curatorial notes are commentary about the
 * proposal, not part of what the sentence attests, so deciding staleness on the
 * broader answer costs a good quote on a metadata-only edit. The proposal then
 * loses the evidence reviewers were meant to check AND is held from
 * auto-publication for lacking it.
 */
describe('proposalContentRevised', () => {
  const stored = {
    proposedValue: { median: 9, unit: 'h' },
    referenceId: 5,
    referenceIds: [5],
  };

  // Metadata cannot even be handed to it — the parameter type admits the value
  // and the references and nothing else, which is the exclusion stated as a
  // shape rather than as a rule that could be forgotten. What a caller passing
  // the broader signal anyway costs is pinned at the handler, in
  // `pending-edits-quote-evidence.test.ts`.
  it('is false when neither the value nor the references moved', () => {
    expect(proposalContentRevised(stored, { ...stored })).toBe(false);
  });

  it('sees a changed value', () => {
    expect(
      proposalContentRevised(
        { ...stored, proposedValue: { median: 11, unit: 'h' } },
        stored,
      ),
    ).toBe(true);
  });

  // The cited source is evidence-defining too: the same sentence cannot be
  // evidence for a value now attributed to a different paper.
  it('sees a changed reference set', () => {
    expect(
      proposalContentRevised(
        { ...stored, referenceId: 6, referenceIds: [6] },
        stored,
      ),
    ).toBe(true);
  });

  // The null / singular / array spellings of one reference set are the same
  // set, and come through the fingerprint's own canonicalization.
  it('does not mistake a respelled reference set for a changed one', () => {
    expect(
      proposalContentRevised(
        { ...stored, referenceIds: undefined },
        stored,
      ),
    ).toBe(false);
  });
});
