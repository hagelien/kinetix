import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { createPriorityFlag } from '@/lib/parameterPriorityFlagsApi';

interface ParameterFlagDialogProps {
  drugId: number;
  parameter: string;
  onClose: () => void;
  onFlagged: () => void;
}

export function ParameterFlagDialog({
  drugId,
  parameter,
  onClose,
  onFlagged,
}: ParameterFlagDialogProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await createPriorityFlag({
        drugId,
        parameter,
        note: note.trim() || undefined,
      });
      onFlagged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t('review.flagDialogTitle')}
      className="w-full max-w-md p-6"
    >
      <h3 className="text-lg font-semibold mb-2">{t('review.flagDialogTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-3">
        {t('review.flagDialogDescription')}
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('review.flagNotePlaceholder')}
        className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px]"
        autoFocus
      />
      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mt-3">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t('review.cancel')}
        </Button>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving ? t('review.rejecting') : t('review.flagSubmit')}
        </Button>
      </div>
    </ModalOverlay>
  );
}
