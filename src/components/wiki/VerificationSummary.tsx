import { useTranslation } from 'react-i18next';
import {
  VERIFICATION_LEVEL_LABEL_KEYS,
  VERIFICATION_DISPUTE_LABEL_KEY,
  type VerificationLevelInfo,
} from '@/lib/verificationLevel';

interface Props {
  info: VerificationLevelInfo;
}

/**
 * Plain-text verification summary for a live parameter value. Shown inside a
 * parameter's discussion + revision-history dialogs instead of as an inline
 * badge on the parameter row, so the browse surfaces stay free of the small
 * per-parameter review symbols.
 */
export function VerificationSummary({ info }: Props) {
  const { t } = useTranslation();
  return (
    <p className="mb-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {t('verification.summaryLabel')}:
      </span>{' '}
      {t(VERIFICATION_LEVEL_LABEL_KEYS[info.level])}
      {info.disputed ? <> · {t(VERIFICATION_DISPUTE_LABEL_KEY)}</> : null}
    </p>
  );
}
