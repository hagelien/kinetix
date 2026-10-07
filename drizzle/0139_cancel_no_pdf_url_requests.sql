-- Close the PDF requests filed against URL citations no PDF can satisfy.
--
-- Migration 0137 did this for PubChem compound records. The same holds for the
-- other public databases agents now read directly and cite through (DrugBank,
-- ChEMBL, ChemSpider, Guide to Pharmacology, LIPID MAPS record pages), and for
-- a site's front page, which names no specific source to read or upload at all
-- and needs re-citing instead. `POST /api/pdf-requests` refuses both
-- (`pdf_request_public_database_record`, `pdf_request_unspecific_url`), and
-- the open queue filters them on read, so a request the previous deployment
-- files after this runs is not stranded there either.
--
-- The pattern is NO_PDF_URL_PATTERN in src/lib/publicDatabaseRecord.ts
-- (tests/no-pdf-url-migration.test.ts keeps the two identical). Only open
-- requests with no stored PDF are touched: settled history stays, and a PDF
-- somebody did upload stays linked.
UPDATE "pdf_requests" r
SET "status" = 'cancelled'
FROM "citations" c
WHERE c."id" = r."citation_id"
  AND r."status" = 'open'
  AND c."type" = 'url'
  AND btrim(c."identifier") ~* '(^https?://(www\.)?(pubchem\.ncbi\.nlm\.nih\.gov/compound/[1-9][0-9]*/?([?#]|$)|go\.drugbank\.com/drugs/DB[0-9]{5}/?([?#]|$)|drugbank\.(com|ca)/drugs/DB[0-9]{5}/?([?#]|$)|ebi\.ac\.uk/chembl/(compound_report_card|explore/compound)/CHEMBL[0-9]+/?([?#]|$)|chemspider\.com/Chemical-Structure\.[0-9]+\.html([?#]|$)|guidetopharmacology\.org/GRAC/LigandDisplayForward\?ligandId=[0-9]+([&#]|$)|lipidmaps\.org/(data/structure/LMSDRecord\.php\?LM_ID=|databases/lmsd/)LM[A-Z]{2}[0-9]+([&/#]|$)))|(^https?://([^/?#]+|(www\.)?ebi\.ac\.uk/chembl)/?(#.*)?$)'
  AND NOT EXISTS (
    SELECT 1 FROM "citation_pdfs" p WHERE p."citation_id" = r."citation_id"
  );
