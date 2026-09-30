import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import type { SimulatorGraphProps } from "./SimulatorGraph";

const SimulatorGraph = lazy(() =>
  import("./SimulatorGraph").then((module) => ({
    default: module.SimulatorGraph,
  })),
);

function SimulatorGraphFallback() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="h-[360px] w-full rounded-lg border border-border bg-card/60 animate-pulse" />
        <p className="text-xs text-muted-foreground italic">
          {t("modelingChart.loading")}
        </p>
      </CardContent>
    </Card>
  );
}

export type {
  LegalLimit,
  PointAnnotation,
  ReferenceRange,
  SimulatorForensicOverlay,
  SimulatorPmOverlay,
  SimulatorTimeAxis,
} from "./SimulatorGraph";

export function LazySimulatorGraph(props: SimulatorGraphProps) {
  return (
    <Suspense fallback={<SimulatorGraphFallback />}>
      <SimulatorGraph {...props} />
    </Suspense>
  );
}
