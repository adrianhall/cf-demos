import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import type { AdminUser } from "../stores/admin";
import AdminUserTable from "./AdminUserTable.vue";

/** A stable admin user fixture for rendering tests. */
function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    business: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    email: "alice@example.com",
    geo: null,
    isAdmin: false,
    usage: emptyUsageSummary(),
    ...overrides,
  };
}

describe("AdminUserTable", () => {
  it("shows a loading state before the very first load resolves", () => {
    const wrapper = mount(AdminUserTable, {
      props: { loading: true, users: [] },
    });

    expect(wrapper.text()).toContain("Loading users");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("shows an empty state when no users have signed in", () => {
    const wrapper = mount(AdminUserTable, {
      props: { loading: false, users: [] },
    });

    expect(wrapper.text()).toContain("No users have signed in yet.");
  });

  it("renders every user's email, ranked order, and cost badge", () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            email: "highest-cost@example.com",
            usage: { ...emptyUsageSummary(), totalCostUsd: 0.5 },
          }),
          adminUser({
            email: "lowest-cost@example.com",
            usage: { ...emptyUsageSummary(), totalCostUsd: 0.01 },
          }),
        ],
      },
    });

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.get('th[scope="row"]').text()).toContain(
      "highest-cost@example.com",
    );
    expect(rows[1]?.get('th[scope="row"]').text()).toContain(
      "lowest-cost@example.com",
    );
  });

  it("shows an Administrator tag only for a user who holds the role", () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({ email: "admin@example.com", isAdmin: true }),
          adminUser({ email: "alice@example.com", isAdmin: false }),
        ],
      },
    });

    const rows = wrapper.findAll("tbody tr");
    expect(rows[0]?.find(".admin-tag").exists()).toBe(true);
    expect(rows[1]?.find(".admin-tag").exists()).toBe(false);
  });

  it("preselects each row's current business/geo value in its own dropdown", () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            business: "leadership",
            email: "alice@example.com",
            geo: "apac",
          }),
        ],
      },
    });

    const businessSelect = wrapper.get(
      'select[aria-label="Business for alice@example.com"]',
    ).element as unknown as HTMLSelectElement;
    const geoSelect = wrapper.get(
      'select[aria-label="Geo for alice@example.com"]',
    ).element as unknown as HTMLSelectElement;
    expect(businessSelect.value).toBe("leadership");
    expect(geoSelect.value).toBe("apac");
  });

  it("shows Unspecified for a user with no business/geo assigned yet", () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [adminUser({ email: "alice@example.com" })],
      },
    });

    const businessSelect = wrapper.get(
      'select[aria-label="Business for alice@example.com"]',
    ).element as unknown as HTMLSelectElement;
    const geoSelect = wrapper.get(
      'select[aria-label="Geo for alice@example.com"]',
    ).element as unknown as HTMLSelectElement;
    expect(businessSelect.value).toBe("");
    expect(geoSelect.value).toBe("");
  });

  it("emits update-metadata with the new business and the row's unchanged geo", async () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            business: null,
            email: "alice@example.com",
            geo: "apac",
          }),
        ],
      },
    });

    await wrapper
      .get('select[aria-label="Business for alice@example.com"]')
      .setValue("field");

    expect(wrapper.emitted("update-metadata")).toEqual([
      ["alice@example.com", "field", "apac"],
    ]);
  });

  it("emits update-metadata with the row's unchanged business and the new geo", async () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            business: "product",
            email: "alice@example.com",
            geo: null,
          }),
        ],
      },
    });

    await wrapper
      .get('select[aria-label="Geo for alice@example.com"]')
      .setValue("emea");

    expect(wrapper.emitted("update-metadata")).toEqual([
      ["alice@example.com", "product", "emea"],
    ]);
  });

  it("emits null when the business dropdown is reset back to Unspecified", async () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            business: "product",
            email: "alice@example.com",
            geo: null,
          }),
        ],
      },
    });

    await wrapper
      .get('select[aria-label="Business for alice@example.com"]')
      .setValue("");

    expect(wrapper.emitted("update-metadata")).toEqual([
      ["alice@example.com", null, null],
    ]);
  });

  it("emits null when the geo dropdown is reset back to Unspecified", async () => {
    const wrapper = mount(AdminUserTable, {
      props: {
        loading: false,
        users: [
          adminUser({
            business: "product",
            email: "alice@example.com",
            geo: "emea",
          }),
        ],
      },
    });

    await wrapper
      .get('select[aria-label="Geo for alice@example.com"]')
      .setValue("");

    expect(wrapper.emitted("update-metadata")).toEqual([
      ["alice@example.com", "product", null],
    ]);
  });
});
