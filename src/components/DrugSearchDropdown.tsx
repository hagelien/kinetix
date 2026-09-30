import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import {
  fetchDrugSearchResults,
  drugSearchRowToComponent,
} from '@/lib/drugApi';
import {
  formatGenericDrugName,
  resolveAltDrugName,
  resolveDrugName,
} from '@/lib/drugNames';
import { drugComponentKey } from '@/lib/drugSearch';
import { activeLangCode } from '@/lib/useDrugName';
import type { DrugComponent } from '@/types';
import { Search } from 'lucide-react';

interface DrugSearchDropdownProps {
  onSelect: (drug: DrugComponent) => void | Promise<void>;
  inputId?: string;
  placeholder?: string;
  maxResults?: number;
  autoFocus?: boolean;
  className?: string;
}

export function DrugSearchDropdown({
  onSelect,
  inputId,
  placeholder,
  maxResults = 10,
  autoFocus = false,
  className = '',
}: DrugSearchDropdownProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DrugComponent[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      requestIdRef.current += 1;
      setResults([]);
      setIsLoading(false);
      setIsOpen(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setIsOpen(true);
      try {
        const { drugs } = await fetchDrugSearchResults({
          q: trimmed,
          limit: maxResults,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setResults(drugs.map(drugSearchRowToComponent));
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (requestIdRef.current !== requestId) return;
        setResults([]);
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, maxResults]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSelect = useCallback(
    async (drug: DrugComponent) => {
      await onSelect(drug);
      setQuery('');
      setResults([]);
      setIsOpen(false);
    },
    [onSelect],
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          id={inputId}
          placeholder={placeholder ?? t('drugTable.searchDrugsPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.trim() && setIsOpen(true)}
          className="h-8 text-sm pl-7 bg-card"
          autoFocus={autoFocus}
        />
      </div>
      {isOpen && (
        <div className="absolute z-[100] w-full mt-1 border rounded bg-card shadow-lg max-h-96 overflow-y-auto">
          {results.map((c) => {
            const primary = resolveDrugName(c.names, lang);
            const alt = resolveAltDrugName(c.names, primary);
            return (
              <button
                key={drugComponentKey(c)}
                type="button"
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted/50 border-b last:border-b-0"
                onClick={() => void handleSelect(c)}
              >
                <div className="font-medium">
                  {formatGenericDrugName(primary)}
                </div>
                {alt && (
                  <div className="text-muted-foreground">
                    {formatGenericDrugName(alt)}
                  </div>
                )}
              </button>
            );
          })}
          {isLoading && (
            <div className="text-xs text-muted-foreground p-2">
              {t('search.searching')}
            </div>
          )}
          {!isLoading && query.trim() && results.length === 0 && (
            <div className="text-xs text-muted-foreground p-2">
              {t('common.noDrugsFound')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
