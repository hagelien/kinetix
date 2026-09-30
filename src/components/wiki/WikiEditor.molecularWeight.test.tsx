/**
 * Regression tests for the new-drug molecular weight field.
 *
 * `parseLocaleNumber` refuses to guess between the two readings of a value
 * like "62.005" (62.005 or a thousands-grouped 62005) because a silent
 * 1000× error in a forensic tool is worse than a rejection. But the create
 * form autofills exactly that string from PubChem — nitrate, CID 943 — and
 * then rejected its own value as "must be a number", with no spelling that
 * would get past it. These cover both halves of the fix: a PubChem-sourced
 * weight saves untouched, and a hand-typed ambiguous one is resolvable.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18nApp from '@/i18n';
import { WikiEditor } from './WikiEditor';
import { useAuthStore } from '@/stores/authStore';

vi.mock('@/lib/useDrugBibliography', () => ({
  useDrugBibliography: () => ({ ordered: [], byId: new Map(), reload: () => {} }),
}));

// The search-stage panel does its own PubChem/kinetix lookups; the tests
// drive the form stage directly via initialNewDrug, so a stub keeps the
// network out of it.
vi.mock('./NewMonographSearchPanel', () => ({
  NewMonographSearchPanel: () => null,
}));

type OnSave = ComponentProps<typeof WikiEditor>['onSave'];

function makeOnSave() {
  return vi.fn<OnSave>(async () => {});
}

/** The molecular weight the editor actually submitted on its first save. */
function savedMolecularWeight(onSave: ReturnType<typeof makeOnSave>) {
  return onSave.mock.calls[0]?.[3]?.newDrug?.molecularWeight;
}

function renderEditor(
  molecularWeight: number | undefined,
  onSave: OnSave = makeOnSave(),
) {
  return render(
    <MemoryRouter>
      <WikiEditor
        mode="create"
        pageType="drug_monograph"
        initialTitle="Nitrat"
        initialNewDrug={{ names: { nb: 'Nitrat', en: 'Nitrate' }, molecularWeight }}
        onSave={onSave}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );
}

/** The MW field is the only text input labelled with the g/mol unit. */
function molecularWeightInput(): HTMLInputElement {
  const label = i18nApp.t('wikiEditor.molecularWeight');
  const span = screen.getByText(label);
  const input = span.parentElement?.querySelector('input');
  if (!input) throw new Error('molecular weight input not found');
  return input;
}

function save() {
  fireEvent.click(screen.getByText(i18nApp.t('wiki.createPublish')));
}

describe('WikiEditor molecular weight', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 1, email: 'a@b.no', role: 'admin', name: 'A' },
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('saves a machine-supplied ambiguous weight without prompting', async () => {
    const onSave = makeOnSave();
    renderEditor(62.005, onSave);

    expect(molecularWeightInput().value).toBe('62.005');
    expect(screen.queryByText(i18nApp.t('wikiEditor.mwAmbiguousPrompt'))).toBeNull();

    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(savedMolecularWeight(onSave)).toBe(62.005);
  });

  it('offers both readings for a hand-typed ambiguous weight and saves the pick', async () => {
    const onSave = makeOnSave();
    renderEditor(undefined, onSave);

    fireEvent.change(molecularWeightInput(), { target: { value: '62.005' } });
    expect(screen.getByText(i18nApp.t('wikiEditor.mwAmbiguousPrompt'))).toBeTruthy();

    // Refuses to guess while the reading is unresolved.
    save();
    await waitFor(() =>
      expect(
        screen.getByText(i18nApp.t('wikiEditor.errorMolecularWeightAmbiguous')),
      ).toBeTruthy(),
    );
    expect(onSave).not.toHaveBeenCalled();

    // Both readings are offered, spelled so they can't be mistaken for each
    // other, and picking the decimal one unblocks the save.
    const candidates = screen
      .getAllByRole('button')
      .filter((b) => /005 g\/mol$/.test(b.textContent ?? ''));
    expect(candidates).toHaveLength(2);
    const labels = candidates.map((b) => b.textContent);
    expect(new Set(labels).size).toBe(2);
    // Digits-only comparison: the thousands reading is 1000× the decimal one,
    // so only the separators tell them apart on screen.
    expect(labels.map((l) => l?.replace(/\D/g, ''))).toEqual(['62005', '62005']);
    fireEvent.click(candidates[0]!);
    expect(screen.queryByText(i18nApp.t('wikiEditor.mwAmbiguousPrompt'))).toBeNull();

    save();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(savedMolecularWeight(onSave)).toBe(62.005);
  });

  it('re-arms the prompt when the resolved text is edited', () => {
    renderEditor(62.005);

    fireEvent.change(molecularWeightInput(), { target: { value: '162.005' } });
    expect(screen.getByText(i18nApp.t('wikiEditor.mwAmbiguousPrompt'))).toBeTruthy();
  });

  it('still rejects genuinely non-numeric input with the plain error', async () => {
    const onSave = makeOnSave();
    renderEditor(undefined, onSave);

    fireEvent.change(molecularWeightInput(), { target: { value: 'sixty two' } });
    expect(screen.queryByText(i18nApp.t('wikiEditor.mwAmbiguousPrompt'))).toBeNull();

    save();
    await waitFor(() =>
      expect(screen.getByText(i18nApp.t('wikiEditor.errorMolecularWeight'))).toBeTruthy(),
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});
