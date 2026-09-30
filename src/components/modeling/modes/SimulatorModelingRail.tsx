import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { DrugPanel } from '@/components/simulator/DrugPanel';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import type { DrugComponent } from '@/types';
import type {
  DrugSimConfig,
  CaseDisplaySettings,
  DistributionSpec,
} from '@/types/simulator';

interface SimulatorModelingRailProps {
  showSettings: boolean;
  displaySettings: CaseDisplaySettings;
  setDisplaySettings: (settings: Partial<CaseDisplaySettings>) => void;
  drugs: DrugSimConfig[];
  drugComponentMap: Map<string, DrugComponent>;
  getResolvedDistributions: (config: DrugSimConfig) =>
    | {
        halfLife: DistributionSpec;
        vd: DistributionSpec;
        f: DistributionSpec;
      }
    | undefined;
  showSearch: boolean;
  setShowSearch: (show: boolean) => void;
  onAddDrug: (component: DrugComponent) => void | Promise<void>;
  selectedMarkerId?: string | null;
}

export function SimulatorModelingRail({
  showSettings,
  displaySettings,
  setDisplaySettings,
  drugs,
  drugComponentMap,
  getResolvedDistributions,
  showSearch,
  setShowSearch,
  onAddDrug,
  selectedMarkerId,
}: SimulatorModelingRailProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {showSettings && (
        <div className="flex items-center gap-4 flex-wrap text-xs border border-border rounded-lg p-3 bg-card">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t('modeling.workspace.simulator.uncertainty')}
            </span>
            <Switch
              checked={displaySettings.showUncertaintyBands}
              onCheckedChange={(checked) =>
                setDisplaySettings({ showUncertaintyBands: checked })
              }
            />
          </label>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground mr-1">
              {t('modeling.workspace.simulator.normalize')}
            </span>
            {(['none', 'peak', 'initial_point'] as const).map((mode) => (
              <Button
                key={mode}
                variant={
                  displaySettings.normalizeMode === mode ? 'default' : 'outline'
                }
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setDisplaySettings({ normalizeMode: mode })}
              >
                {mode === 'none'
                  ? t('modeling.workspace.simulator.off')
                  : mode === 'peak'
                    ? t('modeling.workspace.simulator.peak')
                    : t('modeling.workspace.simulator.c0')}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground mr-1">
              {t('modeling.workspace.simulator.time')}
            </span>
            {(['clock', 'hours'] as const).map((fmt) => (
              <Button
                key={fmt}
                variant={
                  displaySettings.timeFormat === fmt ? 'default' : 'outline'
                }
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setDisplaySettings({ timeFormat: fmt })}
              >
                {fmt === 'clock'
                  ? t('modeling.workspace.simulator.clockFormat')
                  : t('modeling.workspace.simulator.hours')}
              </Button>
            ))}
            {displaySettings.timeFormat === 'clock' && (
              <Input
                type="text"
                placeholder={t('modeling.workspace.simulator.refTime')}
                value={displaySettings.referenceTime}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setDisplaySettings({ referenceTime: e.target.value })
                }
                className="h-6 text-xs bg-card w-24 ml-1"
              />
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {drugs.map((config) => {
          const component = drugComponentMap.get(config.drugId);
          return (
            <DrugPanel
              key={config.id}
              config={config}
              drugComponent={component}
              resolvedDistributions={getResolvedDistributions(config)}
              timeFormat={displaySettings.timeFormat}
              referenceTime={displaySettings.referenceTime}
              selectedMarkerId={selectedMarkerId}
            />
          );
        })}
      </div>

      {showSearch ? (
        <div className="border border-dashed border-border rounded-lg p-4 bg-card/50">
          <p className="text-xs text-muted-foreground mb-2">
            {drugs.length === 0
              ? t('modeling.workspace.simulator.searchToStart')
              : t('modeling.workspace.simulator.addAnother')}
          </p>
          <DrugSearchDropdown
            onSelect={onAddDrug}
            autoFocus={drugs.length === 0}
            maxResults={10}
            placeholder={t('modeling.workspace.simulator.searchDrugs')}
          />
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowSearch(true)}
          className="w-full border-dashed"
        >
          {t('modeling.workspace.simulator.addDrug')}
        </Button>
      )}
    </div>
  );
}
