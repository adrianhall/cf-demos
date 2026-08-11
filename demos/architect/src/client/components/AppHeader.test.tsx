import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IdentityState } from "../hooks/useIdentity";
import {
  AppHeader,
  type AppHeaderAccess,
  type AppHeaderPage,
} from "./AppHeader";

/** Identity state for a request still in flight. */
const loading: IdentityState = {
  email: null,
  error: null,
  isAdmin: false,
  loading: true,
};

/** Identity state for a signed-in, non-administrator visitor. */
const member: IdentityState = {
  email: "member@example.com",
  error: null,
  isAdmin: false,
  loading: false,
};

/** Identity state for a signed-in administrator. */
const admin: IdentityState = {
  email: "admin@example.com",
  error: null,
  isAdmin: true,
  loading: false,
};

/** Identity state after `GET /api/me` failed. */
const failed: IdentityState = {
  email: null,
  error: "Access expired.",
  isAdmin: false,
  loading: false,
};

/** Render the header with sensible defaults for the props under test. */
function renderHeader({
  identity = member,
  current = "dashboard",
  access = "authenticated",
}: {
  identity?: IdentityState;
  current?: AppHeaderPage;
  access?: AppHeaderAccess;
} = {}) {
  return render(
    <AppHeader identity={identity} current={current} access={access} />,
  );
}

describe("AppHeader", () => {
  describe("brand", () => {
    it("renders the brand as a chrome link rather than an underlined body-text link (Bug 34)", () => {
      renderHeader();

      const brand = screen.getByRole("link", { name: "Architect" });
      expect(brand).toHaveClass("nav-link");
      expect(brand).toHaveClass("app-shell__name");
    });

    it("points the brand at the diagram list on the authenticated subtree", () => {
      renderHeader({ access: "authenticated", current: "admin" });

      expect(screen.getByRole("link", { name: "Architect" })).toHaveAttribute(
        "href",
        "/app",
      );
    });

    it("points the brand at the diagram list on a public page for a signed-in visitor", () => {
      renderHeader({ access: "public", current: "blueprints" });

      expect(screen.getByRole("link", { name: "Architect" })).toHaveAttribute(
        "href",
        "/app",
      );
    });

    it("points the brand at the home page on a public page for an anonymous visitor", () => {
      renderHeader({
        access: "public",
        current: "blueprints",
        identity: failed,
      });

      expect(screen.getByRole("link", { name: "Architect" })).toHaveAttribute(
        "href",
        "/",
      );
    });

    it("keeps the brand pointed at the diagram list while identity is still loading on the authenticated subtree", () => {
      renderHeader({ access: "authenticated", identity: loading });

      expect(screen.getByRole("link", { name: "Architect" })).toHaveAttribute(
        "href",
        "/app",
      );
    });
  });

  describe("nav links", () => {
    it("omits 'My Diagrams' on the dashboard, which is the page it would link to", () => {
      renderHeader({ current: "dashboard" });

      expect(
        screen.queryByRole("link", { name: "My Diagrams" }),
      ).not.toBeInTheDocument();
    });

    it("renders 'My Diagrams' on the admin page", () => {
      renderHeader({ current: "admin", identity: admin });

      expect(screen.getByRole("link", { name: "My Diagrams" })).toHaveAttribute(
        "href",
        "/app",
      );
    });

    it("renders 'My Diagrams' on the public blueprint gallery", () => {
      renderHeader({ access: "public", current: "blueprints" });

      expect(screen.getByRole("link", { name: "My Diagrams" })).toHaveAttribute(
        "href",
        "/app",
      );
    });

    it("renders 'My Diagrams' as a chrome link rather than an underlined body-text link (Bug 34)", () => {
      renderHeader({ current: "blueprints", access: "public" });

      expect(screen.getByRole("link", { name: "My Diagrams" })).toHaveClass(
        "nav-link",
      );
    });

    it("renders 'Admin' only for an administrator", () => {
      renderHeader({
        current: "blueprints",
        access: "public",
        identity: admin,
      });

      expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute(
        "href",
        "/app/admin",
      );
    });

    it("omits 'Admin' for a non-administrator", () => {
      renderHeader({ identity: member });

      expect(
        screen.queryByRole("link", { name: "Admin" }),
      ).not.toBeInTheDocument();
    });

    it("renders 'Admin' as a chrome link rather than an underlined body-text link (Bug 34)", () => {
      renderHeader({ identity: admin });

      expect(screen.getByRole("link", { name: "Admin" })).toHaveClass(
        "nav-link",
      );
    });

    it("places 'My Diagrams' immediately before 'Admin'", () => {
      renderHeader({
        current: "blueprints",
        access: "public",
        identity: admin,
      });

      const links = screen
        .getAllByRole("link")
        .map((link) => link.textContent?.trim());
      expect(links.slice(0, 3)).toEqual(["Architect", "My Diagrams", "Admin"]);
    });
  });

  describe("identity slot", () => {
    it("shows the verified email", () => {
      renderHeader({ identity: member });

      expect(screen.getByText("member@example.com")).toBeInTheDocument();
    });

    it("shows the loading state on the authenticated subtree", () => {
      renderHeader({ access: "authenticated", identity: loading });

      expect(screen.getByText("Verifying identity…")).toBeInTheDocument();
    });

    it("alerts on an identity failure on the authenticated subtree", () => {
      renderHeader({ access: "authenticated", identity: failed });

      expect(screen.getByRole("alert")).toHaveTextContent("Access expired.");
    });

    it("shows nothing while loading on a public page", () => {
      renderHeader({
        access: "public",
        current: "blueprints",
        identity: loading,
      });

      expect(screen.queryByText("Verifying identity…")).not.toBeInTheDocument();
    });

    it("does not alert on an identity failure on a public page, where anonymous is expected", () => {
      renderHeader({
        access: "public",
        current: "blueprints",
        identity: failed,
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Access expired.")).not.toBeInTheDocument();
    });
  });

  describe("auth action", () => {
    it("renders sign-out unconditionally on the authenticated subtree, even while loading", () => {
      renderHeader({ access: "authenticated", identity: loading });

      expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute(
        "href",
        "/cdn-cgi/access/logout",
      );
    });

    it("renders sign-out after an identity failure on the authenticated subtree", () => {
      renderHeader({ access: "authenticated", identity: failed });

      expect(
        screen.getByRole("link", { name: "Sign out" }),
      ).toBeInTheDocument();
    });

    it("renders sign-out for a signed-in visitor on a public page", () => {
      renderHeader({ access: "public", current: "blueprints" });

      expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute(
        "href",
        "/cdn-cgi/access/logout",
      );
    });

    it("renders sign-in for an anonymous visitor on a public page", () => {
      renderHeader({
        access: "public",
        current: "blueprints",
        identity: failed,
      });

      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        "/app",
      );
      expect(
        screen.queryByRole("link", { name: "Sign out" }),
      ).not.toBeInTheDocument();
    });

    it("renders neither control while loading on a public page, rather than flickering between them", () => {
      renderHeader({
        access: "public",
        current: "blueprints",
        identity: loading,
      });

      expect(
        screen.queryByRole("link", { name: "Sign in" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Sign out" }),
      ).not.toBeInTheDocument();
    });
  });

  it("carries exactly one dark-mode toggle", () => {
    renderHeader();

    expect(screen.getAllByTitle("Toggle dark mode")).toHaveLength(1);
  });
});
