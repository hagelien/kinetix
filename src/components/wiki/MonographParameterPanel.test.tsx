/**
 * Behaviour tests for MonographParameterPanel (#298 parity):
 * - as an inline rail (`floating={false}`) there's no pop-in handle
 * - as a floating panel (`floating`) a right-edge handle pops it in, and a
 *   close button / backdrop / Escape pops it back out
 * - the open/closed choice is persisted
 *
 * DrugMonographSidebar is mocked out — this suite only exercises the
 * floating/rail shell around it. The rail-vs-floating *decision* is made by
 * the parent (WikiPage) from a measured width and is passed in via `floating`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18nApp from '@/i18n';
import { MonographParameterPanel } from './MonographParameterPanel';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { resetOverlayStackForTests } from '@/lib/overlayStack';

vi.mock('./DrugMonographSidebar', () => ({
  DrugMonographSidebar: () => <div data-testid="sidebar-content" />,
}));

const PANEL_OPEN_STORAGE_KEY = 'kinetix.monographSidebar.panelOpen';

function renderPanel(floating: boolean) {
  return render(
    <MemoryRouter>
      <MonographParameterPanel drugCid={100} floating={floating} />
    </MemoryRouter>,
  );
}

describe('MonographParameterPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    i18nApp.changeLanguage('en');
    resetOverlayStackForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an inline rail with no pop-in handle when it fits', () => {
    renderPanel(false);
    expect(screen.getByTestId('sidebar-content')).toBeInTheDocument();
    const aside = screen.getByRole('complementary', { name: 'Parameters' });
    expect(aside.className).toContain('sticky');
    expect(aside).not.toHaveAttribute('inert');
    expect(
      screen.queryByRole('button', { name: 'Show parameters' }),
    ).not.toBeInTheDocument();
  });

  it('pops the panel in and out when floating', () => {
    renderPanel(true);
    const aside = screen.getByRole('complementary', { name: 'Parameters' });
    // Closed by default: off-canvas + inert.
    expect(aside.className).toContain('translate-x-full');
    expect(aside).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Show parameters' }));
    expect(aside.className).toContain('translate-x-0');
    expect(aside).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Hide parameters' }));
    expect(aside.className).toContain('translate-x-full');
    expect(aside).toHaveAttribute('inert');
  });

  it('closes on backdrop click', () => {
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show parameters' }));
    const aside = screen.getByRole('complementary', { name: 'Parameters' });
    expect(aside.className).toContain('translate-x-0');
    // The backdrop is the aria-hidden overlay behind the panel.
    const backdrop = document.querySelector('[aria-hidden="true"].fixed');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(aside.className).toContain('translate-x-full');
  });

  it('closes on Escape and persists the open choice', () => {
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show parameters' }));
    expect(localStorage.setItem).toHaveBeenCalledWith(
      PANEL_OPEN_STORAGE_KEY,
      'true',
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    const aside = screen.getByRole('complementary', { name: 'Parameters' });
    expect(aside.className).toContain('translate-x-full');
    expect(localStorage.setItem).toHaveBeenCalledWith(
      PANEL_OPEN_STORAGE_KEY,
      'false',
    );
  });

  // Every parameter dialog opens from inside this panel. Both this handler and
  // the dialog's own listen on Escape, so without the overlay stack one press
  // would dismiss the dialog AND collapse the rail out from under the user.
  it('leaves Escape to a dialog opened on top of it', () => {
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show parameters' }));
    const aside = screen.getByRole('complementary', { name: 'Parameters' });
    expect(aside.className).toContain('translate-x-0');

    const dialog = render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Source values">
        <button type="button">Close</button>
      </ModalOverlay>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(aside.className).toContain('translate-x-0');

    // …and once it closes, Escape reaches the panel again.
    dialog.unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(aside.className).toContain('translate-x-full');
  });

  // `floating` is a measurement, not a user action: a resize or zoom across the
  // layout threshold flips it. If that re-registered the rail it would jump
  // above a dialog that is still open, and the next Escape would collapse the
  // rail instead of dismissing the dialog.
  it('keeps a dialog above it across a rail-mode change', () => {
    const { rerender } = render(
      <MemoryRouter>
        <MonographParameterPanel drugCid={100} floating />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show parameters' }));
    const aside = screen.getByRole('complementary', { name: 'Parameters' });

    render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Source values">
        <button type="button">Close</button>
      </ModalOverlay>,
    );

    // Widen past the threshold and back again while the dialog is still up.
    const withFloating = (floating: boolean) => (
      <MemoryRouter>
        <MonographParameterPanel drugCid={100} floating={floating} />
      </MemoryRouter>
    );
    rerender(withFloating(false));
    rerender(withFloating(true));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(aside.className).toContain('translate-x-0');
  });
});
