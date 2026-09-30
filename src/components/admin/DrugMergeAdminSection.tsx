import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showToast } from '@/lib/toast';
import {
  applyDrugMerge,
  DrugMergeError,
  drugDisplayName,
  drugSideDisplayName,
  previewDrugMerge,
  searchDrugsForMerge,
  type ConflictResolution,
  type DrugMergeConflict,
  type DrugMergePlan,
  type DrugMergeTranslatableMessage,
  type DrugSearchResult,
  type DrugSideInfo,
} from '@/lib/drugMergeApi';

type Side = 'a' | 'b';

/** A debounced drug search box that reports the picked drug to the parent. */
function DrugPicker({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: DrugSearchResult | null;
  onSelect: (drug: DrugSearchResult | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const language: 'nb' | 'en' = i18n.language === 'en' ? 'en' : 'nb';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DrugSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const handle = setTimeout(() => {
      searchDrugsForMerge(query).then((rows) => {
        if (active) setResults(rows);
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="flex-1 min-w-0" ref={boxRef}>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {drugDisplayName(selected, language)}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              id {selected.id}
              {selected.pubchemCid ? ` · CID ${selected.pubchemCid}` : ''}
            </span>
          </span>
          <Button variant="outline" size="sm" onClick={() => onSelect(null)}>
            {t('admin.drugMerge.change')}
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={t('admin.drugMerge.searchPlaceholder')}
          />
          {open && results.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full max-h-64 overflow-auto rounded-md border border-border bg-background shadow-lg">
              {results.map((drug) => (
                <li key={drug.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      onSelect(drug);
                      setQuery('');
                      setResults([]);
                      setOpen(false);
                    }}
                  >
                    <span className="font-medium">{drugDisplayName(drug, language)}</span>
                    <span className="text-xs text-muted-foreground">
                      id {drug.id}
                      {drug.pubchemCid ? ` · CID ${drug.pubchemCid}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MonographBadge({ side }: { side: DrugSideInfo }) {
  const { t } = useTranslation();
  if (!side.monograph) return <span>{t('admin.drugMerge.noMonograph')}</span>;
  return (
    <span>
      {side.monograph.hasContent
        ? t('admin.drugMerge.hasMonograph')
        : t('admin.drugMerge.emptyMonograph')}
    </span>
  );
}

function displayValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  // metabolism_profile conflicts carry `{ note, referenceIds }` — render both
  // pieces so the admin sees the citations they are keeping alongside the note.
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('note' in value || 'referenceIds' in value)
  ) {
    const v = value as { note?: string | null; referenceIds?: number[] };
    const note = v.note?.trim() || '—';
    const refs = Array.isArray(v.referenceIds) ? v.referenceIds : [];
    return refs.length > 0 ? `${note}\n[refs: ${refs.join(', ')}]` : note;
  }
  return JSON.stringify(value);
}

function ConflictRow({
  conflict,
  resolution,
  onChange,
  winnerName,
  loserName,
}: {
  conflict: DrugMergeConflict;
  resolution: ConflictResolution;
  onChange: (r: ConflictResolution) => void;
  winnerName: string;
  loserName: string;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`admin.drugMerge.conflictKind.${conflict.kind}`);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 text-sm font-medium">
        {kindLabel}
        {conflict.key !== 'profile' ? `: ${conflict.key}` : ''}
      </div>
      {conflict.kind === 'metabolism_profile' && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t('admin.drugMerge.profileNoteHelp')}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ['winner', winnerName, conflict.winnerValue],
            ['loser', loserName, conflict.loserValue],
          ] as const
        ).map(([choice, name, value]) => (
          <label
            key={choice}
            className={`flex cursor-pointer gap-2 rounded-md border p-2 text-sm ${
              resolution === choice
                ? 'border-primary bg-primary/5'
                : 'border-border'
            }`}
          >
            <input
              type="radio"
              className="mt-0.5"
              checked={resolution === choice}
              onChange={() => onChange(choice)}
            />
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">
                {choice === 'winner'
                  ? t('admin.drugMerge.keepFrom', { name })
                  : t('admin.drugMerge.takeFrom', { name })}
              </span>
              <span className="block whitespace-pre-line break-words font-mono text-xs">
                {displayValue(value)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const COUNT_KEYS = [
  'parametersMovedCleanly',
  'parameterEntries',
  'methodMembershipsMoved',
  'methodMembershipsDeduped',
  'metaboliteEdgesMoved',
  'precursorLinksMoved',
  'receptorTargets',
  'enzymeInteractions',
  'eliminationRoutes',
  'ionizationConstants',
  'pmDistributions',
  'atlasRows',
  'wikiPagesRelinked',
] as const;

/**
 * Render a server-supplied `DrugMergeTranslatableMessage` in the current
 * locale. Uses the code as an i18n key under `admin.drugMerge.<code>`, with
 * the server-supplied English `fallback` as `defaultValue` — so an unknown
 * code (an older client that didn't ship the new key) renders correctly in
 * English rather than as a raw key. `params` are the interpolation values.
 * The server also produces `fallback` in English; never render `code` or the
 * fallback string directly to the user without going through this helper.
 */
function messageForTranslatable(
  msg: DrugMergeTranslatableMessage,
  t: (key: string, options: Record<string, unknown>) => string,
): string {
  return t(`admin.drugMerge.${msg.code}`, {
    defaultValue: msg.fallback,
    ...(msg.params ?? {}),
  });
}

/**
 * The complete set of server-supplied error codes the merge endpoint returns.
 * Every code MUST have a matching `admin.drugMerge.errors.<code>` key in each
 * locale; unknown codes and non-DrugMergeError throws fall back to `generic`.
 * We never render the server's `error` prose — that stays English and is only
 * useful in logs.
 */
const KNOWN_MERGE_ERROR_CODES = new Set([
  'substance_class_mismatch',
  'applicability_conflict',
  'data_conflict',
  'unresolved_conflicts',
  'stale_plan',
]);

/**
 * Turn a merge-error thrown by `drugMergeApi` (or anything else) into a
 * user-visible localized message. Also handles 404 (drugs vanished) and the
 * client-side "same drug" guard, so no English server prose ever surfaces.
 */
function messageForMergeError(
  err: unknown,
  t: (key: string) => string,
): string {
  if (err instanceof DrugMergeError) {
    if (err.httpStatus === 404) return t('admin.drugMerge.errors.not_found');
    if (err.code && KNOWN_MERGE_ERROR_CODES.has(err.code)) {
      return t(`admin.drugMerge.errors.${err.code}`);
    }
    return t('admin.drugMerge.errors.generic');
  }
  return t('admin.drugMerge.errors.generic');
}

export function DrugMergeAdminSection() {
  const { t, i18n } = useTranslation();
  const language: 'nb' | 'en' = i18n.language === 'en' ? 'en' : 'nb';
  const [drugA, setDrugA] = useState<DrugSearchResult | null>(null);
  const [drugB, setDrugB] = useState<DrugSearchResult | null>(null);
  const [plan, setPlan] = useState<DrugMergePlan | null>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [busy, setBusy] = useState<null | 'preview' | 'apply'>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [confirming, setConfirming] = useState(false);

  function pick(side: Side, drug: DrugSearchResult | null) {
    if (side === 'a') setDrugA(drug);
    else setDrugB(drug);
    setPlan(null);
    setConfirming(false);
    setErrorMsg('');
  }

  async function runPreview(winnerId?: number) {
    if (!drugA || !drugB) return;
    if (drugA.id === drugB.id) {
      setErrorMsg(t('admin.drugMerge.sameDrug'));
      return;
    }
    setBusy('preview');
    setErrorMsg('');
    setConfirming(false);
    try {
      const next = await previewDrugMerge({
        drugIdA: drugA.id,
        drugIdB: drugB.id,
        winnerId,
      });
      setPlan(next);
      setResolutions(
        Object.fromEntries(next.conflicts.map((c) => [c.id, 'winner'])),
      );
    } catch (err) {
      setErrorMsg(messageForMergeError(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    if (!plan) return;
    setBusy('apply');
    setErrorMsg('');
    try {
      const stats = await applyDrugMerge({
        winnerId: plan.winner.id,
        loserId: plan.loser.id,
        resolutions,
        planFingerprint: plan.planFingerprint,
      });
      showToast(
        t('admin.drugMerge.merged', {
          winner: drugSideDisplayName(plan.winner, language),
          loser: drugSideDisplayName(plan.loser, language),
        }),
      );
      // Reset the form — the loser no longer exists.
      setPlan(null);
      setDrugA(null);
      setDrugB(null);
      setConfirming(false);
      setResolutions({});
      void stats;
    } catch (err) {
      setErrorMsg(messageForMergeError(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">
        {t('admin.drugMerge.title')}
      </h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        {t('admin.drugMerge.description')}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end max-w-3xl">
        <DrugPicker
          label={t('admin.drugMerge.drugA')}
          selected={drugA}
          onSelect={(d) => pick('a', d)}
        />
        <DrugPicker
          label={t('admin.drugMerge.drugB')}
          selected={drugB}
          onSelect={(d) => pick('b', d)}
        />
        <Button
          onClick={() => runPreview()}
          disabled={!drugA || !drugB || busy !== null}
        >
          {busy === 'preview'
            ? t('admin.drugMerge.previewing')
            : t('admin.drugMerge.preview')}
        </Button>
      </div>

      {errorMsg && <p className="mt-3 text-sm text-red-600">{errorMsg}</p>}

      {plan && (
        <div className="mt-6 max-w-3xl space-y-5">
          <div className="rounded-lg border border-border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  {t('admin.drugMerge.survivor')}
                </div>
                <div className="font-semibold">
                  {drugSideDisplayName(plan.winner, language)}{' '}
                  <span className="text-muted-foreground">
                    (id {plan.winner.id})
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  <MonographBadge side={plan.winner} />
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  {t('admin.drugMerge.removed')}
                </div>
                <div className="font-semibold">
                  {drugSideDisplayName(plan.loser, language)}{' '}
                  <span className="text-muted-foreground">
                    (id {plan.loser.id})
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  <MonographBadge side={plan.loser} />
                </div>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {messageForTranslatable(plan.winnerReason, t)}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={busy !== null}
              onClick={() => runPreview(plan.loser.id)}
            >
              {t('admin.drugMerge.swap')}
            </Button>
          </div>

          {plan.warnings.map((warning, i) => (
            <p
              key={i}
              className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm"
            >
              {messageForTranslatable(warning, t)}
            </p>
          ))}

          {plan.blockers.length > 0 && (
            <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
              <p className="font-medium">{t('admin.drugMerge.blockersTitle')}</p>
              <p className="mt-1 text-muted-foreground">
                {t('admin.drugMerge.blockersHelp')}
              </p>
              <ul className="mt-2 list-disc pl-5">
                {plan.blockers.map((b) => (
                  <li key={`${b.reason}:${b.parameter}`}>
                    <span className="font-mono">{b.parameter}</span> —{' '}
                    {t(`admin.drugMerge.blockerReason.${b.reason}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.substanceClassMismatch && (
            <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
              <p className="font-medium">
                {t('admin.drugMerge.classMismatchTitle')}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t('admin.drugMerge.classMismatchHelp', {
                  winner: plan.substanceClassMismatch.winner,
                  loser: plan.substanceClassMismatch.loser,
                })}
              </p>
            </div>
          )}

          {plan.dataConflicts.length > 0 && (
            <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
              <p className="font-medium">
                {t('admin.drugMerge.dataConflictsTitle')}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t('admin.drugMerge.dataConflictsHelp')}
              </p>
              <ul className="mt-2 space-y-1 list-disc pl-5">
                {plan.dataConflicts.map((c, i) => (
                  <li key={`${c.table}:${c.identity}:${i}`}>
                    <span className="font-mono text-xs">{c.table}</span> —{' '}
                    <span className="font-medium">{c.identity}</span>:{' '}
                    <span>{messageForTranslatable(c.message, t)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.conflicts.length > 0 && (
            <div>
              <h3 className="mb-2 font-semibold">
                {t('admin.drugMerge.conflictsTitle', {
                  count: plan.conflicts.length,
                })}
              </h3>
              <p className="mb-3 text-sm text-muted-foreground">
                {t('admin.drugMerge.conflictsHelp')}
              </p>
              <div className="space-y-2">
                {plan.conflicts.map((conflict) => (
                  <ConflictRow
                    key={conflict.id}
                    conflict={conflict}
                    resolution={resolutions[conflict.id] ?? 'winner'}
                    onChange={(r) =>
                      setResolutions((prev) => ({ ...prev, [conflict.id]: r }))
                    }
                    winnerName={drugSideDisplayName(plan.winner, language)}
                    loserName={drugSideDisplayName(plan.loser, language)}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 font-semibold">
              {t('admin.drugMerge.whatMoves')}
            </h3>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              {COUNT_KEYS.map((key) => (
                <li key={key} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">
                    {t(`admin.drugMerge.counts.${key}`)}
                  </span>
                  <span className="font-mono">{plan.counts[key]}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3 border-t border-border pt-4">
            {confirming ? (
              <>
                <span className="text-sm">
                  {t('admin.drugMerge.confirmPrompt', {
                    loser: drugSideDisplayName(plan.loser, language),
                  })}
                </span>
                <Button
                  variant="destructive"
                  onClick={runApply}
                  disabled={busy !== null}
                >
                  {busy === 'apply'
                    ? t('admin.drugMerge.merging')
                    : t('admin.drugMerge.confirmMerge')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={busy !== null}
                >
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button
                variant="destructive"
                onClick={() => setConfirming(true)}
                disabled={
                  busy !== null ||
                  plan.blockers.length > 0 ||
                  plan.dataConflicts.length > 0 ||
                  plan.substanceClassMismatch !== null
                }
              >
                {t('admin.drugMerge.performMerge')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
