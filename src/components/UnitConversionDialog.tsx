import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Calculator, Search, X } from 'lucide-react';
import { useDrugStore } from '@/stores/drugStore';
import { DrugInlineConverter } from '@/components/drug-table/DrugInlineConverter';
import { fetchDrugComponentById, fetchDrugSearchResults } from '@/lib/drugApi';
import {
  formatGenericDrugName,
  resolveDrugName,
  resolveAltDrugName,
} from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { useOverlayLayer } from '@/lib/overlayStack';
import type { DrugComponent } from '@/types';

interface UnitConversionDialogProps {
  open: boolean;
  onClose: () => void;
}

interface PickerResult {
  drugId: number;
  title: string;
  subtitle?: string;
}

/**
 * Modal wrapper around `DrugInlineConverter` that adds a drug picker
 * (#308). Defaults to the currently active drug in the global store; the
 * user can swap to any other drug via the search input. Triggered by
 * Ctrl+Shift+U at the app shell level.
 */
export function UnitConversionDialog({ open, onClose }: UnitConversionDialogProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const activeDrug = useDrugStore((s) => s.activeDrug);
  const [drug, setDrug] = useState<DrugComponent | null>(activeDrug);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Renders above any open ModalOverlay (z-60 vs z-50); claim the top of the
  // overlay stack so that modal's focus trap yields while this is up.
  useOverlayLayer(open);

  useEffect(() => {
    if (open) {
      setDrug(activeDrug);
      setQuery('');
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, activeDrug]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const data = await fetchDrugSearchResults({ q: trimmed, limit: 8 }).catch(
        () => ({ drugs: [] }),
      );
      if (cancelled) return;
      setResults(
        data.drugs.map((d) => {
          const primary = resolveDrugName(d.names, lang);
          const alt = resolveAltDrugName(d.names, primary);
          return {
            drugId: d.id,
            title: formatGenericDrugName(primary),
            subtitle: formatGenericDrugName(alt ?? ''),
          };
        }),
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, lang]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function pickDrug(result: PickerResult) {
    setQuery('');
    setResults([]);
    try {
      const next = await fetchDrugComponentById(result.drugId);
      setDrug(next);
    } catch {
      // leave previous drug; the user can retry
    }
  }

  const heading = useMemo(() => t('unitConverter.title'), [t]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-label={heading}
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card rounded-xl shadow-2xl border overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Calculator className="h-4 w-4 text-primary" />
            {heading}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close') as string}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('unitConverter.pickDrug') as string}
              className="flex-1 bg-transparent outline-none text-sm"
            />
          </div>
          {results.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border">
              {results.map((r) => (
                <li key={r.drugId}>
                  <button
                    type="button"
                    onClick={() => pickDrug(r)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                  >
                    <div className="font-medium">{r.title}</div>
                    {r.subtitle && (
                      <div className="text-xs text-muted-foreground truncate">
                        {r.subtitle}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {drug ? (
            <div className="rounded-md border border-border p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2">
                {formatGenericDrugName(resolveDrugName(drug.names, lang))}
              </div>
              <DrugInlineConverter drug={drug} />
            </div>
          ) : (
            <div className="text-xs italic text-muted-foreground py-4 text-center">
              {t('unitConverter.noActiveDrug')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
