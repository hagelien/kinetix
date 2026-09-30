import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalOverlay } from './modal-overlay';
import {
  resetOverlayStackForTests,
  useOverlayLayer,
} from '@/lib/overlayStack';

/** Stand-in for the app shell's z-60 palette / unit converter. */
function HigherOverlay({ children }: { children: React.ReactNode }) {
  useOverlayLayer(true);
  return <div data-testid="higher">{children}</div>;
}

describe('ModalOverlay', () => {
  beforeEach(() => {
    resetOverlayStackForTests();
  });

  it('closes when the backdrop outside the box is clicked', () => {
    const onClose = vi.fn();
    // The overlay portals onto document.body, so it is not under `container`.
    const { baseElement, getByText } = render(
      <ModalOverlay onClose={onClose} ariaLabel="Test dialog">
        <p>Body</p>
      </ModalOverlay>,
    );

    const backdrop = getByText('Body').closest('.fixed') as HTMLElement;
    expect(backdrop.parentElement).toBe(baseElement);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Clicking inside the box must not bubble up and dismiss the modal.
    fireEvent.click(getByText('Body'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose} ariaLabel="Test dialog">
        <p>Body</p>
      </ModalOverlay>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The portal appends the box after the app root, so without these the first
  // Tab would walk the page *behind* the overlay instead of the dialog.
  it('exposes dialog semantics and takes focus on open', () => {
    const { getByRole } = render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Source values">
        <button type="button">First</button>
        <button type="button">Last</button>
      </ModalOverlay>,
    );

    const dialog = getByRole('dialog', { name: 'Source values' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(getByRole('button', { name: 'First' }));
  });

  it('cycles Tab within the dialog instead of escaping to the page behind', () => {
    const { getByRole } = render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
        <button type="button">First</button>
        <button type="button">Last</button>
      </ModalOverlay>,
    );

    const first = getByRole('button', { name: 'First' });
    const last = getByRole('button', { name: 'Last' });

    // Forward off the last control wraps to the first…
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // …and backward off the first wraps to the last.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the opener when it closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
        <button type="button">Close</button>
      </ModalOverlay>,
    );
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  // React applies a descendant's autoFocus during commit, before our effects
  // run — so reading document.activeElement there would record the autofocused
  // control as the "opener" and restore focus to a detached node on close.
  describe('with a descendant that autofocuses', () => {
    it('still restores focus to the real opener', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { unmount } = render(
        <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
          <button type="button">Not this one</button>
          <textarea autoFocus />
        </ModalOverlay>,
      );

      unmount();
      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    });

    it('leaves that control focused instead of grabbing the first one', () => {
      const { getByRole } = render(
        <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
          <button type="button">First</button>
          <textarea autoFocus aria-label="Reason" />
        </ModalOverlay>,
      );

      expect(document.activeElement).toBe(
        getByRole('textbox', { name: 'Reason' }),
      );
    });
  });

  it('does not restore focus to an opener that has left the document', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
        <button type="button">Close</button>
      </ModalOverlay>,
    );

    trigger.remove();
    expect(() => unmount()).not.toThrow();
  });

  // Ctrl+K and Ctrl+Shift+U render above this box and can be hit while it is
  // open. A trap that kept firing would read their focus as "outside" and drag
  // every Tab back down here, making the top overlay unusable by keyboard.
  describe('while another overlay is stacked on top', () => {
    it('leaves Tab alone so the higher overlay keeps focus', () => {
      const { getByRole, rerender } = render(
        <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
          <button type="button">Inside</button>
        </ModalOverlay>,
      );

      rerender(
        <>
          <ModalOverlay onClose={vi.fn()} ariaLabel="Test dialog">
            <button type="button">Inside</button>
          </ModalOverlay>
          <HigherOverlay>
            <button type="button">Above</button>
          </HigherOverlay>
        </>,
      );

      const above = getByRole('button', { name: 'Above' });
      above.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(above);
    });

    it('leaves Escape to the higher overlay', () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <ModalOverlay onClose={onClose} ariaLabel="Test dialog">
          <button type="button">Inside</button>
        </ModalOverlay>,
      );

      rerender(
        <>
          <ModalOverlay onClose={onClose} ariaLabel="Test dialog">
            <button type="button">Inside</button>
          </ModalOverlay>
          <HigherOverlay>
            <button type="button">Above</button>
          </HigherOverlay>
        </>,
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('resumes trapping once the higher overlay closes', () => {
      const onClose = vi.fn();
      const tree = (withHigher: boolean) => (
        <>
          <ModalOverlay onClose={onClose} ariaLabel="Test dialog">
            <button type="button">Inside</button>
          </ModalOverlay>
          {withHigher ? (
            <HigherOverlay>
              <button type="button">Above</button>
            </HigherOverlay>
          ) : null}
        </>
      );

      const { rerender } = render(tree(false));
      rerender(tree(true));
      rerender(tree(false));

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
