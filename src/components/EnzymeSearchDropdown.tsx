import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { fetchEnzymeSearch } from '@/lib/drugApi';
import { isEnzymeGroupRank, type MetabolismEnzyme } from '@/lib/metabolism';
import { activeLangCode } from '@/lib/useDrugName';
import { Search } from 'lucide-react';

interface EnzymeSearchDropdownProps {
  onSelect: (enzyme: MetabolismEnzyme) => void | Promise<void>;
  placeholder?: string;
  maxResults?: number;
  className?: string;
}

// Typeahead over the canonical enzyme catalog. A blank focus shows common
// enzymes (the API returns the first N when the query is empty).
export function EnzymeSearchDropdown({
  onSelect,
  placeholder,
  maxResults = 10,
  className = '',
}: EnzymeSearchDropdownProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MetabolismEnzyme[]>([]);
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
        const { enzymes } = await fetchEnzymeSearch({
          q: trimmed,
          limit: maxResults,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (requestIdRef.current !== requestId) return;
        setResults(enzymes);
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
  }, [query, maxResults, isOpen]);

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
    async (enzyme: MetabolismEnzyme) => {
      await onSelect(enzyme);
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
          placeholder={placeholder ?? t('metabolismEdit.searchEnzymePlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          className="h-8 text-sm pl-7 bg-card"
        />
      </div>
      {isOpen && (
        <div className="absolute z-[100] w-full mt-1 border rounded bg-card shadow-lg max-h-72 overflow-y-auto">
          {results.map((e) => {
            const name = lang === 'en' ? (e.nameEn ?? e.name) : e.name;
            const isGroup = isEnzymeGroupRank(e.rank);
            return (
              <button
                key={e.id}
                type="button"
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted/50 border-b last:border-b-0"
                onClick={() => void handleSelect(e)}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{e.symbol}</span>
                  {isGroup && e.rank ? (
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t(`enzymeRank.${e.rank}`)}
                    </span>
                  ) : null}
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
          {!isLoading && results.length === 0 && (
            <div className="text-xs text-muted-foreground p-2">
              {t('metabolismEdit.noEnzymesFound')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
