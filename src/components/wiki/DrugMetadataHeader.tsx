import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/usePermissions';
import {
  DRUG_PARAMETERS,
  METADATA_PARAMETER_IDS,
  getParameterLabelKey,
  type DrugParameterId,
} from '@/lib/drugParameters';
import { readDrugMetadataValue } from '@/lib/drugNames';
import { farmakologiportalenUrl } from '@/lib/farmakologiportalen';
import { ParameterEditForm } from './ParameterEditForm';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import { useDrugSidebarData } from './useDrugSidebarData';

interface DrugMetadataHeaderProps {
  drugCid: number;
}

type DialogKind = 'edit' | 'history';
// Names/short-name/aliases are shown to every contributor. molecularWeight
// lives in the chemistry sidebar group, and pubchemCid is admin-only (it's a
// load-bearing external identifier) so it's appended to the list further down
// only when the viewer is an admin.
const HEADER_METADATA_PARAMETER_IDS = METADATA_PARAMETER_IDS.filter(
  (pid) => pid !== 'molecularWeight' && pid !== 'pubchemCid',
);

/**
 * Inline strip of editable drug identifiers (names, shortname, aliases,
 * molecular weight, PubChem CID) shown directly under the monograph title,
 * followed by the outbound link to this substance on Farmakologiportalen.
 * Pulled out of the PK sidebar so that the sidebar is reserved for actual
 * pharmacokinetic values.
 */
export function DrugMetadataHeader({ drugCid }: DrugMetadataHeaderProps) {
  const { t } = useTranslation();
  // Every edit control here opens ParameterEditForm, which posts to
  // /api/drug-parameter — so they follow that endpoint's capability rather
  // than mere authentication.
  const canEdit = useCan('edit.parameter.submit');
  // pubchemCid is drug metadata on top of that, so surfacing its row needs
  // both: the metadata permission to see it and the parameter permission to
  // save it. Everyone else sees the standard name/alias metadata only.
  const mayEditDrugMetadata = useCan('drug.update');
  const isAdmin = mayEditDrugMetadata && canEdit;

  const headerParameterIds = isAdmin
    ? [...HEADER_METADATA_PARAMETER_IDS, 'pubchemCid' as DrugParameterId]
    : HEADER_METADATA_PARAMETER_IDS;

  const { drug, pendingCounts, ownPendingParams, reload } =
    useDrugSidebarData(drugCid);
  // Outbound link to this substance's page on Farmakologiportalen. Unlike the
  // PubChem CID it is not an editable parameter — it is a matched address
  // written by the importer/backfill — so it renders as a plain trailing item
  // in the same strip rather than a row with edit/history controls. It is also
  // shown to every reader: the PubChem row is admin-only because the CID is a
  // load-bearing identifier they can change, while this is just a reference a
  // reader wants to follow.
  const portalUrl = farmakologiportalenUrl(drug?.farmakologiportalenPath);
  const [dialog, setDialog] = useState<{
    kind: DialogKind;
    parameter: DrugParameterId;
  } | null>(null);

  if (!drug) return null;

  return (
    <div className="mt-2 mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {headerParameterIds.map((pid) => {
        const spec = DRUG_PARAMETERS[pid];
        const value = readDrugMetadataValue(
          drug as unknown as Record<string, unknown>,
          pid,
        );
        const formatted = spec.format(value);
        // The PubChem CID is an external identifier — link it straight to the
        // compound's page on PubChem so it's one click to the source record.
        const pubchemUrl =
          pid === 'pubchemCid' && value != null && String(value).trim() !== ''
            ? `https://pubchem.ncbi.nlm.nih.gov/compound/${encodeURIComponent(
                String(value).trim(),
              )}`
            : null;

        return (
          <div key={pid} className="group inline-flex items-center gap-1">
            <span>
              <span className="font-medium text-foreground/80">
                {t(getParameterLabelKey(pid), { defaultValue: spec.label })}:
              </span>{' '}
              {pubchemUrl ? (
                <a
                  href={pubchemUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {formatted || '—'}
                </a>
              ) : (
                <span>{formatted || '—'}</span>
              )}
            </span>
            <span className="inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ kind: 'edit', parameter: pid })}
                  className="h-4 w-4 p-0"
                  title={t('sidebar.editParam')}
                >
                  <Edit2 className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDialog({ kind: 'history', parameter: pid })}
                className="h-4 w-4 p-0"
                title={t('sidebar.historyParam')}
              >
                <History className="h-3 w-3" />
              </Button>
            </span>
            {pendingCounts[pid] ? (
              <span className="text-[10px] text-accent">
                {ownPendingParams.has(pid)
                  ? t('sidebar.yourSuggestion')
                  : t('sidebar.pendingCount', { count: pendingCounts[pid] })}
              </span>
            ) : null}
          </div>
        );
      })}

      {portalUrl ? (
        <div className="inline-flex items-center gap-1">
          <span>
            <span className="font-medium text-foreground/80">
              {t('sidebar.farmakologiportalen')}:
            </span>{' '}
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              {t('sidebar.farmakologiportalenMonograph')}
            </a>
          </span>
        </div>
      ) : null}

      {dialog?.kind === 'edit' && canEdit && (
        <ParameterEditForm
          drugId={drug.id}
          parameter={dialog.parameter}
          currentValue={readDrugMetadataValue(
            drug as unknown as Record<string, unknown>,
            dialog.parameter,
          )}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <ParameterHistoryDialog
          drugId={drug.id}
          parameter={dialog.parameter}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
