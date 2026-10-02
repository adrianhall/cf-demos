/**
 * @file Builders for real audio bytes, used wherever a test needs audio the production code will
 *   actually accept. These construct genuine headers rather than returning a canned base64 blob,
 *   for the same reason the image fixtures do: the code under test identifies a format by its
 *   signature and reads a WAV's duration from its header, so a fixture has to carry both. Building
 *   them here means a test can ask for "a WAV that plays for two seconds" rather than hunting for a
 *   file that happens to.
 */

/**
 * Builds an MP3 that begins with an ID3v2 tag.
 *
 * The common shape in practice: most encoders write metadata before the first audio frame, so this
 * is the path the sniffer takes for real provider output rather than an edge case.
 *
 * @param padding Extra trailing bytes, to reach a particular file size.
 * @returns The MP3 bytes.
 */
export function mp3WithId3Bytes(padding = 32): Uint8Array {
  const bytes = new Uint8Array(10 + padding);
  // "ID3", major version 3, revision 0.
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);
  return bytes;
}

/**
 * Builds an MP3 that begins directly with a frame header, carrying no ID3 tag.
 *
 * Emitted by some encoders and by streaming endpoints, so both entry points into the sniffer need a
 * fixture. The header fields are set to a legal combination — MPEG-1 Layer III, 128 kbit/s, 44.1
 * kHz — because the sniffer validates each field rather than trusting the sync word alone.
 *
 * @param padding Extra trailing bytes, to reach a particular file size.
 * @returns The MP3 bytes.
 */
export function mp3FrameBytes(padding = 32): Uint8Array {
  const bytes = new Uint8Array(4 + padding);
  // Sync word plus MPEG-1 Layer III, no CRC.
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  // Bitrate index 9 (128 kbit/s) and sampling-rate index 0 (44.1 kHz).
  bytes[2] = 0x90;
  bytes[3] = 0x00;
  return bytes;
}

/**
 * Builds a canonical 44-byte-header WAV file.
 *
 * The byte rate is written into the format chunk and the sample data is sized to match the
 * requested duration, so `readAudioDurationSeconds` has a real header to read rather than a
 * plausible-looking one.
 *
 * @param durationSeconds How long the audio should claim to play for.
 * @param sampleRate Samples per second to declare.
 * @param channels Channel count to declare.
 * @param bitsPerSample Sample depth to declare.
 * @returns The WAV bytes.
 */
export function wavBytes(
  durationSeconds = 1,
  sampleRate = 24_000,
  channels = 1,
  bitsPerSample = 16
): Uint8Array {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const dataLength = Math.round(byteRate * durationSeconds);

  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);

  // "RIFF", the overall chunk size, then "WAVE".
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);

  // "fmt " chunk: 16 bytes of PCM format description.
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  // Format tag 1 is uncompressed PCM.
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);

  // "data" chunk header; the samples themselves are left as silence.
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataLength, true);

  return bytes;
}

/**
 * Builds raw headerless PCM.
 *
 * Exists because Aura's schema genuinely permits `linear16` with `container: none`, which a browser
 * will not play. The sniffer has to refuse it, and refusing it has to be tested against bytes that
 * really are headerless rather than against arbitrary junk.
 *
 * @param length How many bytes to produce.
 * @returns The PCM bytes.
 */
export function rawPcmBytes(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  // A quiet sawtooth, so the content is plausible sample data rather than a run of zeroes that
  // might match some future signature by accident.
  for (let index = 0; index < length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

/**
 * Builds an Ogg file.
 *
 * Only the page header is real. That is enough, because nothing in this demo decodes audio — the
 * Worker identifies the container and forwards the bytes.
 *
 * @param length Total size to produce.
 * @returns The Ogg bytes.
 */
export function oggBytes(length = 512): Uint8Array {
  const bytes = new Uint8Array(length);
  // "OggS"
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
  return bytes;
}

/**
 * Builds a WebM/Matroska file.
 *
 * The format a browser's own recorder produces in Chrome and Firefox, so this fixture covers the
 * microphone path rather than an exotic case.
 *
 * @param length Total size to produce.
 * @returns The WebM bytes.
 */
export function webmBytes(length = 512): Uint8Array {
  const bytes = new Uint8Array(length);
  // EBML header.
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}

/**
 * Builds an ISO base-media (MP4/M4A) file.
 *
 * The signature sits at offset four, after the box size, which is the detail an intuitive
 * implementation gets wrong — so the fixture places it correctly and a test asserts the sniffer
 * finds it there.
 *
 * @param length Total size to produce.
 * @returns The MP4 bytes.
 */
export function mp4Bytes(length = 512): Uint8Array {
  const bytes = new Uint8Array(length);
  // Box size, then "ftyp", then a brand.
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x4d, 0x34, 0x41, 0x20], 8);
  return bytes;
}

/**
 * Wraps bytes in a `ReadableStream`, as the Workers AI binding returns them.
 *
 * A function rather than a shared value, because a stream is single-use: one built at module scope
 * would be consumed by the first test to read it and empty for every test after.
 *
 * @param bytes Data the stream should emit.
 * @param chunkSize How many bytes per chunk, so a test can exercise a multi-chunk read.
 * @returns A stream emitting the bytes.
 */
export function streamOf(bytes: Uint8Array, chunkSize = 16): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    /**
     * Emits the bytes in fixed-size chunks and closes.
     *
     * @param controller The stream's controller.
     * @returns Nothing; the stream is closed once every chunk has been enqueued.
     */
    start(controller): void {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    }
  });
}
