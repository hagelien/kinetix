import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  discussionTargetForFact,
  type DiscussionHost,
} from '@/lib/discussionTargets';
import type { VerificationLevelInfo } from '@/lib/verificationLevel';
import { DiscussionThread } from './DiscussionThread';
import { VerificationSummary } from './VerificationSummary';

interface Props {
  /** Drug monograph (`{ drugId }`) or topic page (`{ wikiPageId }`). */
  host: DiscussionHost;
  factId: string;
  /** Verification level of this fact's live value, if known. */
  verification?: VerificationLevelInfo;
  onClose: () => void;
}

export function FactDiscussionPanel({
  host,
  factId,
  verification,
  onClose,
}: Props) {
  const { t } = useTranslation();

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t('discussion.factTitle')}
      className="w-full max-w-2xl p-6 max-h-[80vh] flex flex-col"
    >
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-lg font-semibold">{t('discussion.factTitle')}</h3>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('sidebar.close')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {verification ? <VerificationSummary info={verification} /> : null}
        <DiscussionThread
          host={host}
          parameter={discussionTargetForFact(factId)}
        />
      </div>
    </ModalOverlay>
  );
}
