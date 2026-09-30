import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { EnzymeSearchDropdown } from '@/components/EnzymeSearchDropdown';
import { resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { parseLocaleNumber } from '@/lib/parseNumber';
import { showToast } from '@/lib/toast';
import { useCan } from '@/lib/usePermissions';
import {
  submitDrugMetabolism,
  type MetabolismMetaboliteInput,
  type MetabolismPrecursorInput,
  type MetabolismRouteInput,
} from '@/lib/drugApi';
import {
  ELIMINATION_ROUTE_KINDS,
  eliminationRouteEnzymeLabel,
  eliminationRouteKindKey,
  isEnzymeGroupRank,
  normalizeMetabolismName,
  type DrugMetabolism,
  type EliminationRouteKind,
  type MetabolismFractionRange,
  type MetaboliteActivity,
} from '@/lib/metabolism';
import type { EntityRank } from '@/lib/bioEntities';

interface Props {
  drugId: number;
  drugName: string;
  metabolism: DrugMetabolism | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Min/median/max percent strings backing a fraction-range input. */
interface RangePercents {
  minPercent: string;
  medianPercent: string;
  maxPercent: string;
}

interface RouteRow extends RangePercents {
  key: string;
  kind: EliminationRouteKind;
  enzymeId: number | null;
  /** Rank of the linked enzyme — set for family/subfamily/superfamily picks. */
  enzymeRank: EntityRank | null;
  label: string;
  note: string;
  referenceIds: number[] | null;
}

interface MetaboliteRow extends RangePercents {
  key: string;
  metaboliteName: string;
  metaboliteDrugId: number | null;
  activity: MetaboliteActivity;
  evidenceNote: string;
  referenceIds: number[] | null;
}

interface PrecursorRow extends RangePercents {
  key: string;
  precursorDrugId: number | null;
  precursorName: string;
  activity: MetaboliteActivity;
  evidenceNote: string;
  referenceIds: number[] | null;
}

const EMPTY_RANGE_PERCENTS: RangePercents = {
  minPercent: '',
  medianPercent: '',
  maxPercent: '',
};

let rowSeq = 0;
function nextKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

function fractionToPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  return String(Math.round(value * 1000) / 10);
}

/** Seed the three percent fields of a fraction-range input from stored data. */
function rangeToPercents(
  range: MetabolismFractionRange | null | undefined,
): RangePercents {
  return {
    minPercent: fractionToPercent(range?.min),
    medianPercent: fractionToPercent(range?.median),
    maxPercent: fractionToPercent(range?.max),
  };
}

export function MetabolismEditForm({
  drugId,
  drugName,
  metabolism,
  onClose,
  onSaved,
}: Props) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const isAdmin = useCan('edit.directWrite');

  const [routes, setRoutes] = useState<RouteRow[]>(() =>
    (metabolism?.routes ?? []).map((r) => ({
      key: nextKey(),
      kind: r.kind,
      enzymeId: r.enzymeId,
      enzymeRank: r.enzyme?.rank ?? null,
      label: r.enzyme
        ? eliminationRouteEnzymeLabel(r, lang)
        : (r.label ?? ''),
      ...rangeToPercents(r.fraction),
      note: r.note ?? '',
      referenceIds: r.referenceIds,
    })),
  );
  const [profileNote, setProfileNote] = useState(
    () => metabolism?.evidenceNote ?? '',
  );

  const [metabolites, setMetabolites] = useState<MetaboliteRow[]>(() =>
    (metabolism?.metabolites ?? []).map((m) => ({
      key: nextKey(),
      metaboliteName: m.drug ? resolveDrugName(m.drug.names, lang) : m.metaboliteName,
      metaboliteDrugId: m.metaboliteDrugId,
      ...rangeToPercents(m.conversionFraction),
      activity: m.activity,
      evidenceNote: m.evidenceNote ?? '',
      referenceIds: m.referenceIds,
    })),
  );
  const [precursors, setPrecursors] = useState<PrecursorRow[]>(() =>
    (metabolism?.precursors ?? []).map((p) => ({
      key: nextKey(),
      // For precursor links the related drug is the parent (precursor) side.
      precursorDrugId: p.drug?.id ?? p.parentDrugId,
      precursorName: p.drug ? resolveDrugName(p.drug.names, lang) : p.metaboliteName,
      ...rangeToPercents(p.conversionFraction),
      activity: p.activity,
      evidenceNote: p.evidenceNote ?? '',
      referenceIds: p.referenceIds,
    })),
  );

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activityOptions = useMemo(
    () => [
      { value: 'unknown', label: t('metabolismEdit.activityUnknown') },
      { value: 'active', label: t('metabolismEdit.activityActive') },
      { value: 'inactive', label: t('metabolismEdit.activityInactive') },
    ],
    [t],
  );

  const routeKindOptions = useMemo(
    () =>
      ELIMINATION_ROUTE_KINDS.map((kind) => ({
        value: kind,
        label: t(`metabolismRoute.${eliminationRouteKindKey(kind)}`),
      })),
    [t],
  );

  function updateRoute(key: string, patch: Partial<RouteRow>) {
    setRoutes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function updateMetabolite(key: string, patch: Partial<MetaboliteRow>) {
    setMetabolites((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }
  function updatePrecursor(key: string, patch: Partial<PrecursorRow>) {
    setPrecursors((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }

  // Parse a single percent input (0–100) to a 0–1 fraction. Returns null when
  // blank, 'error' when out of range or non-numeric.
  function percentToFraction(value: string): number | null | 'error' {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = parseLocaleNumber(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 100) return 'error';
    return Math.round((n / 100) * 10000) / 10000;
  }

  // Parse the three percent fields into a fraction range. Returns null when all
  // blank, { reason } when any field is out of range or the bounds are ordered
  // wrong (min ≤ median ≤ max).
  function percentsToRange(
    p: RangePercents,
  ):
    | { ok: true; value: MetabolismFractionRange | null }
    | { ok: false; reason: 'range' | 'order' } {
    const min = percentToFraction(p.minPercent);
    const median = percentToFraction(p.medianPercent);
    const max = percentToFraction(p.maxPercent);
    if (min === 'error' || median === 'error' || max === 'error') {
      return { ok: false, reason: 'range' };
    }
    if (min === null && median === null && max === null) {
      return { ok: true, value: null };
    }
    if (
      (min !== null && max !== null && min > max) ||
      (min !== null && median !== null && min > median) ||
      (median !== null && max !== null && median > max)
    ) {
      return { ok: false, reason: 'order' };
    }
    return { ok: true, value: { min, median, max } };
  }

  async function handleSave(submitForReview: boolean) {
    setError(null);

    const routeInputs: MetabolismRouteInput[] = [];
    for (const row of routes) {
      if (row.kind === 'enzyme' && !row.label.trim() && row.enzymeId == null) {
        setError(t('metabolismEdit.enzymeRequired'));
        return;
      }
      const frac = percentsToRange(row);
      if (!frac.ok) {
        setError(
          t(
            frac.reason === 'order'
              ? 'metabolismEdit.fractionOrder'
              : 'metabolismEdit.fractionRange',
          ),
        );
        return;
      }
      routeInputs.push({
        kind: row.kind,
        enzymeId: row.kind === 'enzyme' ? row.enzymeId : null,
        label: row.label.trim() || null,
        fraction: frac.value,
        note: row.note.trim() || null,
        referenceIds: row.referenceIds,
      });
    }

    // A metabolite belongs on one row, and the row's name is a label — it is
    // pre-filled in the editing user's language — not the key. So identity is
    // the linked substance when there is one, and a free-text row spelled the
    // way a linked row is spelled resolves to that same substance: both rows
    // would render as one line on the monograph. Catching it here is what
    // keeps the API's hardcoded English 400 off a Norwegian editor's screen;
    // the API still checks, against every locale of the linked drug rather
    // than just the one on display here.
    // null = two linked rows display the same name, so a free-text row
    // carrying it names neither in particular and is left to stand alone.
    const identityByName = new Map<string, string | null>();
    for (const row of metabolites) {
      const name = normalizeMetabolismName(row.metaboliteName);
      if (row.metaboliteDrugId == null || !name) continue;
      const identity = `drug:${row.metaboliteDrugId}`;
      if (!identityByName.has(name)) identityByName.set(name, identity);
      else if (identityByName.get(name) !== identity) {
        identityByName.set(name, null);
      }
    }

    const metaboliteInputs: MetabolismMetaboliteInput[] = [];
    const claimedMetabolites = new Set<string>();
    const claimedLabels = new Set<string>();
    for (const row of metabolites) {
      const name = row.metaboliteName.trim();
      if (!name) {
        setError(t('metabolismEdit.metaboliteNameRequired'));
        return;
      }
      const normalized = normalizeMetabolismName(name);
      const key =
        row.metaboliteDrugId != null
          ? `drug:${row.metaboliteDrugId}`
          : ((identityByName.get(normalized) ?? undefined) ??
            `name:${normalized}`);
      if (claimedMetabolites.has(key)) {
        setError(t('metabolismEdit.metaboliteDuplicate', { name }));
        return;
      }
      claimedMetabolites.add(key);
      // Distinct substances still cannot share a label: the metabolite name is
      // unique per drug in the database, and this field is prefilled from the
      // linked drug's name, which two drugs can share.
      if (claimedLabels.has(normalized)) {
        setError(t('metabolismEdit.metaboliteLabelDuplicate', { name }));
        return;
      }
      claimedLabels.add(normalized);
      const frac = percentsToRange(row);
      if (!frac.ok) {
        setError(
          t(
            frac.reason === 'order'
              ? 'metabolismEdit.fractionOrder'
              : 'metabolismEdit.fractionRange',
          ),
        );
        return;
      }
      metaboliteInputs.push({
        metaboliteName: name,
        metaboliteDrugId: row.metaboliteDrugId,
        conversionFraction: frac.value,
        activity: row.activity,
        evidenceNote: row.evidenceNote.trim() || null,
        referenceIds: row.referenceIds,
      });
    }

    const precursorInputs: MetabolismPrecursorInput[] = [];
    const claimedPrecursors = new Set<number>();
    for (const row of precursors) {
      if (!row.precursorDrugId) {
        setError(t('metabolismEdit.precursorRequired'));
        return;
      }
      if (claimedPrecursors.has(row.precursorDrugId)) {
        setError(t('metabolismEdit.precursorDuplicate'));
        return;
      }
      claimedPrecursors.add(row.precursorDrugId);
      const frac = percentsToRange(row);
      if (!frac.ok) {
        setError(
          t(
            frac.reason === 'order'
              ? 'metabolismEdit.fractionOrder'
              : 'metabolismEdit.fractionRange',
          ),
        );
        return;
      }
      precursorInputs.push({
        precursorDrugId: row.precursorDrugId,
        precursorName: row.precursorName,
        conversionFraction: frac.value,
        activity: row.activity,
        evidenceNote: row.evidenceNote.trim() || null,
        referenceIds: row.referenceIds,
      });
    }

    setSaving(true);
    try {
      const result = await submitDrugMetabolism(drugId, {
        profile: {
          evidenceNote: profileNote.trim() || null,
        },
        routes: routeInputs,
        metabolites: metaboliteInputs,
        precursors: precursorInputs,
        submitForReview,
      });
      if ('pending' in result && result.pending) {
        showToast(t('metabolismEdit.submitted'));
      } else {
        showToast(t('metabolismEdit.updated'));
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('metabolismEdit.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t('metabolismEdit.title', { drug: drugName })}
      className="w-full max-w-2xl p-6"
    >
      <h3 className="mb-1 text-lg font-semibold">
        {t('metabolismEdit.title', { drug: drugName })}
      </h3>
      <p className="mb-4 text-xs text-muted-foreground">
        {t('metabolismEdit.intro')}
      </p>

      <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
        {/* Elimination & metabolism routes */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              {t('metabolismEdit.routesHeading')}
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRoutes((rows) => [
                  ...rows,
                  {
                    key: nextKey(),
                    kind: 'enzyme',
                    enzymeId: null,
                    enzymeRank: null,
                    label: '',
                    ...EMPTY_RANGE_PERCENTS,
                    note: '',
                    referenceIds: null,
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('metabolismEdit.addRoute')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t('metabolismEdit.routesHint')}
          </p>
          {routes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('metabolismEdit.routesEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {routes.map((row) => (
                <li
                  key={row.key}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex items-start gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">
                        {t('metabolismEdit.routeKind')}
                      </span>
                      <Select
                        options={routeKindOptions}
                        value={row.kind}
                        onChange={(e) =>
                          updateRoute(row.key, {
                            kind: e.target.value as EliminationRouteKind,
                            // Clear enzyme link when leaving the enzyme kind.
                            ...(e.target.value === 'enzyme'
                              ? {}
                              : { enzymeId: null, enzymeRank: null }),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="mt-5 text-muted-foreground hover:text-foreground"
                      aria-label={t('metabolismEdit.remove')}
                      onClick={() =>
                        setRoutes((rows) => rows.filter((r) => r.key !== row.key))
                      }
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {row.kind === 'enzyme' ? (
                    <>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">
                          {t('metabolismEdit.enzymeName')}
                        </span>
                        <Input
                          value={row.label}
                          onChange={(e) =>
                            updateRoute(row.key, { label: e.target.value })
                          }
                        />
                      </label>
                      {row.enzymeId ? (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {isEnzymeGroupRank(row.enzymeRank) && row.enzymeRank
                              ? t(`enzymeRank.${row.enzymeRank}`)
                              : t('metabolismEdit.linkedEnzyme')}
                          </span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:underline"
                            onClick={() =>
                              updateRoute(row.key, {
                                enzymeId: null,
                                enzymeRank: null,
                              })
                            }
                          >
                            {t('metabolismEdit.unlinkEnzyme')}
                          </button>
                        </div>
                      ) : (
                        <>
                          <EnzymeSearchDropdown
                            placeholder={t('metabolismEdit.searchEnzyme')}
                            onSelect={(en) =>
                              updateRoute(row.key, {
                                enzymeId: en.id,
                                enzymeRank: en.rank ?? null,
                                label: en.symbol,
                              })
                            }
                          />
                          <p className="text-[11px] text-muted-foreground">
                            {t('metabolismEdit.searchEnzymeHint')}
                          </p>
                        </>
                      )}
                    </>
                  ) : row.kind === 'other_unchanged' ? (
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">
                        {t('metabolismEdit.routeLabel')}
                      </span>
                      <Input
                        value={row.label}
                        placeholder={t('metabolismEdit.routeLabelPlaceholder')}
                        onChange={(e) =>
                          updateRoute(row.key, { label: e.target.value })
                        }
                      />
                    </label>
                  ) : null}

                  <FractionRangeField
                    legend={t('metabolismEdit.fraction')}
                    percents={row}
                    onChange={(patch) => updateRoute(row.key, patch)}
                  />
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {t('metabolismEdit.note')}
                    </span>
                    <Input
                      value={row.note}
                      onChange={(e) =>
                        updateRoute(row.key, { note: e.target.value })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {t('metabolismEdit.profileNote')}
            </span>
            <Input
              value={profileNote}
              onChange={(e) => setProfileNote(e.target.value)}
            />
          </label>
        </section>

        {/* Metabolites */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              {t('metabolismEdit.metabolitesHeading')}
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setMetabolites((rows) => [
                  ...rows,
                  {
                    key: nextKey(),
                    metaboliteName: '',
                    metaboliteDrugId: null,
                    ...EMPTY_RANGE_PERCENTS,
                    activity: 'unknown',
                    evidenceNote: '',
                    referenceIds: null,
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('metabolismEdit.addMetabolite')}
            </Button>
          </div>
          {metabolites.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('metabolismEdit.metabolitesEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {metabolites.map((row) => (
                <li
                  key={row.key}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex items-start gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">
                        {t('metabolismEdit.metaboliteName')}
                      </span>
                      <Input
                        value={row.metaboliteName}
                        onChange={(e) =>
                          updateMetabolite(row.key, {
                            metaboliteName: e.target.value,
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="mt-5 text-muted-foreground hover:text-foreground"
                      aria-label={t('metabolismEdit.remove')}
                      onClick={() =>
                        setMetabolites((rows) =>
                          rows.filter((r) => r.key !== row.key),
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {row.metaboliteDrugId ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('metabolismEdit.linkedDrug')}
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:underline"
                        onClick={() =>
                          updateMetabolite(row.key, { metaboliteDrugId: null })
                        }
                      >
                        {t('metabolismEdit.unlink')}
                      </button>
                    </div>
                  ) : (
                    <DrugSearchDropdown
                      placeholder={t('metabolismEdit.linkDrug')}
                      onSelect={(c) =>
                        updateMetabolite(row.key, {
                          metaboliteDrugId: c._dbId ?? null,
                          metaboliteName:
                            resolveDrugName(c.names, lang) || row.metaboliteName,
                        })
                      }
                    />
                  )}
                  <FractionRangeField
                    legend={t('metabolismEdit.conversionPercent')}
                    percents={row}
                    onChange={(patch) => updateMetabolite(row.key, patch)}
                  />
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {t('metabolismEdit.activity')}
                    </span>
                    <Select
                      options={activityOptions}
                      value={row.activity}
                      onChange={(e) =>
                        updateMetabolite(row.key, {
                          activity: e.target.value as MetaboliteActivity,
                        })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {t('metabolismEdit.note')}
                    </span>
                    <Input
                      value={row.evidenceNote}
                      onChange={(e) =>
                        updateMetabolite(row.key, {
                          evidenceNote: e.target.value,
                        })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Precursors */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              {t('metabolismEdit.precursorsHeading')}
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPrecursors((rows) => [
                  ...rows,
                  {
                    key: nextKey(),
                    precursorDrugId: null,
                    precursorName: '',
                    ...EMPTY_RANGE_PERCENTS,
                    activity: 'unknown',
                    evidenceNote: '',
                    referenceIds: null,
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('metabolismEdit.addPrecursor')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t('metabolismEdit.precursorsHint')}
          </p>
          {precursors.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('metabolismEdit.precursorsEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {precursors.map((row) => (
                <li
                  key={row.key}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      {row.precursorDrugId ? (
                        <div className="text-sm font-medium">
                          {row.precursorName}
                        </div>
                      ) : (
                        <DrugSearchDropdown
                          placeholder={t('metabolismEdit.searchDrug')}
                          onSelect={(c) =>
                            updatePrecursor(row.key, {
                              precursorDrugId: c._dbId ?? null,
                              precursorName: resolveDrugName(c.names, lang),
                            })
                          }
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t('metabolismEdit.remove')}
                      onClick={() =>
                        setPrecursors((rows) =>
                          rows.filter((r) => r.key !== row.key),
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <FractionRangeField
                    legend={t('metabolismEdit.conversionPercent')}
                    percents={row}
                    onChange={(patch) => updatePrecursor(row.key, patch)}
                  />
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {t('metabolismEdit.activity')}
                    </span>
                    <Select
                      options={activityOptions}
                      value={row.activity}
                      onChange={(e) =>
                        updatePrecursor(row.key, {
                          activity: e.target.value as MetaboliteActivity,
                        })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {t('metabolismEdit.note')}
                    </span>
                    <Input
                      value={row.evidenceNote}
                      onChange={(e) =>
                        updatePrecursor(row.key, {
                          evidenceNote: e.target.value,
                        })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {error ? (
        <div className="mt-3 text-sm text-red-600">{error}</div>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        {isAdmin ? (
          <>
            <Button
              variant="outline"
              onClick={() => handleSave(true)}
              disabled={saving}
            >
              {saving ? t('metabolismEdit.saving') : t('metabolismEdit.submitForReview')}
            </Button>
            <Button onClick={() => handleSave(false)} disabled={saving}>
              {saving ? t('metabolismEdit.saving') : t('metabolismEdit.save')}
            </Button>
          </>
        ) : (
          <Button onClick={() => handleSave(true)} disabled={saving}>
            {saving ? t('metabolismEdit.saving') : t('metabolismEdit.submitForReview')}
          </Button>
        )}
      </div>
    </ModalOverlay>
  );
}

function PercentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * Three percent inputs (min / median–mean / max) backing a stored fraction
 * range. Any field may be left blank; the parent validates ordering on save.
 */
function FractionRangeField({
  legend,
  percents,
  onChange,
}: {
  legend: string;
  percents: RangePercents;
  onChange: (patch: Partial<RangePercents>) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{legend}</span>
      <div className="grid grid-cols-3 gap-2">
        <PercentField
          label={t('metabolismEdit.rangeMin')}
          value={percents.minPercent}
          onChange={(v) => onChange({ minPercent: v })}
        />
        <PercentField
          label={t('metabolismEdit.rangeMedian')}
          value={percents.medianPercent}
          onChange={(v) => onChange({ medianPercent: v })}
        />
        <PercentField
          label={t('metabolismEdit.rangeMax')}
          value={percents.maxPercent}
          onChange={(v) => onChange({ maxPercent: v })}
        />
      </div>
    </fieldset>
  );
}
