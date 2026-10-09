import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, ExternalLink, Table as TableIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { DetectionMatrixCard } from '@/components/detection/DetectionMatrixCard';
import { RefsDetectionSection } from '@/components/detection/RefsDetectionSection';
import {
  DETECTION_COLUMN_PRESET,
  REFS_DETECTION_COLUMN_PRESET,
} from '@/lib/detectionColumnPresets';
import { useDrugStore } from '@/stores/drugStore';
import { useRefsDetectionTimes } from '@/lib/useRefsDetectionTimes';
import { fetchDrugById, fetchDrugsByIds, type DrugRow } from '@/lib/drugApi';
import {
  DETECTION_MATRICES,
  detectionBandsFromCachedValues,
  detectionWindowsFor,
  hasAnyDetectionData,
  type DetectionBandReading,
} from '@/lib/detectionWindows';
import {
  capitalizeGenericDrugName,
  resolveDrugName,
} from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { useCan } from '@/lib/usePermissions';
import type { DrugComponent } from '@/types';

/** A metabolite of the searched substance, named in the reader's language. */
interface MetaboliteRow {
  key: string;
  name: string;
  /** Null when the link names a metabolite that has no substance record yet. */
  drugId: number | null;
}

/**
 * Påvisningstider — how long after intake a substance can still be found, per
 * matrix.
 *
 * The module is a reading surface over data that already exists: the three
 * `*DetectionWindow` parameters (see `src/lib/detectionWindows.ts`). It stores
 * nothing of its own, and every number it prints is the pooled aggregate of
 * cited source values — the same `parameter_entries` rows the monograph shows,
 * reachable here through the same source-values dialog, so a window can be
 * traced to its papers (or a missing one filled in) without leaving the page.
 */
export function DetectionTimesPage() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [searchParams, setSearchParams] = useSearchParams();

  const drugIdParam = Number(searchParams.get('drug'));
  const selectedId = Number.isInteger(drugIdParam) && drugIdParam > 0 ? drugIdParam : null;

  const [drug, setDrug] = useState<DrugRow | null>(null);
  /** Bands per metabolite substance id; filled in by the batch lookup below. */
  const [metaboliteBands, setMetaboliteBands] = useState<
    Record<number, DetectionBandReading[]>
  >({});
  const [loading, setLoading] = useState(false);
  // A flag, not a message. `t` is rebound on every language change, so a
  // translated string in state would make `load` — and the effect that clears
  // the page before calling it — unstable across a language toggle.
  const [failed, setFailed] = useState(false);

  const canEdit = useCan('edit.parameterEntry.submit');
  const isAdmin = useCan('edit.directWrite');

  // The laboratory's own guideline table. Members see it as a section of its own,
  // below the pooled windows; nobody else knows it is there.
  const refs = useRefsDetectionTimes();

  const navigate = useNavigate();
  const setTableView = useDrugStore((s) => s.setTableView);
  const requestColumnPreset = useDrugStore((s) => s.requestColumnPreset);

  // Guards against an out-of-order response overwriting a newer selection: the
  // drug fetch is not abortable, so the answer to a stale request has to be
  // dropped on arrival instead.
  const requestRef = useRef(0);

  // The selection as of the latest render, readable from callbacks created in
  // an earlier one. Assigned during render rather than in an effect so a
  // callback firing between the two cannot read a selection that is already
  // gone.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  /**
   * Fetch one substance. Deliberately does NOT clear what is on screen — this
   * runs again after every source-value write (`onMutated`), and blanking the
   * page for that would unmount the very dialog the editor is writing in,
   * costing them a reopen per reading. Clearing is the *selection's* job, below,
   * where it means "a different substance is coming".
   */
  const load = useCallback(async (id: number) => {
    // A write can settle after the reader has moved on: the editor's callback
    // was created for the substance that was on screen when the dialog opened,
    // and `reload()` still fires it from the write's continuation even though
    // the dialog is long unmounted. Reloading then would claim the newest
    // request token and paint the old substance under the new URL. The
    // selection is the authority on what this page is showing.
    if (id !== selectedIdRef.current) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setFailed(false);
    try {
      const { drug: row } = await fetchDrugById(id);
      if (requestRef.current !== requestId) return;
      setDrug(row);
    } catch {
      if (requestRef.current !== requestId) return;
      // A failed refresh leaves the values that are already on screen alone
      // and says so above them; only a failed *selection* has nothing to show,
      // and that one was cleared before the request went out.
      setFailed(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  // Runs on the SELECTION, and nothing else. `load` is stable for the
  // component's lifetime so that switching language — which rebinds `t` and
  // would otherwise recreate it — re-renders the substance in the new language
  // instead of clearing it and fetching it again.
  useEffect(() => {
    setDrug(null);
    if (selectedId == null) {
      requestRef.current += 1;
      setFailed(false);
      setLoading(false);
      return;
    }
    void load(selectedId);
  }, [selectedId, load]);

  /**
   * A detection time is frequently a statement about the metabolite, not the
   * parent — a urine screen finds THC-syre, not THC — so the linked
   * metabolites' windows belong on the same page.
   *
   * Deliberately its own effect, and its own request. The substance the reader
   * asked for is ready the moment its own fetch lands, and must not sit behind
   * a chain of lookups for rows further down the page; the names render at once
   * and the bands fill in. One batch request covers the lot — the metabolism
   * schema allows 100 links, which is exactly the cap `/api/drugs?ids=` accepts,
   * so this cannot fan out into a request per link.
   *
   * Keyed on the substance's id alone. Which metabolites a substance has does
   * not change when one of its source values is written, nor when the reader
   * switches language — the names are resolved at render instead, so neither
   * event re-issues this request or flickers the table back to blanks.
   */
  useEffect(() => {
    setMetaboliteBands({});
    const ids = (drug?.metabolism?.metabolites ?? [])
      .map((link) => link.drug?.id)
      .filter((id): id is number => id != null);
    if (ids.length === 0) return;

    let cancelled = false;
    fetchDrugsByIds(ids)
      .then(({ drugs: loaded }) => {
        if (cancelled) return;
        const bands: Record<number, DetectionBandReading[]> = {};
        for (const row of loaded) {
          bands[row.id] = detectionBandsFromCachedValues(
            row as unknown as Record<string, unknown>,
          );
        }
        setMetaboliteBands(bands);
      })
      .catch(() => {
        // An unreachable batch must not blank the parent's windows: the rows
        // stay named, and only their bands are missing.
      });
    return () => {
      cancelled = true;
    };
  }, [drug?.id]);

  // Names are presentation, so they follow the reader's language without
  // touching the network.
  const metabolites = useMemo<MetaboliteRow[]>(
    () =>
      (drug?.metabolism?.metabolites ?? []).map((link, index) => ({
        key: `${link.id ?? index}-${link.metaboliteName}`,
        name: link.drug
          ? resolveDrugName(link.drug.names, lang)
          : link.metaboliteName,
        drugId: link.drug?.id ?? null,
      })),
    [drug, lang],
  );

  function selectDrugId(id: number | null) {
    // Picking the substance that is already in the URL writes no new search
    // param, so the selection effect would not fire. After a failed lookup that
    // gesture IS the retry — honour it rather than leaving the reader clicking
    // a name that does nothing.
    if (id != null && id === selectedId) {
      void load(id);
      return;
    }
    setSearchParams(id == null ? {} : { drug: String(id) });
  }

  function handleSelect(component: DrugComponent) {
    // `_dbId` only — `component.id` is the PubChem CID where one exists, and
    // `/api/drugs?id=` reads the internal id, so the fallback would silently
    // fetch a different substance.
    const id = component._dbId;
    if (id != null && Number.isInteger(id) && id > 0) selectDrugId(id);
  }

  const windows = useMemo(
    () => detectionWindowsFor(drug?.parameterSummaries),
    [drug],
  );
  const drugName = drug
    ? capitalizeGenericDrugName(resolveDrugName(drug.names, lang))
    : '';

  const refsMatches = useMemo(
    () => (drug ? refs.matchFor(drug) : []),
    [drug, refs],
  );

  /**
   * Open the substance register on the detection-time axis alone.
   *
   * Three moves, and all three are needed: the register only renders full on
   * `/` (the shell drops it to the sidebar on any other route), full is the
   * view worth reading a whole catalog in, and the axis is the point — a reader
   * who asked for "detection times for every substance" does not want to find
   * MW, Vd and pKa and go hunting in the column picker. Members get REFS's own
   * band as one more column, so the comparison the page makes for one substance
   * is the same comparison the register makes for all of them.
   */
  function openAllSubstances() {
    requestColumnPreset([
      ...(refs.canAccess
        ? REFS_DETECTION_COLUMN_PRESET
        : DETECTION_COLUMN_PRESET),
    ]);
    setTableView('full');
    navigate('/');
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Clock className="h-5 w-5 text-primary" />
          {t('detection.title')}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {t('detection.subtitle')}
        </p>
        {/* The page answers one substance at a time; this is the way out to
            the other question — every substance, one axis. It opens the
            register rather than duplicating it here, so there is one table of
            detection times in the app and not two that can disagree. */}
        <Button
          variant="outline"
          size="sm"
          className="mt-3 h-8 text-xs"
          data-testid="detection-all-substances"
          onClick={openAllSubstances}
        >
          <TableIcon className="mr-1.5 h-3.5 w-3.5" />
          {t('detection.allSubstances')}
        </Button>
      </div>

      <div className="mb-6 max-w-md">
        <label
          htmlFor="detection-search"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          {t('detection.searchLabel')}
        </label>
        <DrugSearchDropdown
          inputId="detection-search"
          placeholder={t('detection.searchPlaceholder')}
          onSelect={handleSelect}
          autoFocus
        />
      </div>

      {/* Only ever the FIRST load of a substance replaces the page. A reload
          after a source-value write happens under the values already on
          screen — see `load`. */}
      {loading && !drug && (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {/* The message says "try again", so there is something to press. Without
          it a failed first load was a dead end: re-picking the same substance
          writes the same `?drug=`, which moves no selection and starts no
          request, and the Clear button lives inside the block that never
          mounted. */}
      {failed && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <span>{t('detection.loadError')}</span>
          {selectedId != null && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void load(selectedId)}
            >
              {t('detection.retry')}
            </Button>
          )}
        </div>
      )}

      {!loading && !failed && !drug && (
        <p className="text-sm text-muted-foreground">{t('detection.emptyState')}</p>
      )}

      {drug && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{drugName}</h2>
            <div className="flex items-center gap-2">
              {loading && (
                <span className="text-xs text-muted-foreground">
                  {t('common.loading')}
                </span>
              )}
              <Link
                to={`/wiki/drug/${drug.id}`}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t('detection.monographLink')}
              </Link>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => selectDrugId(null)}
              >
                <X className="mr-1 h-3 w-3" />
                {t('detection.clear')}
              </Button>
            </div>
          </div>

          {/* Only drawn for a reader who ALSO sees the laboratory section. For
              everyone else there is one kind of detection time on this page and
              labelling it would answer a question they have not been given the
              other half of. */}
          {refs.canAccess && (
            <div>
              <h3 className="text-sm font-semibold">
                {t('detection.pooledTitle')}
              </h3>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t('detection.pooledHint')}
              </p>
            </div>
          )}

          {!hasAnyDetectionData(windows) && (
            <p className="text-sm text-muted-foreground">
              {t('detection.noWindows')}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {windows.map((window) => (
              <DetectionMatrixCard
                key={window.key}
                window={window}
                drugId={drug.id}
                drugName={drugName}
                summaries={drug.parameterSummaries}
                molecularWeight={drug.molecularWeight}
                bloodPlasmaRatio={drug.bloodPlasmaRatio}
                canEdit={canEdit}
                isAdmin={isAdmin}
                onMutated={() => void load(drug.id)}
              />
            ))}
          </div>

          {metabolites.length > 0 && (
            <section aria-labelledby="detection-metabolites">
              <h3
                id="detection-metabolites"
                className="text-sm font-semibold"
              >
                {t('detection.metabolites.title')}
              </h3>
              <p className="mb-2 max-w-3xl text-xs text-muted-foreground">
                {t('detection.metabolites.hint')}
              </p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('detection.metabolites.column')}
                      </th>
                      {DETECTION_MATRICES.map((spec) => (
                        <th
                          key={spec.key}
                          scope="col"
                          className="px-3 py-2 text-left font-medium"
                        >
                          {t(`detection.matrix.${spec.key}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metabolites.map((row) => (
                      <tr
                        key={row.key}
                        data-testid="detection-metabolite-row"
                        className="border-t border-border"
                      >
                        <th
                          scope="row"
                          className="px-3 py-2 text-left font-medium"
                        >
                          {row.drugId ? (
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() => selectDrugId(row.drugId)}
                            >
                              {capitalizeGenericDrugName(row.name)}
                            </button>
                          ) : (
                            capitalizeGenericDrugName(row.name)
                          )}
                        </th>
                        {DETECTION_MATRICES.map((spec) => {
                          const band =
                            row.drugId == null
                              ? null
                              : metaboliteBands[row.drugId]?.find(
                                  (reading) => reading.key === spec.key,
                                )?.band;
                          return (
                            <td key={spec.key} className="px-3 py-2">
                              {band ? t(`detection.band.${band}`) : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {/* Outside the `drug &&` block on purpose: the guideline table is worth
          reading on its own, and a member who has not searched for anything yet
          should still be able to open it. */}
      {refs.canAccess && (
        <div className="mt-6">
          <RefsDetectionSection
            payload={refs.payload}
            matches={refsMatches}
            substanceName={drug ? drugName : null}
            loading={refs.loading}
          />
        </div>
      )}

      <section
        aria-labelledby="detection-caveat"
        className="mt-8 rounded-lg border border-border bg-muted/20 p-4"
      >
        <h3 id="detection-caveat" className="text-sm font-semibold">
          {t('detection.caveatTitle')}
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t('detection.caveatDose')}</li>
          <li>{t('detection.caveatCutoff')}</li>
          <li>{t('detection.caveatNegative')}</li>
          <li>{t('detection.caveatDerived')}</li>
        </ul>
      </section>
    </div>
  );
}

export default DetectionTimesPage;
