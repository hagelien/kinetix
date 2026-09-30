/**
 * Which request the loaded row answers.
 *
 * The sidebar keeps the previous row across a `drugCid` change so it does not
 * blank during navigation, which means `drug` can be the substance you came
 * from while the page is already the one you went to. Read-only panels can
 * live with that for a moment; the completeness controls cannot, because they
 * write.
 *
 * The trap this pins is that the answer cannot be re-derived from the row.
 * `wiki_pages.drug_cid` holds `drugs.id` on modern monographs and a PubChem CID
 * on legacy ones, so comparing either field to `drugCid` is wrong for half the
 * catalog — and wrong in the direction that silently hides the controls
 * everywhere rather than failing loudly anywhere.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const fetchDrugByWikiDrugId = vi.fn();
vi.mock('@/lib/drugApi', () => ({
  fetchDrugByWikiDrugId: (...args: unknown[]) => fetchDrugByWikiDrugId(...args),
}));
vi.mock('@/lib/drugIndicatorsApi', () => ({
  fetchDrugIndicators: vi.fn().mockResolvedValue({ comments: {}, refs: {} }),
}));
vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEdits: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({ user: null }),
}));

import { useDrugSidebarData } from './useDrugSidebarData';

/** A modern monograph: `drug_cid` is the internal id, not the PubChem CID. */
const MODERN = { id: 4711, pubchemCid: 3345, slug: 'diazepam' };

beforeEach(() => {
  fetchDrugByWikiDrugId.mockReset().mockResolvedValue({ drug: MODERN });
});

describe('the loaded row is matched to the request, not to a numeric field', () => {
  it('matches on a modern monograph, where the key is the internal id', async () => {
    const { result } = renderHook(() => useDrugSidebarData(MODERN.id));

    await waitFor(() => expect(result.current.drug).not.toBeNull());
    // Comparing `pubchemCid` to `drugCid` here would be false — and would have
    // held back every write-guarded control on an ordinary monograph.
    expect(result.current.drugMatchesRequest).toBe(true);
  });

  it('matches on a legacy monograph, where the key is the PubChem CID', async () => {
    const { result } = renderHook(() => useDrugSidebarData(MODERN.pubchemCid));

    await waitFor(() => expect(result.current.drug).not.toBeNull());
    expect(result.current.drugMatchesRequest).toBe(true);
  });

  it('does not match while a different substance is still loading', async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    const { result, rerender } = renderHook(({ cid }) => useDrugSidebarData(cid), {
      initialProps: { cid: MODERN.id },
    });
    await waitFor(() => expect(result.current.drugMatchesRequest).toBe(true));

    fetchDrugByWikiDrugId.mockImplementation(
      () => new Promise((resolve) => { resolveSecond = resolve; }),
    );
    rerender({ cid: 9999 });

    // The row on hand is still the substance we came from. Anything that writes
    // has to wait, and this is what tells it to.
    await waitFor(() => expect(result.current.drugMatchesRequest).toBe(false));
    expect(result.current.drug).toEqual(MODERN);

    resolveSecond?.({ drug: { id: 9999, pubchemCid: 1, slug: 'other' } });
    await waitFor(() => expect(result.current.drugMatchesRequest).toBe(true));
  });
});
