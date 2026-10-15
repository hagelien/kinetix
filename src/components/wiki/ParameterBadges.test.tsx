import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ParameterBadges } from "./ParameterBadges";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ParameterBadges", () => {
  it("warns when the parameter has no reference attached", () => {
    render(<ParameterBadges refCount={0} />);
    expect(screen.getByTitle("indicators.noReference")).toBeInTheDocument();
  });

  it("renders nothing for a referenced parameter without comments", () => {
    const { container } = render(<ParameterBadges refCount={2} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the discussion from the comment count", () => {
    const onCommentClick = vi.fn();
    render(
      <ParameterBadges
        refCount={1}
        commentCount={3}
        onCommentClick={onCommentClick}
      />,
    );
    fireEvent.click(screen.getByTitle("indicators.comments"));
    expect(onCommentClick).toHaveBeenCalledOnce();
  });
});
