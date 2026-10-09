# Kontrakt og dataflyt

`kinetix-wiki-article-v1` gjelder eksisterende wiki-sider av typen `topic`. Monografier støttes ikke i denne versjonen. `schema.json` er eksportert fra `src/lib/wikiArticleImport.ts`; serverens validering avgjør alltid.

En temaside er et TipTap-dokument. Overskrifter bærer varig `attrs.sectionId`. Et faktum er en `fact`-node med UUID og `referenceIds` til poster i `citations`. Importen oppretter én `pending_edits`-rad per faktum: `editType=wiki_fact`, `factOperation=add`, `targetId=page.id`, `sectionId`, `factStatement`, `referenceIds`, `proposedValue` og `status=pending`. Godkjenning gjøres senere i eksisterende review-flyt. Pluginen skal ikke produsere disse interne feltene.

`facts[].statement` er en lesbar vurderingsenhet: en naturlig setning eller et kort, sammenhengende avsnitt med én eller flere beslektede påstander. Flere setninger er tillatt. Alle empiriske delpåstander skal ha kildegrunnlag; `sourceKeys` samler deres relevante kilder. Formatet krever ikke en egen rad per stoff, faktor, tabellcelle eller minste logiske påstand. Se `writing-units.md`.

Arbeidsutkast:
```json
{
  "page": {"slug": "eksempel"},
  "sources": [{"key": "S1", "type": "doi", "identifier": "10.1093/jat/bkae097"}],
  "sections": [{
    "key": "bakgrunn", "heading": "Bakgrunn", "level": 2,
    "facts": [{"key": "F1", "statement": "En lesbar, kildebelagt setning eller et kort sammenhengende avsnitt.", "sourceKeys": ["S1"], "inputUnits": ["U0001"]}]
  }]
}
```

Eksemplet viser form, ikke en faglig import. `prepare.py` lager `schemaVersion`, `idempotencyKey`, `articleDigest` (SHA-256 av artikkelfilen) og `createdAt`. Det fjerner `inputUnits`/`excludedUnits` fra importfilen og beholder dekningen i `.audit.json`.

- `page.slug` obligatorisk; `page.id` kan bare kopieres fra et faktisk sideoppslag.
- `sources`: 1–200 poster med unik nøkkel. Valgfri `metadata`: `title`, `authors` (liste), `journal`, `year`. Ingen fulltekst-/verifiseringsattest eller uverifiserte kildealiaser.
- `sections`: 1–100 i artikkelrekkefølge, `level` 2/3. Overordnet overskrift kan ha tom `facts`. Eksisterende `sectionId`, tittel og nivå må samsvare. Mangler ID, gjenbruker serveren en entydig eksakt overskrift/nivå eller oppretter en ny. Tvetydighet og rekkefølgekonflikt stopper importen. Eksisterende seksjoner flyttes, omdøpes eller slettes ikke.
- `facts`: samlet 1–500, unike nøkler, `statement` 1–2000 tegn, 1–20 `sourceKeys`. Valgfri `evidence`: liste med `sourceKey` og faktisk kjent `locator`.
- `blockedCandidates`: `sectionKey`, `statement`, `reason`. Vises i forhåndsvisningen, importeres ikke. Trenger også `inputUnits` i arbeidsutkastet.
- Store artikler deles i selvstendige pakker innen grensene med korrekte ankre og kilder. Oppgi alle deler og samlet dekning; aldri trunker JSON eller skjul utelatte fakta.

`POST /api/conversation-ingestion {document}` gir skrivefri forhåndsvisning. Adminflaten sender deretter `{document, action:"apply", expectedFingerprint}`. Endret side/dokument krever ny forhåndsvisning. Apply lager manglende overskrifter med wiki-revisjon og køer fakta i én transaksjon. Identisk faktum med samme kilder i samme seksjon, publisert eller i køen, hoppes over. Kilder normaliseres gjennom Kinetix' kildeoppløsning; DOI/PMID-aliaser som ikke allerede er kjent kan trenge ordinær kildeopprydding. Importen endrer aldri kildevurderinger eller godkjenner fakta.

Offentlig `GET /api/conversation-ingestion?action=formats` annonserer støtte. Et eldre/utilgjengelig system må ikke omtales som kompatibelt fordi en lokal fil validerer.
