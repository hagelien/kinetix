import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopicSectionsEditor } from '@/components/wiki/TopicSectionsEditor';
import { fetchPendingEdits } from '@/lib/pendingEditsApi';
import type { TipTapDoc } from '@/lib/monographContent';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

vi.mock('@/lib/pendingEditsApi', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/pendingEditsApi')
  >('@/lib/pendingEditsApi');
  return { ...actual, fetchPendingEdits: vi.fn() };
});

const doc: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2, sectionId: 'sammendrag' },
      content: [{ type: 'text', text: 'Sammendrag' }],
    },
    {
      type: 'heading',
      attrs: { level: 2, sectionId: 'annet' },
      content: [{ type: 'text', text: 'Annet' }],
    },
  ],
} as TipTapDoc;

describe('TopicSectionsEditor pending facts', () => {
  it('shows facts still in review under their own section', async () => {
    vi.mocked(fetchPendingEdits).mockResolvedValue({
      pendingEdits: [
        {
          id: 11,
          editType: 'wiki_fact',
          sectionId: 'sammendrag',
          factOperation: 'add',
          factStatement: 'Oral fluid answers whether a substance is present.',
        },
      ] as never,
    });

    render(<TopicSectionsEditor content={doc} pageId={5} />);

    const list = await screen.findByTestId('pending-facts');
    expect(fetchPendingEdits).toHaveBeenCalledWith({
      status: 'pending',
      editType: 'wiki_fact',
      targetId: 5,
    });
    expect(
      within(list).getByText(
        'Oral fluid answers whether a substance is present.',
      ),
    ).toBeTruthy();
    expect(within(list).getByText('wikiFact.pendingAdd')).toBeTruthy();
    expect(
      list.closest('[data-topic-section]')?.getAttribute('data-topic-section'),
    ).toBe('sammendrag');
    expect(screen.getAllByTestId('pending-facts')).toHaveLength(1);
  });
});
