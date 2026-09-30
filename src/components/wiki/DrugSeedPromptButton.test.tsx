import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrugSeedPromptButton } from './DrugSeedPromptButton';
import { useAuthStore, type AuthUser } from '@/stores/authStore';
import { loadSeedPromptTemplate } from '@/lib/deepResearchPrompt';

// A faithful-enough i18next: a key that exists in the shipped locale renders as
// the key, so a test can assert the component translated rather than echoing a
// hardcoded string — and a key referenced but never added fails here.
vi.mock('react-i18next', async () => {
  const en = (await import('@/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        en,
      );
  return {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        translated.push({ key, opts });
        return typeof lookup(key) === 'string' ? key : String(opts?.defaultValue ?? key);
      },
    }),
  };
});

const translated: Array<{ key: string; opts?: Record<string, unknown> }> = [];

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

const originalAuthState = useAuthStore.getState();

function signInAs(role: AuthUser['role'] | null) {
  useAuthStore.setState({
    user: role
      ? {
          id: 1,
          email: 'a@b.com',
          username: 'alice',
          role,
          displayName: null,
          enabledConcentrationUnits: ['µmol/L', 'mg/L'],
          notificationSettings: null,
          favoriteParameters: [],
        }
      : null,
    isAuthenticated: role != null,
    isLoading: false,
  });
}

let written: string[] = [];

beforeEach(() => {
  written = [];
  translated.length = 0;
  showToast.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        written.push(text);
      }),
    },
  });
});

afterEach(() => {
  useAuthStore.setState(originalAuthState);
  vi.unstubAllGlobals();
});

/** jsdom's Blob has no `.text()`, so read it the long way. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('DrugSeedPromptButton', () => {
  it('is hidden from an anonymous visitor', () => {
    signInAs(null);
    render(<DrugSeedPromptButton drugName="cocaine" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['authenticated', 'contributor', 'editor'] as const)(
    'is hidden from a %s',
    (role) => {
      signInAs(role);
      render(<DrugSeedPromptButton drugName="cocaine" />);
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('is hidden when the drug has no resolvable name to fill in', () => {
    // The prompt is worthless without a substance, and `[DRUG NAME]` must
    // never reach the clipboard — so the affordance waits for the drug row.
    signInAs('admin');
    render(<DrugSeedPromptButton drugName="   " />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('copies the filled prompt for an admin', async () => {
    signInAs('admin');
    render(<DrugSeedPromptButton drugName="cocaine" />);
    // Clicking before the mount prefetch settles takes the race path, where
    // the pending text is handed to the clipboard rather than awaited.
    fireEvent.click(screen.getByRole('button', { name: /wiki.seedPrompt.copy/ }));

    await waitFor(() => expect(written).toHaveLength(1));
    const copied = written[0]!;
    expect(copied).toContain('You are a scientific deep-research agent');
    expect(copied).toContain('**Drug/substance:** `cocaine`');
    // Operator-only material must not travel with the paste.
    expect(copied).not.toContain('## Operator notes');
    expect(copied).not.toContain('[DRUG NAME]');

    await screen.findByText('wiki.seedPrompt.copied');
    expect(showToast).toHaveBeenCalledWith('wiki.seedPrompt.copiedToast');
    expect(translated).toContainEqual({
      key: 'wiki.seedPrompt.copiedToast',
      opts: { drug: 'cocaine' },
    });
  });

  it('writes to the clipboard inside the click, without awaiting a fetch first', async () => {
    // The prompt chunk is prefetched on mount precisely so the press does not
    // have to wait for it: a clipboard write that resumes after a network
    // await has lost the user's transient activation, and WebKit refuses it.
    // Asserting *synchronously* after the click is what pins that down — an
    // implementation that awaited the import would have called nothing yet.
    signInAs('admin');
    await loadSeedPromptTemplate();
    render(<DrugSeedPromptButton drugName="cocaine" />);
    await act(async () => {}); // let the prefetch's continuation land

    const writeText = vi.mocked(navigator.clipboard.writeText);
    fireEvent.click(screen.getByRole('button', { name: /wiki.seedPrompt.copy/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('**Drug/substance:** `cocaine`');
    await screen.findByText('wiki.seedPrompt.copied');
  });

  it('hands the clipboard the pending text when a press beats the prefetch', async () => {
    // Same rule from the other side: with nothing loaded yet the write cannot
    // be issued with text, so it is issued with a promise — the one form of
    // async clipboard write that survives the gesture.
    signInAs('admin');
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText: vi.fn() },
    });
    class ClipboardItemStub {
      constructor(readonly items: Record<string, Promise<Blob> | Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', ClipboardItemStub);

    render(<DrugSeedPromptButton drugName="cocaine" />);
    fireEvent.click(screen.getByRole('button', { name: /wiki.seedPrompt.copy/ }));

    expect(write).toHaveBeenCalledTimes(1);
    await screen.findByText('wiki.seedPrompt.copied');
    const item = (write.mock.calls[0] as unknown as [ClipboardItemStub[]])[0][0]!;
    expect(await readBlob(await item.items['text/plain']!)).toContain(
      '**Drug/substance:** `cocaine`',
    );
  });

  it('reports a clipboard the browser refused instead of failing silently', async () => {
    signInAs('admin');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
    });
    // The synchronous fallback is unavailable in jsdom, so this exercises both
    // paths failing — the case where the user would otherwise paste stale
    // clipboard content believing the copy worked.
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    render(<DrugSeedPromptButton drugName="cocaine" />);
    fireEvent.click(screen.getByRole('button', { name: /wiki.seedPrompt.copy/ }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('wiki.seedPrompt.failed'));
    // Still offering the copy, not stuck in a "copied" state that never was.
    expect(screen.getByRole('button')).toHaveTextContent('wiki.seedPrompt.copy');
  });
});
