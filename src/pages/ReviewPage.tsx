import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileText, FlaskConical, Inbox } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import { fetchPendingEdits, type PendingEditRow } from '@/lib/pendingEditsApi';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';

// Note: paper reviews are NOT in this list — they auto-publish and never enter
// the review queue (their quality control is the re-review cycle + visible
// revision history on the reference page).
type TypeFilter =
  | 'all'
  | 'parameter'
  | 'param_entry'
  | 'wiki_page'
  | 'wiki_new'
  | 'wiki_fact'
  | 'learning_unit'
  | 'clinical_case'
  | 'bio_entity';
type StatusFilter =
  | 'all'
  | 'pending'
  | 'returned'
  | 'approved'
  | 'rejected'
  | 'draft';

export function ReviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isAuthenticated, isLoading } = useAuthStore();
  const [edits, setEdits] = useState<PendingEditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const isReviewerUser = useCan('review.queue.readAll');
  const canFulfilPdfs = useCan('citation.pdf.access');
  const canDropPdfsInBulk = useCan('pdfInbox.upload');
  const typeFilter = (searchParams.get('type') as TypeFilter | null) ?? 'all';
  const statusFilter =
    (searchParams.get('status') as StatusFilter | null) ??
    (isReviewerUser ? 'pending' : 'all');
  const mineOnly = searchParams.get('mine') === '1' || !isReviewerUser;
  const submittedBy = searchParams.get('submittedBy');
  const targetId = searchParams.get('targetId');
  const editId = searchParams.get('id');

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/login', {
        replace: true,
        state: { message: t('auth.signInToView') },
      });
    }
  }, [isLoading, isAuthenticated, navigate]);

  function updateFilter(
    next: Partial<Record<'type' | 'status' | 'mine', string | null>>,
  ) {
    const sp = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === 'all' || value === '0') sp.delete(key);
      else sp.set(key, value);
    }
    setSearchParams(sp);
  }

  // `background` refreshes (triggered after a reviewer handles a card) keep the
  // existing list mounted instead of swapping it for the loading placeholder.
  // Tearing the list down collapses the page height and resets the scroll to
  // the top, forcing reviewers to scroll back down to where they were. A
  // background refresh reconciles the cards in place, so the handled edit just
  // drops out and the scroll position is preserved.
  function loadEdits(options?: { background?: boolean }) {
    if (!user) return;

    if (!options?.background) setLoading(true);
    fetchPendingEdits({
      status: statusFilter,
      editType: typeFilter === 'all' ? undefined : typeFilter,
      submittedBy: mineOnly
        ? user.id
        : submittedBy
          ? Number(submittedBy)
          : undefined,
      targetId: targetId ? Number(targetId) : undefined,
      id: editId ? Number(editId) : undefined,
    })
      .then((data) => setEdits(data.pendingEdits))
      .catch(() => setEdits([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadEdits();
  }, [user, typeFilter, statusFilter, mineOnly, submittedBy, targetId, editId]);

  const typeOptions = useMemo(
    () => [
      { key: 'all' as const, label: t('review.all') },
      { key: 'parameter' as const, label: t('review.parameters') },
      {
        key: 'param_entry' as const,
        label: t('review.paramEntry.filter', {
          defaultValue: 'Source values',
        }),
      },
      { key: 'wiki_page' as const, label: t('review.pageEdits') },
      { key: 'wiki_new' as const, label: t('review.newPages') },
      { key: 'wiki_fact' as const, label: t('review.newFacts') },
      {
        key: 'learning_unit' as const,
        label: t('review.learningUnits', { defaultValue: 'Learning units' }),
      },
      {
        key: 'clinical_case' as const,
        label: t('review.clinicalCases', { defaultValue: 'Clinical cases' }),
      },
      {
        key: 'bio_entity' as const,
        label: t('review.bioEntities', { defaultValue: 'Bio entities' }),
      },
    ],
    [t],
  );

  const statusOptions = useMemo(
    () => [
      { key: 'all' as const, label: t('review.all') },
      { key: 'pending' as const, label: t('review.pending') },
      { key: 'returned' as const, label: t('review.returned') },
      { key: 'draft' as const, label: t('review.drafts') },
      { key: 'approved' as const, label: t('review.approved') },
      { key: 'rejected' as const, label: t('review.rejected') },
    ],
    [t],
  );

  const canReviewOthers = isReviewerUser;
  const title =
    mineOnly && !canReviewOthers
      ? t('review.myEdits')
      : t('review.reviewQueue');

  return (
    <div className="flex-1 bg-background">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">
              {t('review.resultCount', { count: edits.length })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canFulfilPdfs ? (
              <Link
                to="/pdf-requests"
                className={`${buttonVariants({ variant: 'outline', size: 'sm' })} gap-1.5`}
              >
                <FileText className="h-4 w-4" />
                {t('nav.pdfRequests')}
              </Link>
            ) : null}

            {/* The bulk drop-off sits beside the request queue because it is
                the other half of the same job: the queue says which papers are
                needed, the inbox is where a folder of them is handed over at
                once. */}
            {canDropPdfsInBulk ? (
              <Link
                to="/pdf-inbox"
                className={`${buttonVariants({ variant: 'outline', size: 'sm' })} gap-1.5`}
              >
                <Inbox className="h-4 w-4" />
                {t('nav.pdfInbox')}
              </Link>
            ) : null}

            {/* Filling the extraction queue is an editorial act — it spends
                agent cycles and puts facts in front of these same reviewers —
                so the entrance sits with the review queue, not in the top nav. */}
            {isReviewerUser ? (
              <Link
                to="/paper-extraction"
                className={`${buttonVariants({ variant: 'outline', size: 'sm' })} gap-1.5`}
              >
                <FlaskConical className="h-4 w-4" />
                {t('nav.paperExtraction')}
              </Link>
            ) : null}

            {canReviewOthers ? (
              <Button
                size="sm"
                variant={mineOnly ? 'outline' : 'default'}
                onClick={() => updateFilter({ mine: mineOnly ? null : '1' })}
              >
                {mineOnly ? t('review.showAll') : t('review.showMine')}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-3">
          <div className="flex flex-wrap gap-1">
            {typeOptions.map((option) => (
              <Button
                key={option.key}
                variant={typeFilter === option.key ? 'default' : 'outline'}
                size="sm"
                className="text-xs"
                onClick={() => updateFilter({ type: option.key })}
              >
                {option.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1">
            {statusOptions.map((option) => (
              <Button
                key={option.key}
                variant={statusFilter === option.key ? 'default' : 'outline'}
                size="sm"
                className="text-xs"
                onClick={() => updateFilter({ status: option.key })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('review.loading')}</p>
        ) : edits.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('review.noMatch')}
          </p>
        ) : (
          <div className="space-y-3">
            {edits.map((edit) => (
              <PendingEditCard
                key={edit.id}
                edit={edit}
                onReviewed={() => loadEdits({ background: true })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
