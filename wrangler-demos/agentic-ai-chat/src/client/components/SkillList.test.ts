import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Skill } from "../stores/skills";
import SkillList from "./SkillList.vue";

/** A stable skill fixture for rendering tests. */
function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    name: "cloudflare-spike-fact",
    sourceType: "upload",
    sourceRef: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("SkillList", () => {
  it("shows a loading state instead of the empty state while the first load is in flight", () => {
    const wrapper = mount(SkillList, {
      props: { skills: [], loading: true, emptyMessage: "None yet." },
    });

    expect(wrapper.text()).toContain("Loading skills");
    expect(wrapper.text()).not.toContain("None yet.");
  });

  it("shows the caller's own empty message when there are no skills", () => {
    const wrapper = mount(SkillList, {
      props: { skills: [], loading: false, emptyMessage: "None yet." },
    });

    expect(wrapper.text()).toContain("None yet.");
  });

  it("renders each skill's name and source", () => {
    const wrapper = mount(SkillList, {
      props: {
        skills: [
          skill({ id: "a", name: "brand-voice", sourceType: "upload" }),
          skill({
            id: "b",
            name: "remote-skill",
            sourceType: "url",
            sourceRef: "https://example.com/skill.md",
          }),
        ],
        loading: false,
        emptyMessage: "None yet.",
      },
    });

    const names = wrapper.findAll(".skill-name").map((el) => el.text());
    expect(names).toEqual(["brand-voice", "remote-skill"]);
    const refs = wrapper.findAll(".skill-ref").map((el) => el.text());
    expect(refs).toEqual(["Uploaded content", "https://example.com/skill.md"]);
  });

  it("emits remove with the clicked skill's id", async () => {
    const wrapper = mount(SkillList, {
      props: {
        skills: [skill({ id: "a" }), skill({ id: "b" })],
        loading: false,
        emptyMessage: "None yet.",
      },
    });

    await wrapper.findAll(".remove-button")[1]?.trigger("click");

    expect(wrapper.emitted("remove")).toEqual([["b"]]);
  });
});
