import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReceptorTargetEditForm } from './ReceptorTargetEditForm';
import type { DrugReceptorTargetSummary } from '@/lib/receptorTargets';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'paramEdit.min': 'Min',
        'paramEdit.max': 'Max',
        'paramEdit.unit': 'Unit',
        'mechanismEdit.metricMean': 'Mean',
        'mechanismEdit.metricMedian': 'Median',
        'mechanismEdit.metricAffinity': 'Affinity',
        'mechanismEdit.metricNumberInvalid': `${String(
          opts?.metric ?? '',
        )}: not a finite number`,
      };
      return labels[key] ?? key;
    },
  }),
}));

interface MechanismsPayload {
  mechanisms: Array<{ affinity?: Record<string, unknown> }>;
}

let lastPayload: MechanismsPayload | null = null;
const submitDrugReceptorTargets = vi.fn(
  async (_drugId: number, input: MechanismsPayload) => {
    lastPayload = input;
    return { ok: true as const };
  },
);

vi.mock('@/lib/drugApi', () => ({
  ApiError: class ApiError extends Error {
    code?: string;
  },
  submitDrugReceptorTargets: (drugId: number, input: MechanismsPayload) =>
    submitDrugReceptorTargets(drugId, input),
  searchReceptorTargets: vi.fn(async () => []),
}));

vi.mock('./ReferenceInput', () => ({
  ReferenceInput: () => <div data-testid="reference-input" />,
}));

vi.mock('@/lib/usePermissions', () => ({ useCan: () => true }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

/**
 * A mechanism seeded by the research importer: one reported affinity, stored
 * as a median with no min/max. The form used to bind min/max/unit only, so
 * this value was invisible AND was wiped by the next (full-replace) save.
 */
function medianOnlyTarget(): DrugReceptorTargetSummary {
  return {
    id: 1,
    drugId: 7,
    receptorTargetId: 42,
    interactionType: 'reuptake_inhibitor',
    tier: 'primary',
    affinity: { median: 8.9, unit: 'nM' },
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
    target: {
      id: 42,
      slug: 'slc6a4',
      symbol: 'SLC6A4',
      name: 'Serotonintransportør',
      nameEn: 'Serotonin transporter',
      targetClass: 'transporter',
      organism: 'Homo sapiens',
    },
  };
}

async function waitForPayload(): Promise<MechanismsPayload> {
  await waitFor(() => expect(lastPayload).not.toBeNull());
  return lastPayload as unknown as MechanismsPayload;
}

function renderForm(target: DrugReceptorTargetSummary) {
  return render(
    <ReceptorTargetEditForm
      drugId={7}
      drugName="venlafaxin"
      receptorTargets={[target]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

describe('ReceptorTargetEditForm measurements', () => {
  beforeEach(() => {
    submitDrugReceptorTargets.mockClear();
    lastPayload = null;
  });

  it('shows a stored median-only affinity and round-trips it on save', async () => {
    renderForm(medianOnlyTarget());

    // The panel opens by itself because the mechanism carries measurements.
    const median = screen.getByLabelText('Affinity Median') as HTMLInputElement;
    expect(median.value).toBe('8.9');
    expect(
      (screen.getByLabelText('Affinity Unit') as HTMLInputElement).value,
    ).toBe('nM');

    fireEvent.click(screen.getByText('paramEdit.savePublish'));

    const payload = await waitForPayload();
    expect(payload.mechanisms[0]?.affinity).toEqual({
      median: 8.9,
      unit: 'nM',
    });
  });

  it('sends an edited mean and median alongside the range', async () => {
    renderForm(medianOnlyTarget());

    fireEvent.change(screen.getByLabelText('Affinity Min'), {
      target: { value: '7,5' },
    });
    fireEvent.change(screen.getByLabelText('Affinity Max'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Affinity Mean'), {
      target: { value: '8.7' },
    });

    fireEvent.click(screen.getByText('paramEdit.savePublish'));

    const payload = await waitForPayload();
    expect(payload.mechanisms[0]?.affinity).toEqual({
      min: 7.5,
      max: 10,
      mean: 8.7,
      median: 8.9,
      unit: 'nM',
    });
  });

  it('refuses to submit an unparseable number instead of posting NaN', async () => {
    renderForm(medianOnlyTarget());

    fireEvent.change(screen.getByLabelText('Affinity Median'), {
      target: { value: '1,500' },
    });
    fireEvent.click(screen.getByText('paramEdit.savePublish'));

    expect(
      await screen.findByText('Affinity: not a finite number'),
    ).toBeInTheDocument();
    expect(submitDrugReceptorTargets).not.toHaveBeenCalled();
  });
});
