import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  fetchDrugSearchResults,
  drugSearchRowToComponent,
} from '@/lib/drugApi';
import { resolveAltDrugName, resolveDrugName } from '@/lib/drugNames';
import { drugComponentKey } from '@/lib/drugSearch';
import { activeLangCode } from '@/lib/useDrugName';
import type { DrugComponent } from '@/types';
import type { PubChemCompound } from '@/components/PubChemSearchDropdown';

interface NewMonographSearchPanelProps {
  /**
   * Pre-fills the search field on mount. Used when the panel is opened
   * from a known name (e.g. a missing metabolite/precursor link in a
   * monograph sidebar) so the kinetix + PubChem lookups run immediately
   * for that compound instead of presenting an empty box.
   */
  initialQuery?: string;
  /**
   * Called when the author picks a drug already in the kinetix database.
   * The parent decides whether to navigate to an existing monograph or to
   * link the drug into the create form.
   */
  onPickExistingDrug: (drug: DrugComponent) => void | Promise<void>;
  /**
   * Called when the author picks a PubChem suggestion. The parent should
   * pre-fill name/cid/molecular-weight fields and advance to the form
   * stage.
   */
  onPickPubChem: (compound: PubChemCompound) => void;
  /**
   * Called when the author chooses to skip both databases and add a drug
   * by hand. The current query is forwarded so the parent can seed the
   * Norwegian-name field.
   */
  onSkipManual: (typedQuery: string) => void;
}

const KINETIX_MIN_QUERY = 1;
// Name autocomplete needs a few characters to be useful, but a digit-only
// input is a PubChem CID and should hit the lookup even at 1-2 chars (CIDs
// 1–99 are valid PubChem records). The server-side `/api/pubchem-search`
// route accepts queries from 2 chars and special-cases all-digit input.
const PUBCHEM_MIN_QUERY_NAME = 3;
const PUBCHEM_MIN_QUERY_NUMERIC = 1;

// CAS Registry Numbers (`dddddd-dd-d`) are short enough to type in one
// go and the API resolves them directly, so don't make the user type
// past the name-mode threshold for them. Same intent as the all-digit
// CID branch.
const CAS_PATTERN = /^\d{2,7}-\d{2}-\d$/;

function pubchemMinFor(trimmed: string): number {
  if (/^\d+$/.test(trimmed)) return PUBCHEM_MIN_QUERY_NUMERIC;
  if (CAS_PATTERN.test(trimmed)) return PUBCHEM_MIN_QUERY_NUMERIC;
  return PUBCHEM_MIN_QUERY_NAME;
}

/**
 * Stage A of the new-monograph flow (#329). A single search field that
 * runs two parallel queries:
 *   1. The kinetix `drugs` table covers names, aliases, short name, and exact
 *      PubChem CID matches so duplicates are caught before creation.
 *   2. PubChem (via `/api/pubchem-search`) — when the kinetix DB has no
 *      hit, suggestions from PubChem give the author a one-click path to
 *      a pre-filled new-drug form.
 *
 * The component does not own the navigation or the autofill — it surfaces
 * the picks and lets `WikiEditor` route them.
 */
export function NewMonographSearchPanel({
  initialQuery = '',
  onPickExistingDrug,
  onPickPubChem,
  onSkipManual,
}: NewMonographSearchPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [query, setQuery] = useState(initialQuery);

  const [kinetixResults, setKinetixResults] = useState<DrugComponent[]>([]);
  const [kinetixLoading, setKinetixLoading] = useState(false);
  const kinetixRequestId = useRef(0);

  const [pubchemResults, setPubchemResults] = useState<PubChemCompound[]>([]);
  const [pubchemLoading, setPubchemLoading] = useState(false);
  const [pubchemSearched, setPubchemSearched] = useState(false);
  const pubchemAbort = useRef<AbortController | null>(null);
  const pubchemRequestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    // Clear stale results immediately so a click during the new debounce
    // window can never select a drug from the previous query.
    setKinetixResults([]);
    if (trimmed.length < KINETIX_MIN_QUERY) {
      kinetixRequestId.current += 1;
      setKinetixLoading(false);
      return;
    }
    const requestId = kinetixRequestId.current + 1;
    kinetixRequestId.current = requestId;
    const controller = new AbortController();
    setKinetixLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const searchRes = await fetchDrugSearchResults({
          q: trimmed,
          limit: 6,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (kinetixRequestId.current !== requestId) return;
        setKinetixResults(searchRes.drugs.map(drugSearchRowToComponent));
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (kinetixRequestId.current !== requestId) return;
        setKinetixResults([]);
      } finally {
        if (kinetixRequestId.current === requestId) setKinetixLoading(false);
      }
    }, 200);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    const trimmed = query.trim();
    // Always abort the previous in-flight request and clear stale state
    // so the panel can never report "PubChem ready" for an obsolete
    // query during the 300 ms debounce gap before the next timer fires.
    pubchemAbort.current?.abort();
    setPubchemResults([]);
    setPubchemSearched(false);
    if (trimmed.length < pubchemMinFor(trimmed)) {
      setPubchemLoading(false);
      return;
    }
    const requestId = pubchemRequestId.current + 1;
    pubchemRequestId.current = requestId;
    const handle = window.setTimeout(async () => {
      const controller = new AbortController();
      pubchemAbort.current = controller;
      setPubchemLoading(true);
      setPubchemSearched(true);
      try {
        const res = await fetch(
          `/api/pubchem-search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (pubchemRequestId.current !== requestId) return;
        if (!res.ok) {
          setPubchemResults([]);
          return;
        }
        const data = (await res.json()) as { results?: PubChemCompound[] };
        if (pubchemRequestId.current !== requestId) return;
        setPubchemResults(data.results ?? []);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (pubchemRequestId.current !== requestId) return;
        setPubchemResults([]);
      } finally {
        if (pubchemRequestId.current === requestId) setPubchemLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(handle);
      pubchemAbort.current?.abort();
    };
  }, [query]);

  const trimmedQuery = query.trim();
  const showResults = trimmedQuery.length >= KINETIX_MIN_QUERY;
  const noKinetixHits =
    showResults && !kinetixLoading && kinetixResults.length === 0;
  // Manual-entry gate. Two competing concerns:
  //   - Don't offer it during loading or before the relevant searches have
  //     actually started — clicking too early can create duplicates of
  //     records still being fetched. We use `pubchemSearched`, not just
  //     `!pubchemLoading`, so the 300 ms debounce window before the timer
  //     fires doesn't count as "PubChem ready".
  //   - Still offer it once searches are done even if PubChem returned
  //     suggestions, because PubChem autocomplete can return unrelated
  //     compounds and the author needs an escape hatch to create the
  //     intended drug manually.
  const pubchemMin = pubchemMinFor(trimmedQuery);
  const pubchemRequired = trimmedQuery.length >= pubchemMin;
  const pubchemReady = !pubchemRequired || (pubchemSearched && !pubchemLoading);
  const showManualEntry = noKinetixHits && pubchemReady;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {t('newMonograph.title', {
            defaultValue: 'Add a drug monograph',
          })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('newMonograph.searchHelp', {
            defaultValue:
              "Search by Norwegian or English name, alias, short name, or PubChem CID. We'll first check the kinetix database, then PubChem.",
          })}
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('newMonograph.searchPlaceholder', {
            defaultValue: 'e.g. alprazolam, 2118, 28981-97-7, blue football',
          })}
          className="pl-8"
        />
      </div>

      {showResults && (
        <div className="border border-border rounded-md divide-y divide-border bg-card">
          <section>
            <header className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40 flex items-center gap-2">
              {t('newMonograph.kinetixHeading', {
                defaultValue: 'In kinetix',
              })}
              {kinetixLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            </header>
            {kinetixResults.length > 0 ? (
              <ul>
                {kinetixResults.map((drug) => {
                  const primary = resolveDrugName(drug.names, lang);
                  const alt = resolveAltDrugName(drug.names, primary);
                  return (
                    <li key={drugComponentKey(drug)}>
                      <button
                        type="button"
                        onClick={() => void onPickExistingDrug(drug)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50"
                      >
                        <div className="font-medium">{primary}</div>
                        {alt && (
                          <div className="text-xs text-muted-foreground">
                            {alt}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              !kinetixLoading && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t('newMonograph.noKinetixHit', {
                    defaultValue: 'No match in the kinetix database.',
                  })}
                </p>
              )
            )}
          </section>

          {pubchemRequired && noKinetixHits && (
            <section>
              <header className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40 flex items-center gap-2">
                {t('newMonograph.pubchemHeading', {
                  defaultValue: 'From PubChem',
                })}
                {pubchemLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              </header>
              {pubchemResults.length > 0 ? (
                <ul>
                  {pubchemResults.map((compound) => (
                    <li key={compound.cid}>
                      <button
                        type="button"
                        onClick={() => onPickPubChem(compound)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50"
                      >
                        <div className="font-medium">{compound.name}</div>
                        <div className="text-xs text-muted-foreground flex gap-3">
                          <span>
                            {t('newMonograph.cidLabel', {
                              defaultValue: 'CID',
                            })}
                            : {compound.cid}
                          </span>
                          {compound.molecularWeight != null && (
                            <span>
                              {t('newMonograph.mwLabel', {
                                defaultValue: 'MW',
                              })}
                              : {compound.molecularWeight.toFixed(2)} g/mol
                            </span>
                          )}
                          {compound.molecularFormula && (
                            <span>{compound.molecularFormula}</span>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                !pubchemLoading &&
                pubchemSearched && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    {t('newMonograph.noPubchemHit', {
                      defaultValue: 'No suggestions from PubChem either.',
                    })}
                  </p>
                )
              )}
            </section>
          )}
        </div>
      )}

      {showManualEntry && (
        <button
          type="button"
          onClick={() => onSkipManual(trimmedQuery)}
          className="text-sm text-primary hover:underline"
        >
          {t('newMonograph.manualEntry', {
            defaultValue: "Add manually — drug isn't in any database",
          })}
        </button>
      )}
    </div>
  );
}
