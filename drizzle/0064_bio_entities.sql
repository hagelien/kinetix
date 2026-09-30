-- Unify metabolic enzymes (#436) and pharmacodynamic receptor targets (#432)
-- into one canonical, non-drug "biological entity" registry (#785, Phase 1).
--
-- The same molecule (e.g. acetylcholinesterase) can be both a metabolic enzyme
-- AND a drug target, so the roles it plays live in `bio_entity_functions`
-- rather than being implied by which legacy registry it sat in. This migration
-- is purely additive: the old `enzymes` / `receptor_targets` tables and their
-- edge FKs are untouched, so nothing in the app changes behaviour yet. A
-- `bio_entity_id_map` table records source → new-entity mapping for Phase 2 to
-- repoint the drug edge tables, after which it is dropped.

CREATE TABLE "bio_entities" (
  "id" SERIAL PRIMARY KEY,
  "slug" VARCHAR(120) NOT NULL UNIQUE,
  "symbol" VARCHAR(80) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "name_en" VARCHAR(200),
  "organism" VARCHAR(80) DEFAULT 'Homo sapiens' NOT NULL,
  "rank" VARCHAR(20),
  "parent_id" INTEGER,
  "entity_class" VARCHAR(60),
  "external_ids" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "properties" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bio_entities_symbol_idx" ON "bio_entities" ("symbol");
--> statement-breakpoint
CREATE INDEX "bio_entities_class_idx" ON "bio_entities" ("entity_class");
--> statement-breakpoint
CREATE INDEX "bio_entities_parent_idx" ON "bio_entities" ("parent_id");
--> statement-breakpoint
CREATE INDEX "bio_entities_rank_idx" ON "bio_entities" ("rank");
--> statement-breakpoint
CREATE TABLE "bio_entity_functions" (
  "id" SERIAL PRIMARY KEY,
  "entity_id" INTEGER NOT NULL REFERENCES "bio_entities"("id") ON DELETE CASCADE,
  "function" VARCHAR(30) NOT NULL,
  "detail" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "reference_ids" INTEGER[],
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bio_entity_functions_entity_idx"
  ON "bio_entity_functions" ("entity_id");
--> statement-breakpoint
CREATE INDEX "bio_entity_functions_function_idx"
  ON "bio_entity_functions" ("function");
--> statement-breakpoint
CREATE UNIQUE INDEX "bio_entity_functions_entity_function_idx"
  ON "bio_entity_functions" ("entity_id", "function");
--> statement-breakpoint
-- Transient source → new-entity mapping consumed (and dropped) by Phase 2.
CREATE TABLE "bio_entity_id_map" (
  "source" VARCHAR(20) NOT NULL,
  "source_id" INTEGER NOT NULL,
  "entity_id" INTEGER NOT NULL,
  PRIMARY KEY ("source", "source_id")
);
--> statement-breakpoint
-- Backfill. Enzymes become fresh entities (each with a metabolic_enzyme
-- function); receptor targets merge into an existing entity when their
-- normalized symbol or a shared UniProt id already matches, otherwise create a
-- new entity. Merged molecules end up with one entity and two function rows.
DO $$
DECLARE
  rec RECORD;
  v_entity_id INTEGER;
  v_norm TEXT;
  v_slug TEXT;
  v_n INTEGER;
BEGIN
  FOR rec IN SELECT * FROM "enzymes" ORDER BY "id" LOOP
    v_slug := rec.slug;
    v_n := 2;
    WHILE EXISTS (SELECT 1 FROM "bio_entities" WHERE "slug" = v_slug) LOOP
      v_slug := rec.slug || '-' || v_n;
      v_n := v_n + 1;
    END LOOP;

    INSERT INTO "bio_entities"
      ("slug", "symbol", "name", "name_en", "organism", "rank", "entity_class", "external_ids")
    VALUES (
      v_slug, rec.symbol, rec.name, rec.name_en, 'Homo sapiens',
      CASE WHEN rec.symbol ~ '^CYP[0-9]+[A-Z][0-9]+$' THEN 'gene' ELSE NULL END,
      rec.enzyme_class, rec.external_ids
    )
    RETURNING "id" INTO v_entity_id;

    INSERT INTO "bio_entity_functions" ("entity_id", "function")
    VALUES (v_entity_id, 'metabolic_enzyme');

    INSERT INTO "bio_entity_id_map" ("source", "source_id", "entity_id")
    VALUES ('enzyme', rec.id, v_entity_id);
  END LOOP;

  FOR rec IN SELECT * FROM "receptor_targets" ORDER BY "id" LOOP
    v_norm := upper(regexp_replace(rec.symbol, '[^a-zA-Z0-9]', '', 'g'));
    v_entity_id := NULL;

    -- Match an existing entity by normalized symbol.
    SELECT "id" INTO v_entity_id FROM "bio_entities"
    WHERE upper(regexp_replace("symbol", '[^a-zA-Z0-9]', '', 'g')) = v_norm
    ORDER BY "id" LIMIT 1;

    -- Otherwise match by a shared UniProt id.
    IF v_entity_id IS NULL AND (rec.external_ids ? 'uniprot') THEN
      SELECT "id" INTO v_entity_id FROM "bio_entities"
      WHERE "external_ids" ->> 'uniprot' = rec.external_ids ->> 'uniprot'
      ORDER BY "id" LIMIT 1;
    END IF;

    IF v_entity_id IS NULL THEN
      v_slug := rec.slug;
      v_n := 2;
      WHILE EXISTS (SELECT 1 FROM "bio_entities" WHERE "slug" = v_slug) LOOP
        v_slug := rec.slug || '-' || v_n;
        v_n := v_n + 1;
      END LOOP;

      INSERT INTO "bio_entities"
        ("slug", "symbol", "name", "name_en", "organism", "entity_class", "external_ids")
      VALUES (
        v_slug, rec.symbol, rec.name, rec.name_en,
        COALESCE(rec.organism, 'Homo sapiens'), rec.target_class, rec.external_ids
      )
      RETURNING "id" INTO v_entity_id;
    ELSE
      -- Merge: keep the entity's existing external ids, add any the target has.
      UPDATE "bio_entities"
      SET "external_ids" = rec.external_ids || "external_ids", "updated_at" = now()
      WHERE "id" = v_entity_id;
    END IF;

    INSERT INTO "bio_entity_functions" ("entity_id", "function")
    VALUES (v_entity_id, 'drug_target')
    ON CONFLICT ("entity_id", "function") DO NOTHING;

    INSERT INTO "bio_entity_id_map" ("source", "source_id", "entity_id")
    VALUES ('receptor_target', rec.id, v_entity_id);
  END LOOP;
END $$;
