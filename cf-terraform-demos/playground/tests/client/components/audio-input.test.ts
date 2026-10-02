import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canRecordAudio,
  classifyRecordingFailure,
  encodeAudioBase64,
  formatAudioBytes,
  MIN_AUDIO_UPLOAD_BYTES,
  preferredRecordingMimeType,
  prepareAudio,
  recordingFileName
} from '../../../src/client/components/media/audio-input';

/**
 * A generous ceiling, for tests where the limit is not what is under test.
 */
const LARGE = 4 * 1_024 * 1_024;

/**
 * Builds a `File` reporting an audio type.
 *
 * @param size How many bytes it should hold.
 * @param type Media type to report.
 * @param name File name to report.
 * @returns The file.
 */
function audioFile(size = 2_048, type = 'audio/mpeg', name = 'clip.mp3'): File {
  return new File([new Uint8Array(size)], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preparing a chosen file', () => {
  it('accepts an ordinary audio file', async () => {
    const outcome = await prepareAudio(audioFile(), LARGE);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.audio.byteLength).toBe(2_048);
      expect(outcome.audio.fileName).toBe('clip.mp3');
      expect(outcome.audio.recorded).toBe(false);
    }
  });

  it('builds a playable preview URI', async () => {
    const outcome = await prepareAudio(audioFile(), LARGE);

    expect(outcome.ok && outcome.audio.previewUri.startsWith('data:audio/mpeg;base64,')).toBe(true);
  });

  // Checked loosely and only to catch an obvious mistake. The server identifies the format from
  // the bytes, so a strict check here would reject real audio whose platform-specific type string
  // is not in any list.
  it('refuses a file that is plainly not audio', async () => {
    const outcome = await prepareAudio(
      new File([new Uint8Array(2_048)], 'doc.pdf', { type: 'application/pdf' }),
      LARGE
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('unsupported-type');
  });

  it('accepts a file whose type the browser did not report', async () => {
    const outcome = await prepareAudio(audioFile(2_048, ''), LARGE);

    expect(outcome.ok).toBe(true);
    // Falls back to a playable type, because an empty media type in a `data:` URI is unplayable.
    expect(outcome.ok && outcome.audio.previewUri.startsWith('data:audio/webm')).toBe(true);
  });

  it('accepts a platform-specific WAV type string', async () => {
    expect((await prepareAudio(audioFile(2_048, 'audio/x-wav'), LARGE)).ok).toBe(true);
  });

  it('refuses a file below the floor', async () => {
    const outcome = await prepareAudio(audioFile(MIN_AUDIO_UPLOAD_BYTES - 1), LARGE);

    expect(!outcome.ok && outcome.reason).toBe('too-small');
  });
});

describe('the per-model size limit', () => {
  // The substance of this panel: the limit is a property of the model's contract, so it is passed
  // in rather than read from a constant.
  it('refuses a file beyond the limit it was given', async () => {
    const outcome = await prepareAudio(audioFile(100_000), 4_096);

    expect(!outcome.ok && outcome.reason).toBe('too-large');
  });

  it('accepts the same file against a larger limit', async () => {
    expect((await prepareAudio(audioFile(100_000), LARGE)).ok).toBe(true);
  });

  // A visitor who just succeeded with the same file on another model would otherwise reasonably
  // conclude the panel was broken, so the message names the limit actually in force.
  it('quotes the limit in force and attributes it to the model', async () => {
    const outcome = await prepareAudio(audioFile(100_000), 4_096);

    expect(!outcome.ok && outcome.message).toMatch(/4 KB/u);
    expect(!outcome.ok && outcome.message).toMatch(/selected model/u);
  });
});

describe('recording support detection', () => {
  // The panel must work without it. Offering a button that throws on click is worse than not
  // offering it, which is why this is checked rather than assumed.
  it('reports no support when MediaRecorder is absent', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(canRecordAudio()).toBe(false);
  });

  // Absent outside a secure context, and separately from `MediaRecorder` — a browser can have one
  // without the other, so the two halves are stubbed independently.
  it('reports no support when getUserMedia is absent', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('navigator', { mediaDevices: undefined });

    expect(canRecordAudio()).toBe(false);
  });

  it('reports support when both APIs are present', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });

    expect(canRecordAudio()).toBe(true);
  });
});

describe('negotiating a recording format', () => {
  // Browsers disagree and do not overlap: Chrome and Firefox produce WebM, Safari produces MP4.
  // Asking for an unsupported type makes `MediaRecorder` throw.
  it('prefers Opus in WebM where it is supported', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });

    expect(preferredRecordingMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('falls back to MP4 on a browser that only supports it', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/mp4'
    });

    expect(preferredRecordingMimeType()).toBe('audio/mp4');
  });

  // Letting the recorder pick its own default is the right fallback for a browser whose support
  // this list does not predict.
  it('defers to the browser when nothing in the list is supported', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });

    expect(preferredRecordingMimeType()).toBeUndefined();
  });

  it('defers when the browser cannot be asked', () => {
    vi.stubGlobal('MediaRecorder', undefined);

    expect(preferredRecordingMimeType()).toBeUndefined();
  });
});

describe('classifying a recording failure', () => {
  // The two outcomes need opposite advice: a denial is a decision the visitor can revisit, while
  // a device fault is something retrying might genuinely fix.
  it('treats a permission refusal as a denial', () => {
    expect(classifyRecordingFailure(new DOMException('no', 'NotAllowedError'))).toBe('denied');
  });

  // What older WebKit raised for the same situation. Treating it as a device fault would send the
  // visitor to debug hardware that is working.
  it('treats a security error as a denial', () => {
    expect(classifyRecordingFailure(new DOMException('no', 'SecurityError'))).toBe('denied');
  });

  it('treats a missing device as a failure', () => {
    expect(classifyRecordingFailure(new DOMException('none', 'NotFoundError'))).toBe('failed');
  });

  it('treats anything else as a failure', () => {
    expect(classifyRecordingFailure(new Error('something odd'))).toBe('failed');
    expect(classifyRecordingFailure(undefined)).toBe('failed');
  });
});

describe('naming a recording', () => {
  it('uses a timestamp and the matching extension', () => {
    const name = recordingFileName('audio/webm;codecs=opus', Date.UTC(2026, 2, 4, 9, 30, 0));

    expect(name).toBe('recording-20260304093000.webm');
  });

  it('uses an mp4 extension for an mp4 recording', () => {
    expect(recordingFileName('audio/mp4', 0).endsWith('.mp4')).toBe(true);
  });

  it('defaults to webm when the type is unknown', () => {
    expect(recordingFileName(undefined, 0).endsWith('.webm')).toBe(true);
  });

  // Colons are not safe in a file name on every platform, so the ISO timestamp is reduced to
  // digits rather than used as-is.
  it('produces a name safe on every platform', () => {
    expect(recordingFileName('audio/webm', Date.now())).not.toMatch(/[^\w.-]/u);
  });
});

describe('encoding and formatting', () => {
  it('encodes bytes as base64', () => {
    expect(encodeAudioBase64(new Uint8Array([72, 105]))).toBe('SGk=');
  });

  // `String.fromCharCode(...bytes)` on a multi-megabyte file exceeds the argument limit and throws
  // a `RangeError`. Audio files are routinely large enough for this to be the common path.
  it('encodes a payload far beyond the spread-argument limit', () => {
    const large = new Uint8Array(500_000).fill(65);

    expect(() => encodeAudioBase64(large)).not.toThrow();
    expect(encodeAudioBase64(large).length).toBeGreaterThan(600_000);
  });

  it('formats sizes readably', () => {
    expect(formatAudioBytes(2 * 1_024 * 1_024)).toBe('2.0 MB');
    expect(formatAudioBytes(4_096)).toBe('4 KB');
  });
});
