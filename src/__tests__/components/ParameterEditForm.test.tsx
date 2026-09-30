/**
 * The parameter editor is the one component that decides what "editing a
 * parameter" means, so it is where the source-value rule is made structural.
 *
 * Its callers already hide the control for a source-value-backed parameter and
 * `PUT /api/drug-parameter` answers one with a 409, but neither of those stops
 * a caller added later from mounting the form with a summarizable parameter and
 * handing a curator a value box again. The form refuses on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ParameterEditForm } from '@/components/wiki/ParameterEditForm';

function renderForm(parameter: string, currentValue: unknown = null) {
  return render(
    <ParameterEditForm
      drugId={42}
      parameter={parameter as never}
      currentValue={currentValue}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

describe('ParameterEditForm — source-value-backed parameters', () => {
  it('offers no value inputs for a summarizable parameter', () => {
    renderForm('halfLife', { min: 1, max: 3, unit: 'h' });

    // The explanation replaces the inputs rather than sitting above them.
    expect(screen.getByText(/paramEdit\.errors\.entryBacked/)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('disables saving so no request is made even if inputs were reached', () => {
    renderForm('halfLife', { min: 1, max: 3, unit: 'h' });

    // The submit control is "suggest change" for a contributor and "save
    // directly" for an admin; whichever is rendered, it cannot be used.
    expect(
      screen.getByRole('button', {
        name: /paramEdit\.(suggestChange|saveDirectly)/,
      }),
    ).toBeDisabled();
  });

  it('still renders the inputs for a parameter that is not pooled', () => {
    // Analyte stability is matrix-specific with no valid cross-matrix pool:
    // not summarizable, so it keeps its authored value and its editor.
    renderForm('analyteStability', { min: 1, max: 5, unit: 'h' });

    expect(screen.queryByText(/paramEdit\.errors\.entryBacked/)).toBeNull();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
  });
});
