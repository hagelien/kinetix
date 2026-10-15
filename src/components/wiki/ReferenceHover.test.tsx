import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceHover } from "./ReferenceHover";
import type { CitationRow } from "@/lib/referencesApi";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.n
        ? `${key} ${values.n}`
        : values?.from
          ? `${key} ${values.from}-${values.to}`
          : key,
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

function renderValue(rows = [{ index: 1, row: citation({ id: 77 }) }]) {
  render(<ReferenceHover references={rows}>2.5 h</ReferenceHover>);
  return screen.getByTestId("reference-hover");
}

describe("ReferenceHover", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cites through the value itself, with no superscript [n] markers", () => {
    const { container } = render(
      <ReferenceHover
        references={[
          { index: 3, row: citation({ id: 77 }) },
          { index: 4, row: citation({ id: 78 }) },
        ]}
      >
        2.5 h
      </ReferenceHover>,
    );

    expect(container.querySelector("sup")).toBeNull();
    expect(screen.queryByText(/\[3/)).toBeNull();
    // The bibliography numbers stay available to assistive technology.
    const value = screen.getByTestId("reference-hover");
    expect(value).toHaveAttribute("tabindex", "0");
    expect(value).toHaveTextContent("2.5 h");
    expect(value).toHaveTextContent("indicators.referenceRange 3-4");
  });

  it("renders the value untouched when it has no references", () => {
    const { container } = render(
      <ReferenceHover references={[]}>2.5 h</ReferenceHover>,
    );
    expect(screen.queryByTestId("reference-hover")).toBeNull();
    expect(container).toHaveTextContent("2.5 h");
  });

  it("routes panel citation links through the reference module", async () => {
    const value = renderValue([
      { index: 1, row: citation({ id: 77, identifier: "javascript:alert(1)" }) },
    ]);

    fireEvent.mouseEnter(value);

    const link = await screen.findByRole("link", { name: /\[1\] Smith, 2026/ });
    expect(link.getAttribute("href")).toBe("/references/77");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("opens the panel on keyboard focus", () => {
    const value = renderValue();
    fireEvent.focus(value);
    expect(screen.getByRole("link", { name: /Smith, 2026/ })).not.toBeNull();
  });

  it("hides the panel after the deferred delay once the value is left", () => {
    vi.useFakeTimers();
    const value = renderValue();

    fireEvent.mouseEnter(value);
    const tooltip = screen.getByRole("link", { name: /Smith, 2026/ })
      .parentElement?.parentElement;
    expect(tooltip).toHaveClass("citation-tooltip-portal");

    // Leaving the value schedules a deferred hide rather than closing
    // immediately, so the pointer can bridge the gap onto the panel.
    fireEvent.mouseLeave(value);
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).toBeNull();
  });

  it("keeps the panel open when the pointer bridges onto it", () => {
    vi.useFakeTimers();
    const value = renderValue();

    fireEvent.mouseEnter(value);
    const tooltip = screen.getByRole("link", { name: /Smith, 2026/ })
      .parentElement?.parentElement;

    // Pointer leaves the value but lands on the panel before the deferred
    // hide fires: entering the portal cancels the pending hide so the links
    // inside stay clickable.
    fireEvent.mouseLeave(value);
    fireEvent.pointerEnter(tooltip!);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).not.toBeNull();
  });
  // Review P1: the panel is portalled to the end of <body>, so its links are
  // not next in the value's tab order. Focus moving from the value into the
  // panel used to let the value's blur close it 150 ms later, leaving keyboard
  // users no route to the references.
  it("keeps the panel open while keyboard focus is on a link inside it", () => {
    vi.useFakeTimers();
    const value = renderValue();

    act(() => value.focus());
    const link = screen.getByRole("link", { name: /Smith, 2026/ });
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).not.toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it("moves keyboard focus from the value into the panel", () => {
    const value = renderValue([
      { index: 1, row: citation({ id: 77 }) },
      { index: 2, row: citation({ id: 78, metadata: null, identifier: "Jones 2019", type: "freetext" }) },
    ]);
    expect(value).toHaveAttribute("role", "button");

    act(() => value.focus());
    expect(value).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(value, { key: "Enter" });

    const links = screen.getAllByRole("link");
    expect(document.activeElement).toBe(links[0]);
    expect(links[0]?.getAttribute("href")).toBe("/references/77");
  });

  it("reopens a closed panel and enters it on Enter", () => {
    const value = renderValue();
    act(() => value.focus());
    fireEvent.keyDown(value, { key: "Escape" });
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).toBeNull();

    fireEvent.keyDown(value, { key: "Enter" });
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: /Smith, 2026/ }),
    );
  });

  it("returns focus to the value, closed, on Tab past the last link or Escape", () => {
    const value = renderValue();

    act(() => value.focus());
    fireEvent.keyDown(value, { key: "ArrowDown" });
    const link = screen.getByRole("link", { name: /Smith, 2026/ });
    expect(document.activeElement).toBe(link);

    fireEvent.keyDown(link, { key: "Tab" });
    expect(document.activeElement).toBe(value);
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).toBeNull();
    expect(value).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(value, { key: "Enter" });
    const reopened = screen.getByRole("link", { name: /Smith, 2026/ });
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(document.activeElement).toBe(value);
    expect(screen.queryByRole("link", { name: /Smith, 2026/ })).toBeNull();
  });
});
