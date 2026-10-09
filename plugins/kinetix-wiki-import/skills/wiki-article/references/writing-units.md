# Vurderingsenheter i wiki-tekst

Bevar lesbar fagprosa. La `statement` romme en naturlig setning eller et kort avsnitt som hører sammen tematisk og kan vurderes samlet. «Faktum» er navnet på importens tekst-/vurderingsenhet; det krever ikke én rad per minste logiske påstand. Bevar den opprinnelige rekkefølgen innen seksjonen.

## Eksempel: innledning

Når artikkelen har dette avsnittet med kilder, behold det gjerne som én enhet:

> Rusmiddeltesting i oralvæske kan dokumentere eksponering for blant annet stimulanter, opioider, benzodiazepiner og cannabis, og er undersøkt både i norsk rusbehandling og hos førere mistenkt for ruspåvirket kjøring. Prøvens informasjonsverdi avhenger av hvilke stoffer som analyseres, analysegrensene, prøvetakingsutstyret og eksponeringsforløpet.

Eksemplet viser ønsket oppdeling, ikke et selvstendig dokumentert importforslag. Bruk bare avsnittet når det finnes i materialet og hver delpåstand har kildegrunnlag. Ikke del det i egne rader for hver stoffgruppe, hvert anvendelsesområde og hver faktor.

## Kilder og avgrensning

- Samle alle relevante kildeidentifikatorer i enhetens `sourceKeys`. Kontroller delpåstandene mot sine henvisninger i originalen; en union av kilder betyr ikke at alle kilder støtter alle setninger.
- Behold eksisterende, faktisk kjente kildeplasseringer i `evidence`. Ikke sett inn artikkelens lokale referansenumre som fritekst i `statement`: Kinetix bruker `sourceKeys` til å knytte importerte kilder til teksten.
- Behold «kan», «vanligvis», dose, terskel, populasjon og andre avgrensninger. Ikke gjør en redegjørelse om fire undersøkte stoffer til en påstand om alle rusmidler.
- Behold et funn sammen med begrensningen som styrer fortolkningen. Det er ofte lettere å vurdere enn to adskilte rader.
- Skill ut en udokumentert eller uoppløselig delpåstand til `blockedCandidates`. Ikke fjern den stille eller legg den inn under en nabosetnings kilde.
- Del avsnittet når temaet skifter eller sammenslåing skjuler motstridende betingelser. Følg kontraktens grense på 2000 tegn per enhet; del ved naturlige tekstgrenser, uten å miste kilder og forbehold.

## Eksempel: tabell og sammenligning

En rad om ett prøvemediums styrker og begrensninger kan bli én sammenhengende enhet. En sammenligning av to terskler eller prøvemedier i samme studie kan også stå samlet når dose, terskler, tidsrom og forbehold følger med. Ikke del hvert tall eller hver celle bare fordi det er mulig. Skill derimot ulike studier eller pasientgrupper når felles formulering ville gi et uriktig inntrykk av sammenlignbarhet.

Ved ny konvertering av en tidligere fragmentert fil, bruk hele originalartikkelen og dens kildeliste til å gjenopprette sammenhengen. En ny JSON-fil oppdaterer ikke eksisterende forslag i Kinetix; det nåværende formatet oppretter forslag og hopper bare over identisk tekst med samme kilder. Ikke hev at sammenslåtte enheter automatisk erstatter gamle rader.
