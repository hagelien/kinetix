/**
 * Canonical receptor/target interaction taxonomy.
 *
 * Mirrors the pharmacology "mechanism of action" classification (enzymes,
 * membrane transporters, ion channels, receptors) so the mechanism editor can
 * offer a formatted, grouped picker instead of a raw free-text field. The
 * stored value stays a stable snake_case token (`interaction_type` column);
 * only the displayed label is localized.
 */

export interface InteractionType {
  /** Stored value written to `drug_receptor_targets.interaction_type`. */
  value: string;
  /** i18n key for the human-readable label (under `mechanismEdit.interactionTypes`). */
  labelKey: string;
}

export interface InteractionGroup {
  /** i18n key for the group heading (under `mechanismEdit.interactionGroups`). */
  labelKey: string;
  options: InteractionType[];
}

export const INTERACTION_GROUPS: InteractionGroup[] = [
  {
    labelKey: 'mechanismEdit.interactionGroups.receptor',
    options: [
      { value: 'agonist', labelKey: 'mechanismEdit.interactionTypes.agonist' },
      {
        value: 'partial_agonist',
        labelKey: 'mechanismEdit.interactionTypes.partial_agonist',
      },
      {
        value: 'inverse_agonist',
        labelKey: 'mechanismEdit.interactionTypes.inverse_agonist',
      },
      {
        value: 'antagonist',
        labelKey: 'mechanismEdit.interactionTypes.antagonist',
      },
      {
        value: 'competitive_antagonist',
        labelKey: 'mechanismEdit.interactionTypes.competitive_antagonist',
      },
      {
        value: 'noncompetitive_antagonist',
        labelKey: 'mechanismEdit.interactionTypes.noncompetitive_antagonist',
      },
      {
        value: 'uncompetitive_antagonist',
        labelKey: 'mechanismEdit.interactionTypes.uncompetitive_antagonist',
      },
      {
        value: 'positive_allosteric_modulator',
        labelKey:
          'mechanismEdit.interactionTypes.positive_allosteric_modulator',
      },
      {
        value: 'negative_allosteric_modulator',
        labelKey:
          'mechanismEdit.interactionTypes.negative_allosteric_modulator',
      },
    ],
  },
  {
    labelKey: 'mechanismEdit.interactionGroups.enzyme',
    options: [
      {
        value: 'enzyme_inhibitor',
        labelKey: 'mechanismEdit.interactionTypes.enzyme_inhibitor',
      },
      {
        value: 'enzyme_inducer',
        labelKey: 'mechanismEdit.interactionTypes.enzyme_inducer',
      },
      {
        value: 'enzyme_activator',
        labelKey: 'mechanismEdit.interactionTypes.enzyme_activator',
      },
    ],
  },
  {
    labelKey: 'mechanismEdit.interactionGroups.transporter',
    options: [
      {
        value: 'reuptake_inhibitor',
        labelKey: 'mechanismEdit.interactionTypes.reuptake_inhibitor',
      },
      {
        value: 'reuptake_enhancer',
        labelKey: 'mechanismEdit.interactionTypes.reuptake_enhancer',
      },
      {
        value: 'releasing_agent',
        labelKey: 'mechanismEdit.interactionTypes.releasing_agent',
      },
      {
        value: 'substrate',
        labelKey: 'mechanismEdit.interactionTypes.substrate',
      },
    ],
  },
  {
    labelKey: 'mechanismEdit.interactionGroups.ionChannel',
    options: [
      {
        value: 'channel_blocker',
        labelKey: 'mechanismEdit.interactionTypes.channel_blocker',
      },
      {
        value: 'channel_opener',
        labelKey: 'mechanismEdit.interactionTypes.channel_opener',
      },
    ],
  },
  {
    labelKey: 'mechanismEdit.interactionGroups.other',
    options: [
      {
        value: 'inhibitor',
        labelKey: 'mechanismEdit.interactionTypes.inhibitor',
      },
      {
        value: 'unspecified',
        labelKey: 'mechanismEdit.interactionTypes.unspecified',
      },
    ],
  },
];

const LABEL_KEY_BY_VALUE: Record<string, string> = Object.fromEntries(
  INTERACTION_GROUPS.flatMap((group) =>
    group.options.map((opt) => [opt.value, opt.labelKey]),
  ),
);

export function isKnownInteractionType(value: string): boolean {
  return value in LABEL_KEY_BY_VALUE;
}

/**
 * Human-readable label for an interaction value. Known taxonomy values are
 * localized via `t`; unknown/legacy values fall back to the snake_case token
 * with separators turned into spaces.
 */
export function formatInteractionLabel(
  value: string,
  t: (key: string) => string,
): string {
  const labelKey = LABEL_KEY_BY_VALUE[value];
  if (labelKey) return t(labelKey);
  return value.replace(/[_-]+/g, ' ');
}
