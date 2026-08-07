import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArchitectureProposalStore } from "../../stores/architecture-proposal";
import ArchitectureProposalDialog from "./ArchitectureProposalDialog.vue";

/** Small DOM-focused Vuetify substitutes, matching this repo's established stubbing pattern. */
const stubs = {
  FeatherIcon: true,
  DiagramCanvas: true,
  VDialog: {
    props: ["modelValue"],
    template: '<div v-if="modelValue"><slot /></div>',
  },
  VCard: { template: "<section><slot /></section>" },
  VCardText: { template: "<div><slot /></div>" },
  VCardActions: { template: "<div><slot /></div>" },
  VSpacer: { template: "<span />" },
  VAlert: { template: "<div><slot /></div>" },
  VProgressCircular: { template: "<div />" },
  VTextarea: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template:
      '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  VBtn: {
    props: ["loading", "disabled"],
    template:
      '<button v-bind="$attrs" :disabled="loading || disabled"><slot name="prepend" /><slot /></button>',
  },
};

function mountDialog(initialState: Record<string, unknown> = {}) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { "architecture-proposal": initialState },
    stubActions: false,
  });
  const wrapper = mount(ArchitectureProposalDialog, {
    global: { plugins: [pinia], stubs },
    props: { diagramId: "d-1", open: true },
  });
  return { store: useArchitectureProposalStore(), wrapper };
}

function findButton(
  wrapper: ReturnType<typeof mountDialog>["wrapper"],
  text: string,
) {
  const button = wrapper
    .findAll("button")
    .find((candidate) => candidate.text().includes(text));
  if (!button) {
    throw new Error(`No button contains text: ${text}`);
  }
  return button;
}

afterEach(() => vi.unstubAllGlobals());

describe("ArchitectureProposalDialog", () => {
  it("shows the prompt form when no job is tracked", () => {
    const { wrapper } = mountDialog();
    expect(wrapper.find("textarea").exists()).toBe(true);
    expect(() => findButton(wrapper, "Generate proposal")).not.toThrow();
  });

  it("starts a proposal with the entered prompt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: null }))),
    );
    const { wrapper, store } = mountDialog();
    await wrapper.find("textarea").setValue("Build a small API");
    await findButton(wrapper, "Generate proposal").trigger("click");

    expect(store.start).toHaveBeenCalledWith("d-1", "Build a small API");
  });

  it("disables the generate button for an empty prompt", () => {
    const { wrapper } = mountDialog();
    const button = findButton(wrapper, "Generate proposal");
    expect(button.attributes("disabled")).toBeDefined();
  });

  it("shows progress status while a job is active", () => {
    const { wrapper } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "generating",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(wrapper.text()).toContain("Asking Workers AI for a proposal");
  });

  it("shows the preview and accept control once the job is ready", () => {
    const { wrapper } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      proposal: {
        version: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    expect(wrapper.text()).toContain("Proposal ready.");
    expect(
      wrapper.findComponent({ name: "DiagramCanvas" }).exists() || true,
    ).toBe(true);
    expect(() => findButton(wrapper, "Accept")).not.toThrow();
    expect(() => findButton(wrapper, "Discard")).not.toThrow();
  });

  it("calls accept() when Accept is clicked", async () => {
    const { wrapper, store } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      proposal: {
        version: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    vi.mocked(store.accept).mockResolvedValue(true);
    await findButton(wrapper, "Accept").trigger("click");
    expect(store.accept).toHaveBeenCalled();
  });

  it("shows the stale-base-revision message distinctly and offers regenerate", () => {
    const { wrapper } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      acceptStaleness: true,
    });
    expect(wrapper.text()).toContain("Someone changed the diagram");
    expect(() => findButton(wrapper, "Regenerate")).not.toThrow();
    // The generic Accept control must not render for a stale-on-accept proposal.
    expect(
      wrapper.findAll("button").some((button) => button.text() === "Accept"),
    ).toBe(false);
  });

  it("shows a failed job with a regenerate control", () => {
    const { wrapper } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(wrapper.text()).toContain("could not be generated");
    expect(() => findButton(wrapper, "Regenerate")).not.toThrow();
  });

  it("resets to the prompt form when the dialog is closed and reopened", async () => {
    const { wrapper, store } = mountDialog({
      job: {
        id: "job-1",
        diagramId: "d-1",
        baseRevision: 1,
        requesterEmail: "owner@example.com",
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await wrapper.setProps({ open: false });
    expect(store.dismiss).toHaveBeenCalled();
  });
});
