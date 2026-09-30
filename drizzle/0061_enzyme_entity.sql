-- Metabolic enzymes become a first-class, searchable entity (#436), and the
-- drug metabolism box moves from a fixed 4-bucket fate model to a list of
-- elimination/metabolism routes (enzyme or unchanged-excretion).

CREATE TABLE "enzymes" (
  "id" SERIAL PRIMARY KEY,
  "slug" VARCHAR(120) NOT NULL UNIQUE,
  "symbol" VARCHAR(80) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "name_en" VARCHAR(200),
  "enzyme_class" VARCHAR(60),
  "external_ids" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "enzymes_symbol_idx" ON "enzymes" ("symbol");
--> statement-breakpoint
CREATE INDEX "enzymes_class_idx" ON "enzymes" ("enzyme_class");
--> statement-breakpoint
INSERT INTO "enzymes" ("slug", "symbol", "name", "name_en", "enzyme_class") VALUES
  ('cyp1a2', 'CYP1A2', 'Cytokrom P450 1A2', 'Cytochrome P450 1A2', 'CYP'),
  ('cyp2a6', 'CYP2A6', 'Cytokrom P450 2A6', 'Cytochrome P450 2A6', 'CYP'),
  ('cyp2b6', 'CYP2B6', 'Cytokrom P450 2B6', 'Cytochrome P450 2B6', 'CYP'),
  ('cyp2c8', 'CYP2C8', 'Cytokrom P450 2C8', 'Cytochrome P450 2C8', 'CYP'),
  ('cyp2c9', 'CYP2C9', 'Cytokrom P450 2C9', 'Cytochrome P450 2C9', 'CYP'),
  ('cyp2c19', 'CYP2C19', 'Cytokrom P450 2C19', 'Cytochrome P450 2C19', 'CYP'),
  ('cyp2d6', 'CYP2D6', 'Cytokrom P450 2D6', 'Cytochrome P450 2D6', 'CYP'),
  ('cyp2e1', 'CYP2E1', 'Cytokrom P450 2E1', 'Cytochrome P450 2E1', 'CYP'),
  ('cyp3a4', 'CYP3A4', 'Cytokrom P450 3A4', 'Cytochrome P450 3A4', 'CYP'),
  ('cyp3a5', 'CYP3A5', 'Cytokrom P450 3A5', 'Cytochrome P450 3A5', 'CYP'),
  ('ugt1a1', 'UGT1A1', 'UDP-glukuronosyltransferase 1A1', 'UDP-glucuronosyltransferase 1A1', 'UGT'),
  ('ugt1a4', 'UGT1A4', 'UDP-glukuronosyltransferase 1A4', 'UDP-glucuronosyltransferase 1A4', 'UGT'),
  ('ugt2b7', 'UGT2B7', 'UDP-glukuronosyltransferase 2B7', 'UDP-glucuronosyltransferase 2B7', 'UGT'),
  ('ugt2b15', 'UGT2B15', 'UDP-glukuronosyltransferase 2B15', 'UDP-glucuronosyltransferase 2B15', 'UGT'),
  ('sult1a1', 'SULT1A1', 'Sulfotransferase 1A1', 'Sulfotransferase 1A1', 'SULT'),
  ('adh', 'ADH', 'Alkoholdehydrogenase', 'Alcohol dehydrogenase', 'dehydrogenase'),
  ('aldh', 'ALDH', 'Aldehyddehydrogenase', 'Aldehyde dehydrogenase', 'dehydrogenase'),
  ('dpyd', 'DPYD', 'Dihydropyrimidindehydrogenase', 'Dihydropyrimidine dehydrogenase', 'dehydrogenase'),
  ('xo', 'XO', 'Xantinoksidase', 'Xanthine oxidase', 'oxidase'),
  ('maoa', 'MAO-A', 'Monoaminoksidase A', 'Monoamine oxidase A', 'oxidase'),
  ('maob', 'MAO-B', 'Monoaminoksidase B', 'Monoamine oxidase B', 'oxidase'),
  ('fmo3', 'FMO3', 'Flavinholdig monooksygenase 3', 'Flavin-containing monooxygenase 3', 'oxidase'),
  ('comt', 'COMT', 'Katekol-O-metyltransferase', 'Catechol-O-methyltransferase', 'transferase'),
  ('nat2', 'NAT2', 'N-acetyltransferase 2', 'N-acetyltransferase 2', 'transferase'),
  ('tpmt', 'TPMT', 'Tiopurin-S-metyltransferase', 'Thiopurine S-methyltransferase', 'transferase'),
  ('gst', 'GST', 'Glutation-S-transferase', 'Glutathione S-transferase', 'transferase'),
  ('ces1', 'CES1', 'Karboksylesterase 1', 'Carboxylesterase 1', 'esterase'),
  ('ces2', 'CES2', 'Karboksylesterase 2', 'Carboxylesterase 2', 'esterase'),
  ('bche', 'BChE', 'Butyrylkolinesterase', 'Butyrylcholinesterase', 'esterase'),
  ('ache', 'AChE', 'Acetylkolinesterase', 'Acetylcholinesterase', 'esterase');
--> statement-breakpoint
CREATE TABLE "drug_elimination_routes" (
  "id" SERIAL PRIMARY KEY,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "kind" VARCHAR(30) DEFAULT 'enzyme' NOT NULL,
  "enzyme_id" INTEGER REFERENCES "enzymes"("id") ON DELETE SET NULL,
  "label" VARCHAR(200),
  "fraction" NUMERIC(6, 4),
  "note" TEXT,
  "reference_ids" INTEGER[],
  "sort_order" INTEGER DEFAULT 0 NOT NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drug_elimination_routes_drug_idx"
  ON "drug_elimination_routes" ("drug_id");
--> statement-breakpoint
CREATE INDEX "drug_elimination_routes_enzyme_idx"
  ON "drug_elimination_routes" ("enzyme_id");
--> statement-breakpoint
-- Backfill: named enzymes -> enzyme routes, matched to a canonical row when
-- the symbol/name lines up; the original text is always kept as the label.
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "enzyme_id", "label")
SELECT
  p."drug_id",
  'enzyme',
  (
    SELECT e."id" FROM "enzymes" e
    WHERE UPPER(e."symbol") = UPPER(trim(elem.value))
       OR lower(e."name") = lower(trim(elem.value))
       OR lower(e."name_en") = lower(trim(elem.value))
    ORDER BY e."id"
    LIMIT 1
  ),
  trim(elem.value)
FROM "drug_metabolism_profiles" p
CROSS JOIN LATERAL jsonb_array_elements_text(p."enzymes") AS elem(value)
WHERE trim(elem.value) <> '';
--> statement-breakpoint
-- Backfill: fate fractions -> dedicated route rows.
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "fraction")
SELECT "drug_id", 'metabolized', "metabolized_fraction"
FROM "drug_metabolism_profiles" WHERE "metabolized_fraction" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "fraction")
SELECT "drug_id", 'renal_unchanged', "renal_unchanged_fraction"
FROM "drug_metabolism_profiles" WHERE "renal_unchanged_fraction" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "fraction")
SELECT "drug_id", 'fecal_biliary', "fecal_biliary_fraction"
FROM "drug_metabolism_profiles" WHERE "fecal_biliary_fraction" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "fraction", "label")
SELECT "drug_id", 'other_unchanged', "excreted_unchanged_fraction", 'excreted unchanged'
FROM "drug_metabolism_profiles" WHERE "excreted_unchanged_fraction" IS NOT NULL;
--> statement-breakpoint
-- Backfill: free-text elimination routes -> 'other_unchanged' rows by label.
INSERT INTO "drug_elimination_routes" ("drug_id", "kind", "label")
SELECT p."drug_id", 'other_unchanged', trim(elem.value)
FROM "drug_metabolism_profiles" p
CROSS JOIN LATERAL jsonb_array_elements_text(p."elimination_routes") AS elem(value)
WHERE trim(elem.value) <> '';
--> statement-breakpoint
-- Drop the migrated columns; the profile row now carries only the note.
ALTER TABLE "drug_metabolism_profiles"
  DROP COLUMN "enzymes",
  DROP COLUMN "elimination_routes",
  DROP COLUMN "excreted_unchanged_fraction",
  DROP COLUMN "metabolized_fraction",
  DROP COLUMN "renal_unchanged_fraction",
  DROP COLUMN "fecal_biliary_fraction";
--> statement-breakpoint
-- Drop profile rows that only existed for the migrated columns.
DELETE FROM "drug_metabolism_profiles"
WHERE "evidence_note" IS NULL AND "reference_ids" IS NULL;
