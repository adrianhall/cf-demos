import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { type CatalogModelId, MODEL_CATALOG } from "../../models";
import ModelSelector from "./ModelSelector.vue";

describe("ModelSelector", () => {
  it("lists every catalog model, labeled with its provider and reasoning behavior", () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelId: "@cf/ibm-granite/granite-4.0-h-micro",
        temperature: 0.6,
        maxTokens: 256,
      },
    });

    const options = wrapper.findAll("option");
    expect(options).toHaveLength(MODEL_CATALOG.length);
    expect(options.map((option) => option.text())).toEqual([
      "Granite 4.0 H Micro — IBM (non-reasoning)",
      "Llama 4 Scout 17B — Meta (non-reasoning)",
      "DeepSeek R1 Distill Qwen 32B — DeepSeek (reasoning)",
      "GLM 4.7 Flash — Zhipu AI (reasoning)",
      "Gemma 4 26B — Google (reasoning)",
    ]);
  });

  it("emits update:modelId when a different model is selected", async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelId: "@cf/ibm-granite/granite-4.0-h-micro",
        temperature: 0.6,
        maxTokens: 256,
      },
    });

    await wrapper
      .get("select")
      .setValue("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");

    expect(wrapper.emitted("update:modelId")).toEqual([
      ["@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"],
    ]);
  });

  it("bounds the temperature slider to the selected model's descriptor", () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelId: "@cf/meta/llama-4-scout-17b-16e-instruct",
        temperature: 0.7,
        maxTokens: 512,
      },
    });

    const temperatureInput = wrapper.get("#temperature-range");
    // Llama 4 Scout's real ceiling is 2, not the 0-5 range its shared input type suggests (see
    // docs/05-AI-CHAT.md's spike correction) — the bound must come from this model's own entry.
    expect(temperatureInput.attributes("max")).toBe("2");
    expect(temperatureInput.attributes("min")).toBe("0");
  });

  it("falls back to the first catalog entry's bounds for an unrecognized modelId", () => {
    // `.vue` components are typed through this repo's ambient `*.vue` module declaration (see
    // `src/vue.d.ts`), which does not preserve `defineProps<Props>()`'s exact prop types for
    // plain `tsc` — unlike a plain function's parameter types — so no `@ts-expect-error` is
    // needed to pass an ID outside the catalog union here.
    const wrapper = mount(ModelSelector, {
      props: {
        modelId: "@cf/not-a-real/model" as CatalogModelId,
        temperature: 0.6,
        maxTokens: 256,
      },
    });

    const firstEntry = MODEL_CATALOG[0];
    expect(wrapper.get("#temperature-range").attributes("max")).toBe(
      String(firstEntry.temperature.max),
    );
  });

  it("emits update:temperature and update:maxTokens as the sliders change", async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelId: "@cf/ibm-granite/granite-4.0-h-micro",
        temperature: 0.6,
        maxTokens: 256,
      },
    });

    await wrapper.get("#temperature-range").setValue("1.5");
    await wrapper.get("#max-tokens-range").setValue("1000");

    expect(wrapper.emitted("update:temperature")).toEqual([[1.5]]);
    expect(wrapper.emitted("update:maxTokens")).toEqual([[1000]]);
  });
});
