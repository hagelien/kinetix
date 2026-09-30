import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DrugComponent } from '@/types';
import { DrugNameCell } from './DrugNameCell';

const drug = {
  id: '1',
  names: { en: 'Methylenedioxymethamphetamine' },
  nameShort: 'MDMA',
  aliases: ['Ecstasy', 'Molly'],
} as DrugComponent;

describe('DrugNameCell', () => {
  it('shows the full name and puts the shortname and aliases in its tooltip', () => {
    render(
      <DrugNameCell
        drug={drug}
        displayName="Methylenedioxymethamphetamine"
        t={(key) =>
          key === 'drugTable.tooltip.shortName' ? 'Short name' : 'Aliases'
        }
      />,
    );

    const visibleName = screen.getByText('Methylenedioxymethamphetamine', {
      selector: 'span.truncate',
    });
    expect(visibleName).toBeInTheDocument();

    fireEvent.mouseEnter(visibleName.parentElement!);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).not.toHaveClass('sr-only');
    expect(tooltip).toHaveTextContent('Short name: MDMA');
    expect(tooltip).toHaveTextContent('Aliases: Ecstasy, Molly');
  });
});
