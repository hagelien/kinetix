-- Mark PDF requests that exist to REPLACE stored full text.
--
-- `POST /api/pdf-requests {replace:true}` is editor-gated because swapping a
-- stored PDF discards the previous asset. But the request it opens was
-- indistinguishable from an ordinary one, and both fulfilment routes (the
-- client-upload token and the URL submit) ask only for `contributor` plus an
-- open request — so the editor-only invariant held when the request was
-- created and evaporated the moment it existed.
--
-- That is not merely a short race. If the editor's upload is interrupted the
-- open request persists, and the open-queue listing deliberately excludes
-- citations that already have a stored PDF, so the lingering request is
-- invisible: a standing, unadvertised grant for any contributor to overwrite
-- that paper's full text.
--
-- This flag lets fulfilment enforce the same tier that opening did.
ALTER TABLE "pdf_requests"
  ADD COLUMN IF NOT EXISTS "is_replacement" boolean DEFAULT false NOT NULL;
