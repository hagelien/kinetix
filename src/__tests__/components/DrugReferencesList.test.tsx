import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DrugReferencesList } from '@/components/wiki/DrugReferencesList';
import type { CitationRow } from '@/lib/referencesApi';
import type { OrderedReference } from '@/lib/useDrugBibliography';
import '@/i18n';

function makeRow(id: number, title: string): CitationRow {
  return {
    id,
    drugId: null,
    type: 'freetext',
    identifier: title,
    metadata: { title },
    createdBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  } as unknown as CitationRow;
}

function ordered(rows: CitationRow[]): OrderedReference[] {
  return rows.map((row, i) => ({ index: i + 1, row }));
}

describe('DrugReferencesList — activeReferenceId highlight', () => {
  const refs = [
    makeRow(101, 'First reference'),
    makeRow(202, 'Second reference'),
    makeRow(303, 'Third reference'),
  ];

  it('renders nothing when there are no refs', () => {
    const { container } = render(
      <DrugReferencesList orderedRefs={[]} activeReferenceId={null} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders all refs without highlight when no active id', () => {
    const { container } = render(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={null}
      />,
    );
    expect(container.textContent).not.toContain('First reference');
    fireEvent.click(screen.getByRole('button'));
    expect(container.textContent).toContain('First reference');
    expect(container.textContent).toContain('Second reference');
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('routes reference links through the reference module', () => {
    const doi = {
      ...makeRow(404, 'DOI reference'),
      type: 'doi',
      identifier: '10.1093/jat/bkaa044',
    };
    const { container } = render(
      <DrugReferencesList orderedRefs={ordered([doi])} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const link = container.querySelector('a[href="/references/404"]');
    expect(link?.textContent).toBe('10.1093/jat/bkaa044');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('marks the matching <li> with aria-current and a highlight class', () => {
    const { container } = render(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={202}
      />,
    );
    const active = container.querySelector('[aria-current="true"]');
    expect(active).not.toBeNull();
    expect(active?.getAttribute('data-reference-id')).toBe('202');
    expect(active?.className).toMatch(/bg-accent\/40/);
    // Other entries should not be highlighted.
    const others = container.querySelectorAll(
      '[data-reference-id]:not([aria-current="true"])',
    );
    expect(others.length).toBe(2);
    others.forEach((el) => {
      expect(el.className).not.toMatch(/bg-accent\/40/);
    });
  });

  it('clears the highlight when activeReferenceId becomes null', () => {
    const { container, rerender } = render(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={303}
      />,
    );
    expect(container.querySelector('[aria-current="true"]')).not.toBeNull();
    rerender(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={null}
      />,
    );
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('ignores activeReferenceId when no row matches', () => {
    const { container } = render(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={999}
      />,
    );
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('expands when a same-hash reference link is activated', () => {
    window.history.pushState(null, '', '#param-ref-2');
    const link = document.createElement('a');
    link.href = '#param-ref-2';
    link.textContent = '[2]';
    document.body.append(link);

    const { container } = render(
      <DrugReferencesList
        orderedRefs={ordered(refs)}
        activeReferenceId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(container.textContent).not.toContain('Second reference');

    fireEvent.click(link);

    expect(container.textContent).toContain('Second reference');
    link.remove();
    window.history.pushState(null, '', window.location.pathname);
  });
});
