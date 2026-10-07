import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  DRUG_PARAMETERS,
  type DrugParameterId,
} from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import type { VerificationLevelInfo } from '@/lib/verificationLevel';
import { DiscussionThread } from './DiscussionThread';
import { VerificationSummary } from './VerificationSummary';

interface Props {
  drugId: number;
  parameter: DrugParameterId;
  /** Verification level of this parameter's live value, if known. */
  verification?: VerificationLevelInfo;
  /** Comment to scroll to and highlight (a notification's deep link). */
  focusCommentId?: number;
  onClose: () => void;
}

export function ParameterDiscussionPanel({
  drugId,
  parameter,
  verification,
  focusCommentId,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const spec = DRUG_PARAMETERS[parameter];
  const { longLabel } = useParameterLabels(spec);
  // One string for the visible heading and the dialog's accessible name, so
  // the two can never drift apart.
  const heading = t('discussion.parameterHeading', { parameter: longLabel });

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={heading}
      className="w-full max-w-2xl p-6 max-h-[80vh] flex flex-col"
    >
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-lg font-semibold">{heading}</h3>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('sidebar.close')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {verification ? <VerificationSummary info={verification} /> : null}
        <DiscussionThread
          host={{ drugId }}
          parameter={parameter}
          focusCommentId={focusCommentId}
        />
      </div>
    </ModalOverlay>
  );
}
