import { describe, expect, it } from 'vitest';
import { formatSseFrame, parseSseBuffer } from '../../src/shared/sse';

describe('parseSseBuffer', () => {
  it('parses one complete frame', () => {
    const result = parseSseBuffer('event: delta\ndata: {"text":"hi"}\n\n');
    expect(result.frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
    expect(result.rest).toBe('');
  });

  it('parses several frames from one buffer', () => {
    const result = parseSseBuffer('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(result.frames.map((frame) => frame.event)).toEqual(['a', 'b']);
  });

  // A chunk boundary falls wherever the network puts it, routinely mid-frame. Holding the remainder
  // over is the whole reason this is a pure function rather than a stream transform.
  it('holds an unterminated frame over as the remainder', () => {
    const result = parseSseBuffer('event: delta\ndata: {"text":"par');
    expect(result.frames).toEqual([]);
    expect(result.rest).toBe('event: delta\ndata: {"text":"par');
  });

  it('completes a frame split across two calls', () => {
    const first = parseSseBuffer('event: delta\ndata: {"te');
    const second = parseSseBuffer(first.rest + 'xt":"hi"}\n\n');
    expect(second.frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('accepts a frame with no event name', () => {
    expect(parseSseBuffer('data: [DONE]\n\n').frames).toEqual([{ data: '[DONE]' }]);
  });

  // Several `data:` lines in one frame are joined with newlines, as the specification requires, so
  // a multi-line payload survives rather than being truncated to its first line.
  it('joins multiple data lines with newlines', () => {
    expect(parseSseBuffer('data: line one\ndata: line two\n\n').frames[0]?.data).toBe(
      'line one\nline two'
    );
  });

  it('normalises carriage-return line endings', () => {
    expect(parseSseBuffer('event: delta\r\ndata: hi\r\n\r\n').frames).toEqual([
      { event: 'delta', data: 'hi' }
    ]);
  });

  // Keep-alive comments carry no payload. A caller that saw them as empty data frames would have to
  // filter them itself, and would eventually forget to.
  it('discards comment-only frames', () => {
    expect(parseSseBuffer(': keep-alive\n\n').frames).toEqual([]);
  });

  it('discards a frame with no data field', () => {
    expect(parseSseBuffer('event: delta\n\n').frames).toEqual([]);
  });

  it('strips exactly one space after the field colon', () => {
    expect(parseSseBuffer('data:  two spaces\n\n').frames[0]?.data).toBe(' two spaces');
  });

  it('preserves a data value containing a colon', () => {
    expect(parseSseBuffer('data: {"url":"https://example.com"}\n\n').frames[0]?.data).toBe(
      '{"url":"https://example.com"}'
    );
  });

  it('returns an empty result for an empty buffer', () => {
    expect(parseSseBuffer('')).toEqual({ frames: [], rest: '' });
  });

  it('preserves an empty data value', () => {
    expect(parseSseBuffer('data:\n\n').frames[0]?.data).toBe('');
  });
});

describe('formatSseFrame', () => {
  it('writes a named event with a JSON payload', () => {
    expect(formatSseFrame('delta', { text: 'hi' })).toBe('event: delta\ndata: {"text":"hi"}\n\n');
  });

  // The payload is JSON-encoded, so a newline inside generated text can never terminate its own
  // frame — which is the failure mode of hand-written SSE that streams user text directly.
  it('encodes a newline in the payload rather than emitting it raw', () => {
    const frame = formatSseFrame('delta', { text: 'one\ntwo' });
    expect(frame).toContain('\\n');
    expect(frame.split('\n\n')).toHaveLength(2);
  });

  it('round-trips through the parser', () => {
    const frame = formatSseFrame('completed', { receipt: { runId: 'r1' } });
    const parsed = parseSseBuffer(frame);
    expect(parsed.frames).toHaveLength(1);
    expect(JSON.parse(parsed.frames[0]!.data)).toEqual({ receipt: { runId: 'r1' } });
  });

  it('round-trips a payload containing a blank line', () => {
    const frame = formatSseFrame('delta', { text: 'before\n\nafter' });
    const parsed = parseSseBuffer(frame);
    expect(JSON.parse(parsed.frames[0]!.data)).toEqual({ text: 'before\n\nafter' });
  });
});
