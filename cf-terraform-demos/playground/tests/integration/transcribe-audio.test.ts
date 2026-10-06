/**
 * @file Workers-runtime tests for the Transcribe Audio surface. These dispatch real requests
 *   through the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The three response envelopes and the per-model request shapes are
 *   covered against a fake inference port in the Worker suite.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES } from '../../src/worker/routes/transcribe-audio';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed model: takes audio as a base64 string.
 */
const TURBO = '@cf/openai/whisper-large-v3-turbo';

/**
 * The partner model: requires an `{ body, contentType }` object and takes BCP-47 language tags.
 */
const NOVA = '@cf/deepgram/nova-3';

/**
 * The byte-array model, whose size ceiling is a quarter of the others'.
 */
const WHISPER = '@cf/openai/whisper';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-2222-4333-8444-555566667777';

/**
 * Builds base64 audio of a given size with a real MP3 signature.
 *
 * A genuine ID3 header rather than arbitrary bytes, because the server identifies the format by
 * signature — a payload of zeroes would be refused as "not audio" and every test here would pass
 * for the wrong reason.
 *
 * @param size How many bytes the decoded file should hold.
 * @returns The base64 representation.
 */
function mp3Base64(size = 2_048): string {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);

  let binary = '';
  const CHUNK = 8_192;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Builds a valid request body.
 *
 * @param overrides Fields to replace or add.
 * @returns The body to send.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { audioBase64: mp3Base64(), model: TURBO, runId: RUN_ID, ...overrides };
}

/**
 * Builds an authenticated `POST` to the Transcribe Audio route.
 *
 * @param email Identity to sign the token for.
 * @param payload Request body to send.
 * @param extraHeaders Additional headers, used to attempt header-based identity smuggling.
 * @returns A request ready to dispatch.
 */
async function postAs(
  email: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request('https://playground.example/api/transcribe-audio', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/transcribe-audio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Every Access application in a team shares a JWKS, so a token minted for an unrelated
  // application would be accepted without this check.
  it('refuses a token minted for another audience', async () => {
    const token = await signDevJwt('alice@example.com', { audience: 'b'.repeat(64) });
    const response = await send(
      new Request('https://playground.example/api/transcribe-audio', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Validation runs for an authenticated caller, so reaching a `400` proves the request got past
  // Access rather than being turned away at the edge.
  it('admits an authenticated caller to validation', async () => {
    const response = await send(await postAs('alice@example.com', { nonsense: true }));
    expect(response.status).toBe(400);
  });
});

describe('request validation at the deployed surface', () => {
  it('rejects absent and empty audio', async () => {
    expect(
      (await send(await postAs('alice@example.com', body({ audioBase64: undefined })))).status
    ).toBe(400);
    expect((await send(await postAs('alice@example.com', body({ audioBase64: '' })))).status).toBe(
      400
    );
  });

  it('rejects a file that is not audio', async () => {
    const text = btoa('x'.repeat(2_048));
    const response = await send(await postAs('alice@example.com', body({ audioBase64: text })));

    expect(response.status).toBe(400);
  });

  it('rejects a file too short to contain speech', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ audioBase64: mp3Base64(16) }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a malformed run identifier', async () => {
    const response = await send(await postAs('alice@example.com', body({ runId: 'short' })));
    expect(response.status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/deepgram/aura-2-en' }))
    );

    expect(response.status).toBe(400);
  });

  // The panel's defining rule, at the deployed surface: the limit is a property of the selected
  // model's contract, so the same file is legitimately accepted for one and refused for another.
  it('refuses for the byte-array model a file it accepts for the others', async () => {
    const large = mp3Base64(1_200 * 1_024);

    const refused = await send(
      await postAs('alice@example.com', body({ model: WHISPER, audioBase64: large }))
    );
    expect(refused.status).toBe(400);

    // Valid for the base64 model, so it fails later at the unavailable binding rather than at
    // validation. That difference is the proof the per-model resolution is really happening.
    const accepted = await send(
      await postAs('alice@example.com', body({ model: TURBO, audioBase64: large }))
    );
    expect(accepted.status).not.toBe(400);
  });

  it('explains why that model\u2019s limit is lower', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: WHISPER, audioBase64: mp3Base64(1_200 * 1_024) })
      )
    );
    const problem = (await response.json()) as { detail: string };

    expect(problem.detail).toMatch(/JSON array of byte values/u);
  });

  // The clearest demonstration that a language code is a per-model contract rather than a
  // universal identifier: the two models that take one use different standards.
  it('accepts a BCP-47 tag only for the model that uses them', async () => {
    const refused = await send(
      await postAs('alice@example.com', body({ model: TURBO, language: 'en-GB' }))
    );
    expect(refused.status).toBe(400);

    const accepted = await send(
      await postAs('alice@example.com', body({ model: NOVA, language: 'en-GB' }))
    );
    expect(accepted.status).not.toBe(400);
  });

  it('rejects a language on the model that takes none', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: WHISPER, language: 'en' }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a control the selected model does not support', async () => {
    expect((await send(await postAs('alice@example.com', body({ diarize: true })))).status).toBe(
      400
    );
    expect((await send(await postAs('alice@example.com', body({ punctuate: true })))).status).toBe(
      400
    );
  });

  it('rejects a context prompt on a model that takes none', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: NOVA, contextPrompt: 'x' }))
    );

    expect(response.status).toBe(400);
  });

  // Individually legal, contradictory together. The provider would silently honour one, and
  // picking a winner on the visitor's behalf would hide which took effect.
  it('rejects a language hint together with language detection', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: NOVA, language: 'en', detectLanguage: true }))
    );

    expect(response.status).toBe(400);
  });

  it('rejects a body over the transport size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(TRANSCRIBE_AUDIO_BODY_LIMIT_BYTES + 1_024);
    const response = await send(
      new Request('https://playground.example/api/transcribe-audio', {
        method: 'POST',
        headers: {
          [JWT_HEADER]: token,
          'content-type': 'application/json',
          'content-length': String(oversized.length)
        },
        body: oversized
      })
    );

    expect(response.status).toBe(400);
  });

  it('answers a GET with a not-found rather than a transcript', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/transcribe-audio', {
        headers: { [JWT_HEADER]: token }
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('identity cannot be supplied by the caller', () => {
  // The body is refused outright rather than having the field stripped, so a caller learns their
  // attempt was noticed instead of believing it worked.
  it('rejects a body carrying an identity field', async () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'mallory@example.com' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  // A header is the other route by which a caller might try to choose who a run is attributed to.
  // The actor comes from the verified JWT claims alone, so a smuggled header changes nothing.
  it('ignores an identity smuggled in a header', async () => {
    const response = await send(
      await postAs('alice@example.com', body(), {
        'cf-access-authenticated-user-email': 'mallory@example.com',
        'x-forwarded-user': 'mallory@example.com'
      })
    );

    // Not a 400: the request is valid. It fails later, at the unavailable `AI` binding.
    expect(response.status).not.toBe(400);
  });
});

describe('the audio cannot be self-described', () => {
  // Refused rather than ignored, and it matters more here than for images: Nova 3's schema
  // requires a content type, so this value becomes a real field of the outgoing request and must
  // come from the bytes rather than from the caller.
  it('rejects a body describing the recording', async () => {
    for (const field of ['mediaType', 'contentType', 'mimeType', 'durationSeconds', 'fileName']) {
      const response = await send(
        await postAs('alice@example.com', body({ [field]: 'audio/wav' }))
      );
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });
});

describe('error responses', () => {
  it('answers a validation failure as RFC 9457 problem details', async () => {
    const response = await send(await postAs('alice@example.com', { nonsense: true }));

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; title: string; detail: string };
    expect(problem.status).toBe(400);
    expect(problem.detail).toBeTruthy();
  });

  // A deployed build must never emit a stack trace: `includeStack` is gated on
  // `import.meta.env.DEV`, which Vite replaces with a literal `false` in production.
  it('leaks no stack trace', async () => {
    const text = await (await send(await postAs('alice@example.com', { nonsense: true }))).text();

    expect(text).not.toMatch(/\n\s*at\s/u);
    expect(text).not.toContain('.ts:');
  });

  // The context prompt is the visitor's own text. An error that quoted it back would put it in one
  // more place — including any intermediary that logs response bodies.
  it('does not echo a context prompt back in an error', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ model: NOVA, contextPrompt: 'a confidential codename' })
      )
    );

    expect(await response.text()).not.toContain('a confidential codename');
  });

  it('does not echo the submitted audio back in an error', async () => {
    const audio = mp3Base64();
    const response = await send(
      await postAs('alice@example.com', body({ audioBase64: audio, diarize: true }))
    );

    expect(await response.text()).not.toContain(audio.slice(0, 64));
  });
});

describe('the panel catalogue', () => {
  // The browser builds its selector, its controls, *and its file size limit* from this response,
  // so a panel listed without reviewed models would produce an empty selector
  // and a zero-byte upload ceiling in the deployed UI.
  it('advertises Transcribe Audio with reviewed models', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const response = await send(
      new Request('https://playground.example/api/catalogue', {
        headers: { [JWT_HEADER]: token }
      })
    );

    const payload = (await response.json()) as {
      tasks: {
        id: string;
        gateway: string;
        hosting: { cloudflare: boolean; thirdParty: boolean };
      }[];
      models: {
        id: string;
        task: string;
        provider: string;
        transcriptionControls?: {
          audioEncoding: string;
          maxAudioBytes: number;
          pricePerAudioMinuteUsd?: number;
        };
      }[];
    };

    const task = payload.tasks.find((candidate) => candidate.id === 'transcribe-audio');
    expect(task).toMatchObject({ gateway: 'required' });

    const models = payload.models.filter((candidate) => candidate.task === 'transcribe-audio');
    expect(models.length).toBeGreaterThan(0);

    // Every reviewed model is Cloudflare-hosted, which is why this panel could be delivered
    // without prepaid AI Gateway credit.
    for (const model of models) {
      expect(model.provider, `${model.id} is Cloudflare-hosted`).toBe('workers-ai');
      expect(model.transcriptionControls, `${model.id} publishes controls`).toBeDefined();
      // The browser refuses an oversized file before uploading it, which it can only do if every
      // model publishes a real ceiling.
      expect(
        model.transcriptionControls?.maxAudioBytes,
        `${model.id} publishes a size ceiling`
      ).toBeGreaterThan(0);
      // A rate is optional, because one reviewed model genuinely publishes none — but a rate that
      // is present must be real. Zero would format as `$0.0000` and read as "free", which is a
      // false claim where an absent value is an honest one the panel states in words.
      const rate = model.transcriptionControls?.pricePerAudioMinuteUsd;
      if (rate !== undefined) {
        expect(rate, `${model.id} publishes a positive rate`).toBeGreaterThan(0);
      }
    }

    // The three encodings are the reason this panel exists in the shape it does, so the catalogue
    // has to carry all three for the UI to size its uploads correctly.
    const encodings = models.map((model) => model.transcriptionControls?.audioEncoding);
    expect(new Set(encodings).size).toBe(3);
  });
});
