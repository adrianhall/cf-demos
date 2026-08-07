import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInvitationRedemptionStore } from "../stores/invitation-redemption";
import InvitationRedeemView from "./InvitationRedeemView.vue";

const pushMock = vi.fn();
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { token: "raw-token-value" } }),
  useRouter: () => ({ push: pushMock }),
}));

const stubs = {
  FeatherIcon: true,
  VContainer: { template: "<div><slot /></div>" },
  VSpacer: { template: "<span />" },
  VBtn: {
    template:
      '<button v-bind="$attrs"><slot name="prepend" /><slot /></button>',
  },
  VProgressCircular: { template: "<div />" },
  VAlert: { template: '<div><slot name="title" /><slot /></div>' },
};

function mountView(
  stubActions: { redeem?: (token: string) => Promise<string | undefined> } = {},
) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const store = useInvitationRedemptionStore();
  if (stubActions.redeem) {
    store.redeem = stubActions.redeem;
  }
  const wrapper = mount(InvitationRedeemView, {
    global: { plugins: [pinia], stubs },
  });
  return { store, wrapper };
}

/** Wait for pending microtasks (the mounted redeem call) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("InvitationRedeemView", () => {
  beforeEach(() => pushMock.mockClear());

  it("redeems the route's token on mount and navigates to the diagram on success", async () => {
    const redeem = vi.fn().mockImplementation(async (token: string) => {
      expect(token).toBe("raw-token-value");
      return "diagram-1";
    });
    mountView({ redeem });
    await flushPromises();

    expect(redeem).toHaveBeenCalledWith("raw-token-value");
    expect(pushMock).toHaveBeenCalledWith({
      name: "diagram-editor",
      params: { id: "diagram-1" },
    });
  });

  it("shows an error state and does not navigate when redemption fails", async () => {
    const redeem = vi.fn().mockResolvedValue(undefined);
    const { wrapper, store } = mountView({ redeem });
    await flushPromises();
    store.error = "This invitation is no longer valid.";
    await wrapper.vm.$nextTick();

    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("This invitation is no longer valid.");
  });

  it("always renders an unconditional sign-out control", () => {
    const { wrapper } = mountView({
      redeem: vi.fn().mockResolvedValue(undefined),
    });
    const signOut = wrapper
      .findAll("a,button")
      .find((el) => el.text().includes("Sign out"));
    expect(signOut).toBeTruthy();
  });
});
