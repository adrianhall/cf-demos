import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { findModel } from "../../models";
import { useSettingsStore } from "./settings";

describe("useSettingsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("defaults to the cheapest non-reasoning model and its default parameters", () => {
    const store = useSettingsStore();
    const granite = findModel("@cf/ibm-granite/granite-4.0-h-micro");
    if (!granite) {
      throw new Error(
        "Granite must be a catalog entry for this test to be meaningful.",
      );
    }

    expect(store.modelId).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    expect(store.temperature).toBe(granite.temperature.default);
    expect(store.maxTokens).toBe(granite.maxOutputTokens.default);
    expect(store.descriptor).toEqual(granite);
  });

  it("clamps a value legal for the current model but not the newly selected one", () => {
    const store = useSettingsStore();

    // Llama 4 Scout's real temperature ceiling is 2 (see docs/05-AI-CHAT.md's spike correction),
    // while Granite and DeepSeek accept up to 5 — this is exactly the cross-model boundary the
    // per-descriptor clamp exists to catch.
    store.setTemperature(4);
    expect(store.temperature).toBe(4);

    store.selectModel("@cf/meta/llama-4-scout-17b-16e-instruct");

    expect(store.modelId).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(store.temperature).toBe(2);
  });

  it("re-clamps maxTokens to the newly selected model's ceiling", () => {
    const store = useSettingsStore();

    store.selectModel("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
    store.setMaxTokens(3000);
    expect(store.maxTokens).toBe(3000);

    store.selectModel("@cf/zai-org/glm-4.7-flash");
    expect(store.maxTokens).toBe(2048);
  });

  it("leaves values unchanged when they already fit the newly selected model", () => {
    const store = useSettingsStore();

    store.setTemperature(0.5);
    store.setMaxTokens(100);
    store.selectModel("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");

    expect(store.temperature).toBe(0.5);
    expect(store.maxTokens).toBe(100);
  });

  it("ignores selecting a model ID that is not in the catalog", () => {
    const store = useSettingsStore();

    // @ts-expect-error deliberately passing an ID outside the catalog union
    store.selectModel("@cf/not-a-real/model");

    expect(store.modelId).toBe("@cf/ibm-granite/granite-4.0-h-micro");
  });

  it("clamps setTemperature/setMaxTokens to the current model's bounds", () => {
    const store = useSettingsStore();

    store.setTemperature(-5);
    expect(store.temperature).toBe(store.descriptor.temperature.min);

    store.setTemperature(999);
    expect(store.temperature).toBe(store.descriptor.temperature.max);

    store.setMaxTokens(0);
    expect(store.maxTokens).toBe(1);

    store.setMaxTokens(999_999);
    expect(store.maxTokens).toBe(store.descriptor.maxOutputTokens.max);
  });
});
