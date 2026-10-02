import { describe, expect, it } from 'vitest';
import {
  isPlayable,
  readAudioDurationSeconds,
  sniffAudioMediaType,
  speechFileName
} from '../../../src/worker/domain/audio-bytes';
import { mp3FrameBytes, mp3WithId3Bytes, rawPcmBytes, wavBytes } from '../support/audio-fixtures';

describe('identifying audio by signature', () => {
  it('recognises an MP3 that starts with an ID3 tag', () => {
    expect(sniffAudioMediaType(mp3WithId3Bytes())).toBe('audio/mpeg');
  });

  // Both entry points matter: a provider streaming audio commonly omits the metadata tag, so a
  // sniffer that only understood ID3 would reject half of its real output.
  it('recognises an MP3 that starts with a frame header', () => {
    expect(sniffAudioMediaType(mp3FrameBytes())).toBe('audio/mpeg');
  });

  it('recognises a WAV', () => {
    expect(sniffAudioMediaType(wavBytes())).toBe('audio/wav');
  });

  it('refuses an empty buffer', () => {
    expect(sniffAudioMediaType(new Uint8Array(0))).toBeUndefined();
  });

  // The failure this check exists for. Aura's schema permits `linear16` with `container: none`,
  // which is real audio data that no browser will play. Accepting it would put a silent, broken
  // player in front of a visitor with no explanation.
  it('refuses raw headerless PCM, which a browser cannot play', () => {
    expect(sniffAudioMediaType(rawPcmBytes())).toBeUndefined();
  });

  // The other failure that matters: a provider answering with an error document under a success
  // status. Without this the page would get a `data:audio/mpeg` URI containing JSON.
  it('refuses a JSON error document returned under a success status', () => {
    const json = new TextEncoder().encode('{"error":"model unavailable"}');
    expect(sniffAudioMediaType(json)).toBeUndefined();
  });

  it('refuses an HTML error page', () => {
    const html = new TextEncoder().encode('<!doctype html><title>502 Bad Gateway</title>');
    expect(sniffAudioMediaType(html)).toBeUndefined();
  });

  // `RIFF` alone is also AVI. Matching it without checking for `WAVE` would identify a video file
  // as audio, which is precisely the kind of near-miss a two-part signature exists to prevent.
  it('refuses a RIFF container that is not WAVE', () => {
    const avi = new Uint8Array(16);
    avi.set([0x52, 0x49, 0x46, 0x46], 0);
    avi.set([0x41, 0x56, 0x49, 0x20], 8);
    expect(sniffAudioMediaType(avi)).toBeUndefined();
  });

  // The sync word is eleven set bits, which occurs often in arbitrary binary data. Each following
  // field has a reserved encoding a real encoder never emits, and checking them is what separates a
  // confident match from a coincidence.
  it('refuses a frame header whose version field is reserved', () => {
    const bytes = mp3FrameBytes();
    // Version ID `01` is reserved.
    bytes[1] = 0xe9;
    expect(sniffAudioMediaType(bytes)).toBeUndefined();
  });

  it('refuses a frame header whose layer field is reserved', () => {
    const bytes = mp3FrameBytes();
    bytes[1] = 0xf9;
    expect(sniffAudioMediaType(bytes)).toBeUndefined();
  });

  it('refuses a frame header whose bitrate index is invalid', () => {
    const bytes = mp3FrameBytes();
    bytes[2] = 0xf0;
    expect(sniffAudioMediaType(bytes)).toBeUndefined();
  });

  it('refuses a frame header whose sampling rate is reserved', () => {
    const bytes = mp3FrameBytes();
    bytes[2] = 0x9c;
    expect(sniffAudioMediaType(bytes)).toBeUndefined();
  });

  // A sync word found some way into an arbitrary payload says nothing about the payload's format.
  // Scanning for one would turn this check into a way of finding false positives in a text
  // document, so the match is anchored at the start.
  it('does not scan for a frame header further into the payload', () => {
    const text = new TextEncoder().encode('not audio at all, really');
    const bytes = new Uint8Array(text.length + 4);
    bytes.set(text, 0);
    bytes.set([0xff, 0xfb, 0x90, 0x00], text.length);

    expect(sniffAudioMediaType(bytes)).toBeUndefined();
  });

  it('refuses a truncated buffer too short to hold a signature', () => {
    expect(sniffAudioMediaType(new Uint8Array([0xff]))).toBeUndefined();
    expect(sniffAudioMediaType(new Uint8Array([0x49, 0x44]))).toBeUndefined();
  });
});

describe('the playable-type predicate', () => {
  it('accepts the two formats this panel plays', () => {
    expect(isPlayable('audio/mpeg')).toBe(true);
    expect(isPlayable('audio/wav')).toBe(true);
  });

  // Formats Aura's schema permits but a browser handles poorly or not at all. They are absent from
  // the reviewed list rather than offered and then apologised for.
  it('refuses a format the panel does not offer', () => {
    expect(isPlayable('audio/flac')).toBe(false);
    expect(isPlayable('audio/ogg')).toBe(false);
    expect(isPlayable('audio/basic')).toBe(false);
  });
});

describe('reading a duration from the container', () => {
  it('reads a WAV duration from its format chunk', () => {
    expect(readAudioDurationSeconds(wavBytes(2), 'audio/wav')).toBeCloseTo(2, 2);
  });

  it('reads a fractional duration', () => {
    expect(readAudioDurationSeconds(wavBytes(0.5), 'audio/wav')).toBeCloseTo(0.5, 2);
  });

  // Independent of the sample rate: the duration comes from the declared byte rate rather than from
  // an assumption about format.
  it('reads a duration at a different sample rate', () => {
    expect(readAudioDurationSeconds(wavBytes(1.5, 48_000, 2), 'audio/wav')).toBeCloseTo(1.5, 2);
  });

  // Deliberately not attempted. An MP3's duration needs either a constant-bitrate assumption that
  // is wrong for real encoder output, or a walk of every frame. A wrong duration beside a player
  // that disagrees with it is worse than none, so the panel reads the true value from the element.
  it('declines to guess an MP3 duration', () => {
    expect(readAudioDurationSeconds(mp3WithId3Bytes(4_096), 'audio/mpeg')).toBeUndefined();
  });

  it('refuses a WAV too short to carry a header', () => {
    expect(readAudioDurationSeconds(new Uint8Array(20), 'audio/wav')).toBeUndefined();
  });

  // A zero byte rate would otherwise divide by zero and produce `Infinity`, which would render as a
  // nonsensical duration rather than an honest absence.
  it('refuses a WAV declaring a zero byte rate', () => {
    const bytes = wavBytes(1);
    new DataView(bytes.buffer).setUint32(28, 0, true);
    expect(readAudioDurationSeconds(bytes, 'audio/wav')).toBeUndefined();
  });
});

describe('download file names', () => {
  it('names a file from the run identifier and the sniffed extension', () => {
    expect(speechFileName('run-7', 'mp3')).toBe('playground-run-7.mp3');
  });

  // The spoken text is never used. A file name derived from user content is a path-traversal and
  // header-injection surface for no real benefit.
  it('does not incorporate any caller-supplied text', () => {
    expect(speechFileName('run-7', 'wav')).not.toMatch(/[^\w.-]/u);
  });
});
