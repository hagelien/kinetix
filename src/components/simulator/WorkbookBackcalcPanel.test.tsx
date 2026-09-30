import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkbookBackcalcPanel } from "./WorkbookBackcalcPanel";
import type { EtohParityInput } from "@/lib/etohWorkbookFlows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "nb" },
  }),
}));

const baseInput: EtohParityInput = {
  drinkStopTime: 0.5,
  eventTime: 0.7916666667,
  sampleTime: 0.8333333333,
  detectedPromille: 0.84,
  eliminationMin: 0.1,
  eliminationLikely: 0.15,
  absorptionMinHours: 3,
  absorptionLikelyHours: 1,
  drinksMl: [330, 0, 0, 0, 0, 0],
  drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
  firstPassMinPercent: 15,
  firstPassLikelyPercent: 25,
  weightKg: 78,
  widmarkR: 0.7,
  sexMale01: 1,
  heightCm: 182,
  ageYears: 35,
};

describe("WorkbookBackcalcPanel", () => {
  it("renders the v3 high-tier outputs (Phase D2)", () => {
    render(
      <WorkbookBackcalcPanel
        inputs={baseInput}
        onChange={vi.fn()}
        onChangeDrink={vi.fn()}
      />,
    );

    // High-tier Widmark labels surfaced in Phase D2 — assert on the i18n keys
    // since `useTranslation` is mocked to identity for tests.
    expect(screen.getByText("ethanol.workbookPanel.backcalcHigh")).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.afterIntakeMin"),
    ).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.backcalcMinusIntakeHigh"),
    ).toBeTruthy();

    // Watson siblings.
    expect(
      screen.getByText("ethanol.workbookPanel.afterIntakeMinWattson"),
    ).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.backcalcMinusIntakeHighWattson"),
    ).toBeTruthy();

    // Existing rows still present (regression guard).
    expect(screen.getByText("ethanol.workbookPanel.backcalcMin")).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.backcalcLikely"),
    ).toBeTruthy();
    expect(screen.getByText("ethanol.workbookPanel.wattsonR")).toBeTruthy();
  });

  it("renders the v3 BMI block from workbook weight and height", () => {
    render(
      <WorkbookBackcalcPanel
        inputs={baseInput}
        onChange={vi.fn()}
        onChangeDrink={vi.fn()}
      />,
    );

    expect(screen.getByText("ethanol.workbookPanel.bmi")).toBeTruthy();
    expect(screen.getByText("23,5")).toBeTruthy();
    expect(screen.getByText("ethanol.workbookPanel.bmiCategory")).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.bmiCategories.normalWeight"),
    ).toBeTruthy();
  });

  it("renders the v3 two-sample warning when promille is not falling", () => {
    render(
      <WorkbookBackcalcPanel
        inputs={{
          ...baseInput,
          secondSampleTime: 0.875,
          secondSamplePromille: 0.9,
        }}
        onChange={vi.fn()}
        onChangeDrink={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workbook-second-sample")).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.secondSampleFalling"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "ethanol.workbookPanel.warnings.notFallingBetweenSamples",
      ),
    ).toBeTruthy();
  });

  it("renders the v3 workbook conclusion text", () => {
    render(
      <WorkbookBackcalcPanel
        inputs={baseInput}
        onChange={vi.fn()}
        onChangeDrink={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workbook-conclusion")).toBeTruthy();
    expect(
      screen.getByText("ethanol.workbookPanel.conclusionAfterIntake"),
    ).toBeTruthy();
  });
});
