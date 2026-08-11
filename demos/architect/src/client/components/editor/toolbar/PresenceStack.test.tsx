import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PresenceStack } from "./PresenceStack";

describe("PresenceStack", () => {
  it("renders nothing when there are no participants", () => {
    const { container } = render(<PresenceStack participants={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one avatar per participant, each with an accessible name (the full email)", () => {
    render(
      <PresenceStack
        participants={{
          "alice@example.com": {
            color: "#111111",
            displayName: null,
            email: "alice@example.com",
          },
          "bob@example.com": {
            color: "#222222",
            displayName: null,
            email: "bob@example.com",
          },
        }}
      />,
    );

    expect(
      screen.getByRole("list", { name: "Currently viewing" }),
    ).toBeInTheDocument();
    const aliceAvatar = screen.getByRole("img", {
      name: "alice@example.com",
    });
    const bobAvatar = screen.getByRole("img", { name: "bob@example.com" });
    expect(aliceAvatar).toHaveTextContent("A");
    expect(bobAvatar).toHaveTextContent("B");
  });

  it("colors each avatar with that identity's own server-assigned color", () => {
    render(
      <PresenceStack
        participants={{
          "carol@example.com": {
            color: "#abcdef",
            displayName: null,
            email: "carol@example.com",
          },
        }}
      />,
    );

    const avatar = screen.getByRole("img", { name: "carol@example.com" });
    expect(avatar).toHaveStyle({ backgroundColor: "rgb(171, 205, 239)" });
  });

  it("falls back to '?' for a pathological empty-string email", () => {
    render(
      <PresenceStack
        participants={{
          "": { color: "#333333", displayName: null, email: "" },
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "" })).toHaveTextContent("?");
  });
});
