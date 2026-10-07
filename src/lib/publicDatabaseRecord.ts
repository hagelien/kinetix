/**
 * URL citations that never need a PDF, and why.
 *
 * Two kinds of URL are cited like papers but have no PDF anybody could supply:
 *
 * - **Public database records** — a PubChem, DrugBank, ChEMBL, ChemSpider,
 *   Guide to Pharmacology or LIPID MAPS entry. These aggregate other sources.
 *   Agents read the record directly (PubChem through its open PUG-View
 *   service, `node scripts/kinetix-fulltext.mjs pubchem <CID>`) and cite the
 *   primary study it attributes. Their HTML pages often answer automated
 *   readers with a CAPTCHA or bot wall, which is why agents used to conclude
 *   the "full text" was missing and file PDF requests nobody could fulfil.
 * - **Site landing pages** — a website's front page (`https://www.noklus.no`)
 *   or a database's home (`https://www.ebi.ac.uk/chembl/`). There is nothing
 *   specific there to read, review or upload; the citation itself needs
 *   replacing with the exact page or study it was meant to point to, and
 *   `POST /api/references` refuses new ones.
 *
 * The PDF-request routes, the full-text gap list and the reference page's
 * upload prompt all use this classification to stay out of that loop.
 *
 * Only record-page shapes qualify as database records, so a cited substance,
 * bioassay, search result or name-style URL keeps the ordinary full-text path.
 * The patterns are shared verbatim with SQL (`~*`, case-insensitive), so keep
 * them to syntax both JavaScript and PostgreSQL regexes read the same way.
 */

const PUBCHEM_RECORD = 'pubchem\\.ncbi\\.nlm\\.nih\\.gov/compound/[1-9][0-9]*/?([?#]|$)';

/** Host-and-path shapes of the record pages, without the scheme. */
const DATABASE_RECORDS = [
  PUBCHEM_RECORD,
  'go\\.drugbank\\.com/drugs/DB[0-9]{5}/?([?#]|$)',
  'drugbank\\.(com|ca)/drugs/DB[0-9]{5}/?([?#]|$)',
  'ebi\\.ac\\.uk/chembl/(compound_report_card|explore/compound)/CHEMBL[0-9]+/?([?#]|$)',
  'chemspider\\.com/Chemical-Structure\\.[0-9]+\\.html([?#]|$)',
  'guidetopharmacology\\.org/GRAC/LigandDisplayForward\\?ligandId=[0-9]+([&#]|$)',
  'lipidmaps\\.org/(data/structure/LMSDRecord\\.php\\?LM_ID=|databases/lmsd/)LM[A-Z]{2}[0-9]+([&/#]|$)',
];

export const PUBCHEM_RECORD_URL_PATTERN = `^https?://(www\\.)?${PUBCHEM_RECORD}`;

export const PUBLIC_DATABASE_RECORD_URL_PATTERN = `^https?://(www\\.)?(${DATABASE_RECORDS.join('|')})`;

/**
 * A site's front page, or a database's home page. The scheme and host with an
 * optional trailing slash and fragment; a query string is not a landing page.
 */
export const SITE_LANDING_PAGE_URL_PATTERN =
  '^https?://([^/?#]+|(www\\.)?ebi\\.ac\\.uk/chembl)/?(#.*)?$';

/** Either kind: a URL citation no PDF request can ever satisfy. */
export const NO_PDF_URL_PATTERN = `(${PUBLIC_DATABASE_RECORD_URL_PATTERN})|(${SITE_LANDING_PAGE_URL_PATTERN})`;

const pubChemRecordUrl = new RegExp(PUBCHEM_RECORD_URL_PATTERN, 'i');
const databaseRecordUrl = new RegExp(PUBLIC_DATABASE_RECORD_URL_PATTERN, 'i');
const landingPageUrl = new RegExp(SITE_LANDING_PAGE_URL_PATTERN, 'i');

interface CitationHandle {
  type: string;
  identifier: string;
}

export function isPubChemRecordCitation(citation: CitationHandle): boolean {
  return (
    citation.type === 'url' && pubChemRecordUrl.test(citation.identifier.trim())
  );
}

export function isSiteLandingPageUrl(url: string): boolean {
  return landingPageUrl.test(url.trim());
}

export type NoPdfReason = 'public_database_record' | 'site_landing_page';

/** Why this citation can never be satisfied by a PDF, or null if it can. */
export function noPdfReason(citation: CitationHandle): NoPdfReason | null {
  if (citation.type !== 'url') return null;
  const url = citation.identifier.trim();
  if (databaseRecordUrl.test(url)) return 'public_database_record';
  if (landingPageUrl.test(url)) return 'site_landing_page';
  return null;
}
