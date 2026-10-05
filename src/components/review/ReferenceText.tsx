import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X } from 'lucide-react';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { UserBadge } from '@/components/ui/UserBadge';
import {
  parseReferences,
  pendingEditHref,
  type ReferenceKind,
} from '@/lib/referenceLinks';
import { fetchDisputeById } from '@/lib/disputesApi';
import { fetchDiscussionById, type DrugDiscussionDTO } from '@/lib/drugApi';

const linkClass =
  'cursor-pointer text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid';

/**
 * Free text with its cross-references made clickable: "diskusjon #1379" and
 * "bestridelse #871" open a preview of the comment or objection they cite, and
 * "pending_edit 1412" links to that edit on /review. Everything else renders
 * as plain text, so this is a drop-in for a `{text}` child.
 */
export function ReferenceText({ text }: { text: string }) {
  const [open, setOpen] = useState<{
    kind: Exclude<ReferenceKind, 'pending_edit'>;
    id: number;
  } | null>(null);
  const segments = parseReferences(text);
  return (
    <>
      {segments.map((s, i) => {
        if (s.type === 'text') return <span key={i}>{s.text}</span>;
        const kind = s.kind;
        if (kind === 'pending_edit') {
          return (
            <Link key={i} to={pendingEditHref(s.id)} className={linkClass}>
              {s.text}
            </Link>
          );
        }
        return (
          <button
            key={i}
            type="button"
            className={`${linkClass} inline p-0 align-baseline [font:inherit]`}
            onClick={() => setOpen({ kind, id: s.id })}
          >
            {s.text}
          </button>
        );
      })}
      {open ? (
        <ReferencePreviewDialog
          kind={open.kind}
          id={open.id}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

type DisputePayload = Awaited<ReturnType<typeof fetchDisputeById>>['dispute'];
type DiscussionPayload = Awaited<ReturnType<typeof fetchDiscussionById>>;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; notFound: boolean }
  | { status: 'dispute'; data: DisputePayload }
  | { status: 'discussion'; data: DiscussionPayload };

function ReferencePreviewDialog({
  kind,
  id,
  onClose,
}: {
  kind: Exclude<ReferenceKind, 'pending_edit'>;
  id: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load =
      kind === 'dispute'
        ? fetchDisputeById(id).then(
            (r) => ({ status: 'dispute', data: r.dispute }) as const,
          )
        : fetchDiscussionById(id).then(
            (r) => ({ status: 'discussion', data: r }) as const,
          );
    load
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: { status?: number }) => {
        if (!cancelled) {
          setState({
            status: 'error',
            notFound: err?.status === 404 || err?.status === 403,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  const title =
    kind === 'dispute'
      ? t('review.reference.disputeTitle', { id })
      : t('review.reference.discussionTitle', { id });

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={title}
      className="flex max-h-[85vh] w-full max-w-xl flex-col"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('review.reference.close')}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {state.status === 'loading' ? (
          <p className="text-muted-foreground">
            {t('review.reference.loading')}
          </p>
        ) : state.status === 'error' ? (
          <p className="text-muted-foreground">
            {state.notFound
              ? t('review.reference.notFound')
              : t('review.reference.failed')}
          </p>
        ) : state.status === 'dispute' ? (
          <DisputePreview dispute={state.data} onNavigate={onClose} />
        ) : (
          <DiscussionPreview data={state.data} onNavigate={onClose} />
        )}
      </div>
    </ModalOverlay>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function OpenLink({
  to,
  label,
  onNavigate,
}: {
  to: string;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      {label}
    </Link>
  );
}

function DisputePreview({
  dispute,
  onNavigate,
}: {
  dispute: DisputePayload;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const statusLabel =
    dispute.status === 'open'
      ? t('review.reference.disputeOpen')
      : dispute.resolution
        ? t(`review.reference.disputeResolution.${dispute.resolution}`)
        : t('review.reference.disputeResolved');
  return (
    <>
      <Meta>
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
          {statusLabel}
        </span>
        <span className="font-medium text-foreground">
          {dispute.author?.name ??
            dispute.author?.agentSlug ??
            t('review.dispute.unknownAuthor')}
        </span>
        <span>
          ·{' '}
          {t(
            dispute.source === 'agent'
              ? 'review.dispute.sourceAgent'
              : 'review.dispute.sourceHuman',
          )}
        </span>
        <span>· {new Date(dispute.createdAt).toLocaleString()}</span>
      </Meta>
      <p className="whitespace-pre-wrap leading-snug">
        {dispute.reasonMd.trim() || t('review.dispute.noReason')}
      </p>
      {dispute.evidenceRefs.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">
            {t('review.verification.evidenceLabel')}:
          </span>{' '}
          {dispute.evidenceRefs
            .map((e) => {
              if (e.citationId !== undefined) return `#${e.citationId}`;
              if (e.url) return e.url;
              if (e.quote) return `“${e.quote}”`;
              return '';
            })
            .filter(Boolean)
            .join(' · ')}
        </div>
      ) : null}
      <div className="text-xs text-muted-foreground">
        {t('review.reference.disputeTarget', {
          type: dispute.targetType,
          id: dispute.targetId,
        })}
      </div>
      <OpenLink
        to={
          dispute.targetType === 'pending_edit'
            ? pendingEditHref(dispute.targetId)
            : dispute.url
        }
        label={t('review.reference.openTarget')}
        onNavigate={onNavigate}
      />
    </>
  );
}

function Comment({ c, muted }: { c: DrugDiscussionDTO; muted?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={
        muted
          ? 'space-y-1 rounded-md border border-border bg-muted/40 p-2 text-xs'
          : 'space-y-1'
      }
    >
      <Meta>
        {c.author ? (
          <UserBadge user={c.author} />
        ) : (
          <span>{t('review.dispute.unknownAuthor')}</span>
        )}
        <span>· {new Date(c.createdAt).toLocaleString()}</span>
        <span>· #{c.id}</span>
      </Meta>
      <p className="whitespace-pre-wrap leading-snug">{c.body}</p>
    </div>
  );
}

function DiscussionPreview({
  data,
  onNavigate,
}: {
  data: DiscussionPayload;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const { discussion, parent, replies, url } = data;
  return (
    <>
      {discussion.parameter ? (
        <div className="text-xs text-muted-foreground">
          {t('review.reference.discussionThread', {
            parameter: discussion.parameter,
          })}
        </div>
      ) : null}
      {parent ? (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('review.reference.inReplyTo')}
          </div>
          <Comment c={parent} muted />
        </div>
      ) : null}
      <Comment c={discussion} />
      {replies.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('review.reference.replies', { count: replies.length })}
          </div>
          <div className="space-y-1.5">
            {replies.map((r) => (
              <Comment key={r.id} c={r} muted />
            ))}
          </div>
        </div>
      ) : null}
      <OpenLink
        to={url}
        label={t('review.reference.openDiscussion')}
        onNavigate={onNavigate}
      />
    </>
  );
}
