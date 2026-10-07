import type { MonographSectionId } from './monographSections';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  type ParameterGroupId,
} from './drugParameters';
import { loadJSON, persist } from './storage';

/**
 * Sub-pages of a drug monograph. Each tab shows one former parameter box at
 * the top of the monograph, followed by the prose sections that belong to the
 * same topic. The order here is the order in the header sub-menu.
 */
export const MONOGRAPH_TAB_IDS = [
  'chemistry',
  'pharmacodynamics',
  'pharmacokinetics',
  'metabolism',
  'dose_exposure',
  'interpretive_concentrations',
  'analytics_detection',
  'postmortem',
] as const satisfies readonly ('metabolism' | ParameterGroupId)[];

export type MonographTabId = (typeof MONOGRAPH_TAB_IDS)[number];

export const DEFAULT_MONOGRAPH_TAB: MonographTabId = 'chemistry';

const TAB_LABEL_KEYS: Record<MonographTabId, string> = {
  chemistry: 'parameterGroups.chemistry',
  pharmacodynamics: 'parameterGroups.pharmacodynamics',
  pharmacokinetics: 'parameterGroups.pharmacokinetics',
  metabolism: 'sidebar.metabolism',
  dose_exposure: 'parameterGroups.doseExposure',
  interpretive_concentrations: 'parameterGroups.interpretiveConcentrations',
  analytics_detection: 'parameterGroups.analyticsDetection',
  postmortem: 'parameterGroups.postmortem',
};

export function monographTabLabelKey(tab: MonographTabId): string {
  return TAB_LABEL_KEYS[tab];
}

export function isMonographTabId(value: unknown): value is MonographTabId {
  return (
    typeof value === 'string' &&
    (MONOGRAPH_TAB_IDS as readonly string[]).includes(value)
  );
}

/**
 * Which tab each prose section is shown under. Sections without a box of
 * their own are folded into the nearest topic: effects with
 * pharmacodynamics, toxicity with the interpretive concentrations, medical
 * and non-medical use with dose & exposure, and the forensic section with
 * postmortem. Text outside any known section lands on chemistry.
 */
export const SECTION_TAB: Record<MonographSectionId, MonographTabId> = {
  pd: 'pharmacodynamics',
  effects: 'pharmacodynamics',
  pk: 'pharmacokinetics',
  metabolism: 'metabolism',
  medical_use: 'dose_exposure',
  non_medical_use: 'dose_exposure',
  toxicity: 'interpretive_concentrations',
  analytical: 'analytics_detection',
  forensic: 'postmortem',
};

/** Prose sections shown (and edited) on a tab, in schema order. */
export function sectionsForTab(tab: MonographTabId): MonographSectionId[] {
  return (Object.keys(SECTION_TAB) as MonographSectionId[]).filter(
    (id) => SECTION_TAB[id] === tab,
  );
}

function tabForSection(sectionId: string): MonographTabId {
  return (
    (SECTION_TAB as Record<string, MonographTabId | undefined>)[sectionId] ??
    DEFAULT_MONOGRAPH_TAB
  );
}

/**
 * The prose section that shares its tab's name. Its own heading would only
 * repeat the page title, so it is dropped when that tab is shown.
 */
const TITLE_SECTION: Partial<Record<MonographTabId, MonographSectionId>> = {
  pharmacodynamics: 'pd',
  pharmacokinetics: 'pk',
  metabolism: 'metabolism',
};

const SECTION_TITLE_RE = /<h2\b[^>]*\bdata-monograph-section-title="[a-z_]+"[^>]*>[\s\S]*?<\/h2>/;

const SECTION_BLOCK_RE =
  /<section\b[^>]*\bdata-monograph-section="([a-z_]+)"[^>]*>[\s\S]*?<\/section>/g;

/**
 * Keep only the parts of a monograph's rendered HTML that belong on `tab`.
 *
 * The server renders each prose section as one top-level
 * `<section data-monograph-section="…">` block, and sections never nest, so
 * a non-greedy match is safe (the same assumption `WikiRenderer` makes).
 * Anything outside a section block — legacy free-form pages, for instance —
 * has no topic and is shown on the default tab. The heading of the section
 * named like the tab is dropped, since the page title already says it.
 */
export function filterMonographHtmlForTab(
  html: string,
  tab: MonographTabId,
): string {
  const kept: string[] = [];
  let unsectioned = '';
  let last = 0;
  for (const match of html.matchAll(SECTION_BLOCK_RE)) {
    unsectioned += html.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    if (tabForSection(match[1]!) !== tab) continue;
    kept.push(
      TITLE_SECTION[tab] === match[1]
        ? match[0].replace(SECTION_TITLE_RE, '')
        : match[0],
    );
  }
  unsectioned += html.slice(last);
  if (tab === DEFAULT_MONOGRAPH_TAB && unsectioned.trim()) {
    kept.unshift(unsectioned);
  }
  return kept.join('');
}

/**
 * The tab a parameter's box lives on, so a deep link to a parameter's
 * history or discussion opens the page where that parameter is shown.
 * Parameters without a group (names, aliases, CID) sit on chemistry.
 */
export function tabForParameter(parameter: string): MonographTabId | null {
  if (!isDrugParameterId(parameter)) return null;
  const group = DRUG_PARAMETERS[parameter].group;
  return group && isMonographTabId(group) ? group : DEFAULT_MONOGRAPH_TAB;
}

const LAST_TAB_STORAGE_KEY = 'kinetix.monograph.lastTab';

/** The tab the reader was last on, so switching drug keeps the same topic. */
export function loadLastMonographTab(): MonographTabId {
  const stored = loadJSON<unknown>(LAST_TAB_STORAGE_KEY, DEFAULT_MONOGRAPH_TAB);
  return isMonographTabId(stored) ? stored : DEFAULT_MONOGRAPH_TAB;
}

export function saveLastMonographTab(tab: MonographTabId): void {
  persist(LAST_TAB_STORAGE_KEY, tab);
}

/** Route to a tab of a drug's monograph. */
export function monographTabPath(slug: string, tab: MonographTabId): string {
  return `/wiki/${encodeURIComponent(slug)}/${tab}`;
}
