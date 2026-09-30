import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelingWorkspace } from '@/components/modeling/ModelingWorkspace';

const SimulatorBody = lazy(() =>
  import('./SimulatorPage').then((m) => ({ default: m.SimulatorPage })),
);

function BodyFallback() {
  const { t } = useTranslation();
  return (
    <div className="px-6 py-12 text-center text-sm text-muted-foreground">
      {t('modeling.loading')}
    </div>
  );
}

export function ModelingPage() {
  return (
    <ModelingWorkspace>
      <Suspense fallback={<BodyFallback />}>
        <SimulatorBody />
      </Suspense>
    </ModelingWorkspace>
  );
}
