import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CaseScenario } from './CaseScenario';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const content = {
  safetyNotice: 'Kun til opplæring — ikke pasientspesifikke kliniske råd.',
  scenario: 'En fiktiv pasient presenterer med uventede symptomer.',
};

describe('CaseScenario', () => {
  it('renders the verbatim safety notice prominently and the scenario', () => {
    render(
      <CaseScenario
        title="Klinisk case om dosering"
        difficulty="advanced_lis"
        content={content}
      />,
    );
    expect(screen.getByText('learn.case.safetyNoticeLabel')).toBeInTheDocument();
    expect(screen.getByText(content.safetyNotice)).toBeInTheDocument();
    expect(screen.getByText(content.scenario)).toBeInTheDocument();
    expect(screen.getByText('Klinisk case om dosering')).toBeInTheDocument();
  });

  it('never embeds external content', () => {
    const { container } = render(
      <CaseScenario title="x" difficulty="board" content={content} />,
    );
    expect(container.querySelector('iframe, embed, object')).toBeNull();
  });
});
