/**
 * The entity monograph's target-pharmacology collection: the ligand table,
 * the assay-species filter and the activity-grouped measurement plot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18nApp from '@/i18n';
import { EntityTargetLigands } from './EntityTargetLigands';
import { fetchEntityTargetLigands } from '@/lib/bioEntitiesApi';
import type { EntityTargetLigand } from '@/lib/receptorTargets';

vi.mock('@/lib/bioEntitiesApi', () => ({
  fetchEntityTargetLigands: vi.fn(),
}));

function ligand(
  overrides: Partial<EntityTargetLigand> & {
    relationshipId: number;
    drugSlug: string;
  },
): EntityTargetLigand {
  return {
    drugId: overrides.relationshipId,
    drugNames: { nb: overrides.drugSlug, en: overrides.drugSlug },
    drugMonographSlug: null,
    interactionType: 'agonist',
    tier: null,
    affinity: null,
    potency: null,
    efficacy: null,
    ki: null,
    ic50: null,
    ec50: null,
    emax: null,
    selectivityRatio: null,
    assaySpecies: null,
    referenceIds: [],
    evidenceNote: null,
    ...overrides,
  };
}

const LIGANDS: EntityTargetLigand[] = [
  ligand({
    relationshipId: 1,
    drugSlug: 'morphine',
    drugMonographSlug: 'morfin',
    interactionType: 'agonist',
    ki: { min: 1, max: 3, unit: 'nM', note: 'guinea pig ileum' },
    ec50: { median: 40, unit: 'nM' },
    assaySpecies: 'Homo sapiens',
    referenceIds: [11, 12],
    evidenceNote: 'Summarised from two binding studies.',
  }),
  ligand({
    relationshipId: 2,
    drugSlug: 'buprenorphine',
    interactionType: 'partial_agonist',
    ki: { median: 0.2, unit: 'nM' },
    assaySpecies: 'Rattus norvegicus',
  }),
  ligand({
    relationshipId: 3,
    drugSlug: 'naloxone',
    interactionType: 'antagonist',
    // Qualitative only — no measurement at all.
    assaySpecies: null,
  }),
  ligand({
    relationshipId: 4,
    drugSlug: 'oliceridine',
    interactionType: 'biased_agonist',
    ki: { median: 6, unit: 'nM' },
    assaySpecies: 'recombinant human (HEK293)',
  }),
  ligand({
    relationshipId: 5,
    drugSlug: 'tramadol',
    interactionType: 'agonist',
    ki: { median: 2.4, unit: 'ng/mL' },
    assaySpecies: 'HEK293',
  }),
];

function renderSection() {
  return render(
    <MemoryRouter>
      <EntityTargetLigands entityId={7} />
    </MemoryRouter>,
  );
}

function tableRows() {
  return screen
    .getAllByTestId('target-ligand-row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent);
}

function plottedDrugs() {
  return screen
    .queryAllByTestId('target-plot-point')
    .map((point) => point.getAttribute('data-drug'));
}

describe('EntityTargetLigands', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18nApp.changeLanguage('en');
  });

  it('renders nothing when no relationship points at the entity', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue([]);
    const { container } = renderSection();
    await waitFor(() =>
      expect(fetchEntityTargetLigands).toHaveBeenCalledWith(7, expect.anything()),
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists every relationship, including qualitative-only and unstated-species rows', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue(LIGANDS);
    renderSection();

    expect(
      await screen.findByRole('heading', { name: /target pharmacology/i }),
    ).toBeInTheDocument();
    expect(tableRows()).toEqual([
      'Morphine',
      'Buprenorphine',
      'Naloxone',
      'Oliceridine',
      'Tramadol',
    ]);
    const naloxoneRow = screen.getAllByTestId('target-ligand-row')[2]!;
    // Null species is spelled out, never shown as human.
    expect(within(naloxoneRow).getByText('Unstated')).toBeInTheDocument();
    // A range stays a range in the table.
    const morphineRow = screen.getAllByTestId('target-ligand-row')[0]!;
    expect(within(morphineRow).getByText('1–3 nM')).toBeInTheDocument();
    // The stored interaction type is shown as recorded, not re-labelled.
    expect(within(screen.getAllByTestId('target-ligand-row')[1]!).getByText('partial agonist')).toBeInTheDocument();
    expect(within(screen.getAllByTestId('target-ligand-row')[3]!).getByText('biased agonist')).toBeInTheDocument();
    // The drug links to its monograph when one exists, else the drug route.
    expect(screen.getByRole('link', { name: 'Morphine' })).toHaveAttribute(
      'href',
      '/wiki/morfin',
    );
    expect(screen.getByRole('link', { name: 'Naloxone' })).toHaveAttribute(
      'href',
      '/wiki/drug/3',
    );
  });

  it('plots Ki by default and keeps unknown interaction types under Other', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue(LIGANDS);
    renderSection();
    await screen.findByTestId('target-activity-plot');

    expect(screen.getByLabelText('Measurement')).toHaveValue('ki');
    // Tramadol's ng/mL "Ki" is not a molar concentration: in the table, not the plot.
    expect(plottedDrugs()).toEqual(['morphine', 'buprenorphine', 'oliceridine']);
    expect(screen.getByTestId('target-plot-omitted')).toHaveTextContent(
      /not a molar concentration/i,
    );
    expect(tableRows()).toContain('Tramadol');

    const other = screen.getByRole('group', { name: 'Other / unspecified' });
    expect(within(other).getByText('Oliceridine')).toBeInTheDocument();
    // The morphine Ki has no median: the plot shows its range, not a midpoint.
    const morphinePoint = screen
      .getAllByTestId('target-plot-point')
      .find((p) => p.getAttribute('data-drug') === 'morphine')!;
    expect(within(morphinePoint).getByText('1–3 nM')).toBeInTheDocument();
    expect(within(morphinePoint).queryByText(/^2 nM/)).toBeNull();
  });

  it('selecting EC50 drops rows without an EC50 from the plot but not the table', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue(LIGANDS);
    renderSection();
    await screen.findByTestId('target-activity-plot');

    fireEvent.change(screen.getByLabelText('Measurement'), {
      target: { value: 'ec50' },
    });

    expect(plottedDrugs()).toEqual(['morphine']);
    expect(tableRows()).toHaveLength(5);
  });

  it('applies the species filter to both the table and the plot', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue(LIGANDS);
    renderSection();
    await screen.findByTestId('target-activity-plot');

    // Counts per class are visible on the control.
    expect(screen.getByRole('radio', { name: /^human 2/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /non-human 2/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /unstated 1/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /^human/i }));
    expect(tableRows()).toEqual(['Morphine', 'Oliceridine']);
    expect(plottedDrugs()).toEqual(['morphine', 'oliceridine']);

    fireEvent.click(screen.getByRole('radio', { name: /unstated/i }));
    expect(tableRows()).toEqual(['Naloxone']);
    // Nothing in this selection has a measurement: the plot says so in text.
    expect(plottedDrugs()).toEqual([]);
    expect(screen.getByText(/no measurement in this selection/i)).toBeInTheDocument();
  });

  it('reveals evidence notes and references without hover', async () => {
    vi.mocked(fetchEntityTargetLigands).mockResolvedValue(LIGANDS);
    renderSection();
    const toggle = await screen.findByRole('button', {
      name: /evidence details for morphine/i,
    });
    expect(toggle).toHaveTextContent('2 references');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('Summarised from two binding studies.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ki: guinea pig ileum/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#11' })).toHaveAttribute(
      'href',
      '/references/11',
    );
  });

  it('fails locally with a retry instead of breaking the page', async () => {
    vi.mocked(fetchEntityTargetLigands)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(LIGANDS);
    renderSection();

    expect(
      await screen.findByText(/could not load the target pharmacology/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByTestId('target-activity-plot')).toBeInTheDocument();
    expect(fetchEntityTargetLigands).toHaveBeenCalledTimes(2);
  });
});
