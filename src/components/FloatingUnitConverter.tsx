import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Calculator, X } from 'lucide-react';
import { useDrugStore } from '@/stores/drugStore';
import { useSimulatorStore } from '@/stores/simulatorStore';
import { loadComponents } from '@/data';
import { DrugInlineConverter } from '@/components/drug-table/DrugInlineConverter';
import { HelpfulTip } from '@/components/ui/HelpfulTip';
import { Select } from '@/components/ui/select';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import type { DrugComponent } from '@/types';

/**
 * Floating unit-conversion calculator pinned to the lower-right corner of the
 * app shell. Hidden by default behind a small calculator button; clicking it
 * expands a panel large enough for the bidirectional `DrugInlineConverter`
 * (same logic used in the drug table and the Ctrl+Shift+U dialog).
 *
 * Its parameters (molecular weight, blood/plasma ratio) default to whichever
 * monograph is in focus — `activeDrug` in the drug store. But when the user is
 * running the simulator (often reached from a monograph via `?drugId=`, which
 * pins `activeDrug` to that one drug), they may have added other drugs; a picker
 * lets them convert any of those too, not just the original.
 */
export function FloatingUnitConverter() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const activeDrug = useDrugStore((s) => s.activeDrug);
  const simDrugs = useSimulatorStore((s) => s.drugs);
  const [open, setOpen] = useState(false);
  // Set once the user touches a converter field, so the helpful tip can
  // auto-surface (when the universal tips feature is on and undismissed).
  const [interacted, setInteracted] = useState(false);

  // Full component catalog, resolved lazily only when the panel is open and the
  // simulator has drugs to offer — so opening the converter elsewhere stays a
  // no-op. `loadComponents()` is cached after the first call.
  const [catalog, setCatalog] = useState<DrugComponent[]>([]);
  useEffect(() => {
    if (!open || simDrugs.length === 0 || catalog.length > 0) return;
    let cancelled = false;
    void loadComponents()
      .then((components) => {
        if (!cancelled) setCatalog(components);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, simDrugs.length, catalog.length]);

  // Candidate drugs to convert: the active (monograph/URL) drug plus every drug
  // added to the simulator, de-duplicated by component id with the active drug
  // first so it stays the default.
  const candidates = useMemo(() => {
    const byId = new Map(catalog.map((c) => [c.id, c] as const));
    const seen = new Set<string>();
    const out: DrugComponent[] = [];
    const push = (c: DrugComponent | null | undefined) => {
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    };
    push(activeDrug);
    for (const cfg of simDrugs) push(byId.get(cfg.drugId));
    return out;
  }, [activeDrug, simDrugs, catalog]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedDrug =
    candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null;

  const settingsTip = (
    <HelpfulTip
      id="unit-converter-settings"
      autoShow={interacted}
      triggerLabel={t('unitConverter.settingsTipLabel') as string}
      content={
        <Trans
          i18nKey="unitConverter.settingsTip"
          components={{
            settingsLink: (
              <Link
                to="/preferences"
                className="font-medium text-primary underline-offset-2 hover:underline"
              />
            ),
          }}
        />
      }
    />
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('unitConverter.open') as string}
        title={t('unitConverter.open') as string}
        className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Calculator className="h-6 w-6" />
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={t('unitConverter.title') as string}
      className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Calculator className="h-4 w-4 text-primary" />
          {t('unitConverter.title')}
          {settingsTip}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t('unitConverter.close') as string}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="px-4 py-3">
        {selectedDrug ? (
          <div
            className="rounded-md border border-border p-3"
            onFocusCapture={() => setInteracted(true)}
            onPointerDownCapture={() => setInteracted(true)}
          >
            {candidates.length > 1 ? (
              <Select
                className="mb-2 h-8 text-xs"
                aria-label={t('unitConverter.drugPickerLabel') as string}
                value={selectedDrug.id}
                onChange={(e) => setSelectedId(e.target.value)}
                options={candidates.map((c) => ({
                  value: c.id,
                  label: formatGenericDrugName(resolveDrugName(c.names, lang)),
                }))}
              />
            ) : (
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {formatGenericDrugName(resolveDrugName(selectedDrug.names, lang))}
              </div>
            )}
            <DrugInlineConverter drug={selectedDrug} />
          </div>
        ) : (
          <div className="py-4 text-center text-xs italic text-muted-foreground">
            {t('unitConverter.noActiveDrug')}
          </div>
        )}
      </div>
    </div>
  );
}
