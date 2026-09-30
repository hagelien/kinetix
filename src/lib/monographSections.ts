import type { DrugParameterId } from './drugParameters.js';

export const MONOGRAPH_SECTION_IDS = [
  'pd',
  'pk',
  'metabolism',
  'medical_use',
  'non_medical_use',
  'effects',
  'toxicity',
  'analytical',
  'forensic',
] as const;

export type MonographSectionId = (typeof MONOGRAPH_SECTION_IDS)[number];

export type MonographFieldKind =
  // Free prose body, retained for future structured slots if needed.
  | 'prose'
  // Mirrors a structured drug parameter inline (read-only in the monograph).
  | 'parameter';

export interface MonographField {
  /** Stable id, unique within its parent section. */
  id: string;
  titleNb: string;
  titleEn: string;
  kind: MonographFieldKind;
  /**
   * For `kind: 'parameter'`: the numeric drug parameter this field mirrors.
   * Set when issue #276 marks the field with `*` AND a parameter already
   * exists in the registry.
   */
  parameterAnchor?: DrugParameterId;
  /**
   * For `*`-marked fields whose anchor is not yet in the schema. The
   * description records the intended structured field so future schema work
   * can be tracked back to the originating monograph slot.
   */
  pendingAnchor?: { description: string };
}

export interface MonographSection {
  id: MonographSectionId;
  /** 1-indexed display order, matches issue #276. */
  order: number;
  titleNb: string;
  titleEn: string;
  /** Author-facing hint shown when the section is empty (canonical Norwegian). */
  descriptionNb: string;
  /** English translation of the author hint, used when the UI language is `en`. */
  descriptionEn: string;
  /** Optional structured slots within the section. */
  fields: MonographField[];
}

/**
 * #458 retired monograph sub-categories as authoring targets. Existing rows
 * may still store fact bodies in these field slots; monographContent merges
 * those bodies into the parent section while keeping truly removed #396
 * parameter fields hidden.
 */
export const MERGED_MONOGRAPH_FIELD_IDS: Partial<
  Record<MonographSectionId, readonly string[]>
> = {
  pk: ['cmax', 'special_populations'],
  metabolism: [
    'parent_compound',
    'prodrugs',
    'active_metabolites',
    'inactive_metabolites',
  ],
  effects: [
    'psychiatric',
    'neurological',
    'cardiovascular',
    'respiratory',
    'gi_hepatic',
    'renal',
    'endocrine_sexual',
    'immunological',
  ],
  analytical: [
    'matrix_blood',
    'matrix_serum_plasma',
    'matrix_urine',
    'matrix_oral_fluid',
    'matrix_hair',
    'matrix_vitreous',
    'matrix_tissue',
    'matrix_gastric',
  ],
};

export const MONOGRAPH_SECTIONS: readonly MonographSection[] = [
  {
    id: 'pd',
    order: 1,
    titleNb: 'Farmakodynamikk',
    titleEn: 'Pharmacodynamics',
    descriptionNb:
      'Primære og sekundære mål, agonist/antagonist-status, affiniteter, funksjonelle effekter, toleranse- og avhengighetsmekanismer.',
    descriptionEn:
      'Primary and secondary targets, agonist/antagonist status, affinities, functional effects, tolerance and dependence mechanisms.',
    fields: [],
  },
  {
    id: 'pk',
    order: 2,
    titleNb: 'Farmakokinetikk',
    titleEn: 'Pharmacokinetics',
    descriptionNb:
      'Absorpsjon, distribusjon, eliminasjon og kinetikk i spesielle populasjoner. Numeriske parametre vises i parameterboksen til høyre, ikke inline.',
    descriptionEn:
      'Absorption, distribution, elimination and kinetics in special populations. Numeric parameters live in the right-side parameter box, not inline.',
    fields: [],
  },
  {
    id: 'metabolism',
    order: 3,
    titleNb: 'Biotransformasjon, metabolitter og prodrugs',
    titleEn: 'Biotransformation, metabolites, precursors and prodrugs',
    descriptionNb:
      'Fase I/II-metabolisme, aktive og toksiske metabolitter, enzymer, induktorer/inhibitorer og analytiske implikasjoner.',
    descriptionEn:
      'Phase I/II metabolism, active and toxic metabolites, enzymes, inducers/inhibitors and analytical implications.',
    fields: [],
  },
  {
    id: 'medical_use',
    order: 4,
    titleNb: 'Medisinsk bruk',
    titleEn: 'Medical use',
    descriptionNb:
      'Godkjente og off-label-indikasjoner, formuleringer, doser, terapeutisk monitorering, kontraindikasjoner og interaksjoner.',
    descriptionEn:
      'Approved and off-label indications, formulations, doses, therapeutic monitoring, contraindications and interactions.',
    fields: [],
  },
  {
    id: 'non_medical_use',
    order: 5,
    titleNb: 'Ikke-medisinsk bruk og misbruk',
    titleEn: 'Non-medical use, misuse and abuse',
    descriptionNb:
      'Inntaksruter, doser, bruksmønstre, ønskede effekter, avhengighet, samtidig bruk og forfalskningskontekst.',
    descriptionEn:
      'Routes of administration, doses, use patterns, desired effects, dependence, co-use, and adulterant context.',
    fields: [],
  },
  {
    id: 'effects',
    order: 6,
    titleNb: 'Effekter, bivirkninger og komplikasjoner',
    titleEn: 'Effects, adverse effects and complications',
    descriptionNb:
      'Forventede og uønskede effekter, kroniske komplikasjoner og interaksjoner.',
    descriptionEn:
      'Expected and adverse effects, chronic complications, and interactions.',
    fields: [],
  },
  {
    id: 'toxicity',
    order: 7,
    titleNb: 'Toksisitet og overdose',
    titleEn: 'Toxicity and overdose',
    descriptionNb:
      'Toksikodynamikk, klinisk presentasjon, dose- og konsentrasjonsforhold, antidoter og forsinket toksisitet.',
    descriptionEn:
      'Toxicodynamics, clinical presentation, dose- and concentration-toxicity relationships, antidotes, and delayed toxicity.',
    fields: [],
  },
  {
    id: 'analytical',
    order: 8,
    titleNb: 'Analytisk toksikologi',
    titleEn: 'Analytical toxicology',
    descriptionNb:
      'Matriser, screening- og bekreftelsesmetoder, LOD/LOQ, stabilitet, deteksjonsvinduer og parent/metabolitt-detekterbarhet.',
    descriptionEn:
      'Matrices, screening and confirmatory methods, LOD/LOQ, stability, detection windows, and parent/metabolite detectability.',
    fields: [],
  },
  {
    id: 'forensic',
    order: 9,
    titleNb: 'Forensisk tolkning',
    titleEn: 'Forensic interpretation',
    descriptionNb:
      'Tolkning av positive/negative funn, postmortem-spesifikke forhold, tidsestimering og typiske forbehold.',
    descriptionEn:
      'Interpretation of positive/negative findings, postmortem-specific considerations, time estimation, and typical caveats.',
    fields: [],
  },
];

const SECTIONS_BY_ID: Record<MonographSectionId, MonographSection> =
  Object.fromEntries(MONOGRAPH_SECTIONS.map((s) => [s.id, s])) as Record<
    MonographSectionId,
    MonographSection
  >;

export function isMonographSectionId(id: string): id is MonographSectionId {
  return (MONOGRAPH_SECTION_IDS as readonly string[]).includes(id);
}

export function getMonographSection(id: MonographSectionId): MonographSection {
  return SECTIONS_BY_ID[id];
}

export function getMonographField(
  sectionId: MonographSectionId,
  fieldId: string,
): MonographField | null {
  const section = SECTIONS_BY_ID[sectionId];
  return section.fields.find((f) => f.id === fieldId) ?? null;
}

export function isMergedMonographFieldId(
  sectionId: MonographSectionId,
  fieldId: string,
): boolean {
  const mergedIds = MERGED_MONOGRAPH_FIELD_IDS[sectionId] as
    | readonly string[]
    | undefined;
  return mergedIds?.includes(fieldId) ?? false;
}

/**
 * Walks every parameter-anchored field across all sections. Useful when the
 * renderer/editor needs to mirror structured drug-row values into the right
 * section slot.
 */
export function getParameterAnchoredFields(): Array<{
  section: MonographSection;
  field: MonographField;
  parameterAnchor: DrugParameterId;
}> {
  const out: Array<{
    section: MonographSection;
    field: MonographField;
    parameterAnchor: DrugParameterId;
  }> = [];
  for (const section of MONOGRAPH_SECTIONS) {
    for (const field of section.fields) {
      if (field.kind === 'parameter' && field.parameterAnchor) {
        out.push({ section, field, parameterAnchor: field.parameterAnchor });
      }
    }
  }
  return out;
}

/**
 * Fields marked with `*` in issue #276 whose structured anchor is not yet in
 * the schema. Callers (e.g. an admin coverage view) can surface these as
 * follow-up schema work.
 */
export function getPendingAnchorFields(): Array<{
  section: MonographSection;
  field: MonographField;
}> {
  const out: Array<{ section: MonographSection; field: MonographField }> = [];
  for (const section of MONOGRAPH_SECTIONS) {
    for (const field of section.fields) {
      if (field.pendingAnchor) {
        out.push({ section, field });
      }
    }
  }
  return out;
}
