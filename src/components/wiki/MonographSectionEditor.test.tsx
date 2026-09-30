/**
 * Hard-mode behaviour tests (#303 P1) for MonographSectionEditor:
 * confirms the TipTap surface is read-only and the legacy-prose banner
 * shows only on sections that carry grandfathered v1 content.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@/i18n';
import { MonographSectionEditor } from './MonographSectionEditor';
import { MONOGRAPH_SECTIONS } from '@/lib/monographSections';
import type { TipTapDoc } from '@/lib/monographContent';

function noop() {}

const summarySection = MONOGRAPH_SECTIONS.find((s) => s.id === 'pd')!;

const proseDoc: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Existing legacy paragraph.' }],
    },
  ],
} as unknown as TipTapDoc;

const factOnlyDoc: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'fact',
      attrs: { factId: 'fact-1', referenceIds: [42] },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Approved atomic fact.' }],
        },
      ],
    },
  ],
} as unknown as TipTapDoc;

describe('MonographSectionEditor (#303 hard mode)', () => {
  it('renders the TipTap surface as read-only in edit mode (pageId set)', () => {
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={proseDoc}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={1}
        drugId={1}
      />,
    );
    const editorEl = container.querySelector('.wiki-prose');
    expect(editorEl).not.toBeNull();
    expect(editorEl?.getAttribute('contenteditable')).toBe('false');
  });

  it('keeps the editor editable in create mode (pageId null) so the initial monograph shell can be authored', () => {
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={null}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={null}
        drugId={null}
      />,
    );
    const editorEl = container.querySelector('.wiki-prose');
    expect(editorEl?.getAttribute('contenteditable')).toBe('true');
  });

  it('shows the legacy-prose banner when initialBody carries v1 prose', () => {
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={proseDoc}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={1}
        drugId={1}
      />,
    );
    expect(container.querySelector('[role="note"]')).not.toBeNull();
  });

  it('hides the banner in create mode even when initialBody has prose (Codex follow-up)', () => {
    // pageId == null is the create flow; editor is editable so prose
    // input is valid. The banner would contradict valid authoring,
    // so it must stay hidden until the page exists.
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={proseDoc}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={null}
        drugId={null}
      />,
    );
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('hides the banner for fact-only sections (Codex follow-up)', () => {
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={factOnlyDoc}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={1}
        drugId={1}
      />,
    );
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('hides the banner for empty/new sections so they look intentional', () => {
    const { container } = render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={null}
        onBodyChange={noop}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={1}
        drugId={1}
      />,
    );
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('never fires onBodyChange with a doc payload for the read-only surface', () => {
    const onBodyChange = vi.fn();
    render(
      <MonographSectionEditor
        section={summarySection}
        initialBody={proseDoc}
        onBodyChange={onBodyChange}
        onEditorReady={noop}
        onFocus={noop}
        onSelectionChange={noop}
        pageId={1}
        drugId={1}
      />,
    );
    expect(onBodyChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'doc' }),
    );
  });
});
