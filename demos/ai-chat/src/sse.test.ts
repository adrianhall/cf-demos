import { describe, expect, it } from "vitest";
import { decodeSseStream } from "./sse";

/** Build a `ReadableStream<Uint8Array>` that emits each string in `chunks` as one `read()`. */
function streamFromChunks(
  chunks: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

/** Drain every payload the decoder yields into a plain array, for easy assertion. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of decodeSseStream(stream)) {
    payloads.push(payload);
  }
  return payloads;
}

describe("decodeSseStream", () => {
  it("decodes a single well-formed frame per chunk", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}', '{"a":2}']);
  });

  it("recognizes the [DONE] sentinel as an ordinary payload", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}', "[DONE]"]);
  });

  it("reassembles a frame split across multiple byte chunks", async () => {
    const stream = streamFromChunks(['data: {"a":', "1}\n", "\n"]);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}']);
  });

  it("reassembles a frame boundary split exactly at the blank-line separator", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n', '\ndata: {"a":2}\n\n']);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}', '{"a":2}']);
  });

  it("joins multiple data: lines within one frame with a newline", async () => {
    const stream = streamFromChunks(["data: line one\ndata: line two\n\n"]);
    await expect(collect(stream)).resolves.toEqual(["line one\nline two"]);
  });

  it("ignores non-data fields such as event: and comments", async () => {
    const stream = streamFromChunks([
      'event: message\n:comment\ndata: {"a":1}\nid: 1\n\n',
    ]);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}']);
  });

  it("flushes a trailing frame with no closing blank line", async () => {
    const stream = streamFromChunks(['data: {"a":1}']);
    await expect(collect(stream)).resolves.toEqual(['{"a":1}']);
  });

  it("yields nothing for an empty stream", async () => {
    const stream = streamFromChunks([]);
    await expect(collect(stream)).resolves.toEqual([]);
  });

  it("cancels the underlying reader when the caller stops iterating early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("data: 1\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const payload of decodeSseStream(stream)) {
      expect(payload).toBe("1");
      break;
    }

    expect(cancelled).toBe(true);
  });
});
