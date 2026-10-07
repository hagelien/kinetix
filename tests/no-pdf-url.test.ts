import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NO_PDF_URL_PATTERN,
  noPdfReason,
} from '../src/lib/publicDatabaseRecord';

const url = (identifier: string) => ({ type: 'url', identifier });

describe('noPdfReason', () => {
  it('recognises public database record pages', () => {
    for (const identifier of [
      'https://pubchem.ncbi.nlm.nih.gov/compound/115237',
      'https://go.drugbank.com/drugs/DB00820',
      'https://www.drugbank.ca/drugs/DB00497/',
      'https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL160/',
      'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL160',
      'https://www.chemspider.com/Chemical-Structure.26250.html',
      'https://www.guidetopharmacology.org/GRAC/LigandDisplayForward?ligandId=1627',
      'https://www.lipidmaps.org/data/structure/LMSDRecord.php?LM_ID=LMGP02050001',
      'https://www.lipidmaps.org/databases/lmsd/LMFA01010001',
    ])
      expect(noPdfReason(url(identifier)), identifier).toBe(
        'public_database_record',
      );
  });

  it("recognises a site's front page and a database home page", () => {
    for (const identifier of [
      'https://www.noklus.no',
      ' https://www.guidetopharmacology.org/ ',
      'https://www.ebi.ac.uk/chembl/',
      'http://example.org/#top',
    ])
      expect(noPdfReason(url(identifier)), identifier).toBe(
        'site_landing_page',
      );
  });

  it('leaves documents, labels, reports and non-record database pages alone', () => {
    for (const identifier of [
      'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=a00e5720',
      'https://www.who.int/publications/m/item/protonitazene-critical-review-report',
      'https://www.legeforeningen.no/foreningsledd/fagmed/peth-veileder/',
      'https://pubchem.ncbi.nlm.nih.gov/compound/paliperidone',
      'https://pubchem.ncbi.nlm.nih.gov/substance/1',
      'https://go.drugbank.com/drugs/DB00820/clinical_trials',
      'https://example.org/?id=3',
      'https://drugbank.com.evil.example/drugs/DB00820',
    ])
      expect(noPdfReason(url(identifier)), identifier).toBeNull();
    expect(
      noPdfReason({ type: 'doi', identifier: 'https://www.noklus.no' }),
    ).toBeNull();
  });

  it('is the exact pattern migration 0139 applies in SQL', () => {
    const migration = readFileSync(
      'drizzle/0139_cancel_no_pdf_url_requests.sql',
      'utf8',
    );
    expect(migration).toContain(`~* '${NO_PDF_URL_PATTERN}'`);
  });
});
