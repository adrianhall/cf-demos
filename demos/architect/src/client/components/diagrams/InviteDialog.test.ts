import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramInvitationsStore } from "../../stores/diagram-invitations";
import InviteDialog from "./InviteDialog.vue";

/** Small DOM-focused Vuetify substitutes, matching this repo's established stubbing pattern. */
const stubs = {
  FeatherIcon: true,
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
  VList: { template: "<div><slot /></div>" },
  VListItem: {
    template: '<div><slot name="title" /><slot name="append" /></div>',
  },
  VBtn: {
    props: ["loading"],
    template:
      '<button v-bind="$attrs" :disabled="loading"><slot name="prepend" /><slot /></button>',
  },
};

function mountDialog(initialState: Record<string, unknown> = {}) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { "diagram-invitations": initialState },
    stubActions: false,
  });
  const wrapper = mount(InviteDialog, {
    global: { plugins: [pinia], stubs },
    props: { diagramId: "diagram-1", open: true },
  });
  return { store: useDiagramInvitationsStore(), wrapper };
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

describe("InviteDialog", () => {
  it("creates an invitation and shows its one-time copy link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            invitation: {
              id: "invite-1",
              diagramId: "diagram-1",
              creatorEmail: "owner@example.com",
              expiresAt: "2026-01-03T00:00:00.000Z",
            },
            token: "raw-token-value",
          }),
          { status: 201 },
        ),
      ),
    );
    const { wrapper } = mountDialog();

    await findButton(wrapper, "Create invitation link").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("/app/invitations/raw-token-value");
  });

  it("copies the invitation link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { wrapper } = mountDialog({ lastCreatedToken: "raw-token-value" });

    await findButton(wrapper, "Copy link").trigger("click");

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/app/invitations/raw-token-value"),
    );
  });

  it("revokes an invitation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const { wrapper } = mountDialog({
      invitations: [
        {
          id: "invite-1",
          diagramId: "diagram-1",
          creatorEmail: "owner@example.com",
          expiresAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });

    expect(wrapper.text()).toContain("Expires");
    const revokeButton = wrapper
      .findAll("button")
      .find((candidate) =>
        candidate.attributes("aria-label")?.startsWith("Revoke"),
      );
    if (!revokeButton) {
      throw new Error("No revoke button found");
    }
    await revokeButton.trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("Expires");
  });

  it("shows a store error message", () => {
    const { wrapper } = mountDialog({
      error: "Only the diagram's owner can do this.",
    });
    expect(wrapper.text()).toContain("Only the diagram's owner can do this.");
  });
});

/** Wait for pending microtasks (store async actions) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
