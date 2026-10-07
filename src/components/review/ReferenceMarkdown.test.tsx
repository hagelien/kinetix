import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ReferenceMarkdown } from './ReferenceMarkdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => key,
  }),
}));
vi.mock('@/lib/disputesApi', () => ({ fetchDisputeById: vi.fn() }));
vi.mock('@/lib/drugApi', () => ({ fetchDiscussionById: vi.fn() }));

const reason = [
  '**Bestridt påstand:**',
  '> Ingen eget spredningsmål (SD/KI) er rapportert',
  '',
  'Tallet er riktig avskrevet, se bestridelse #871.',
  '',
  '---',
  '',
  '- første',
  '- andre',
  '',
  'Raw <script>alert(1)</script> & [lenke](javascript:alert(1))',
].join('\n');

function renderIt() {
  return render(
    <MemoryRouter>
      <ReferenceMarkdown text={reason} />
    </MemoryRouter>,
  );
}

describe('ReferenceMarkdown', () => {
  it('renders markdown instead of literal symbols', () => {
    const { container } = renderIt();
    expect(container.querySelector('strong')).toHaveTextContent(
      'Bestridt påstand:',
    );
    expect(container.querySelector('blockquote')).toHaveTextContent(
      'Ingen eget spredningsmål (SD/KI) er rapportert',
    );
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('---');
  });

  it('keeps cross-references clickable', () => {
    renderIt();
    expect(
      screen.getByRole('button', { name: 'bestridelse #871' }),
    ).toBeInTheDocument();
  });

  it('never injects raw HTML or unsafe links', () => {
    const { container } = renderIt();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('lenke');
  });

  it('keeps the checked state of task-list items', () => {
    render(
      <MemoryRouter>
        <ReferenceMarkdown text={'- [x] verified\n- [ ] pending'} />
      </MemoryRouter>,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(screen.getByText('verified')).toBeInTheDocument();
  });

  it('replaces the bullet and keeps the box beside multi-block task text', () => {
    const { container } = render(
      <MemoryRouter>
        <ReferenceMarkdown text={'- [x] first\n\n  more\n- plain'} />
      </MemoryRouter>,
    );
    const [task, plain] = Array.from(container.querySelectorAll('li'));
    expect(task).toHaveClass('list-none', 'flex');
    expect(plain).not.toHaveClass('list-none');
    const box = task!.querySelector('input')!;
    expect(box.nextElementSibling).toHaveTextContent('first');
    expect(box.nextElementSibling).toHaveTextContent('more');
  });
});
