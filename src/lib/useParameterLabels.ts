import { useTranslation } from 'react-i18next';
import {
  getParameterLabelKey,
  getParameterLongLabelKey,
  type ParameterSpec,
} from './drugParameters';

/**
 * Resolve a parameter's translated `label` and `longLabel`, falling back
 * to the hardcoded English strings on `spec` when a translation is
 * missing. Use this anywhere the sidebar/edit/history/discussion UI
 * renders a parameter name to end users; the registry's spec strings
 * stay English-only and serve as the safety net for newly-registered
 * parameters before translations land.
 */
export function useParameterLabels(spec: ParameterSpec): {
  label: string;
  longLabel: string;
} {
  const { t } = useTranslation();
  return {
    label: t(getParameterLabelKey(spec.id), { defaultValue: spec.label }),
    longLabel: t(getParameterLongLabelKey(spec.id), {
      defaultValue: spec.longLabel,
    }),
  };
}
