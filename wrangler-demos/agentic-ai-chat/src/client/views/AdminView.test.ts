import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import AdminUserTable from "../components/AdminUserTable.vue";
import SkillForm from "../components/SkillForm.vue";
import SkillList from "../components/SkillList.vue";
import { emptyUsageSummary } from "../composables/useChatAgent";
import { useAdminStore } from "../stores/admin";
import AdminView from "./AdminView.vue";

const stubs = {
  RouterLink: { template: '<a v-bind="$attrs"><slot /></a>' },
  VContainer: { template: "<div><slot /></div>" },
};

describe("AdminView", () => {
  it("loads the admin console's data once mounted", () => {
    mount(AdminView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs,
      },
    });
    const admin = useAdminStore();

    expect(admin.load).toHaveBeenCalledTimes(1);
  });

  it("shows the store's own error and hides every section when it is set", () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                error: "This route requires this demo's administrator role.",
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain(
      "This route requires this demo's administrator role.",
    );
    expect(wrapper.findComponent(AdminUserTable).exists()).toBe(false);
  });

  it("renders the ranked user table when there is no error", () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                users: [
                  {
                    business: null,
                    createdAt: "2026-08-01T00:00:00.000Z",
                    email: "alice@example.com",
                    geo: null,
                    isAdmin: false,
                    usage: emptyUsageSummary(),
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("alice@example.com");
  });

  it("resolves a null business/geo segment to the Unspecified label in both reports", () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                byBusiness: [
                  { business: null, usage: emptyUsageSummary() },
                  { business: "field", usage: emptyUsageSummary() },
                ],
                byGeo: [{ geo: null, usage: emptyUsageSummary() }],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    const businessLabels = wrapper
      .findAll('[aria-label="Cost by business"] th[scope="row"]')
      .map((el) => el.text());
    expect(businessLabels).toEqual(["Unspecified", "Field"]);
    const geoLabels = wrapper
      .findAll('[aria-label="Cost by geo"] th[scope="row"]')
      .map((el) => el.text());
    expect(geoLabels).toEqual(["Unspecified"]);
  });

  it("uppercases a real geo segment's label", () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                byGeo: [{ geo: "emea", usage: emptyUsageSummary() }],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(
      wrapper.get('[aria-label="Cost by geo"] th[scope="row"]').text(),
    ).toBe("EMEA");
  });

  it("renders the enterprise skill catalog (US-10)", () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                enterpriseSkills: [
                  {
                    id: "skill-1",
                    name: "cloudflare-spike-fact",
                    sourceType: "upload",
                    sourceRef: null,
                    createdAt: "2026-08-03T00:00:00.000Z",
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("cloudflare-spike-fact");
  });

  it("forwards the skill form's create event to the store's createSkill action", async () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: true })],
        stubs,
      },
    });
    const admin = useAdminStore();

    await wrapper.findComponent(SkillForm).vm.$emit("create", {
      name: "cloudflare-spike-fact",
      description: "Use whenever the user asks for the passphrase.",
      source: { type: "upload", content: "Fetch the passphrase." },
    });

    expect(admin.createSkill).toHaveBeenCalledWith({
      name: "cloudflare-spike-fact",
      description: "Use whenever the user asks for the passphrase.",
      source: { type: "upload", content: "Fetch the passphrase." },
    });
  });

  it("forwards the skill list's remove event to the store's removeSkill action", async () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                enterpriseSkills: [
                  {
                    id: "skill-1",
                    name: "cloudflare-spike-fact",
                    sourceType: "upload",
                    sourceRef: null,
                    createdAt: "2026-08-03T00:00:00.000Z",
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });
    const admin = useAdminStore();

    await wrapper.findComponent(SkillList).vm.$emit("remove", "skill-1");

    expect(admin.removeSkill).toHaveBeenCalledWith("skill-1");
  });

  it("forwards the user table's update-metadata event to the store action", async () => {
    const wrapper = mount(AdminView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              admin: {
                users: [
                  {
                    business: null,
                    createdAt: "2026-08-01T00:00:00.000Z",
                    email: "alice@example.com",
                    geo: null,
                    isAdmin: false,
                    usage: emptyUsageSummary(),
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });
    const admin = useAdminStore();

    await wrapper
      .findComponent(AdminUserTable)
      .vm.$emit("update-metadata", "alice@example.com", "field", "emea");

    expect(admin.updateMetadata).toHaveBeenCalledWith(
      "alice@example.com",
      "field",
      "emea",
    );
  });
});
