import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParameterBadges } from "./ParameterBadges";
import type { CitationRow } from "@/lib/referencesApi";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.n ? `${key} ${values.n}` : key,
  }),
}));

function citation(partial: Partial<CitationRow>): CitationRow {
  return {
    id: 12,
    drugId: 1,
    type: "doi",
    identifier: "10.1000/example",
    metadata: {
      title: "Reference title",
      authors: ["Smith"],
      journal: "Journal",
      year: 2026,
    },
    createdAt: "2026-05-21T00:00:00.000Z",
    ...partial,
  };
}

describe("ParameterBadges", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes tooltip citation links through the reference module", async () => {
    render(
      <ParameterBadges
        refIndices={[1]}
        references={[
          {
            index: 1,
            row: citation({ id: 77, identifier: "javascript:alert(1)" }),
          },
        ]}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("link", { name: /indicators.reference 1/ })
        .parentElement!,
    );

    const link = await screen.findByRole("link", { name: /Smith, 2026/ });
    expect(link.getAttribute("href")).toBe("/references/77");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("hides the reference tooltip after the deferred delay once the marker is left", () => {
    vi.useFakeTimers();
    render(
      <ParameterBadges
        refIndices={[1]}
        references={[
          {
            index: 1,
            row: citation({ id: 77 }),
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("link", {
      name: /indicators.reference 1/,
    }).parentElement;
    expect(trigger).toHaveClass("relative", "inline-block");

    fireEvent.mouseEnter(trigger!);
    const tooltipLink = screen.getByRole("link", { name: /Smith, 2026/ });
    const tooltip = tooltipLink.parentElement?.parentElement;
    expect(tooltip).toHaveClass("citation-tooltip-portal");

    // Leaving the marker schedules a deferred hide rather than closing
    // immediately, so the pointer can bridge the gap onto the tooltip.
    fireEvent.mouseLeave(trigger!);
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).toBeNull();
  });

  it("keeps the tooltip open when the pointer bridges onto it", () => {
    vi.useFakeTimers();
    render(
      <ParameterBadges
        refIndices={[1]}
        references={[
          {
            index: 1,
            row: citation({ id: 77 }),
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("link", {
      name: /indicators.reference 1/,
    }).parentElement;

    fireEvent.mouseEnter(trigger!);
    const tooltip = screen.getByRole("link", { name: /Smith, 2026/ })
      .parentElement?.parentElement;
    expect(tooltip).toHaveClass("citation-tooltip-portal");

    // Pointer leaves the marker but lands on the tooltip before the deferred
    // hide fires: entering the portal cancels the pending hide so the links
    // inside stay clickable.
    fireEvent.mouseLeave(trigger!);
    fireEvent.pointerEnter(tooltip!);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).not.toBeNull();
  });
});
