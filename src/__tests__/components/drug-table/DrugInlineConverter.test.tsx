import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '@/i18n';
import { DrugInlineConverter } from '@/components/drug-table/DrugInlineConverter';
import type { DrugComponent } from '@/types';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function makeDrug(overrides: Partial<DrugComponent> = {}): DrugComponent {
  return {
    id: '5288826',
    names: { primary: 'Morphine' },
    nameShort: 'Morphine',
    molecularWeight: 285.34,
    bloodPlasmaRatio: 1,
    ...overrides,
  } as unknown as DrugComponent;
}

describe('DrugInlineConverter', () => {
  it('converts molar → mass instantly when source field is edited', () => {
    render(<DrugInlineConverter drug={makeDrug()} />);
    const molarInput = screen.getByLabelText(
      /from concentration/i,
    ) as HTMLInputElement;
    const massInput = screen.getByLabelText(
      /to concentration/i,
    ) as HTMLInputElement;

    // 1 µmol/L morphine ≈ 0.285 mg/L (MW 285.34, blood↔blood, B/P 1).
    fireEvent.change(molarInput, { target: { value: '1' } });

    expect(molarInput.value).toBe('1');
    const target = Number(massInput.value);
    expect(Number.isFinite(target)).toBe(true);
    expect(target).toBeGreaterThan(0.28);
    expect(target).toBeLessThan(0.29);
  });

  it('converts mass → molar instantly when target field is edited', () => {
    render(<DrugInlineConverter drug={makeDrug()} />);
    const molarInput = screen.getByLabelText(
      /from concentration/i,
    ) as HTMLInputElement;
    const massInput = screen.getByLabelText(
      /to concentration/i,
    ) as HTMLInputElement;

    fireEvent.change(massInput, { target: { value: '0.285' } });

    expect(massInput.value).toBe('0.285');
    const back = Number(molarInput.value);
    expect(Number.isFinite(back)).toBe(true);
    expect(back).toBeGreaterThan(0.99);
    expect(back).toBeLessThan(1.01);
  });

  it('accepts a comma as the decimal separator (Norwegian keyboards)', () => {
    render(<DrugInlineConverter drug={makeDrug()} />);
    const molarInput = screen.getByLabelText(
      /from concentration/i,
    ) as HTMLInputElement;
    const massInput = screen.getByLabelText(
      /to concentration/i,
    ) as HTMLInputElement;

    // "0,76" must behave identically to "0.76".
    fireEvent.change(molarInput, { target: { value: '0,76' } });

    expect(molarInput.value).toBe('0,76');
    const target = Number(massInput.value);
    expect(Number.isFinite(target)).toBe(true);
    // 0.76 µmol/L morphine ≈ 0.217 mg/L (MW 285.34, blood↔blood, B/P 1).
    expect(target).toBeGreaterThan(0.21);
    expect(target).toBeLessThan(0.22);
  });

  it('converts blood molar → plasma molar (same kind, both sides molar)', () => {
    // Valproate-like: B/P midpoint 0.55 from a 0.5–0.6 range. blood = plasma × ratio,
    // so plasma = blood / 0.55.
    render(
      <DrugInlineConverter
        drug={makeDrug({
          molecularWeight: 144.21,
          bloodPlasmaRatio: { min: 0.5, max: 0.6 } as unknown as DrugComponent['bloodPlasmaRatio'],
        })}
      />,
    );
    const fromInput = screen.getByLabelText(/from concentration/i) as HTMLInputElement;
    const toInput = screen.getByLabelText(/to concentration/i) as HTMLInputElement;

    // Make the target unit molar (µmol/L) and matrix plasma; source stays blood µmol/L.
    fireEvent.change(screen.getByLabelText(/to unit/i), { target: { value: 'µmol/L' } });
    fireEvent.change(screen.getByLabelText(/from matrix/i), { target: { value: 'blood' } });
    fireEvent.change(screen.getByLabelText(/to matrix/i), { target: { value: 'plasma/serum' } });
    fireEvent.change(fromInput, { target: { value: '109' } });

    const plasma = Number(toInput.value);
    // 109 (blood) / 0.55 ≈ 198.18 µmol/L plasma.
    expect(plasma).toBeGreaterThan(197);
    expect(plasma).toBeLessThan(199);
  });

  it('surfaces the applied B/P midpoint and the converted output range', () => {
    render(
      <DrugInlineConverter
        drug={makeDrug({
          molecularWeight: 144.21,
          bloodPlasmaRatio: { min: 0.5, max: 0.6 } as unknown as DrugComponent['bloodPlasmaRatio'],
        })}
      />,
    );
    // Same matrix → no ratio note.
    expect(screen.queryByText(/ratio applied/i)).not.toBeInTheDocument();

    // blood µmol/L → plasma µmol/L so the range stays in molar units.
    fireEvent.change(screen.getByLabelText(/to unit/i), { target: { value: 'µmol/L' } });
    fireEvent.change(screen.getByLabelText(/to matrix/i), { target: { value: 'plasma/serum' } });
    fireEvent.change(screen.getByLabelText(/from concentration/i), { target: { value: '109' } });

    expect(screen.getByText(/ratio applied: 0\.55/i)).toBeInTheDocument();
    // 109 / 0.6 ≈ 181.7 … 109 / 0.5 = 218 µmol/L (the converted output range,
    // NOT the 0.5–0.6 ratio range), shown at a sane ~4-sig-fig precision.
    expect(screen.getByText(/range 181\.7–218 µmol\/L/i)).toBeInTheDocument();
  });

  it('shows no converted range when matrices match', () => {
    render(
      <DrugInlineConverter
        drug={makeDrug({
          molecularWeight: 144.21,
          bloodPlasmaRatio: { min: 0.5, max: 0.6 } as unknown as DrugComponent['bloodPlasmaRatio'],
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText(/from concentration/i), { target: { value: '109' } });
    // Both sides blood by default → ratio not applied, no range line.
    expect(screen.queryByText(/ratio applied/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^range /i)).not.toBeInTheDocument();
  });

  it('shows a notice when molecular weight is missing', () => {
    render(
      <DrugInlineConverter
        drug={makeDrug({ molecularWeight: undefined as unknown as number })}
      />,
    );
    expect(
      screen.getByText(/molecular weight unavailable/i),
    ).toBeInTheDocument();
  });
});
