-- Metoder feature: add the MKK (minste kvantifiserbare konsentrasjon / LLOQ)
-- reporting limit to analytical_method_components.
--
-- The method sheet lists three concentration limits per component:
--   Påvisn. (cut-off, already stored as lor),
--   MKK     (LLOQ, this new column),
--   Terskel (threshold, already stored as lod).
-- Previously only Påvisn. and Terskel were captured; MKK was dropped at
-- import time. The column is nullable because many method sheets leave the
-- MKK cell blank.

ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "mkk" double precision;
