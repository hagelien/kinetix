import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';

interface PlanParameter {
  parameter: string;
  sourceCount: number;
}

interface PlanIonizationConstant {
  pKa: number;
  protonatedCharge: number;
  deprotonatedCharge: number;
  type: 'macroscopic' | 'microscopic';
  evidenceType: 'experimental' | 'predicted';
  sourceCount: number;
}

interface PlanCounts {
  parameters: number;
  ionizationConstants?: number;
  sources: number;
  pharmacodynamicTargets: number;
  eliminationRoutes: number;
  metabolites: number;
  enzymeInteractions: number;
}

interface Plan {
  drug: { nameNb: string | null; nameEn: string | null; pubchemCid: number | null };
  parameters: PlanParameter[];
  ionizationConstants?: PlanIonizationConstant[];
  counts: PlanCounts;
}

interface ImportStats {
  drugId: number;
  drugCreated: boolean;
  citations: number;
  parameters: number;
  parametersSkipped: number;
  pdTargets: number;
  routes: number;
  metabolites: number;
  enzymeInteractions: number;
  keptWithUnattachedSources?: Array<{ parameter: string; sources: number }>;
  sourcesAttachedToUnchanged?: number;
  entries?: number;
  entriesUpdated?: number;
  entriesSkipped?: number;
  entriesKept?: Array<{ parameter: string; entries: number }>;
  entriesInvalid?: Array<{ parameter: string; message: string }>;
  entrySourcesUnresolved?: number;
  metabolitesKept?: Array<{ name: string; linkedAs: string }>;
  ionizationConstants?: number;
  ionizationConstantsUpdated?: number;
  ionizationConstantsSkipped?: number;
  ionizationConstantsKept?: number;
}

interface ApiResult {
  ok: boolean;
  dryRun?: boolean;
  plan?: Plan;
  stats?: ImportStats;
  warnings?: string[];
  errors?: string[];
  error?: string;
}

/**
 * Terminal-free path for the deep-research bulk-seed. An admin pastes or
 * uploads a `kinetix-deep-research-output-v1` JSON, previews it (server-side
 * dry-run), then imports. Mirrors `npm run import:research` — same endpoint,
 * same validation and write path.
 */
export function ResearchImportAdminSection() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<null | 'preview' | 'import'>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
      setResult(null);
      setErrorMsg('');
    };
    reader.readAsText(file);
    // Allow re-selecting the same file.
    e.target.value = '';
  }

  async function send(dryRun: boolean) {
    setErrorMsg('');
    setResult(null);
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      setErrorMsg(t('admin.researchImport.invalidJson'));
      return;
    }
    setBusy(dryRun ? 'preview' : 'import');
    try {
      const res = await fetch('/api/research-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, dryRun, overwrite }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResult;
      setResult(data);
      if (!res.ok || data.ok === false) {
        setErrorMsg(data.error ?? (data.errors ? '' : t('admin.researchImport.requestFailed')));
      } else if (!dryRun) {
        showToast(t('admin.researchImport.imported'));
      }
    } catch {
      setErrorMsg(t('admin.researchImport.requestFailed'));
    } finally {
      setBusy(null);
    }
  }

  const plan = result?.ok ? result.plan : undefined;
  const stats = result?.ok && result.dryRun === false ? result.stats : undefined;
  const drugLabel = plan
    ? plan.drug.nameNb || plan.drug.nameEn || t('admin.researchImport.unnamedDrug')
    : '';

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('admin.researchImport.title')}</h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        {t('admin.researchImport.description')}
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onPickFile}
          className="hidden"
        />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
          {t('admin.researchImport.chooseFile')}
        </Button>
        {text && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('');
              setResult(null);
              setErrorMsg('');
            }}
          >
            {t('admin.researchImport.clear')}
          </Button>
        )}
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        placeholder={t('admin.researchImport.placeholder')}
        spellCheck={false}
        className="w-full h-56 font-mono text-xs rounded-md border border-input bg-background p-3 mb-3"
      />

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Button onClick={() => send(true)} disabled={!text.trim() || busy !== null} variant="outline">
          {busy === 'preview' ? t('admin.researchImport.previewing') : t('admin.researchImport.preview')}
        </Button>
        <Button
          onClick={() => send(false)}
          disabled={!plan || busy !== null}
          title={!plan ? t('admin.researchImport.previewFirst') : undefined}
        >
          {busy === 'import' ? t('admin.researchImport.importing') : t('admin.researchImport.import')}
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          {t('admin.researchImport.overwrite')}
        </label>
      </div>

      {errorMsg && <p className="text-sm text-red-600 mb-2">{errorMsg}</p>}
      {result?.ok === false && result.errors && result.errors.length > 0 && (
        <div className="mb-3">
          <p className="text-sm font-medium text-red-600 mb-1">
            {t('admin.researchImport.validationFailed')}
          </p>
          <ul className="list-disc pl-5 text-sm text-red-600 space-y-0.5">
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {plan && (
        <div className="border border-border rounded-lg p-4 mb-3 max-w-2xl">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="font-semibold">
              {drugLabel}
              {plan.drug.pubchemCid ? (
                <span className="text-muted-foreground font-normal"> · CID {plan.drug.pubchemCid}</span>
              ) : null}
            </h3>
            <span className="text-xs text-muted-foreground">
              {stats
                ? t('admin.researchImport.imported')
                : t('admin.researchImport.previewBadge')}
            </span>
          </div>

          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm mb-2">
            <li>
              {t('admin.researchImport.countParameters')}: <strong>{plan.counts.parameters}</strong>
            </li>
            {plan.counts.ionizationConstants ? (
              <li>
                {t('admin.researchImport.countIonizationConstants')}:{' '}
                <strong>{plan.counts.ionizationConstants}</strong>
              </li>
            ) : null}
            <li>
              {t('admin.researchImport.countSources')}: <strong>{plan.counts.sources}</strong>
            </li>
            <li>
              {t('admin.researchImport.countPdTargets')}: <strong>{plan.counts.pharmacodynamicTargets}</strong>
            </li>
            <li>
              {t('admin.researchImport.countRoutes')}: <strong>{plan.counts.eliminationRoutes}</strong>
            </li>
            <li>
              {t('admin.researchImport.countMetabolites')}: <strong>{plan.counts.metabolites}</strong>
            </li>
            <li>
              {t('admin.researchImport.countEnzymeInteractions')}:{' '}
              <strong>{plan.counts.enzymeInteractions}</strong>
            </li>
          </ul>

          {plan.parameters.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {plan.parameters
                .map((p) => `${p.parameter}${p.sourceCount ? ` [${p.sourceCount}]` : ''}`)
                .join(' · ')}
            </div>
          )}

          {plan.ionizationConstants && plan.ionizationConstants.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              {plan.ionizationConstants
                .map(
                  (c) =>
                    `pKa ${c.pKa} (${c.protonatedCharge}→${c.deprotonatedCharge}, ${c.evidenceType}` +
                    `${c.type === 'microscopic' ? ', microscopic' : ''}${c.sourceCount ? `, [${c.sourceCount}]` : ''})`,
                )
                .join(' · ')}
            </div>
          )}

          {stats && (
            <div className="mt-3 pt-3 border-t border-border text-sm">
              <p className="font-medium mb-1">
                {stats.drugCreated
                  ? t('admin.researchImport.drugCreated')
                  : t('admin.researchImport.drugMatched')}{' '}
                (id {stats.drugId})
              </p>
              <p className="text-muted-foreground">
                {t('admin.researchImport.wroteSummary', {
                  parameters: stats.parameters,
                  skipped: stats.parametersSkipped,
                  citations: stats.citations,
                  pd: stats.pdTargets,
                  routes: stats.routes,
                  metabolites: stats.metabolites,
                  enzymes: stats.enzymeInteractions,
                })}
              </p>
              {stats.entries ||
              stats.entriesUpdated ||
              stats.entriesSkipped ? (
                <p className="text-muted-foreground">
                  {t('admin.researchImport.sourceValues', {
                    written: stats.entries ?? 0,
                    updated: stats.entriesUpdated ?? 0,
                    present: stats.entriesSkipped ?? 0,
                  })}
                </p>
              ) : null}
              {stats.ionizationConstants ||
              stats.ionizationConstantsUpdated ||
              stats.ionizationConstantsSkipped ||
              stats.ionizationConstantsKept ? (
                <p className="text-muted-foreground">
                  {t('admin.researchImport.ionizationConstants', {
                    written: stats.ionizationConstants ?? 0,
                    updated: stats.ionizationConstantsUpdated ?? 0,
                    present: stats.ionizationConstantsSkipped ?? 0,
                    kept: stats.ionizationConstantsKept ?? 0,
                  })}
                </p>
              ) : null}
              {stats.entriesKept && stats.entriesKept.length > 0 && (
                // A reading that changed since the last run is never applied
                // silently — the operator decides whether to re-run with
                // overwrite, exactly as for a kept parameter value.
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  {t('admin.researchImport.sourceValuesKept', {
                    count: stats.entriesKept.reduce((n, k) => n + k.entries, 0),
                    parameters: stats.entriesKept
                      .map((k) => k.parameter)
                      .join(', '),
                  })}
                </p>
              )}
              {stats.entriesInvalid && stats.entriesInvalid.length > 0 && (
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  {t('admin.researchImport.sourceValuesRejected', {
                    count: stats.entriesInvalid.length,
                    details: stats.entriesInvalid
                      .map((k) => `${k.parameter}: ${k.message}`)
                      .join('; '),
                  })}
                </p>
              )}
              {stats.sourcesAttachedToUnchanged ? (
                <p className="text-muted-foreground">
                  {t('admin.researchImport.attachedToUnchanged', {
                    count: stats.sourcesAttachedToUnchanged,
                  })}
                </p>
              ) : null}
              {stats.keptWithUnattachedSources &&
                stats.keptWithUnattachedSources.length > 0 && (
                  // Citations for a kept value are intentionally not attached
                  // to it — they back the value the document proposed instead.
                  // Say so, or the run looks complete while those parameters
                  // stay flagged as unreferenced.
                  <p className="mt-2 text-amber-700 dark:text-amber-400">
                    {t('admin.researchImport.unattachedSources', {
                      count: stats.keptWithUnattachedSources.reduce(
                        (n, k) => n + k.sources,
                        0,
                      ),
                      parameters: stats.keptWithUnattachedSources
                        .map((k) => k.parameter)
                        .join(', '),
                    })}
                  </p>
                )}
              {stats.metabolitesKept && stats.metabolitesKept.length > 0 && (
                // The drug already links these substances under another
                // spelling, so the document's rows were not written at all.
                // Unsaid, `metabolites: 0` reads as an idempotent re-run.
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  {t('admin.researchImport.metabolitesKept', {
                    count: stats.metabolitesKept.length,
                    metabolites: stats.metabolitesKept
                      .map((k) => `${k.name} → ${k.linkedAs}`)
                      .join(', '),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {result?.warnings && result.warnings.length > 0 && (
        <div className="border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 rounded-lg p-3 max-w-2xl">
          <p className="text-sm font-medium mb-1">
            {t('admin.researchImport.warnings', { count: result.warnings.length })}
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
