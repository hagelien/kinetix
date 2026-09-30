import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { SimulatorMechanicsPage } from './SimulatorMechanicsPage';
import { mechanicsModels, mechanicsVersions } from '@/lib/simulatorMechanics';

/**
 * The page is the reviewer-facing surface of `docs/simulator-mechanics.md`. Two things
 * must hold every time: the prose renders, and the `{{live:…}}` tokens are REPLACED by
 * the engine's real inventory rather than shipped as literal text. The document's claims
 * are pinned separately, in `src/lib/__tests__/simulatorMechanics.test.ts`.
 */
function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <SimulatorMechanicsPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('SimulatorMechanicsPage', () => {
  it('renders the document prose', () => {
    const { container } = renderPage();
    expect(
      screen.getByRole('heading', { name: /how the kinetix simulator works/i }),
    ).toBeTruthy();
    // A section a reviewer specifically comes for.
    expect(container.textContent).toMatch(/Strengths and weaknesses/i);
  });

  it('substitutes every live token instead of shipping it as text', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/\{\{live:/);
  });

  it('renders the engine inventory from the running registry', () => {
    const { container } = renderPage();
    const models = mechanicsModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(container.textContent).toContain(model.modelId);
    }
    // The release the curve would actually be produced by, not a transcribed version.
    expect(container.textContent).toContain(
      mechanicsVersions().registryChecksum,
    );
  });

  it('offers a way back to the modelling workspace', () => {
    renderPage();
    const back = screen.getByRole('link', { name: /modell|modeling/i });
    expect(back.getAttribute('href')).toBe('/modeling');
  });
});
