/**
 * A SYNTHETIC stand-in for the restricted urine detection-time guideline, for
 * tests only.
 *
 * The real table is an internal controlled document and never enters the
 * source tree (it is loaded into `refs_detection_guidelines` from outside the
 * repository). These rows are invented: the substance names are ordinary
 * public names chosen to exercise the matcher's hard cases — compound cells,
 * parenthesised synonyms, a substance that is both a row and another row's
 * metabolite, split parent/metabolite readings — and every band, comment and
 * detail below was made up for the test. None of it is a forensic statement.
 */
import type {
  RefsDetectionBand,
  RefsGuidelineSource,
  RefsUrineDetectionPayload,
  RefsUrineDetectionRow,
} from '../../refsDetectionTimes';

export const SYNTHETIC_REFS_SOURCE: RefsGuidelineSource = {
  title: 'Synthetic urine guideline (test fixture)',
  documentId: 'SYNTH-0001',
  version: '1',
  approvedFrom: '2000-01-01',
  unit: 'Synthetic test unit',
  classification: 'Synthetic – not a real document',
};

export const SYNTHETIC_REFS_PREAMBLE =
  'Synthetic preamble: these bands are invented for tests.';

const band = (
  value: RefsDetectionBand,
  upper?: RefsDetectionBand,
): RefsUrineDetectionRow['readings'] => [
  {
    scope: 'both',
    statement: { kind: 'band', band: value, ...(upper ? { upper } : {}) },
  },
];

const split = (
  parent: RefsDetectionBand,
  metabolite: RefsDetectionBand,
): RefsUrineDetectionRow['readings'] => [
  { scope: 'parent', statement: { kind: 'band', band: parent } },
  { scope: 'metabolite', statement: { kind: 'band', band: metabolite } },
];

export const SYNTHETIC_REFS_ROWS: RefsUrineDetectionRow[] = [
  {
    key: 'diazepam',
    parent: 'Diazepam',
    metabolites: ['Nordiazepam', 'Oxazepam', 'Temazepam'],
    readings: band('week'),
    comment: 'Synthetic comment.',
    detail: 'Synthetic detail text for tests.',
  },
  {
    key: 'etanol',
    parent: 'Etanol',
    metabolites: ['Etylglukuronid', 'Etylsulfat'],
    readings: split('halfDay', 'days'),
    aliases: ['Ethanol'],
    metaboliteAliases: { Etylglukuronid: ['EtG'], Etylsulfat: ['EtS'] },
  },
  {
    key: 'fencyklidin',
    parent: 'Fencyklidin (PCP)',
    metabolites: [],
    readings: [{ scope: 'both', statement: { kind: 'noDocumentation' } }],
  },
  {
    key: 'ketamin',
    parent: 'Ketamin',
    metabolites: [],
    readings: band('days'),
  },
  {
    key: 'kokain',
    parent: 'Kokain',
    metabolites: ['Benzoylekgonin'],
    readings: split('halfDay', 'days'),
    aliases: ['Cocaine'],
    metaboliteAliases: { Benzoylekgonin: ['Benzoylecgonine'] },
  },
  {
    key: 'mdma-mda',
    parent: 'MDMA/MDA (Ecstacy)',
    metabolites: [],
    readings: band('day', 'days'),
  },
  {
    key: 'metadon',
    parent: 'Metadon',
    metabolites: ['EDDP'],
    readings: [{ scope: 'parent', statement: { kind: 'band', band: 'week' } }],
    aliases: ['Methadone'],
  },
  {
    key: 'metamfetamin',
    parent: 'Metamfetamin',
    metabolites: ['Amfetamin'],
    readings: band('days'),
    aliases: ['Methamphetamine'],
  },
  {
    key: 'morfin',
    parent: 'Morfin',
    metabolites: ['Morfin-3-glukuronid'],
    readings: band('days'),
    metaboliteAliases: { 'Morfin-3-glukuronid': ['M3G'] },
  },
  {
    key: 'oxazepam',
    parent: 'Oxazepam',
    metabolites: [],
    readings: band('days'),
  },
  {
    key: 'thc',
    parent: 'THC',
    metabolites: ['THC-syre'],
    readings: [{ scope: 'both', statement: { kind: 'curves' } }],
  },
  {
    key: 'zopiklon',
    parent: 'Zopiklon',
    metabolites: [],
    readings: [{ scope: 'both', statement: { kind: 'notStated' } }],
  },
];

/** What the route answers an entitled caller, built from the rows above. */
export const SYNTHETIC_REFS_PAYLOAD: RefsUrineDetectionPayload = {
  source: SYNTHETIC_REFS_SOURCE,
  preamble: SYNTHETIC_REFS_PREAMBLE,
  rows: SYNTHETIC_REFS_ROWS,
  gated: false,
};
