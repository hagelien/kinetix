import { useTranslation } from 'react-i18next';
import {
  getMonographSection,
  isMonographSectionId,
  getMonographField,
  type MonographSectionId,
} from '@/lib/monographSections';
import { activeLangCode } from '@/lib/useDrugName';
import {
  formatReference,
  referenceModulePath,
  type ReferenceRow,
} from '@/lib/referenceApi';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

interface WikiFactDiffProps {
  edit: PendingEditRow;
}

/**
 * Render a `wiki_fact` pending edit as a single-claim review card. Topology:
 *   header (operation badge + section/field path)
 *   body (claim — for replace shows existing → proposed, for remove shows
 *         the existing claim struck through, for add shows only the new
 *         claim with a green accent)
 *   references list
 *
 * Atomic facts are single sentences, so a word-diff would be visual noise;
 * showing the existing and proposed claims stacked is enough for review.
 */
export function WikiFactDiff({ edit }: WikiFactDiffProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);

  const op = edit.factOperation ?? 'add';
  const sectionId = edit.sectionId ?? null;
  const fieldId = edit.fieldId ?? null;
  const factStatement = edit.factStatement ?? '';
  const currentFactText = edit.currentFactText ?? '';
  const factId =
    typeof edit.factTargetAnchor?.factId === 'string'
      ? edit.factTargetAnchor.factId
      : null;

  const sectionLabel =
    sectionId && isMonographSectionId(sectionId)
      ? lang === 'en'
        ? getMonographSection(sectionId).titleEn
        : getMonographSection(sectionId).titleNb
      : sectionId;
  const fieldLabel =
    sectionId && isMonographSectionId(sectionId) && fieldId
      ? (() => {
          const field = getMonographField(
            sectionId as MonographSectionId,
            fieldId,
          );
          if (!field) return fieldId;
          return lang === 'en' ? field.titleEn : field.titleNb;
        })()
      : null;

  const opBadge =
    op === 'add'
      ? t('review.factOpAdd')
      : op === 'replace'
        ? t('review.factOpReplace')
        : op === 'reorder'
          ? t('review.factOpReorder', { defaultValue: 'Reorder fact' })
          : t('review.factOpRemove');

  // Reorder ships its destination index in proposedValue.position;
  // surface it in the review card so reviewers know where the fact
  // is being moved without scrolling the raw payload.
  const reorderPosition =
    op === 'reorder' &&
    edit.proposedValue &&
    typeof edit.proposedValue === 'object' &&
    typeof (edit.proposedValue as { position?: unknown }).position === 'number'
      ? (edit.proposedValue as { position: number }).position
      : null;

  const refs: ReferenceRow[] = edit.references ?? [];

  // Sources on this proposal a reviewer must open before approving.
  //
  // Two different facts feed this, and conflating them loses the one that
  // matters:
  //
  //  - **the assistant never read this paper for this claim** — recorded on the
  //    proposal at ingestion (`unverifiedReferenceIds`). It is why the claim
  //    was queued instead of published, it is a statement about history, and
  //    it stays true no matter what happens to the paper afterwards. A paper
  //    can carry someone else's read-in-full review and still have never been
  //    checked against *this sentence*;
  //  - **nobody has read this paper at all** — live on the citation
  //    (`readInFull === false`), which also catches a reference added while the
  //    proposal was out for revision.
  //
  // So: the union. Frozen ids are intersected with the references actually on
  // the row, so a paper dropped during a revision cannot be marked; live state
  // covers what the frozen list cannot know about. `readInFull` is undefined on
  // payloads that do not supply it, and unknown is not a claim of unread.
  //
  // Scoped to proposals conversation ingestion staged, because that is where
  // the queue route promises a full-text check: an unreviewed citation on a
  // contributor's fact is ordinary — the reference gate is an agent discipline,
  // not a human one — and flagging every one of those would be a different
  // change to a shared card.
  const meta = edit.proposedMeta as {
    source?: unknown;
    unverifiedReferenceIds?: unknown;
  } | null;
  const fromConversation = meta?.source === 'conversation-ingestion';
  const stagedUnverified = new Set(
    Array.isArray(meta?.unverifiedReferenceIds)
      ? (meta.unverifiedReferenceIds as unknown[]).filter(
          (id): id is number => typeof id === 'number',
        )
      : [],
  );
  const unreadIds = new Set(
    fromConversation
      ? refs
          .filter((r) => stagedUnverified.has(r.id) || r.readInFull === false)
          .map((r) => r.id)
      : [],
  );

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-background px-1.5 py-0.5 font-medium text-foreground">
          {opBadge}
        </span>
        <span className="font-medium text-foreground">{sectionLabel}</span>
        {fieldLabel ? (
          <>
            <span aria-hidden>›</span>
            <span className="font-medium text-foreground">{fieldLabel}</span>
          </>
        ) : null}
        {factId ? (
          <span className="font-mono text-[10px] opacity-60">
            #{factId.slice(0, 8)}
          </span>
        ) : null}
      </div>

      {op === 'replace' ? (
        <div className="space-y-2 text-sm">
          <ClaimBlock
            label={t('review.factCurrent')}
            text={currentFactText || t('review.factSnippetUnavailable')}
            tone="removed"
          />
          <ClaimBlock
            label={t('review.factProposed')}
            text={factStatement}
            tone="added"
          />
        </div>
      ) : op === 'remove' ? (
        <ClaimBlock
          label={t('review.factCurrent')}
          text={currentFactText || t('review.factSnippetUnavailable')}
          tone="removed"
        />
      ) : op === 'reorder' ? (
        <div className="space-y-2 text-sm">
          {/* Reorder is not a deletion — render the current fact in
              the neutral tone, not the rose strikethrough used for
              `remove`/replace-current. The amber bar below carries
              the position-change signal so reviewers see what's
              actually changing. */}
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {t('review.factCurrent')}
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-2 text-foreground">
              {currentFactText || (
                <span className="italic opacity-70">
                  {t('review.factSnippetUnavailable')}
                </span>
              )}
            </div>
          </div>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <span className="font-medium">
              {t('review.factTargetPosition', {
                defaultValue: 'Move to fact-position',
              })}
              :
            </span>{' '}
            <span className="font-mono">{reorderPosition ?? '—'}</span>
          </div>
        </div>
      ) : (
        <ClaimBlock
          label={t('review.factProposed')}
          text={factStatement}
          tone="added"
        />
      )}

      {/* The claim reached the queue unverified. That is not a badge about
          review status — it is the task: approving publishes a sentence whose
          source nobody has opened. Stated before the reference list, which
          then marks which paper that is. */}
      {unreadIds.size > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
          {t('review.factUnverifiedSource', { count: unreadIds.size })}
        </div>
      ) : null}

      {refs.length > 0 ? (
        <div className="space-y-1 rounded-md bg-background px-3 py-2 text-xs">
          <div className="font-medium text-muted-foreground">
            {t('review.factReferences', { count: refs.length })}
          </div>
          <ul className="space-y-1">
            {refs.map((ref, idx) => (
              <li key={ref.id} className="leading-snug">
                <span className="mr-1 text-muted-foreground">[{idx + 1}]</span>
                <ReferenceLink refRow={ref} />
                {unreadIds.has(ref.id) ? (
                  <span className="ml-1 text-amber-700 dark:text-amber-400">
                    {t('review.factReferenceNotRead')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ClaimBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'added' | 'removed';
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div
        className={
          tone === 'added'
            ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-900 dark:text-emerald-100'
            : 'rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-900 line-through decoration-rose-500/60 dark:text-rose-100'
        }
      >
        {text || <span className="italic opacity-70">—</span>}
      </div>
    </div>
  );
}

function ReferenceLink({ refRow }: { refRow: ReferenceRow }): JSX.Element {
  const label = referenceLabel(refRow);

  return (
    <a
      href={referenceModulePath(refRow.id)}
      className="text-primary underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {label}
    </a>
  );
}

function referenceLabel(ref: ReferenceRow): string {
  const formatted = formatReference(ref);
  if (formatted) return formatted;
  return ref.identifier || `ref ${ref.id}`;
}
