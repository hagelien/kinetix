/**
 * The works the pattern registries cite, with the metadata that makes each one
 * checkable (§13.3, owner decision: published sources only).
 *
 * This exists because a citation *handle* is not a citation. A PMID is eight
 * digits; any eight digits are a syntactically valid PMID, and the wrong ones
 * point at a real paper about something else entirely. A gate that checks the
 * shape of the handle therefore checks nothing that matters — which is exactly
 * how a mistyped identifier came to authorise the only ENFSI strength statement
 * in the benzodiazepine module, backed by a paper on enzymatic hydrolysis
 * artefacts.
 *
 * Registration here is a curator asserting: I looked this up, this is the work,
 * and this is what kind of work it is. `workKind` is what the published-sources
 * decision actually turns on — a preprint or a personal communication is a
 * handle that resolves and still may not support a forensic strength statement.
 *
 * Phase 1 replaces this table with the `citations` store and its
 * `work_kind_status` resolution. The shape of the question does not change, so
 * neither does anything that calls `resolvesToPublishedWork`.
 */

import type { PatternCitationRef } from '../../types/patternCase.js';

/**
 * What kind of work a handle names. The distinction is not decorative: the
 * owner decision admits published sources only, so the set below is split into
 * those that qualify and those that resolve but do not.
 */
export type PublishedWorkKind =
  | 'journal_article'
  | 'book'
  | 'official_guideline'
  | 'preprint'
  | 'thesis'
  | 'conference_abstract'
  | 'web_page'
  | 'personal_communication';

/** The kinds that satisfy "published source". */
const PUBLISHED_KINDS: ReadonlySet<PublishedWorkKind> = new Set<PublishedWorkKind>([
  'journal_article',
  'book',
  'official_guideline',
]);

export interface RegisteredWork {
  handle: PatternCitationRef;
  workKind: PublishedWorkKind;
  /** Verified against the source record, not transcribed from a code comment. */
  title: string;
  container: string;
  year: number;
  doi?: string;
}

/**
 * Every work the shipped registries cite. Metadata verified against the PubMed
 * record for each identifier rather than copied from the prose around it.
 */
const REGISTERED_WORKS: RegisteredWork[] = [
  {
    handle: { type: 'pmid', identifier: '23298862' },
    workKind: 'journal_article',
    title: 'Methadone N-demethylation by the common CYP2B6 allelic variant CYP2B6.6',
    container: 'Drug Metabolism and Disposition 41(4):709–713',
    year: 2013,
    doi: '10.1124/dmd.112.050625',
  },
  {
    handle: { type: 'pmid', identifier: '25897175' },
    workKind: 'journal_article',
    title: 'Differences in Methadone Metabolism by CYP2B6 Variants',
    container: 'Drug Metabolism and Disposition 43(7):994–1001',
    year: 2015,
    doi: '10.1124/dmd.115.064352',
  },
  {
    handle: { type: 'pmid', identifier: '19161663' },
    workKind: 'journal_article',
    title: 'Normalization of urinary drug concentrations with specific gravity and creatinine',
    container: 'Journal of Analytical Toxicology 33(1):1–7',
    year: 2009,
    doi: '10.1093/jat/33.1.1',
  },
  {
    handle: { type: 'pmid', identifier: '20529458' },
    workKind: 'journal_article',
    title:
      'A novel reductive transformation of oxazepam to nordiazepam observed during enzymatic hydrolysis',
    container: 'Journal of Analytical Toxicology 34(5):243–251',
    year: 2010,
    doi: '10.1093/jat/34.5.243',
  },
  {
    handle: { type: 'pmid', identifier: '22797834' },
    workKind: 'journal_article',
    title:
      'Concentrations of diazepam and nordiazepam in 1,000 blood samples from apprehended drivers — therapeutic use or abuse of anxiolytics?',
    container: 'Journal of Pharmacy Practice 26(3):198–203',
    year: 2012,
    doi: '10.1177/0897190012451910',
  },
  {
    handle: { type: 'pmid', identifier: '24500275' },
    workKind: 'journal_article',
    title: 'Urinary diazepam metabolite distribution in a chronic pain population',
    container: 'Journal of Analytical Toxicology 38(3):135–142',
    year: 2014,
    doi: '10.1093/jat/bku001',
  },
  {
    handle: { type: 'pmid', identifier: '32219697' },
    workKind: 'journal_article',
    title: 'Study on the pharmacokinetics of diazepam and its metabolites in blood of Chinese people',
    container: 'European Journal of Drug Metabolism and Pharmacokinetics 45(4):477–485',
    year: 2020,
    doi: '10.1007/s13318-020-00614-8',
  },
];

const BY_HANDLE = new Map(
  REGISTERED_WORKS.map((work) => [handleKey(work.handle), work] as const),
);

function handleKey(ref: PatternCitationRef): string {
  return `${ref.type}:${ref.identifier.trim().toLowerCase()}`;
}

/** The registered work behind a handle, if a curator has registered one. */
export function lookupWork(ref: PatternCitationRef | undefined): RegisteredWork | undefined {
  if (!ref || typeof ref.identifier !== 'string') return undefined;
  return BY_HANDLE.get(handleKey(ref));
}

/**
 * Whether a handle names a registered work of a published kind.
 *
 * Both halves are load-bearing. Unregistered means nobody checked what the
 * identifier points at; registered-but-unpublished means somebody did, and the
 * answer disqualifies it.
 */
export function resolvesToPublishedWork(ref: PatternCitationRef | undefined): boolean {
  const work = lookupWork(ref);
  return work !== undefined && PUBLISHED_KINDS.has(work.workKind);
}
