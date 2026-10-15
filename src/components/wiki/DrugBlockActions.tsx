import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { History, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DrugBlockId } from '@/lib/drugBlocks';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import { ParameterDiscussionPanel } from './ParameterDiscussionPanel';

interface Props {
  drugId: number;
  block: DrugBlockId;
}

type OpenDialog = {
  kind: 'history' | 'discussion';
  /** Revision (history) or comment (discussion) a deep link points at. */
  focusId?: number;
};

/**
 * The revision-history and discussion actions of a whole monograph block —
 * metabolism, pharmacodynamics or the model structure (#37). The same two
 * actions every parameter row has, opening the same dialogs, but for the block
 * as a whole rather than one value: these blocks are structured lists, and
 * their history and discussion belong to the list.
 *
 * Hover-revealed like the section's other actions. A notification's deep link
 * (`?param=<block>&view=history|discussion` plus `revision`/`comment`) opens
 * the dialog here, the way the sidebar does it for a parameter, and closing
 * the dialog drops those query keys again.
 */
export function DrugBlockActions({ drugId, block }: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const linkParam = searchParams.get('param');
  const linkView = searchParams.get('view');
  const linkFocus = searchParams.get(
    linkView === 'history' ? 'revision' : 'comment',
  );

  useEffect(() => {
    if (linkParam !== block) return;
    if (linkView !== 'history' && linkView !== 'discussion') return;
    const focus = Number(linkFocus);
    setDialog({
      kind: linkView,
      focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
    });
  }, [block, linkParam, linkView, linkFocus]);

  const close = useCallback(() => {
    setDialog(null);
    if (searchParams.get('param') !== block || !searchParams.has('view')) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of ['param', 'view', 'revision', 'comment']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [block, searchParams, setSearchParams]);

  const className =
    'hover-actions h-6 w-6 p-0 text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none';

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog({ kind: 'history' })}
        className={className}
        title={t('sidebar.historyParam')}
        aria-label={t('sidebar.historyParam')}
        data-testid={`block-history-${block}`}
      >
        <History className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog({ kind: 'discussion' })}
        className={className}
        title={t('sidebar.discussionParam')}
        aria-label={t('sidebar.discussionParam')}
        data-testid={`block-discussion-${block}`}
      >
        <MessageSquare className="h-3 w-3" />
      </Button>
      {dialog?.kind === 'history' ? (
        <ParameterHistoryDialog
          drugId={drugId}
          parameter={block}
          focusRevisionId={dialog.focusId}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === 'discussion' ? (
        <ParameterDiscussionPanel
          drugId={drugId}
          parameter={block}
          focusCommentId={dialog.focusId}
          onClose={close}
        />
      ) : null}
    </>
  );
}
