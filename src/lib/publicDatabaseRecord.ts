/**
 * Public database records that are cited like papers but are not papers.
 *
 * A PubChem compound page is free to read, so it never needs a PDF: agents read
 * it through PubChem's open PUG-View data service
 * (`node scripts/kinetix-fulltext.mjs pubchem <CID>`). Its HTML page answers
 * automated readers with a CAPTCHA, which is why agents used to conclude the
 * "full text" was missing and file PDF requests nobody could meaningfully
 * fulfil. The PDF-request routes, the full-text gap list and the reference
 * page's upload prompt all use this classification to stay out of that loop.
 *
 * Only numeric compound-record URLs (`/compound/<CID>`) qualify — exactly what
 * the helper fetches. Substance, bioassay, patent and name-style URLs keep the
 * ordinary full-text path, since the helper cannot read them as cited.
 *
 * The pattern is shared verbatim with SQL (`~*`, case-insensitive), so keep it
 * to syntax both JavaScript and PostgreSQL regexes read the same way.
 */
export const PUBCHEM_RECORD_URL_PATTERN =
  '^https?://(www\\.)?pubchem\\.ncbi\\.nlm\\.nih\\.gov/compound/[1-9][0-9]*/?([?#]|$)';

const pubChemRecordUrl = new RegExp(PUBCHEM_RECORD_URL_PATTERN, 'i');

export function isPubChemRecordCitation(citation: {
  type: string;
  identifier: string;
}): boolean {
  return (
    citation.type === 'url' && pubChemRecordUrl.test(citation.identifier.trim())
  );
}
