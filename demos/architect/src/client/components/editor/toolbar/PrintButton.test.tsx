import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDiagramStore } from "../../../stores/diagramStore";
import { PrintButton } from "./PrintButton";

describe("PrintButton", () => {
  beforeEach(() => {
    useDiagramStore.setState({ printMode: false });
  });

  it("enters print mode when clicked", () => {
    render(<PrintButton />);

    fireEvent.click(screen.getByTitle("Print"));

    expect(useDiagramStore.getState().printMode).toBe(true);
  });
});
