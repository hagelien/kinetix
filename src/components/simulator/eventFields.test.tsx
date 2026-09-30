import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field, TimeField } from './eventFields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function NumericHarness() {
  const [value, setValue] = useState<number | undefined>();
  return (
    <>
      <Field
        label="Amount"
        placeholder="e.g. 1.5"
        value={value}
        onChange={setValue}
      />
      <output data-testid="value">{value ?? ''}</output>
    </>
  );
}

function RelativeTimeHarness() {
  const [value, setValue] = useState<number | undefined>();
  return (
    <>
      <TimeField
        label="Prediction time"
        placeholder="+1:30"
        value={value}
        onChange={setValue}
        timeFormat="clock"
        referenceTime="08:00"
        preferRelative
      />
      <output data-testid="value">{value ?? ''}</output>
    </>
  );
}

describe('simulator event fields', () => {
  it('keeps comma and dot decimal input editable while storing parsed numbers', () => {
    render(<NumericHarness />);

    const input = screen.getByPlaceholderText('e.g. 1.5') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1,' } });
    expect(input.value).toBe('1,');
    expect(screen.getByTestId('value').textContent).toBe('1');

    fireEvent.change(input, { target: { value: '1,5' } });
    expect(input.value).toBe('1,5');
    expect(screen.getByTestId('value').textContent).toBe('1.5');

    fireEvent.change(input, { target: { value: '2.75' } });
    expect(input.value).toBe('2.75');
    expect(screen.getByTestId('value').textContent).toBe('2.75');
  });

  it('accepts signed relative hours and minutes for prediction times', () => {
    render(<RelativeTimeHarness />);

    const input = screen.getByPlaceholderText('+1:30') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '+1:30' } });
    expect(input.value).toBe('+1:30');
    expect(screen.getByTestId('value').textContent).toBe('1.5');

    fireEvent.change(input, { target: { value: '-0:45' } });
    expect(input.value).toBe('-0:45');
    expect(screen.getByTestId('value').textContent).toBe('-0.75');
  });

  it('reads a bare number in a prediction field as a positive hour offset', () => {
    render(<RelativeTimeHarness />);

    const input = screen.getByPlaceholderText('+1:30') as HTMLInputElement;

    // Typing "2" means "+2 hours" — no leading sign required.
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByTestId('value').textContent).toBe('2');

    // Decimal and H:MM forms work unsigned too.
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(screen.getByTestId('value').textContent).toBe('2.5');

    fireEvent.change(input, { target: { value: '1:30' } });
    expect(screen.getByTestId('value').textContent).toBe('1.5');

    // On blur the stored offset reformats to the canonical "+H:MM".
    fireEvent.blur(input);
    expect(input.value).toBe('+1:30');
  });
});
