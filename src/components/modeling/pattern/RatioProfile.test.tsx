/**
 * The view renders the fixture case end to end.
 *
 * This is the Phase 0 acceptance criterion in its visible form: the handoff's
 * numbers on screen, no percentile anywhere, no strength expression that does
 * not trace to a registered published source — which, after verifying the
 * module's citations, means none — and the source-ambiguity statement present
 * because the fixture declares no exposures.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import nb from '../../../locales/nb.json';

/**
 * Resolve against the real Norwegian bundle rather than echoing keys back.
 *
 * The repo's convention is to stub `t`, but a stub would make this suite pass
 * with an empty locale file — and half the point of the view is that the
 * registry's keys reach a reader as Norwegian. This exercises the same path the
 * app does, interpolation included.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, options?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' && part in node
              ? (node as Record<string, unknown>)[part]
              : undefined,
          nb,
        );
      if (typeof value !== 'string') return key;
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options?.[name] ?? `{{${name}}}`),
      );
    },
  }),
}));

import { RatioProfile } from './RatioProfile';
import { buildProfileFromCase } from '../../../lib/pattern/buildProfile';
import { BENZODIAZEPINE_GRAPH, DIAZEPAM_FIXTURE_CASE } from '../../../lib/pattern/fixtures';
import type { ObservationEdit } from '../../../lib/pattern/buildProfile';
import { BENZODIAZEPINE_MODULE } from '../../../lib/pattern/modules/benzodiazepines';

function buildModel(contextOverrides: Record<string, string> = {}) {
  return buildProfileFromCase({
    caseData: DIAZEPAM_FIXTURE_CASE,
    modules: [BENZODIAZEPINE_MODULE],
    graph: BENZODIAZEPINE_GRAPH,
    contextOverrides,
  });
}

describe('RatioProfile', () => {
  it('renders the handoff’s within-matrix figures', () => {
    render(<RatioProfile model={buildModel()} />);

    // Twice each: the visible grid cell and the visually-hidden table §9.3
    // requires. Asserting a single match would pass only while one of the two
    // was missing.
    for (const value of ['1,45', '1,79', '0,212', '0,461']) {
      expect(screen.getAllByText(value)).toHaveLength(2);
    }
  });

  it('heads each group with the matrix its ratios come from', () => {
    // The handoff's three subheadings. Grouping every within-matrix ratio under
    // one heading put the blood ratio beside three urine ones and left the
    // matrix — the thing this screen compares across — readable only from each
    // label.
    render(<RatioProfile model={buildModel()} />);

    for (const heading of ['Blod', 'Urin', 'Kryssmatrise']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      // Once as a heading, once in the visually-hidden table's group column,
      // which §9.3 asks to carry every fact the picture does.
      expect(screen.getAllByText(heading).length).toBeGreaterThanOrEqual(2);
    }

    // The dilution note is per group, because the reason differs: urine's
    // ratios are invariant *because* the creatinine factor cancels, and
    // dilution is not something that happens to blood at all.
    expect(screen.getByText(/Innen blod/)).toBeInTheDocument();
    expect(screen.getByText(/Innen urin — dilusjonsinvariant/)).toBeInTheDocument();
  });

  it('labels a decade too small to write out as a decimal', () => {
    // `{ lo: 1e-21, hi: 1 }` is a valid parity-containing pin, so nothing in
    // the registry has reason to refuse it. Its lowest decade has no honest
    // decimal rendering: a browser predating `Intl.NumberFormat` v3's
    // hundred-digit ceiling throws a RangeError and takes the profile with it,
    // a current one draws a hundred-character tick, and clamping at twenty
    // prints `0` for a nonzero decade.
    const model = buildProfileFromCase({
      caseData: DIAZEPAM_FIXTURE_CASE,
      modules: [{ ...BENZODIAZEPINE_MODULE, axisPin: { lo: 1e-21, hi: 1 } }],
      graph: BENZODIAZEPINE_GRAPH,
    });

    render(<RatioProfile model={model} />);

    expect(screen.getByText(/^1E.21$/)).toBeInTheDocument();
    // And the decades a decimal can state are still stated that way.
    expect(screen.getByText('0,1')).toBeInTheDocument();
  });

  it('renders the cross-matrix figures at the spec creatinine reference', () => {
    render(<RatioProfile model={buildModel()} />);

    // 3,28 and 5,87 — the handoff's 3,71 and 6,64 restated at 8.84 mmol/L.
    expect(screen.getAllByText('3,28')).toHaveLength(2);
    expect(screen.getAllByText('5,87')).toHaveLength(2);
  });

  it('states the source ambiguity, since the fixture declares no exposures', () => {
    render(<RatioProfile model={buildModel()} />);

    expect(
      screen.getByText('Kilden til analyttene er ikke avklart.'),
    ).toBeInTheDocument();
  });

  it('carries the metabolite-coverage caveat, whatever the source status says', () => {
    // Standing, not conditional. The withdrawn completeness markers were the
    // only thing that could have made an empty candidate set mean "nothing can
    // confound this", so the residual is disclosed on every profile — including
    // the one where no ambiguity statement renders at all, which is the case it
    // qualifies most.
    render(<RatioProfile model={buildModel()} />);

    expect(
      screen.getByText(/Metabolitter som ikke er registrert, kan derfor forstyrre/),
    ).toBeInTheDocument();
  });

  it('shows the withdrawn ratio as a footnote rather than a row', () => {
    render(<RatioProfile model={buildModel()} />);

    expect(screen.getByText(/Sum urin ∶ sum blod er tatt ut/)).toBeInTheDocument();
  });

  it('states no strength at all while the case data is unstated', () => {
    // The bare fixture answers nothing, so every signal degrades — including the
    // one that has a published cut-off. A strength expression here would be
    // computed from context nobody entered.
    const { container } = render(<RatioProfile model={buildModel()} />);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/støtte for H[pd]/);
    expect(text).toContain('Styrke ikke beregnbar');
  });

  it('states no strength even with the case data fully stated', () => {
    const { container } = render(
      <RatioProfile
        model={buildModel({
          bmatrix: 'antemortem_whole_blood',
          umatrix: 'spot',
          interval: 'simultaneous',
          hydro: 'none',
          history: 'repeated',
        })}
      />,
    );
    const text = container.textContent ?? '';

    // The dilution signal carried the module's only strength expression, on
    // creatinine cut-offs attributed to a paper that turned out to publish no
    // such mapping. With nothing registered behind them the rule is withdrawn,
    // and the screen says so rather than restating a verdict nobody sourced.
    expect(text).not.toMatch(/støtte for H[pd]/);
    expect(text).toContain('ingen registrert publisert kilde fastsetter grenseverdier');
    // No band position is ever expressed as a statistic either.
    expect(text).not.toMatch(/persentil|percentile/i);
  });

  it('renders the not-established finding outside the signal list', () => {
    render(<RatioProfile model={buildModel()} />);

    expect(screen.getByText('Ikke etablert')).toBeInTheDocument();
    expect(screen.getByText('Etterlevelse av forskrivning')).toBeInTheDocument();
  });
});

describe('the plot cannot contradict the row it belongs to', () => {
  it('states both propositions on every signal row', () => {
    const { container } = render(
      <RatioProfile
        model={buildModel({
          bmatrix: 'antemortem_whole_blood',
          umatrix: 'spot',
          interval: 'simultaneous',
          hydro: 'none',
          history: 'repeated',
        })}
      />,
    );
    const text = container.textContent ?? '';

    // A side is unreadable without knowing what each proposition asserts, and
    // that stays true of a row that states no side: "strength not calculable"
    // is an answer to a question the reader still has to be able to see.
    expect(text).toContain('Urinprøven har normal konsentrasjon.');
    expect(text).toContain('Urinprøven er fortynnet.');
  });

  it('says a band is withheld rather than just not drawing one', () => {
    // A cross-matrix row whose band basis nobody stated. Drawing nothing and
    // saying nothing would read as "no reference distribution exists", which is
    // a different claim from "one exists and cannot be compared with this case".
    const { container } = render(<RatioProfile model={buildModel()} />);

    expect(container.textContent).toContain('Referansebåndets grunnlag er ikke angitt');
  });

  it('does not tell a screen reader a withheld band does not exist', () => {
    // `noBand` claims none exists; a withheld band is the opposite case, and the
    // row's notes already say so. Saying "no reference band" in the two places a
    // reader who cannot see the hatching depends on — the table cell and the
    // track's accessible name — made the same row contradict itself.
    render(<RatioProfile model={buildModel()} />);

    const withheld = 'Referansebåndets grunnlag er ikke angitt';
    const described = screen
      .getAllByRole('img')
      .map((el) => el.getAttribute('aria-label') ?? '');

    expect(described.some((label) => label.includes(withheld))).toBe(true);
    expect(described.some((label) => label.includes('Ingen referansebånd'))).toBe(false);

    // And the same in the table §9.3 requires.
    const row = screen.getByRole('row', { name: /4,92/ });
    expect(row.textContent).toContain(withheld);
  });

  it('puts parity where the axis actually places 1', () => {
    const model = buildModel();
    // The module pins 0.03–100, which is not symmetric around 1: parity sits
    // near 43%, and a line at the midpoint would show markers on the wrong side.
    expect(model.axis.parityPct).toBeCloseTo(43.2, 1);
    expect(model.axis.parityPct).not.toBeCloseTo(50, 1);
  });
});

describe('the row and the plot are readable without sight of each other', () => {
  it('labels raw and normalised so neither can be taken for the other', () => {
    const { container } = render(<RatioProfile model={buildModel()} />);
    const text = container.textContent ?? '';

    // 4,92 and 3,28 are materially different and §3.4 asserts neither is the
    // correct one, so position alone must not be what tells them apart.
    expect(text).toContain('rå');
    expect(text).toContain('norm.');
  });

  it('gives the plot a numeric text equivalent', () => {
    render(<RatioProfile model={buildModel()} />);

    // role="img" collapses the graphic into one accessibility object, so the
    // value and the band's bounds have to be in its name or they are lost.
    const tracks = screen.getAllByRole('img');
    const described = tracks.map((t) => t.getAttribute('aria-label') ?? '');

    expect(described.some((label) => label.includes('1,45'))).toBe(true);
    expect(described.some((label) => /Foreløpig bånd fra .* til .*, median/.test(label))).toBe(true);
  });

  it('says a clamped marker is off the axis, not sitting on the boundary', () => {
    // A result outside the pinned span is drawn at the rim — exactly where one
    // that genuinely sits at the boundary is drawn. The endpoint is a few
    // pixels wider, which says "something happened" and nothing about what or
    // which way, and role="img" hides that difference entirely from a screen
    // reader. The pin is 0.03–100, so a blood diazepam far below its
    // nordazepam pair pushes the first ratio off the top.
    const offAxis = buildProfileFromCase({
      caseData: {
        ...DIAZEPAM_FIXTURE_CASE,
        observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
          o.id === 'obs-dzp-b' ? { ...o, value: 0.05 } : o,
        ),
      },
      modules: [BENZODIAZEPINE_MODULE],
      graph: BENZODIAZEPINE_GRAPH,
    });

    const row = offAxis.ratioGroups.flatMap((g) => g.rows).find((r) => r.featureId === 'ndd_dzp');
    expect(row?.marker?.outOfAxis).toBe('high');

    render(<RatioProfile model={offAxis} />);
    const described = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label') ?? '');

    expect(described.some((l) => l.includes('over aksens øvre ende'))).toBe(true);
  });

  it('announces an interval that leaves the axis only at its far end', () => {
    // The near endpoint is on-axis, so `marker.outOfAxis` is null and the row
    // used to say nothing at all — while the far endpoint sat at 100 exactly
    // like an interval that genuinely ends there.
    const model = buildModel();
    const row = model.ratioGroups.flatMap((g) => g.rows)[0]!;
    const wide = {
      ...model,
      ratioGroups: [
        {
          ...model.ratioGroups[0]!,
          rows: [
            {
              ...row,
              status: 'interval' as const,
              marker: {
                positionPct: 50,
                endPct: 100,
                bound: null,
                isInterval: true,
                outOfAxis: null,
                endOutOfAxis: 'high' as const,
                isZero: false,
              },
            },
          ],
        },
      ],
    };

    render(<RatioProfile model={wide} />);
    const described = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label') ?? '');

    expect(described.some((l) => l.includes('over aksens øvre ende'))).toBe(true);
  });

  it('reports a context edit, and the model for that edit differs', () => {
    // Phase 0's interaction criterion: an edit recomputes without a submit. The
    // two halves are tested separately because they fail separately — a callback
    // that never fires, and a model that ignores what it is given.
    const edits: Array<Record<string, string>> = [];
    render(
      <RatioProfile model={buildModel()} onContextChange={(next) => edits.push(next)} />,
    );

    fireEvent.change(screen.getByLabelText('Hydrolyseprotokoll'), {
      target: { value: 'none' },
    });
    fireEvent.change(screen.getByLabelText('Urinprøve'), { target: { value: 'spot' } });

    // Each edit is a patch naming one field. A caller that replaced its record
    // with the payload would drop the first selection when the second arrived,
    // so the contract is stated here as well as in the prop's docblock.
    expect(edits).toEqual([{ hydro: 'none' }, { umatrix: 'spot' }]);

    const merged = edits.reduce((all, patch) => ({ ...all, ...patch }), {});
    expect(merged).toEqual({ hydro: 'none', umatrix: 'spot' });

    const before = render(<RatioProfile model={buildModel()} />);
    expect(before.container.textContent).toContain('β-glukuronidase');
    before.unmount();

    // "Ingen hydrolyse" rules the conversion out, so the caution the unstated
    // default raises disappears.
    const after = render(<RatioProfile model={buildModel({ hydro: 'none' })} />);
    expect(after.container.textContent).not.toContain('β-glukuronidase');
  });
});

describe('the case data can be edited in place', () => {
  it('reports a concentration edit as a patch', () => {
    // §10's interaction criterion, and the half that was missing: editing a
    // concentration, not only a context field.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile
        model={buildModel()}
        onObservationChange={(patch) => edits.push(patch)}
      />,
    );

    const input = screen.getByLabelText(/Diazepam/);
    fireEvent.change(input, { target: { value: '210.26' } });

    expect(edits).toEqual([{ 'obs-dzp-b': { value: 210.26, reportedDecimals: 2 } }]);
  });

  it('shows the evidence grade beside every signal', () => {
    const { container } = render(<RatioProfile model={buildModel()} />);
    // A validated cut-off and an exploratory reading must not look alike.
    expect(container.textContent).toContain('validert');
  });
});

describe('the ratio section is navigable without sight of the grid (§9.3)', () => {
  it('offers the same ratios as a visually hidden table', () => {
    // Each track names its own row, which serves a reader moving through them
    // one at a time. Comparing several ratios needs structure the tracks cannot
    // give, and the axis beside them is aria-hidden.
    render(<RatioProfile model={buildModel()} />);

    const table = screen.getByRole('table', { name: /Forholdstall som tabell/ });
    expect(table).toBeInTheDocument();

    const rows = screen.getAllByRole('row');
    // One header row plus every rendered ratio.
    const ratioCount = buildModel().ratioGroups.flatMap((g) => g.rows).length;
    expect(rows).toHaveLength(ratioCount + 1);

    // The cross-matrix row's two bases, which the grid distinguishes by
    // position and a label a screen reader never reaches.
    const withinRow = screen.getByRole('row', { name: /1,45/ });
    expect(withinRow).toBeInTheDocument();
  });

  it('states the case-data row state in words, not only in colour', () => {
    // `missing`, `assumed` and `known` are told apart by text colour alone in
    // the visual layout, and colour is not information a screen reader or a
    // colour-blind reader receives.
    const { container } = render(<RatioProfile model={buildModel()} />);
    const text = container.textContent ?? '';

    expect(text).toContain('(mangler)');
  });

  it('names the concentration field with a label element', () => {
    // `aria-label` names the field for assistive technology and gives a
    // pointer user no click target at all.
    render(<RatioProfile model={buildModel()} onObservationChange={() => {}} />);

    const input = screen.getByLabelText(/Diazepam/);
    expect(input.closest('label')).not.toBeNull();
  });
});

describe('editing does not invent values', () => {
  it('ignores a cleared field rather than reading it as zero', () => {
    // Number('') is 0, so a blank editing state would otherwise become a
    // quantified zero and recompute the whole profile from it.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    const input = screen.getByLabelText(/Diazepam/);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '-5' } });

    expect(edits).toEqual([]);
  });

  it('accepts the decimal separator it displays', () => {
    // The field shows `315,39`; a reader retyping what they can see must not
    // have it silently discarded. `Number('315,39')` is NaN, and a
    // `<input type="number">` rejects the comma before it ever gets parsed.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    fireEvent.change(screen.getByLabelText(/Diazepam/), { target: { value: '210,26' } });

    expect(edits).toEqual([{ 'obs-dzp-b': { value: 210.26, reportedDecimals: 2 } }]);
  });

  it('offers a grouped value in a form that can actually be edited', () => {
    // The fixture's 2250 nmol/L reads as `2 250`, and that string cannot be
    // typed back: the parser rejects Norwegian's non-breaking space outright.
    // An editable field bound to the display value can only be cleared.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    const input = screen.getByLabelText(/N-desmetyldiazepam — urine-1/) as HTMLInputElement;
    expect(input.value).toBe('2250');

    fireEvent.change(input, { target: { value: '2251' } });
    expect(edits).toEqual([{ 'obs-ndd-u': { value: 2251, reportedDecimals: 0 } }]);
  });

  it('keeps the precision of a value entered in scientific notation', () => {
    // `1e-7` has no decimal separator. Recording zero decimals and then
    // treating that as the reported precision renders the measurement as `0`
    // while the engine goes on computing from 1e-7.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    fireEvent.change(screen.getByLabelText(/Diazepam/), { target: { value: '1e-7' } });

    expect(edits).toEqual([{ 'obs-dzp-b': { value: 1e-7, reportedDecimals: 7 } }]);
  });

  it('offers no number to edit on a censored result', () => {
    // The type permits a censored observation to carry a `value`, and an import
    // can produce one. The engine reads the limit rather than the value for a
    // censored qualifier, so presenting the number as editable hides the
    // qualifier and its threshold and accepts edits that change no ratio.
    const censored = buildProfileFromCase({
      caseData: {
        ...DIAZEPAM_FIXTURE_CASE,
        observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
          o.id === 'obs-dzp-b'
            ? {
                ...o,
                qualifier: 'below_limit' as const,
                limitRef: { label: 'rapporteringsgrense', value: 10, unit: 'nmol/L' },
              }
            : o,
        ),
      },
      modules: [BENZODIAZEPINE_MODULE],
      graph: BENZODIAZEPINE_GRAPH,
    });

    const { container } = render(
      <RatioProfile model={censored} onObservationChange={() => {}} />,
    );

    expect(screen.queryByLabelText(/Diazepam/)).toBeNull();
    // The qualifier and its threshold are what the row states instead.
    expect(container.textContent).toContain('under');
    expect(container.textContent).toContain('rapporteringsgrense');
  });

  it('keeps a trailing zero the reader typed', () => {
    // `1,50` and `1,5` parse to the same number and say different things about
    // the assay's precision. JavaScript cannot hold the distinction, so the
    // patch carries it: reconstructing the display from the number afterwards
    // would drop the laboratory's last significant digit.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    fireEvent.change(screen.getByLabelText(/Diazepam/), { target: { value: '1,50' } });

    expect(edits).toEqual([{ 'obs-dzp-b': { value: 1.5, reportedDecimals: 2 } }]);
  });

  it('refuses an entry that could mean two things a thousandfold apart', () => {
    // `1,500` is 1.5 or 1500 depending on the reader. On a forensic
    // concentration, picking one is a 1000× error, so it is rejected visibly
    // rather than resolved quietly.
    const edits: Array<Record<string, ObservationEdit>> = [];
    render(
      <RatioProfile model={buildModel()} onObservationChange={(patch) => edits.push(patch)} />,
    );

    const input = screen.getByLabelText(/Diazepam/);
    fireEvent.change(input, { target: { value: '1,500' } });

    expect(edits).toEqual([]);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Tvetydig/)).toBeInTheDocument();
  });

  it('lets the field stay empty while a new value is typed', () => {
    // The model holds only values the engine would compute from, so a controlled
    // input reading straight from it restores the old number the instant the
    // field is cleared — and the reader cannot replace a value, only prepend to
    // it. Emitting nothing and displaying nothing are separate obligations.
    render(<RatioProfile model={buildModel()} onObservationChange={() => {}} />);

    const input = screen.getByLabelText(/Diazepam/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });

    expect(input.value).toBe('');
  });
});

describe('every number on screen is in the reader’s locale', () => {
  it('formats a read-only concentration with the locale separator', () => {
    // Read-only because no edit callback is passed — the report path. A raw JS
    // number here would put a decimal point beside the comma-formatted ratios.
    const { container } = render(<RatioProfile model={buildModel()} />);
    const text = container.textContent ?? '';

    expect(text).toContain('315,39');
    expect(text).not.toContain('315.39');
  });

  it('names an out-of-module analyte by its identity, never by its row id', () => {
    // A panel routinely reports substances no loaded module declares. Their
    // label key is empty, and falling back to the observation id shows a reader
    // an opaque record identifier — a UUID, once cases are stored — where an
    // analyte name belongs.
    const withUnrelated = buildProfileFromCase({
      caseData: {
        ...DIAZEPAM_FIXTURE_CASE,
        observations: [
          ...DIAZEPAM_FIXTURE_CASE.observations,
          {
            id: '9f1c6b7e-0a2d-4c11-9d34-8e0f5b2a7c61',
            specimenId: 'blood-1',
            analyte: { pubchemCid: 702, slug: 'etanol' },
            value: 400,
            unit: 'nmol/L',
            qualifier: 'quantified' as const,
          },
        ],
      },
      modules: [BENZODIAZEPINE_MODULE],
      graph: BENZODIAZEPINE_GRAPH,
    });

    const { container } = render(<RatioProfile model={withUnrelated} />);
    const text = container.textContent ?? '';

    expect(text).toContain('etanol');
    expect(text).not.toContain('9f1c6b7e');
  });

  it('shows the creatinine every normalised value is computed from', () => {
    // The method line discloses the reference the correction targets. Without
    // the measured value beside it, a reader can see the correction and its
    // target but not its input — so an erroneous specimen value has nowhere to
    // become visible, and the normalised figures cannot be checked at all.
    const { container } = render(<RatioProfile model={buildModel()} />);
    const text = container.textContent ?? '';

    expect(text).toContain('Kreatinin');
    expect(text).toContain('13,26');
    expect(text).toContain('mmol/L');
  });

  it('keeps every reported decimal rather than rounding to the ratio ladder', () => {
    // The ratio ladder gives a three-digit magnitude zero decimals, which would
    // silently drop what the laboratory reported.
    const { container } = render(<RatioProfile model={buildModel()} />);
    expect(container.textContent).toContain('457,317');
  });
});

describe('a context value the registry no longer offers', () => {
  it('shows it as unknown rather than as the first option in the list', () => {
    // An option withdrawn since the case was saved. The engine already treats
    // the field as missing; a <select> with no matching option displays its
    // first one, so the screen would report a known answer for a gap.
    const model = buildModel({ hydro: 'retired_protocol' });
    const field = model.contextFields.find((f) => f.id === 'hydro');
    expect(field?.state).toBe('missing');

    render(<RatioProfile model={model} onContextChange={() => {}} />);

    const select = screen.getByLabelText('Hydrolyseprotokoll') as HTMLSelectElement;
    expect(select.value).toBe('retired_protocol');
    expect(select.selectedOptions[0]?.textContent).toBe('Ukjent verdi');
  });
});
