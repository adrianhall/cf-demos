import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { BlueprintPreview } = await import("./BlueprintPreview");

describe("BlueprintPreview", () => {
  it("renders the mocked canvas for well-formed graph data", () => {
    render(
      <BlueprintPreview
        graphData={JSON.stringify({ edges: [], nodes: [{ id: "a" }] })}
      />,
    );
    expect(screen.getByTestId("react-flow")).toBeInTheDocument();
  });

  it("tolerates malformed graph data by rendering an empty canvas", () => {
    render(<BlueprintPreview graphData="not json" />);
    expect(screen.getByTestId("react-flow")).toBeInTheDocument();
  });

  it("is hidden from assistive technology, since it is a purely visual thumbnail", () => {
    const { container } = render(<BlueprintPreview graphData="{}" />);
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });
});
