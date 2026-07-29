import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Channel } from "../stores/channels";
import ChannelSidebar from "./ChannelSidebar.vue";

/** A channel fixture used across sidebar tests. */
const general: Channel = {
  createdAt: "2026-07-27T00:00:00.000Z",
  createdBy: "system",
  name: "general",
};

/** A second channel fixture used to verify multi-item rendering and selection. */
const random: Channel = {
  createdAt: "2026-07-27T00:00:01.000Z",
  createdBy: "system",
  name: "random",
};

/** Mount the sidebar with small DOM-focused Vuetify substitutes. */
function mountSidebar(channels: Channel[], selected: string | null = null) {
  return mount(ChannelSidebar, {
    props: { channels, selected },
    global: {
      stubs: {
        FeatherIcon: true,
        VBtn: { template: '<button v-bind="$attrs"><slot /></button>' },
        VList: { template: "<ul><slot /></ul>" },
        VListItem: {
          template:
            '<li v-bind="$attrs"><slot name="prepend" /><slot /><slot name="append" /></li>',
        },
        VListItemTitle: { template: "<span><slot /></span>" },
        VTextField: {
          emits: ["update:modelValue"],
          props: ["modelValue"],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  });
}

describe("ChannelSidebar", () => {
  it("renders an empty-state prompt when there are no channels", () => {
    expect(mountSidebar([]).text()).toContain("No channels yet");
  });

  it("lists every channel and emits a select event when one is clicked", async () => {
    const wrapper = mountSidebar([general, random], "general");

    expect(wrapper.text()).toContain("general");
    expect(wrapper.text()).toContain("random");

    await wrapper.findAll("li")[1]?.trigger("click");

    expect(wrapper.emitted("select")).toEqual([["random"]]);
  });

  it("emits a remove event for a channel's remove control without selecting it", async () => {
    const wrapper = mountSidebar([general, random], "general");

    await wrapper
      .get('button[aria-label="Remove channel: random"]')
      .trigger("click");

    expect(wrapper.emitted("remove")).toEqual([["random"]]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("emits a trimmed create event and clears the field", async () => {
    const wrapper = mountSidebar([general]);

    await wrapper.get("input").setValue("  deploys  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toEqual([["deploys"]]);
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
  });

  it("does not emit a blank channel name", async () => {
    const wrapper = mountSidebar([general]);

    await wrapper.get("input").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toBeUndefined();
  });
});
