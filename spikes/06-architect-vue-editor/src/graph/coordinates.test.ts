import { describe, expect, it } from "vitest";
import { graphToScreen, screenToGraph } from "./coordinates";

describe("remote cursor coordinate conversion", () => {
  it("maps the same graph point under distinct pan and zoom viewports", () => {
    const graphPoint = { x: 420, y: 250 };
    const firstViewport = { x: 40, y: -20, zoom: 1 };
    const secondViewport = { x: -300, y: 180, zoom: 1.75 };
    expect(screenToGraph(graphToScreen(graphPoint, firstViewport), firstViewport)).toEqual(graphPoint);
    expect(screenToGraph(graphToScreen(graphPoint, secondViewport), secondViewport)).toEqual(graphPoint);
    expect(graphToScreen(graphPoint, firstViewport)).not.toEqual(graphToScreen(graphPoint, secondViewport));
  });
});
