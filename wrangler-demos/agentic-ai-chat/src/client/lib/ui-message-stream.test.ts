import { describe, expect, it } from "vitest";
import { UiMessageStreamDecoder } from "./ui-message-stream";

describe("UiMessageStreamDecoder", () => {
  it("decodes several bare, back-to-back JSON objects with no separator", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push(
      '{"type":"start"}{"type":"start-step"}{"type":"text-start","id":"a"}',
    );

    expect(parts).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "a" },
    ]);
  });

  it("buffers a JSON object split across two chunks", () => {
    const decoder = new UiMessageStreamDecoder();

    const first = decoder.push('{"type":"text-delta","id":"a","delta":"Hel');
    expect(first).toEqual([]);

    const second = decoder.push('lo"}{"type":"text-end","id":"a"}');
    expect(second).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-end", id: "a" },
    ]);
  });

  it("does not mistake a brace inside a string value for structural JSON", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push(
      '{"type":"text-delta","id":"a","delta":"a { b } c"}{"type":"finish"}',
    );

    expect(parts).toEqual([
      { type: "text-delta", id: "a", delta: "a { b } c" },
      { type: "finish" },
    ]);
  });

  it("does not mistake an escaped quote inside a string for the string's end", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push(
      String.raw`{"type":"text-delta","id":"a","delta":"say \"hi\""}`,
    );

    expect(parts).toEqual([{ type: "text-delta", id: "a", delta: 'say "hi"' }]);
  });

  it("accumulates deltas across many chunks into the full turn", () => {
    const decoder = new UiMessageStreamDecoder();
    const chunks = [
      '{"type":"start"}',
      '{"type":"start-step"}',
      '{"type":"text-start","id":"a"}',
      '{"type":"text-delta","id":"a","delta":"Hello"}',
      '{"type":"text-delta","id":"a","delta":" world"}',
      '{"type":"text-end","id":"a"}',
      '{"type":"finish-step"}',
      '{"type":"finish"}',
    ];

    const parts = chunks.flatMap((chunk) => decoder.push(chunk));

    const text = parts
      .filter(
        (part): part is { type: "text-delta"; id: string; delta: string } =>
          part.type === "text-delta",
      )
      .map((part) => part.delta)
      .join("");
    expect(text).toBe("Hello world");
    expect(parts.at(-1)).toEqual({ type: "finish" });
  });

  it("decodes an error part", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push(
      '{"type":"error","errorText":"model temporarily unavailable"}',
    );

    expect(parts).toEqual([
      { type: "error", errorText: "model temporarily unavailable" },
    ]);
  });

  it("preserves an unrecognized part shape verbatim instead of dropping it", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push(
      '{"type":"tool-input-available","toolCallId":"1","toolName":"writeMarkdown","input":{}}',
    );

    expect(parts).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "1",
        toolName: "writeMarkdown",
        input: {},
      },
    ]);
  });

  it("ignores whitespace between objects", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push('{"type":"start"}\n{"type":"finish"}\n');

    expect(parts).toEqual([{ type: "start" }, { type: "finish" }]);
  });

  it("returns an empty array when fed only a partial object", () => {
    const decoder = new UiMessageStreamDecoder();

    const parts = decoder.push('{"type":"text-delta","id":"a"');

    expect(parts).toEqual([]);
  });
});
