# Artikkelimport til wiki-review

Pluginen `plugins/kinetix-wiki-import` konverterer kildebelagte artikler til
`kinetix-wiki-article-v1`. Det eksisterende samtaleformatet kan publisere verifiserte
fakta og krever eksisterende seksjoner. Artikkelformatet er separat: alle fakta
blir forslag, og manglende overskrifter kan opprettes ved eksplisitt adminimport.

## Data og arbeidsflyt

1. ChatGPT bevarer naturlige setninger og korte, sammenhengende avsnitt som
   vurderingsenheter, med kildekoblinger og overskriftshierarki,
   henter offentlige seksjons-ID-er og validerer JSON. Dekningsrapporten sporer
   tekstblokker og tabellrader, men erstatter ikke semantisk eller faglig kontroll.
2. Admin → importer samtale → **Artikkel til review-køen** forhåndsviser filen.
   Den viser nye overskrifter, alle fakta med kilder og blokkerte kandidater.
3. **Opprett seksjoner og send fakta til review-køen** oppretter overskrifter,
   lagrer en wiki-revisjon og setter hvert nytt faktum til `pending` i én
   transaksjon. Eksisterende brødtekst og kildevurderinger bevares.

Målet må være en eksisterende `topic`-side. Ordningen endrer ikke monografier,
erstatter ikke fakta og oppretter ikke nye sider. Nye H2/H3-overskrifter flettes
inn etter artikkelens foregående seksjon; eksisterende seksjoner flyttes ikke.
En H3 må ha riktig H2-forelder, også når siden har andre seksjoner mellom ankre.

`src/lib/wikiArticleImport.ts` er kontrakten. Pluginens JSON Schema eksporteres
fra denne. Python-valideringen kontrollerer også kryssreferanser og dekning.
`api/_lib/wikiArticleImportStore.ts` normaliserer kilder med `resolveCitation`,
beholder lokaliseringsnotater i `proposedMeta.evidence`, og skriver ordinære
`wiki_fact`-forslag med `referenceIds` og varige `sectionId`.

Kildenøkler i JSON er lokale, aldri database-ID-er. Ingen kildeverifisering
oppgis eller omskrives av importen. Den eksisterende fulltekstporten aktiveres
via `unverifiedReferenceIds: []`: review-flyten sjekker faktisk gjeldende
kildevurderinger. Pluginen kan ikke godkjenne ved å sende et statusfelt.

## Lesbar tekst

Et `facts[].statement` kan inneholde flere beslektede, kildebelagte påstander.
En oppramsing av stoffer, en forklaring med flere faktorer eller en tabellrad
med styrker og begrensninger trenger ikke deles i egne forslag for hvert ledd.
Kildegrunnlaget kontrolleres fortsatt for hver empiriske delpåstand, og enhetens
`sourceKeys` samler kildene som støtter teksten. Del ved temaskifte eller når
forutsetninger, usikkerhet eller manglende kilder ellers ville bli uklare.
Det eksisterende formatet og grensen på 2000 tegn gjelder uendret.

En ny konvertering endrer ikke allerede innsendte forslag: importen erstatter
ingen rader og hopper bare over identisk tekst med identiske kilder i samme
seksjon. Sammenslåtte avsnitt må derfor ikke omtales som en automatisk opprydding
av den gamle review-køen.

## Integritet

- Samme autorisasjon, CSRF-kontroll og 8 MiB-grense som samtaleimport.
- Offentlig GET `?action=formats` annonserer kun formatnavn; ingen databasebruk.
- POST med `{document}` er skrivefri. Apply krever `expectedFingerprint` fra
  forhåndsvisningen og kontrollerer både dokument og gjeldende sideinnhold.
- Apply tar sidelås og eksisterende `wiki_fact_proposal`-lås, revaliderer og
  utfører alle skriver i én transaksjon. Side-/ID-konflikter gir 409.
- Agentidentiteter omfattes av eksisterende agent-focus-begrensninger.
- Identisk påstand og identiske referanser i samme seksjon, publisert eller
  allerede pending, hoppes over. Nye kilder på samme tekst blir et nytt forslag
  som må vurderes. Avviste/returnerte forslag kan foreslås igjen.
- IdempotencyKey er sporbarhet; duplikatsjekken bygger på faktisk innhold.
- Kildealiaser som ikke allerede er kjent av citation-store kan kreve vanlig
  DOI/PMID-opprydding. En lokal formatvalidering bekrefter ikke medisinske fakta.

Den eksisterende review-flyten avgjør senere godkjenning. Denne importen kaller
aldri `applyApprovedEdit`, endrer ingen kildevurdering og importerer ikke
`blockedCandidates`. Admin må lese den viste listen over utelatte kandidater.

## Drift

Pluginen kan opprettes og installeres uavhengig av webappen. Manuell import krever
at denne server-/adminutvidelsen er satt i drift. Pluginens context.py kontrollerer
annonsert formatstøtte og skal opplyse om manglende støtte. Produksjonssetting
følger repositoryets menneskestyrte deployrutine.

Pluginpakken består av én rotmappe med plugin.json og skills/wiki-article.
Pakk bare denne mappen; hold testdata, artikkelutkast og Python-cache utenfor.
