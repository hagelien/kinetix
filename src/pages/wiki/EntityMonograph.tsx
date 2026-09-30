import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { BioEntitySummary } from '@/lib/bioEntities';
import { EntityMetabolismDrugs } from '@/components/wiki/EntityMetabolismDrugs';

/**
 * Resolve `/wiki/entity/:slug` to the entity's monograph wiki page (#785). The
 * monograph is a normal wiki page, so once we know its slug we hand off to the
 * standard `/wiki/:slug` renderer. Mirrors how `/wiki/drug/:drugId` resolves a
 * drug to its monograph.
 *
 * An entity with no monograph yet falls back to a minimal page of its own —
 * name plus the drugs the metabolism database links to it — rather than a bare
 * "no monograph" line, so the registry's data is reachable before anyone
 * writes the article. The same linked-drug section renders inside the
 * monograph itself (see WikiPage) once one exists.
 */
export function EntityMonograph() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; monographSlug: string }
    // An entity with no monograph yet still has catalog identity and database
    // links, so the fallback view names it and lists its linked drugs instead
    // of dead-ending on a bare "no monograph" line. `entity` is null only when
    // the lookup itself failed (unknown slug, network error).
    | { status: 'missing'; entity: BioEntitySummary | null }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // Drop the previous slug's result before resolving a new one: client-side
    // navigation reuses this component, and a stale `missing` state would keep
    // rendering the old entity's name and linked drugs under the new URL.
    setState({ status: 'loading' });
    async function resolve() {
      try {
        const res = await fetch(
          `/api/bio-entities?slug=${encodeURIComponent(slug ?? '')}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          entity: BioEntitySummary;
          monographSlug: string | null;
        };
        if (cancelled) return;
        setState(
          data.monographSlug
            ? { status: 'ready', monographSlug: data.monographSlug }
            : { status: 'missing', entity: data.entity ?? null },
        );
      } catch {
        if (!cancelled) setState({ status: 'missing', entity: null });
      }
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.status === 'ready') {
    return <Navigate to={`/wiki/${state.monographSlug}`} replace />;
  }
  if (state.status === 'loading') {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const entity = state.entity;
  return (
    <div className="p-6">
      {entity && (
        <div className="mb-2">
          <h1 className="text-3xl font-bold">{entity.symbol}</h1>
          <p className="text-sm text-muted-foreground">
            {entity.name}
            {entity.nameEn && entity.nameEn !== entity.name
              ? ` · ${entity.nameEn}`
              : ''}
          </p>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {t('bioEntity.monographMissing')}
      </p>
      {entity && <EntityMetabolismDrugs entityId={entity.id} />}
    </div>
  );
}
