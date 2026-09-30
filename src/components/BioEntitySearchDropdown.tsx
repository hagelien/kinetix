import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { searchBioEntities } from '@/lib/bioEntitiesApi';
import type { BioEntityFunction, BioEntitySummary } from '@/lib/bioEntities';
import { activeLangCode } from '@/lib/useDrugName';
import { Search } from 'lucide-react';

interface BioEntitySearchDropdownProps {
  onSelect: (entity: BioEntitySummary) => void | Promise<void>;
  /** Restrict the catalog to entities that play this function. */
  function?: BioEntityFunction;
  /** Exclude these entity ids from the results (e.g. the entity being edited). */
  excludeIds?: ReadonlyArray<number>;
  placeholder?: string;
  maxResults?: number;
  className?: string;
}

/**
 * Typeahead over the unified biological-entity catalog (#785). Generalizes the
 * old enzyme-only dropdown: pass `function` to scope it (e.g. `metabolic_enzyme`
 * for the metabolism editor, `drug_target` for the PD editor, or omit it for
 * the registry admin). A blank focus shows the first N entities.
 */
export function BioEntitySearchDropdown({
  onSelect,
  function: fn,
  excludeIds,
  placeholder,
  maxResults = 10,
  className = '',
}: BioEntitySearchDropdownProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BioEntitySummary[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const entities = await searchBioEntities(trimmed, {
          function: fn,
          limit: maxResults,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setResults(entities);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (requestIdRef.current !== requestId) return;
        setResults([]);
      } finally {
        if (requestIdRef.current === requestId) setIsLoading(false);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, maxResults, isOpen, fn]);

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
    async (entity: BioEntitySummary) => {
      await onSelect(entity);
      setQuery('');
      setResults([]);
      setIsOpen(false);
    },
    [onSelect],
  );

  const excluded = new Set(excludeIds ?? []);
  const visible = results.filter((e) => !excluded.has(e.id));

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={placeholder ?? t('bioEntity.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          className="h-8 text-sm pl-7 bg-card"
        />
      </div>
      {isOpen && (
        <div className="absolute z-[100] w-full mt-1 border rounded bg-card shadow-lg max-h-72 overflow-y-auto">
          {visible.map((e) => {
            const name = lang === 'en' ? (e.nameEn ?? e.name) : e.name;
            return (
              <button
                key={e.id}
                type="button"
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted/50 border-b last:border-b-0"
                onClick={() => void handleSelect(e)}
              >
                <div className="font-medium">
                  {e.symbol}
                  {e.entityClass && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {e.entityClass}
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground">{name}</div>
              </button>
            );
          })}
          {isLoading && (
            <div className="text-xs text-muted-foreground p-2">
              {t('search.searching')}
            </div>
          )}
          {!isLoading && visible.length === 0 && (
            <div className="text-xs text-muted-foreground p-2">
              {t('bioEntity.noneFound')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
