/**
 * @file Generate Music route tests. Mounted without the Access middleware — authentication is
 *   covered against the real Worker in the Workers-runtime suite — so a failure here points at the
 *   handler rather than the middleware stack. The logging assertions carry more weight on this
 *   panel than on most, for a specific reason: this is the first panel whose log lines are the only
 *   record of **what something was expected to cost**, in a unit that is not tokens. A run whose
 *   reported cost diverges from its estimate is worth noticing, and a log line that recorded a bare
 *   number without its unit would be ambiguous between the two models.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_MUSIC_PROMPT_CHARACTERS,
  type GeneratedTrack,
  type GenerateMusicResponse
} from '../../../src/shared/generate-music';
import { GenerateMusicService } from '../../../src/worker/application/generate-music/generate-music-service';
import type { GeneratedAudioPort } from '../../../src/worker/application/ports/generated-audio-port';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  GENERATE_MUSIC_BODY_LIMIT_BYTES,
  generateMusicRouter
} from '../../../src/worker/routes/generate-music';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed music models, in catalogue order.
 */
const [ELEVENLABS, MINIMAX] = modelsForTask('generate-music');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'd1d1d1d1-2222-4333-8444-555566667777';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * A provider URL on an approved host for the default model.
 */
const TRACK_URL = 'https://examples.aig.cloudflare.com/elevenlabs/music-v2/track.mp3';

/**
 * A verified track, as the retrieval port returns one.
 */
const TRACK: GeneratedTrack = {
  base64: 'SUQzAwA=',
  mediaType: 'audio/mpeg',
  byteLength: 2_048,
  sourceHost: 'examples.aig.cloudflare.com'
};

/**
 * A retrieval port returning a fixed verified track.
 *
 * @returns The port.
 */
function audioPort(): GeneratedAudioPort {
  return {
    /**
     * Returns the fixed track without a network request.
     *
     * @returns The verified track.
     */
    fetchTrack: async (): Promise<GeneratedTrack> => TRACK
  };
}

/**
 * Mounts the Generate Music router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to the nested envelope both models
 *   document.
 * @param identity Verified identity to present.
 * @returns The app and the captured logs.
 */
function mount(
  options: FakeInferenceOptions = {},
  identity: { email: string; sub: string } | undefined = IDENTITY
): { app: ReturnType<typeof mountRoute>['app']; logs: LogCapture } {
  const inference = new FakeInference({
    output: () => ({ state: 'Completed', result: { audio: TRACK_URL } }),
    ...options
  });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new GenerateMusicService({
    inference,
    runs: createMemoryRunRepository(now),
    audio: audioPort(),
    logger,
    now
  });

  const mounted = mountRoute('/api/generate-music', generateMusicRouter, {
    identity,
    generateMusicService: service,
    logger
  });
  mounted.app.onError(problemDetailsErrorHandler({ includeStack: false }));

  return { app: mounted.app, logs: capture };
}

/**
 * Posts a body to the route.
 *
 * @param app App to dispatch through.
 * @param payload Body to send.
 * @returns The response.
 */
async function post(
  app: ReturnType<typeof mountRoute>['app'],
  payload: unknown
): Promise<Response> {
  return app.request('/api/generate-music', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Builds a valid body.
 *
 * @param overrides Fields to replace or add.
 * @returns The body to send.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'A warm cinematic ambient piece',
    model: ELEVENLABS!.id,
    runId: RUN_ID,
    instrumental: true,
    ...overrides
  };
}

beforeEach(() => {
  clearRunRecords();
});

describe('POST /api/generate-music', () => {
  it('returns the track, the receipt, and the applied controls', async () => {
    const { app } = mount();
    const response = await post(app, body({ lengthSeconds: 30 }));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as GenerateMusicResponse;
    expect(payload.track).toEqual(TRACK);
    expect(payload.receipt.task).toBe('generate-music');
    expect(payload.applied.lengthSeconds).toBe(30);
    expect(payload.applied.pricingUnit).toBe('audio-second');
  });

  // The response carries the audio rather than the provider's URL, so the browser never makes a
  // request to a third-party CDN and never renders a link that may already have expired.
  it('returns audio bytes and never the provider\u2019s URL', async () => {
    const { app } = mount();
    const text = await (await post(app, body())).text();

    expect(text).toContain('"base64"');
    expect(text).not.toContain(TRACK_URL);
  });

  it('reports the billing unit and cost basis in the response', async () => {
    const { app } = mount();
    const payload = (await (
      await post(app, body({ lengthSeconds: 20 }))
    ).json()) as GenerateMusicResponse;

    expect(payload.applied.estimatedCostUsd).toBeCloseTo(0.05, 10);
    expect(payload.applied.costBasis).toContain('per second of output audio');
  });

  it('answers a validation failure as RFC 9457 problem details', async () => {
    const { app } = mount();
    const response = await post(app, { nonsense: true });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; detail: string };
    expect(problem.status).toBe(400);
    expect(problem.detail).toBeTruthy();
  });

  it('refuses a body over the size limit', async () => {
    const { app } = mount();
    const response = await app.request('/api/generate-music', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(GENERATE_MUSIC_BODY_LIMIT_BYTES + 1_024)
      },
      body: 'x'.repeat(GENERATE_MUSIC_BODY_LIMIT_BYTES + 1_024)
    });

    expect(response.status).toBe(400);
  });

  it('answers a GET with a not-found rather than a track', async () => {
    const { app } = mount();
    expect((await app.request('/api/generate-music')).status).toBe(404);
  });
});

describe('the billing failure', () => {
  // The expected outcome on an unfunded account, because every reviewed music model is third-party.
  // The inference client raises the `503` in exactly one place and the route must let it through
  // unchanged, since the panel presents a billing failure differently from a provider one.
  it('passes the gateway\u2019s 503 through unchanged', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail:
          'This model uses prepaid AI Gateway credits, and this account does not have enough '
          + 'credit for the request. Add AI Gateway credits, then try again.'
      })
    });

    const response = await post(app, body());

    expect(response.status).toBe(503);
    const problem = (await response.json()) as { detail: string };
    expect(problem.detail).toMatch(/AI Gateway credits/iu);
  });

  // The classified reason is the field that distinguishes "top up the account" from "try again" in a
  // log, exactly as it does in the UI. Without it a `503` and a `502` are indistinguishable in a
  // search by run identifier.
  it('logs the classified reason against the run identifier', async () => {
    const { app, logs } = mount({
      failWith: new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail: 'Add AI Gateway credits, then try again.'
      })
    });

    await post(app, body());

    const failed = logs.entries.find((entry) => entry.message === 'generate_music_run_failed');
    expect(failed?.context?.['runId']).toBe(RUN_ID);
    expect(failed?.context?.['reason']).toBe('insufficient-credit');
  });

  it('logs a provider failure as a provider failure rather than a billing one', async () => {
    const { app, logs } = mount({ output: () => ({}) });

    expect((await post(app, body())).status).toBe(502);

    const failed = logs.entries.find((entry) => entry.message === 'generate_music_run_failed');
    expect(failed?.context?.['reason']).toBe('provider-failure');
  });
});

describe('structured logging', () => {
  // Logged before the model is called. A request that fails inside the provider, times out, or is
  // cancelled mid-flight would otherwise leave no record of having been attempted — which is
  // precisely the case where knowing what was asked for, and what it was expected to cost, matters
  // most.
  it('logs an attempt before calling the model', async () => {
    const { app, logs } = mount();
    await post(app, body({ lengthSeconds: 30 }));

    const started = logs.entries.find((entry) => entry.message === 'generate_music_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: ELEVENLABS!.id,
      lengthSeconds: 30,
      instrumental: true,
      pricingUnit: 'audio-second'
    });
    expect(started?.context?.['estimatedCostUsd']).toBeCloseTo(0.075, 10);
  });

  // The estimate's *unit* travels with it, because a bare figure is ambiguous between the two models
  // on this panel. Both log lines carry it.
  it('logs the billing unit beside every cost estimate', async () => {
    const { app, logs } = mount();
    await post(app, body({ model: MINIMAX!.id, format: 'mp3' }));

    const started = logs.entries.find((entry) => entry.message === 'generate_music_run_started');
    const completed = logs.entries.find(
      (entry) => entry.message === 'generate_music_run_completed'
    );

    expect(started?.context?.['pricingUnit']).toBe('track');
    expect(completed?.context?.['pricingUnit']).toBe('track');
    expect(completed?.context?.['estimatedCostUsd']).toBeCloseTo(0.15, 10);
  });

  it('logs the completion with the retrieved track\u2019s facts', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const completed = logs.entries.find(
      (entry) => entry.message === 'generate_music_run_completed'
    );
    expect(completed?.context).toMatchObject({
      runId: RUN_ID,
      mediaType: 'audio/mpeg',
      byteLength: 2_048,
      // Named so the panel's expiry disclosure and the log agree about which host served the
      // original, and so a provider moving CDN is diagnosable from the log.
      sourceHost: 'examples.aig.cloudflare.com'
    });
  });

  // Absent for MP3, which is the common case. Recorded as `null` rather than omitted, so a log
  // search for the key does not imply a bug.
  it('records an absent duration as null rather than omitting the field', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const completed = logs.entries.find(
      (entry) => entry.message === 'generate_music_run_completed'
    );
    expect(completed?.context?.['durationSeconds']).toBeNull();
  });

  // The prompt and the lyrics are the visitor's content. Their lengths distinguish a real request
  // from an empty one without retaining what was written.
  it('logs the prompt and lyrics lengths rather than their content', async () => {
    const { app, logs } = mount();
    await post(
      app,
      body({
        model: MINIMAX!.id,
        format: 'mp3',
        instrumental: false,
        prompt: 'a confidential brief about an unreleased product',
        lyrics: 'secret words here'
      })
    );

    const started = logs.entries.find((entry) => entry.message === 'generate_music_run_started');
    expect(started?.context?.['promptCharacters']).toBe(48);
    expect(started?.context?.['lyricsCharacters']).toBe(17);
    expect(started?.context?.['lyricsSource']).toBe('caller');

    const text = logs.text();
    expect(text).not.toContain('confidential brief');
    expect(text).not.toContain('secret words here');
  });

  // The verified email belongs in AI Gateway metadata and nowhere else: a structured log is a
  // different retention domain with different access control.
  it('never logs the verified email', async () => {
    const { app, logs } = mount();
    await post(app, body());

    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  // Every line carries the run identifier, so one search returns the whole story of one request
  // rather than fragments of several.
  it('correlates every line by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const lines = logs.entries.filter((entry) => entry.message.startsWith('generate_music_'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.context?.['runId'], line.message).toBe(RUN_ID);
    }
  });
});

describe('request rules at the route', () => {
  // Asserted here as well as in the domain tests, because these are the refusals a caller meets and
  // the route is where they become a status code.
  it.each(['user', 'email', 'actor', 'sub'])('refuses identity field %s', async (field) => {
    const { app } = mount();
    const response = await post(app, body({ [field]: 'mallory@example.com' }));

    expect(response.status).toBe(400);
  });

  it.each(['audio', 'audioUrl', 'mediaType', 'durationSeconds'])(
    'refuses output-describing field %s',
    async (field) => {
      const { app } = mount();
      const response = await post(app, body({ [field]: 'https://evil.example/track.mp3' }));

      expect(response.status).toBe(400);
    }
  );

  it('refuses a prompt beyond the character limit', async () => {
    const { app } = mount();
    const response = await post(app, body({ prompt: 'a'.repeat(MAX_MUSIC_PROMPT_CHARACTERS + 1) }));

    expect(response.status).toBe(400);
  });

  it('refuses a length for the model that has no length parameter', async () => {
    const { app } = mount();
    const response = await post(
      app,
      body({ model: MINIMAX!.id, format: 'mp3', lengthSeconds: 30 })
    );

    expect(response.status).toBe(400);
  });

  it('refuses a vocal track with no words for the model that requires them', async () => {
    const { app } = mount();
    const response = await post(
      app,
      body({ model: MINIMAX!.id, format: 'mp3', instrumental: false })
    );

    expect(response.status).toBe(400);
  });

  // The prompt is the visitor's content. An error that quoted it back would put it in one more
  // place, including any intermediary that logs response bodies.
  it('does not echo the prompt in an error response', async () => {
    const { app } = mount();
    const response = await post(
      app,
      body({ prompt: 'a confidential brief', model: 'not-a-model' })
    );

    expect(await response.text()).not.toContain('a confidential brief');
  });
});
