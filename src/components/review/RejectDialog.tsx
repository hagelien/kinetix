import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { REJECTION_REASONS, type RejectionReason } from '@/lib/rejectionReasons';

interface RejectDialogProps {
  onReject: (args: { reason: RejectionReason; comment: string }) => void;
  onCancel: () => void;
  saving: boolean;
  /**
   * Failure surfaced from the parent's review call. Rendered inside the
   * dialog so the reviewer sees why a rejection didn't go through instead of
   * the modal silently staying open with the error hidden behind it.
   */
  error?: string | null;
}

export function RejectDialog({
  onReject,
  onCancel,
  saving,
  error,
}: RejectDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [comment, setComment] = useState('');

  const requireComment = reason === 'other' || reason === '';
  const submitDisabled = !reason || saving || (requireComment && !comment.trim());

  return (
    <ModalOverlay
      onClose={onCancel}
      ariaLabel={t('review.rejectEdit')}
      className="w-full max-w-md p-6"
    >
      <h3 className="text-lg font-semibold mb-2">{t('review.rejectEdit')}</h3>
      <p className="text-sm text-muted-foreground mb-3">
        {t('review.rejectExplanation')}
      </p>

      <label className="block text-xs font-medium mb-1">
        {t('review.rejectionReasonLabel')}
      </label>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value as RejectionReason | '')}
        className="w-full px-3 py-2 mb-3 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        autoFocus
      >
        <option value="">{t('review.rejectionReasonPickPrompt')}</option>
        {REJECTION_REASONS.map((id) => (
          <option key={id} value={id}>
            {t(`rejectionReasons.${id}`)}
          </option>
        ))}
      </select>

      <label className="block text-xs font-medium mb-1">
        {t('review.rejectionCommentLabel')}
        {requireComment ? <span className="text-rose-500"> *</span> : null}
      </label>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('review.rejectPlaceholder')}
        className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px]"
      />

      {error ? (
        <p className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t('review.cancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={() =>
            reason && onReject({ reason: reason as RejectionReason, comment: comment.trim() })
          }
          disabled={submitDisabled}
        >
          {saving ? t('review.rejecting') : t('review.reject')}
        </Button>
      </div>
    </ModalOverlay>
  );
}
