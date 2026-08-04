import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SkillForm from "./SkillForm.vue";

describe("SkillForm", () => {
  it("emits create with an upload source and clears the form (default source type)", async () => {
    const wrapper = mount(SkillForm, { props: { submitting: false } });

    await wrapper.get("#skill-name").setValue("cloudflare-spike-fact");
    await wrapper
      .get("#skill-description")
      .setValue("Use whenever the user asks for the spike passphrase.");
    await wrapper.get("#skill-content").setValue("Fetch the passphrase.");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toEqual([
      [
        {
          name: "cloudflare-spike-fact",
          description: "Use whenever the user asks for the spike passphrase.",
          source: { type: "upload", content: "Fetch the passphrase." },
        },
      ],
    ]);
    expect((wrapper.get("#skill-name").element as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("emits create with a URL source once the URL radio is selected", async () => {
    const wrapper = mount(SkillForm, { props: { submitting: false } });

    await wrapper.get("#skill-name").setValue("remote-skill");
    await wrapper.get("#skill-description").setValue("Fetched remotely.");
    await wrapper.get('input[type="radio"][value="url"]').setValue(true);
    await wrapper.get("#skill-url").setValue("https://example.com/skill.md");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toEqual([
      [
        {
          name: "remote-skill",
          description: "Fetched remotely.",
          source: { type: "url", url: "https://example.com/skill.md" },
        },
      ],
    ]);
  });

  it("switches back to an upload source once the upload radio is re-selected", async () => {
    const wrapper = mount(SkillForm, { props: { submitting: false } });

    await wrapper.get("#skill-name").setValue("brand-voice");
    await wrapper.get("#skill-description").setValue("Use for tone.");
    await wrapper.get('input[type="radio"][value="url"]').setValue(true);
    await wrapper.get('input[type="radio"][value="upload"]').setValue(true);
    await wrapper.get("#skill-content").setValue("Be concise and friendly.");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toEqual([
      [
        {
          name: "brand-voice",
          description: "Use for tone.",
          source: { type: "upload", content: "Be concise and friendly." },
        },
      ],
    ]);
  });

  it("does not emit create while any required field is empty", async () => {
    const wrapper = mount(SkillForm, { props: { submitting: false } });

    await wrapper.get("#skill-name").setValue("cloudflare-spike-fact");
    // description and content are both still empty.
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("create")).toBeUndefined();
  });

  it("disables every field and the submit button while submitting", () => {
    const wrapper = mount(SkillForm, { props: { submitting: true } });

    expect(
      (wrapper.get("#skill-name").element as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (wrapper.get(".submit-button").element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(wrapper.get(".submit-button").text()).toBe("Adding…");
  });
});
