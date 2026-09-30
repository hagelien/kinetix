import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fetchEntityMetabolismDrugs } from '@/lib/bioEntitiesApi';
import { capitalizeGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { formatFractionRangePercent } from '@/lib/metabolism';
import type { EntityMetabolismDrug } from '@/lib/metabolism';

interface EntityMetabolismDrugsProps {
  entityId: number;
}

/**
 * The reverse of a drug monograph's metabolism box: on a bio entity's page,
 * list every component the metabolism database routes through this entity
 * (`drug_elimination_routes.bio_entity_id`), with the dose share when known.
 *
 * Collapsed by default — an entity like CYP3A4 links to a long tail of drugs
 * that would otherwise bury the monograph prose. The count is visible while
 * collapsed so the reader knows what expanding costs. Renders nothing when the
 * entity has no linked drugs (or the lookup fails), so entities that are pure
 * drug targets don't grow an empty section.
 */
export function EntityMetabolismDrugs({ entityId }: EntityMetabolismDrugsProps) {
  const { t, i18n } = useTranslation();
  const [drugs, setDrugs] = useState<EntityMetabolismDrug[]>([]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setDrugs([]);
    fetchEntityMetabolismDrugs(entityId, controller.signal)
      .then((rows) => setDrugs(rows))
      .catch(() => {
        // A failed lookup collapses to "no linked drugs" rather than an error
        // banner: this section is supplementary to the monograph itself.
        if (!controller.signal.aborted) setDrugs([]);
      });
    return () => controller.abort();
  }, [entityId]);

  if (drugs.length === 0) return null;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2>
        <button
          type="button"
          className="flex items-center gap-1.5 text-lg font-semibold hover:text-primary"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          {t('bioEntity.metabolismDrugsHeading')}
          <span className="text-sm font-normal text-muted-foreground">
            ({drugs.length})
          </span>
        </button>
      </h2>
      {expanded && (
        <ul id={listId} className="mt-3 space-y-1">
          {drugs.map((row) => {
            const name =
              capitalizeGenericDrugName(
                resolveDrugName(row.drug.names, i18n.language),
              ) || row.drug.slug;
            const fraction = formatFractionRangePercent(row.fraction);
            return (
              <li
                key={row.routeId}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <Link
                  to={`/wiki/drug/${row.drug.id}`}
                  className="text-primary hover:underline"
                >
                  {name}
                </Link>
                {fraction && (
                  <span className="text-xs text-muted-foreground">
                    {fraction}
                  </span>
                )}
                {row.note && (
                  <span className="w-full text-xs text-muted-foreground">
                    {row.note}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
