import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import UsageBadge from "./UsageBadge.vue";

describe("UsageBadge", () => {
  it("shows 'No turns yet' and no confirmation ratio before any turn completes", () => {
    const wrapper = mount(UsageBadge, {
      props: { usage: emptyUsageSummary() },
    });

    expect(wrapper.text()).toContain("No turns yet");
    expect(wrapper.text()).toContain("$0.0000");
    expect(wrapper.find(".confirmation-ratio").exists()).toBe(false);
  });

  it("labels a fully estimated chat's badge Estimated", () => {
    const wrapper = mount(UsageBadge, {
      props: {
        usage: {
          totalCostUsd: 0.001_2,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          turnCount: 1,
          confirmedTurnCount: 0,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(wrapper.get(".source-label").text()).toBe("Estimated");
    expect(wrapper.text()).toContain("0 of 1 turn confirmed by AI Gateway");
  });

  it("labels a fully confirmed chat's badge AI Gateway", () => {
    const wrapper = mount(UsageBadge, {
      props: {
        usage: {
          totalCostUsd: 0.001_2,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          turnCount: 2,
          confirmedTurnCount: 2,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(wrapper.text()).toContain("AI Gateway");
    expect(wrapper.text()).toContain("2 of 2 turns confirmed by AI Gateway");
  });

  it("labels a chat with a mix of confirmed and estimated turns as Estimated + AI Gateway", () => {
    const wrapper = mount(UsageBadge, {
      props: {
        usage: {
          totalCostUsd: 0.002,
          totalPromptTokens: 30,
          totalCompletionTokens: 60,
          turnCount: 4,
          confirmedTurnCount: 3,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(wrapper.text()).toContain("Estimated + AI Gateway");
    expect(wrapper.text()).toContain("3 of 4 turns confirmed by AI Gateway");
  });

  it("omits per-token counts and the confirmation ratio in compact mode", () => {
    const wrapper = mount(UsageBadge, {
      props: {
        compact: true,
        usage: {
          totalCostUsd: 0.001,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          turnCount: 1,
          confirmedTurnCount: 1,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(wrapper.find(".tokens").exists()).toBe(false);
    expect(wrapper.find(".confirmation-ratio").exists()).toBe(false);
    expect(wrapper.text()).toContain("AI Gateway");
  });

  it("plays a flash animation once when a usage_reconciled event arrives", async () => {
    vi.useFakeTimers();
    const wrapper = mount(UsageBadge, {
      props: {
        usage: {
          totalCostUsd: 0.001,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          turnCount: 1,
          confirmedTurnCount: 1,
          lastUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
        lastReconciliationEvent: null,
      },
    });
    expect(wrapper.get(".usage-badge").classes()).not.toContain("flashing");

    await wrapper.setProps({
      lastReconciliationEvent: {
        type: "usage_reconciled",
        chatUsageId: "usage-1",
        receivedAt: Date.now(),
      },
    });
    expect(wrapper.get(".usage-badge").classes()).toContain("flashing");

    vi.advanceTimersByTime(1_200);
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".usage-badge").classes()).not.toContain("flashing");
    vi.useRealTimers();
  });

  it("does not flash and does not throw when lastReconciliationEvent transitions back to null (switching chats)", async () => {
    const wrapper = mount(UsageBadge, {
      props: {
        usage: emptyUsageSummary(),
        lastReconciliationEvent: {
          type: "usage_reconciled" as const,
          chatUsageId: "usage-1",
          receivedAt: Date.now(),
        },
      },
    });

    await wrapper.setProps({ lastReconciliationEvent: null });

    expect(wrapper.get(".usage-badge").classes()).not.toContain("flashing");
  });

  it("lets a second, later event supersede the first's flash without the first event's own timer clearing it early", async () => {
    vi.useFakeTimers();
    const wrapper = mount(UsageBadge, {
      props: { usage: emptyUsageSummary(), lastReconciliationEvent: null },
    });

    await wrapper.setProps({
      lastReconciliationEvent: {
        type: "usage_reconciled",
        chatUsageId: "usage-1",
        receivedAt: Date.now(),
      },
    });
    expect(wrapper.get(".usage-badge").classes()).toContain("flashing");

    vi.advanceTimersByTime(600);
    await wrapper.setProps({
      lastReconciliationEvent: {
        type: "usage_reconcile_exhausted",
        chatUsageId: "usage-2",
        receivedAt: Date.now(),
      },
    });
    expect(wrapper.get(".usage-badge").classes()).toContain("flashing");

    // The first event's own 1200ms timer fires here -- it must not clear the second event's
    // still-active flash.
    vi.advanceTimersByTime(600);
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".usage-badge").classes()).toContain("flashing");

    // The second event's own timer fires here, and is what finally clears it.
    vi.advanceTimersByTime(600);
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".usage-badge").classes()).not.toContain("flashing");
    vi.useRealTimers();
  });

  it("does not re-flash for the same reconciliation event object", async () => {
    vi.useFakeTimers();
    const event = {
      type: "usage_reconcile_exhausted" as const,
      chatUsageId: "usage-2",
      receivedAt: Date.now(),
    };
    const wrapper = mount(UsageBadge, {
      props: {
        usage: emptyUsageSummary(),
        lastReconciliationEvent: event,
      },
    });

    await wrapper.setProps({ lastReconciliationEvent: { ...event } });

    // A structurally-identical-but-distinct object with the *same* receivedAt is treated as the
    // same occurrence (the composable only ever produces a genuinely new object for a genuinely
    // new event), so no fresh flash should be scheduled.
    vi.advanceTimersByTime(1_200);
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".usage-badge").classes()).not.toContain("flashing");
    vi.useRealTimers();
  });
});
