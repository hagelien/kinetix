-- Close the PDF requests filed against PubChem compound-record URLs
-- (`/compound/<CID>`, the records the PubChem helper reads).
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
-- excludes PubChem records too. A request the previous deployment files after
-- this runs is hidden from the open queue and its count by the same test in
-- api/pdf-requests.ts, so the deploy window cannot strand one there.
UPDATE "pdf_requests" r
SET "status" = 'cancelled'
FROM "citations" c
WHERE c."id" = r."citation_id"
  AND r."status" = 'open'
  AND c."type" = 'url'
  AND btrim(c."identifier") ~* '^https?://(www\.)?pubchem\.ncbi\.nlm\.nih\.gov/compound/[1-9][0-9]*/?([?#]|$)'
  AND NOT EXISTS (
    SELECT 1 FROM "citation_pdfs" p WHERE p."citation_id" = r."citation_id"
  );
