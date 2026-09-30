import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkbookForwardPanel } from './WorkbookForwardPanel';
import type { EtohParityInput } from '@/lib/etohWorkbookFlows';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'nb' },
  }),
}));

const baseInput: EtohParityInput = {
  drinkStopTime: 0, // doubles as drinkStartTime in the forward adapter
  eventTime: 2 / 24, // 02:00 — two hours after the drink window begins
  sampleTime: 0.8333333333,
  detectedPromille: 0.84,
  eliminationMin: 0.1,
  eliminationLikely: 0.15,
  absorptionMinHours: 3,
  absorptionLikelyHours: 1,
  drinksMl: [330, 0, 0, 0, 0, 0],
  drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
  firstPassMinPercent: 15,
  firstPassLikelyPercent: 25,
  weightKg: 78,
  widmarkR: 0.7,
  sexMale01: 1,
  heightCm: 182,
  ageYears: 35,
};

describe('WorkbookForwardPanel', () => {
  it('renders both theoretical and forward-projected sections (Phase J2)', () => {
    render(<WorkbookForwardPanel inputs={baseInput} />);

    // Section dividers — proves both are rendered.
    expect(screen.getByTestId('forward-theoretical')).toBeTruthy();
    expect(screen.getByTestId('forward-projected')).toBeTruthy();

    // Tier labels (Widmark + Watson, theoretical + projected).
    expect(screen.getByText('ethanol.forwardPanel.theoreticalHigh')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.theoreticalLikely')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.theoreticalLow')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.theoreticalHighWattson')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.forwardHigh')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.forwardLikely')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.forwardLow')).toBeTruthy();
    expect(screen.getByText('ethanol.forwardPanel.forwardLowWattson')).toBeTruthy();
  });

  it('passes the engine output through to the rendered cells', () => {
    // 3.3 dL × 4.7% × 0.8 = 12.408 g, kg×r = 78×0.7 = 54.6.
    // Theoretical high (firstPassMin=15): 12.408 * 0.85 / 54.6 ≈ 0.193144 → "0,19" in nb-NO.
    render(<WorkbookForwardPanel inputs={baseInput} />);
    expect(screen.getByText('0,19')).toBeTruthy();
  });
});
