import { describe, expect, it } from "vitest";
import { createThinkTagSplitter } from "./reasoning";

describe("createThinkTagSplitter", () => {
  it("passes plain text through as answer when no markers ever appear", () => {
    const splitter = createThinkTagSplitter();
    expect(splitter.push("Hello, ")).toEqual({
      answer: "Hello, ",
      thinking: "",
    });
    expect(splitter.push("world.")).toEqual({ answer: "world.", thinking: "" });
    expect(splitter.flush()).toEqual({ answer: "", thinking: "" });
  });

  it("splits a complete <think>...</think> block within a single push", () => {
    const splitter = createThinkTagSplitter();
    const result = splitter.push("<think>reasoning</think>answer");
    expect(result).toEqual({ answer: "answer", thinking: "reasoning" });
    expect(splitter.flush()).toEqual({ answer: "", thinking: "" });
  });

  it("splits text before, inside, and after a think block within one push", () => {
    const splitter = createThinkTagSplitter();
    const result = splitter.push("before<think>middle</think>after");
    expect(result).toEqual({ answer: "beforeafter", thinking: "middle" });
  });

  it("handles multiple separate think blocks in one turn", () => {
    const splitter = createThinkTagSplitter();
    const first = splitter.push("<think>one</think>A<think>two</think>B");
    expect(first).toEqual({ answer: "AB", thinking: "onetwo" });
  });

  it("reassembles an opening marker split across chunk boundaries", () => {
    const splitter = createThinkTagSplitter();
    expect(splitter.push("Hello <th")).toEqual({
      answer: "Hello ",
      thinking: "",
    });
    expect(splitter.push("ink>reasoning")).toEqual({
      answer: "",
      thinking: "reasoning",
    });
  });

  it("reassembles a closing marker split across chunk boundaries", () => {
    const splitter = createThinkTagSplitter();
    splitter.push("<think>reasoning</th");
    const result = splitter.push("ink>answer");
    expect(result).toEqual({ answer: "answer", thinking: "" });
  });

  it("reassembles a marker split across three chunks, one character at a time near the boundary", () => {
    const splitter = createThinkTagSplitter();
    expect(splitter.push("Hello <th")).toEqual({
      answer: "Hello ",
      thinking: "",
    });
    expect(splitter.push("ink>reasoning</th")).toEqual({
      answer: "",
      thinking: "reasoning",
    });
    expect(splitter.push("ink>answer")).toEqual({
      answer: "answer",
      thinking: "",
    });
  });

  it("handles a marker split with only one character delivered per chunk", () => {
    const splitter = createThinkTagSplitter();
    const chunks = "<think>hi</think>bye".split("");
    let answer = "";
    let thinking = "";
    for (const chunk of chunks) {
      const result = splitter.push(chunk);
      answer += result.answer;
      thinking += result.thinking;
    }
    expect(answer).toBe("bye");
    expect(thinking).toBe("hi");
  });

  it("flushes an unclosed <think> block at end of stream as thinking, not dropped", () => {
    const splitter = createThinkTagSplitter();
    const pushResult = splitter.push(
      "<think>partial reasoning that never closes",
    );
    const flushResult = splitter.flush();
    // The text was fully consumed as thinking during push() here (no trailing partial marker to
    // hold back); the important claim is that none of it silently disappeared or leaked into
    // answer — see the next test for the case where a fragment is still pending at flush time.
    expect(pushResult.thinking + flushResult.thinking).toBe(
      "partial reasoning that never closes",
    );
    expect(pushResult.answer + flushResult.answer).toBe("");
  });

  it("flushes held-back partial marker text still pending inside an unclosed think block", () => {
    const splitter = createThinkTagSplitter();
    // Ends mid-way through what could be the closing marker, so it is held back as `pending`.
    splitter.push("<think>reasoning</th");
    expect(splitter.flush()).toEqual({ answer: "", thinking: "</th" });
  });

  it("flushes a false-alarm partial opening marker (never entered a think block) as answer", () => {
    const splitter = createThinkTagSplitter();
    splitter.push("answer text <th");
    expect(splitter.flush()).toEqual({ answer: "<th", thinking: "" });
  });

  it("never leaks a literal <think> into the answer for a well-formed stream", () => {
    const splitter = createThinkTagSplitter();
    let answer = "";
    for (const chunk of [
      "Let me ",
      "<think>",
      "think about",
      " it</think>",
      " here's my answer",
    ]) {
      answer += splitter.push(chunk).answer;
    }
    expect(answer).not.toContain("<think>");
    expect(answer).not.toContain("</think>");
    expect(answer).toBe("Let me  here's my answer");
  });

  it("treats a lone '<' with no marker following it as ordinary answer text once resolved", () => {
    const splitter = createThinkTagSplitter();
    const first = splitter.push("1 < 2 and 3 <");
    // "3 <" ends with a partial marker prefix ("<"), so it is held back...
    expect(first).toEqual({ answer: "1 < 2 and 3 ", thinking: "" });
    // ...and resolved as ordinary text once the next chunk proves it wasn't a marker.
    const second = splitter.push(" 4");
    expect(second).toEqual({ answer: "< 4", thinking: "" });
  });

  it("returns an empty result from flush when nothing is pending", () => {
    const splitter = createThinkTagSplitter();
    splitter.push("plain text, no markers");
    expect(splitter.flush()).toEqual({ answer: "", thinking: "" });
  });

  it("keeps independent state across two separate splitter instances", () => {
    const first = createThinkTagSplitter();
    const second = createThinkTagSplitter();
    first.push("<think>a");
    expect(second.push("plain")).toEqual({ answer: "plain", thinking: "" });
    expect(first.flush()).toEqual({ answer: "", thinking: "" });
  });
});
