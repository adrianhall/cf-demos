import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useDiagramDocumentStore } from "../stores/diagram-document";
import DiagramEditorView from "./DiagramEditorView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "diagram-1" } }),
  useRouter: () => ({ push: vi.fn() }),
}));

const diagramCanvasStub = {
  emits: [
    "clearSelection",
    "connectNodes",
    "cursorMove",
    "moveNode",
    "selectEdge",
    "selectNode",
  ],
  props: ["edges", "nodes", "remoteCursors"],
  template: "<div />",
};

const stubs = {
  DiagramCanvas: diagramCanvasStub,
  DiagramPalette: true,
  FeatherIcon: true,
  InviteDialog: true,
  MemberList: true,
  PropertiesPanel: true,
  VAlert: { template: "<div><slot /></div>" },
  VBtn: {
    template:
      '<button v-bind="$attrs"><slot name="prepend" /><slot /></button>',
  },
  VChip: {
    template: '<span v-bind="$attrs"><slot name="prepend" /><slot /></span>',
  },
  VProgressCircular: { template: "<div />" },
  VSpacer: { template: "<span />" },
};

const baseDiagramDocumentState = {
  diagram: {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "diagram-1",
    ownerEmail: "owner@example.com",
    title: "Test diagram",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  document: {
    edges: [],
    nodes: [],
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  loading: false,
  selection: null,
};

function mountEditor(diagramDocumentOverrides: Record<string, unknown> = {}) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: {
      "diagram-document": {
        ...baseDiagramDocumentState,
        ...diagramDocumentOverrides,
      },
      session: { email: "owner@example.com" },
    },
    stubActions: true,
  });
  const wrapper = mount(DiagramEditorView, {
    global: { plugins: [pinia], stubs },
  });
  return { store: useDiagramDocumentStore(), wrapper };
}

describe("DiagramEditorView", () => {
  it("shows other connected participants, excluding the signed-in identity's own connection", () => {
    const { wrapper } = mountEditor({
      connectionStatus: "connected",
      participants: [
        { email: "owner@example.com", role: "owner" },
        { email: "editor@example.com", role: "editor" },
      ],
    });
    const participantsRegion = wrapper.get(
      '[aria-label="Other collaborators editing this diagram"]',
    );
    expect(participantsRegion.text()).toContain("editor@example.com");
    expect(participantsRegion.text()).not.toContain("owner@example.com");
  });

  it("announces reconnecting via the aria-live status region", () => {
    const { wrapper } = mountEditor({
      connectionStatus: "reconnecting",
      participants: [],
    });
    expect(wrapper.get('[role="status"]').text()).toBe("Reconnecting…");
  });

  it("announces a stale-conflict notice via the aria-live status region", () => {
    const { wrapper } = mountEditor({
      connectionStatus: "connected",
      participants: [],
      staleNotice: true,
    });
    expect(wrapper.get('[role="status"]').text()).toMatch(/conflicted/);
  });

  it("announces how many other people are editing once connected", () => {
    const { wrapper } = mountEditor({
      connectionStatus: "connected",
      participants: [
        { email: "owner@example.com", role: "owner" },
        { email: "editor@example.com", role: "editor" },
      ],
    });
    expect(wrapper.get('[role="status"]').text()).toBe(
      "Connected — editing with 1 other person.",
    );
  });

  it("forwards a local cursor move, with the current selection, to the store", async () => {
    const { store, wrapper } = mountEditor({
      connectionStatus: "connected",
      participants: [],
      selection: { kind: "node", id: "a" },
    });
    await wrapper
      .findComponent(diagramCanvasStub)
      .vm.$emit("cursorMove", 12, 34);
    expect(store.sendCursor).toHaveBeenCalledWith(12, 34, {
      kind: "node",
      id: "a",
    });
  });

  it("disconnects the live socket when the view unmounts", () => {
    const { store, wrapper } = mountEditor({
      connectionStatus: "connected",
      participants: [],
    });
    wrapper.unmount();
    expect(store.disconnect).toHaveBeenCalledOnce();
  });
});
