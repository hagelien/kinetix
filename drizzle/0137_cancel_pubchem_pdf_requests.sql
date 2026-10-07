-- Close the PDF requests filed against PubChem record URLs.
--
-- A PubChem compound page is a public database entry, not a paywalled paper.
-- Its HTML page answers automated readers with a CAPTCHA, so the review agent
-- concluded the "full text" was missing and filed PDF requests a contributor
-- could never meaningfully fulfil. Agents now read the same record through
-- PubChem's open PUG-View service (`node scripts/kinetix-fulltext.mjs pubchem
-- <CID>`), and `POST /api/pdf-requests` refuses these citations
-- (`pdf_request_public_database_record`). The pattern matches
-- PUBCHEM_RECORD_URL_PATTERN in src/lib/publicDatabaseRecord.ts.
--
-- Only open requests with no stored PDF are touched: a request that is already
-- fulfilled or cancelled keeps its history, and a PDF somebody did upload stays
-- linked. Cancelled rows do not resurface in the full-text gap list, which now
-- excludes PubChem records too.
UPDATE "pdf_requests" r
SET "status" = 'cancelled'
FROM "citations" c
WHERE c."id" = r."citation_id"
  AND r."status" = 'open'
  AND c."type" = 'url'
  AND btrim(c."identifier") ~* '^https?://(www\.)?pubchem\.ncbi\.nlm\.nih\.gov/'
  AND NOT EXISTS (
    SELECT 1 FROM "citation_pdfs" p WHERE p."citation_id" = r."citation_id"
  );
