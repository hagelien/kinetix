/**
 * The controls are the only place the simulator can qualify a percentile line.
 * A reader working from the chart never opens the monograph, so anything the
 * source says about how its numbers may be used has to be reachable here.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18nApp from '@/i18n';
import { PmReferenceLineControls } from './PmReferenceLineControls';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_PM_LINE_SETTINGS } from '@/lib/pmConcentrations';

// Synthetic cohort: every name, citation and caveat here is invented.
const SOURCE = {
  key: 'synthetic-test-cohort',
  citation: 'Syntetisk testkohort, oppdiktede tall (kun for tester)',
  shortLabel: 'Syntetisk',
  heading: 'Syntetiske postmortale testdata',
  matrix: 'postmortem_femoral_blood',
  unit: 'mg/L',
  description: '',
  caveats: [
    'Syntetisk forbehold én.',
    'Syntetisk forbehold to.',
  ],
};

function renderControls(overrides = {}) {
  return render(
    <PmReferenceLineControls
      sources={[SOURCE]}
      availableStatistics={['median', 'p90']}
      conversionUnavailableFor={[]}
      reviewNotes={[]}
      {...overrides}
    />,
  );
}

describe('PmReferenceLineControls', () => {
  // Per test, not once per file: another suite in this worker pins 'en' in
  // its own beforeEach, and i18n is a shared singleton — a beforeAll here is
  // silently undone by whatever runs in between.
  beforeEach(async () => {
    await i18nApp.changeLanguage('nb');
    useAppStore.setState({ pmLines: DEFAULT_PM_LINE_SETTINGS });
  });

  it('leads with the source heading, not with checkboxes', () => {
    renderControls();
    expect(
      screen.getByText('Syntetiske postmortale testdata'),
    ).toBeTruthy();
  });

  it("shows the source's own caveats once expanded", () => {
    renderControls();
    fireEvent.click(
      screen.getByText('Syntetiske postmortale testdata'),
    );

    expect(
      screen.getByText('Syntetisk forbehold én.'),
    ).toBeTruthy();
    expect(screen.getByText('Syntetisk forbehold to.')).toBeTruthy();
    expect(
      screen.getByText('Syntetisk testkohort, oppdiktede tall (kun for tester)'),
    ).toBeTruthy();
  });

  it('names a substance whose analyte mapping is unconfirmed', () => {
    // Its lines are drawn — the numbers are the source's — but never silently.
    renderControls({
      reviewNotes: [
        { label: 'Mockamine, 4-hydroxy-', note: 'Bekreft analytten.' },
      ],
    });
    fireEvent.click(
      screen.getByText('Syntetiske postmortale testdata'),
    );

    expect(screen.getByText(/Mockamine, 4-hydroxy-/)).toBeTruthy();
    expect(screen.getByText(/Bekreft analytten\./)).toBeTruthy();
  });

  it('does not let one cohort\'s heading speak for another', () => {
    // Two cohorts, two sets of caveats. Labelling the panel with the first
    // heading would qualify the second cohort's lines with the wrong sentence
    // — and "first" is only query row order.
    const other = {
      ...SOURCE,
      key: 'annen-kohort',
      shortLabel: 'Annen 2024',
      heading: 'Annen postmortal kohort',
      citation: 'Annen kilde, 2024',
      caveats: ['Andre forbehold.'],
    };
    renderControls({ sources: [SOURCE, other] });

    // The collapsed label is generic, not either cohort's heading.
    expect(
      screen.queryByText('Syntetiske postmortale testdata'),
    ).toBeNull();
    fireEvent.click(screen.getByText('Postmortale data'));

    // Expanded, each cohort carries its own heading and caveats.
    expect(
      screen.getByText('Syntetiske postmortale testdata'),
    ).toBeTruthy();
    expect(screen.getByText('Annen postmortal kohort')).toBeTruthy();
    expect(screen.getByText('Andre forbehold.')).toBeTruthy();
  });

  it('renders nothing when no cohort covers the chart', () => {
    const { container } = renderControls({ sources: [] });
    expect(container.firstChild).toBeNull();
  });

  it('disables a statistic no visible substance can draw', () => {
    renderControls({ availableStatistics: ['median'] });
    fireEvent.click(
      screen.getByText('Syntetiske postmortale testdata'),
    );

    const p90 = screen.getByText('90. persentil').closest('button')!;
    expect(p90.hasAttribute('disabled')).toBe(true);
  });
});
