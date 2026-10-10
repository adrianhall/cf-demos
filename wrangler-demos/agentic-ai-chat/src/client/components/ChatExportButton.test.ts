import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ChatExportButton from "./ChatExportButton.vue";

describe("ChatExportButton", () => {
  it("links to the ownership-checked export route for the current chat", () => {
    const wrapper = mount(ChatExportButton, { props: { chatId: "chat-1" } });

    const anchor = wrapper.get("a");
    expect(anchor.attributes("href")).toBe("/api/chats/chat-1/export");
    expect(anchor.attributes("aria-disabled")).toBe("false");
    expect(anchor.attributes("tabindex")).toBe("0");
  });

  it("URL-encodes the chat id", () => {
    const wrapper = mount(ChatExportButton, {
      props: { chatId: "chat/needs encoding" },
    });

    expect(wrapper.get("a").attributes("href")).toBe(
      "/api/chats/chat%2Fneeds%20encoding/export",
    );
  });

  it("renders disabled, with no href, when no chat is selected", () => {
    const wrapper = mount(ChatExportButton, { props: { chatId: null } });

    const anchor = wrapper.get("a");
    expect(anchor.attributes("href")).toBeUndefined();
    expect(anchor.attributes("aria-disabled")).toBe("true");
    expect(anchor.attributes("tabindex")).toBe("-1");
    expect(anchor.classes()).toContain("disabled");
  });

  it("blocks navigation when clicked while disabled (defensive)", () => {
    const wrapper = mount(ChatExportButton, { props: { chatId: null } });
    const anchor = wrapper.get("a").element as HTMLAnchorElement;
    const event = new MouseEvent("click", { cancelable: true });

    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not block navigation when clicked while enabled", () => {
    // `preventDefault()` is spied on this specific event instance rather than inspected via
    // `event.defaultPrevented` after a real dispatch, so this never has to exercise (or
    // silence) jsdom's own unimplemented page-navigation default action for a real `<a href>`
    // click -- only whether this component's own guard called it.
    const wrapper = mount(ChatExportButton, { props: { chatId: "chat-1" } });
    const anchor = wrapper.get("a").element as HTMLAnchorElement;
    const event = new MouseEvent("click", { cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");

    anchor.dispatchEvent(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });
});
