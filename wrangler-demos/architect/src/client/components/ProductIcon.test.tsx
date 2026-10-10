import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductIcon } from "./ProductIcon";

describe("ProductIcon", () => {
  it("renders a vendored SVG icon inline, recolored via the wrapper's style", () => {
    const { container } = render(
      <ProductIcon icon={{ kind: "svg", name: "workers" }} color="#3B82F6" />,
    );
    const wrapper = container.querySelector(
      ".product-icon--svg",
    ) as HTMLElement;
    expect(wrapper).toBeInTheDocument();
    expect(wrapper.style.color).toBe("rgb(59, 130, 246)");
    expect(wrapper.querySelector("svg")).toBeInTheDocument();
  });

  it("applies the default size when none is given", () => {
    const { container } = render(
      <ProductIcon icon={{ kind: "svg", name: "workers" }} />,
    );
    const wrapper = container.querySelector(
      ".product-icon--svg",
    ) as HTMLElement;
    expect(wrapper.style.width).toBe("24px");
    expect(wrapper.style.height).toBe("24px");
  });

  it("renders nothing for an svg icon name with no vendored asset", () => {
    const { container } = render(
      <ProductIcon icon={{ kind: "svg", name: "does-not-exist" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a react-feather icon for the external/generic category", () => {
    const { container } = render(
      <ProductIcon icon={{ kind: "feather", name: "Globe" }} size={20} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders nothing for a feather icon name that does not exist", () => {
    const { container } = render(
      <ProductIcon icon={{ kind: "feather", name: "NotARealIcon" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("forwards className to both icon kinds", () => {
    const { container: svgContainer } = render(
      <ProductIcon
        icon={{ kind: "svg", name: "workers" }}
        className="cf-node__icon"
      />,
    );
    expect(svgContainer.querySelector(".product-icon--svg")).toHaveClass(
      "cf-node__icon",
    );

    const { container: featherContainer } = render(
      <ProductIcon
        icon={{ kind: "feather", name: "Globe" }}
        className="cf-node__icon"
      />,
    );
    expect(featherContainer.querySelector("svg")).toHaveClass("cf-node__icon");
  });
});
