import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ModelingChart } from "@/components/modeling/ModelingChart";
import { kinelabPredictiveToModelingSeries } from "@/lib/modelingAdapters";
import type { PosteriorPredictivePoint } from "@/lib/compute/inference";

interface Props {
  points: PosteriorPredictivePoint[];
  /** Optional observation markers to overlay (t in hours, c in mg/L). */
  observations?: Array<{ tHours: number; concentration: number }>;
  unit?: string;
  /** Optional ARIA label override. Defaults to the localized
   *  `kinelab.chart.ariaLabel` string. */
  ariaLabel?: string;
}

const HEIGHT_PX = 280;

export function PosteriorPredictiveChartPlotly({
  points,
  observations = [],
  unit = "mg/L",
  ariaLabel,
}: Props) {
  const { t } = useTranslation();
  const series = useMemo(
    () =>
      kinelabPredictiveToModelingSeries(points, {
        label: t("kinelab.result.envelope"),
        unit,
        observations: observations.map((o, idx) => ({
          ...o,
          label: t("modelingChart.observationN", { count: idx + 1 }),
        })),
      }),
    [points, observations, unit, t],
  );

  return (
    <ModelingChart
      series={series}
      options={{
        accent: "kinelab",
        ariaLabel: ariaLabel ?? t("kinelab.chart.ariaLabel"),
        emptyMessage: t("kinelab.chart.empty"),
        xAxisTitle: t("kinelab.chart.xAxis"),
        yAxisTitle: t("kinelab.chart.yAxis", { unit }),
        showUncertaintyBands: true,
        showLogToggle: true,
        height: HEIGHT_PX,
      }}
    />
  );
}
