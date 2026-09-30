/**
 * The §5.1 review workspace, and the two states around it.
 *
 * The gate's own contract is that "hidden still shows the reason and the evidence
 * record", and that a grade D reaches a reviewer only "through a recorded
 * acknowledgement, in a labelled review workspace". Both are user-visible claims, so
 * they are pinned here rather than left to the policy unit tests: the policy can be
 * right and the surface still silent.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelGradeNotice } from '@/components/modeling/ModelGradeNotice';
import type { GradePolicyResult } from '@/lib/kinetics-core';

const D_POLICY: GradePolicyResult = {
  grade: 'D',
  limitingDimensions: ['parameter-provenance', 'uncertainty-semantics'],
  disclosable: [
    {
      dimension: 'parameter-provenance',
      grade: 'D',
      reason: 'Per-input provenance is not recorded for a derived model.',
    },
    {
      dimension: 'uncertainty-semantics',
      grade: 'D',
      reason: 'Every parameter is fixed at its median.',
    },
  ],
  hardStops: [],
};

const HARD_STOP: GradePolicyResult = {
  grade: 'ungraded',
  limitingDimensions: [],
  disclosable: [
    {
      dimension: 'matrix-route-match',
      grade: 'hard-stop',
      reason: 'The requested route is not one this model declares.',
    },
  ],
  hardStops: [
    {
      dimension: 'matrix-route-match',
      grade: 'hard-stop',
      reason: 'The requested route is not one this model declares.',
    },
  ],
};

describe('ModelGradeNotice — the review workspace', () => {
  it('itemises what is being acknowledged before offering the acknowledgement', () => {
    // An acknowledgement of an unstated deficiency is not an informed one, so the
    // button must never be the only thing in this state.
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="acknowledge-in-review-workspace"
        drugLabel="Test drug"
        onAcknowledge={() => {}}
      />,
    );
    // The test harness leaves i18n keys unresolved, so the keys are what is asserted.
    expect(screen.getByText(/modelGrade\.reviewWorkspace/)).toBeInTheDocument();
    expect(screen.getByText('modelGrade.acknowledgementRequired')).toBeInTheDocument();
    // §5.1 requires the exploratory / may-be-qualitatively-wrong / not-for-decisions
    // statement before the acknowledgement is offered.
    expect(screen.getByText('modelGrade.acknowledgementWarning')).toBeInTheDocument();
    expect(screen.getByText(/Test drug/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'modelGrade.acknowledgeAction' }),
    ).toBeInTheDocument();
  });

  it('states THIS model’s own limitations, not the generic per-dimension copy', () => {
    // The generic copy is written for the grade-C case and is materially false here:
    // it calls uncertainty-semantics a band whose probability meaning is unestablished,
    // when a derived model emits no band at all. Consent to a wrong paraphrase is not
    // informed consent.
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="acknowledge-in-review-workspace"
        onAcknowledge={() => {}}
      />,
    );
    expect(screen.getByText(/Every parameter is fixed at its median/)).toBeInTheDocument();
    expect(
      screen.getByText(/Per-input provenance is not recorded for a derived model/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/modelGrade\.dimensionWhy\.uncertainty-semantics/),
    ).not.toBeInTheDocument();
  });

  it('records the acknowledgement when the reviewer accepts', () => {
    const onAcknowledge = vi.fn();
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="acknowledge-in-review-workspace"
        onAcknowledge={onAcknowledge}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'modelGrade.acknowledgeAction' }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('offers no acknowledgement on a hard stop', () => {
    // A hard stop is not a low grade: no role, acknowledgement or amendment reaches
    // it, and offering the control would imply otherwise. The disposition is what
    // withholds it — `renderDisposition` never returns the workspace for an ungraded
    // result — so this pins that the component follows the disposition, not the grade.
    render(
      <ModelGradeNotice
        policy={HARD_STOP}
        disposition="hidden"
        onAcknowledge={() => {}}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('states the reason when a model is withheld, rather than showing nothing', () => {
    render(<ModelGradeNotice policy={HARD_STOP} disposition="hidden" drugLabel="Test drug" />);
    expect(screen.getByText(/Test drug/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('states the reason for a hard stop that carries an empty disclosable list', () => {
    // `gradeResult`'s "derived model with no committed grade" result is built by hand
    // and puts its one dimension in `hardStops` only. Reading `disclosable` alone
    // rendered the heading over an EMPTY list — no reason at all, on the result that
    // most needs one.
    render(
      <ModelGradeNotice
        policy={{ ...HARD_STOP, disclosable: [] }}
        disposition="hidden"
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('says a rendered curve is rendering on the viewer’s own acknowledgement', () => {
    // Without this the acknowledgement is invisible and irreversible from the UI:
    // the model would read as ordinarily renderable from here on.
    const onWithdraw = vi.fn();
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        acknowledged
        onWithdraw={onWithdraw}
      />,
    );
    expect(screen.getByText('modelGrade.acknowledgedByYou')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'modelGrade.withdrawAction' }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it('shows when the acknowledgement was recorded, when the record says', () => {
    // Part of the record §5.1 asks for: actor, version, and time.
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        acknowledged
        acknowledgedAt="2026-08-27T09:00:00.000Z"
      />,
    );
    expect(screen.getByText('modelGrade.acknowledgedByYouAt')).toBeInTheDocument();
  });

  it('states a simplified structure at the acknowledged curve, in the viewer’s language', () => {
    // Regression: the generic completeness copy only says an input was defaulted, so
    // a two-compartment declaration drawn one-compartment vanished from the curve.
    // It is stated through a translated key, never the scorer's English prose.
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        acknowledged
        simplifications={[
          { axis: 'disposition', declared: 'two-compartment', runs: 'one-compartment' },
        ]}
      />,
    );
    expect(screen.getByTestId('model-simplification')).toHaveTextContent(
      'modelGrade.simplifiedStructure',
    );
    expect(screen.queryByText(/Per-input provenance/)).not.toBeInTheDocument();
  });

  it('states a simplified structure in the review workspace too, before acknowledgement', () => {
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="acknowledge-in-review-workspace"
        simplifications={[
          { axis: 'disposition', declared: 'two-compartment', runs: 'one-compartment' },
        ]}
      />,
    );
    expect(screen.getByTestId('model-simplification')).toBeInTheDocument();
  });

  it('states each cautious default at the curve through its translated key', () => {
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        acknowledged
        cautiousDefaults={['bioavailability']}
      />,
    );
    const notes = screen.getAllByTestId('model-cautious-default');
    expect(notes.map((n) => n.textContent)).toEqual(['modelGrade.cautiousDefault.bioavailability']);
  });

  it('states a cautious default in the review workspace too, before acknowledgement', () => {
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="acknowledge-in-review-workspace"
        cautiousDefaults={['bioavailability']}
      />,
    );
    expect(screen.getByTestId('model-cautious-default')).toBeInTheDocument();
  });

  it('adds no simplification note when the curve runs the declared structure', () => {
    render(<ModelGradeNotice policy={D_POLICY} disposition="render-with-limitations" acknowledged />);
    expect(screen.queryByTestId('model-simplification')).not.toBeInTheDocument();
  });

  it('says nothing about an acknowledgement for a model that did not need one', () => {
    render(<ModelGradeNotice policy={D_POLICY} disposition="render-with-limitations" />);
    expect(screen.queryByText('modelGrade.acknowledgedByYou')).not.toBeInTheDocument();
  });
});

describe('ModelGradeNotice — naming a band that exists', () => {
  // The uncertainty-semantics disclosure says the SHADED BAND is a plausible
  // range. With every model parameter fixed the run collapses onto one curve
  // and there is no shaded band on the chart, so that sentence describes
  // something the reader cannot see.
  it('describes the plausible range when a band was reported', () => {
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        hasBand
      />,
    );
    expect(screen.getByText('modelGrade.plausibleRange')).toBeTruthy();
    expect(screen.queryByText('modelGrade.noBandReported')).toBeNull();
  });

  it('says there is no band when the run was deterministic', () => {
    render(
      <ModelGradeNotice
        policy={D_POLICY}
        disposition="render-with-limitations"
        hasBand={false}
      />,
    );
    expect(screen.getByText('modelGrade.noBandReported')).toBeTruthy();
    expect(screen.queryByText('modelGrade.plausibleRange')).toBeNull();
  });
});
