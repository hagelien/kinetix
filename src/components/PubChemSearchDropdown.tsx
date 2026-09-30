import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

export interface PubChemCompound {
  cid: number;
  name: string;
  molecularWeight: number | null;
  molecularFormula: string | null;
}

interface PubChemSearchDropdownProps {
  query: string;
  onSelect: (compound: PubChemCompound) => void;
  className?: string;
}

export function PubChemSearchDropdown({
  query,
  onSelect,
  className = '',
}: PubChemSearchDropdownProps) {
  const { t } = useTranslation();
  const [results, setResults] = useState<PubChemCompound[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setIsOpen(false);
      setSearched(false);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setSearched(true);
      try {
        const res = await fetch(
          `/api/pubchem-search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setResults([]);
          setIsOpen(false);
          return;
        }
        const data = await res.json();
        const items: PubChemCompound[] = data.results ?? [];
        setResults(items);
        setIsOpen(items.length > 0 || true); // Show "no results" too
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setResults([]);
          setIsOpen(false);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSelect = useCallback(
    (compound: PubChemCompound) => {
      onSelect(compound);
      setIsOpen(false);
    },
    [onSelect],
  );

  if (!isOpen && !loading) return null;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {loading && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('pubchemSearch.searching')}
        </div>
      )}
      {!loading && isOpen && (
        <div className="absolute z-[100] w-full mt-1 border rounded bg-card shadow-lg max-h-56 overflow-y-auto">
          {results.length > 0 ? (
            results.map((c) => (
              <button
                key={c.cid}
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted/50 border-b last:border-b-0"
                onClick={() => handleSelect(c)}
              >
                <div className="font-medium">{c.name}</div>
                <div className="text-muted-foreground flex gap-2">
                  <span>CID: {c.cid}</span>
                  {c.molecularWeight != null && (
                    <span>MW: {c.molecularWeight.toFixed(2)} g/mol</span>
                  )}
                  {c.molecularFormula && <span>{c.molecularFormula}</span>}
                </div>
              </button>
            ))
          ) : (
            searched && (
              <div className="text-xs text-muted-foreground p-2">
                {t('pubchemSearch.noResults')}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
