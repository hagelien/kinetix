-- Backfill the CYP taxonomic subdivision spine (#785, Phase 6). The CYP naming
-- scheme is itself the hierarchy: gene CYP3A4 → subfamily CYP3A → family CYP3 →
-- superfamily CYP. This mints the missing intermediate family/subfamily/
-- superfamily entities and wires each gene's parent_id chain, leaving any
-- already-set parent untouched (idempotent / safe to re-run conceptually).
-- Non-CYP entities (ADH, UGT…, receptors) are left flat for manual curation.

DO $$
DECLARE
  rec RECORD;
  v_super INTEGER;
  v_family INTEGER;
  v_subfam INTEGER;
  v_family_sym TEXT;
  v_subfam_sym TEXT;
  v_slug TEXT;
  v_n INTEGER;
BEGIN
  -- Superfamily root.
  SELECT id INTO v_super FROM bio_entities WHERE symbol = 'CYP' LIMIT 1;
  IF v_super IS NULL THEN
    v_slug := 'cyp'; v_n := 2;
    WHILE EXISTS (SELECT 1 FROM bio_entities WHERE slug = v_slug) LOOP
      v_slug := 'cyp-' || v_n; v_n := v_n + 1;
    END LOOP;
    INSERT INTO bio_entities (slug, symbol, name, name_en, rank, entity_class)
      VALUES (v_slug, 'CYP', 'Cytokrom P450', 'Cytochrome P450', 'superfamily', 'CYP')
      RETURNING id INTO v_super;
  END IF;

  FOR rec IN
    SELECT id, symbol FROM bio_entities WHERE symbol ~ '^CYP[0-9]+[A-Z]+[0-9]+$'
  LOOP
    v_family_sym := 'CYP' || substring(rec.symbol FROM '^CYP([0-9]+)');
    v_subfam_sym := v_family_sym || substring(rec.symbol FROM '^CYP[0-9]+([A-Z]+)');

    -- Family (e.g. CYP3).
    SELECT id INTO v_family FROM bio_entities WHERE symbol = v_family_sym LIMIT 1;
    IF v_family IS NULL THEN
      v_slug := lower(v_family_sym); v_n := 2;
      WHILE EXISTS (SELECT 1 FROM bio_entities WHERE slug = v_slug) LOOP
        v_slug := lower(v_family_sym) || '-' || v_n; v_n := v_n + 1;
      END LOOP;
      INSERT INTO bio_entities (slug, symbol, name, name_en, rank, entity_class, parent_id)
        VALUES (v_slug, v_family_sym, v_family_sym, v_family_sym, 'family', 'CYP', v_super)
        RETURNING id INTO v_family;
    ELSE
      UPDATE bio_entities SET parent_id = v_super
        WHERE id = v_family AND parent_id IS NULL;
    END IF;

    -- Subfamily (e.g. CYP3A).
    SELECT id INTO v_subfam FROM bio_entities WHERE symbol = v_subfam_sym LIMIT 1;
    IF v_subfam IS NULL THEN
      v_slug := lower(v_subfam_sym); v_n := 2;
      WHILE EXISTS (SELECT 1 FROM bio_entities WHERE slug = v_slug) LOOP
        v_slug := lower(v_subfam_sym) || '-' || v_n; v_n := v_n + 1;
      END LOOP;
      INSERT INTO bio_entities (slug, symbol, name, name_en, rank, entity_class, parent_id)
        VALUES (v_slug, v_subfam_sym, v_subfam_sym, v_subfam_sym, 'subfamily', 'CYP', v_family)
        RETURNING id INTO v_subfam;
    ELSE
      UPDATE bio_entities SET parent_id = v_family
        WHERE id = v_subfam AND parent_id IS NULL;
    END IF;

    -- Gene → subfamily.
    UPDATE bio_entities SET parent_id = v_subfam
      WHERE id = rec.id AND parent_id IS NULL;
  END LOOP;
END $$;
