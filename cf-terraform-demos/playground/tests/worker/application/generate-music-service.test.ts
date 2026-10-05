/**
 * @file Generate Music service tests. The service's job is narrow — call the model, read the audio
 *   location out of whichever envelope came back, hand the URL to the retrieval port, and build a
 *   receipt — so these tests concentrate on the three things that are easy to get wrong and
 *   invisible when they are. **The envelope reader.** Both reviewed models document a nested `{
 *   state, result: { audio } }` shape, and the binding sometimes unwraps a Unified Catalog envelope
 *   before the application sees it. Both forms are covered, and every malformed shape is covered
 *   too, because the failure mode of a careless reader is a `TypeError` that the toolkit renders as
 *   "An unexpected error occurred" with nothing in the log. **The host allowlist is the port's, not
 *   the service's.** The service must pass the descriptor's own host list through unchanged. A
 *   service that substituted its own list, or passed an empty one, would either refuse every result
 *   or accept any host — and the test that catches that has to assert on what the port was _given_.
 *   **The insufficient-credit path.** This is the condition an unfunded account actually meets on
 *   this panel, and it must surface as the shared `503` rather than as a generic `502`. It is
 *   verified against the real classifier so the panel cannot drift onto a second opinion about what
 *   counts as a billing failure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { GeneratedTrack } from '../../../src/shared/generate-music';
import {
  GenerateMusicService,
  classifyMusicFailure
} from '../../../src/worker/application/generate-music/generate-music-service';
import type { GeneratedAudioPort } from '../../../src/worker/application/ports/generated-audio-port';
import { validateGenerateMusicRequest } from '../../../src/worker/domain/generate-music';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';
import { problemWithStatus } from '../support/problem-details';

/**
 * The reviewed music models, in catalogue order.
 */
const [ELEVENLABS, MINIMAX] = modelsForTask('generate-music');

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee11-2222-4333-8444-555566667777';

/**
 * The verified identity runs are attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

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
 * Records what the retrieval port was asked for, so a test can assert on the host list it received.
 *
 * @param track Track to return, or an error to throw instead.
 * @returns The port and the calls made against it.
 */
function audioPort(track: GeneratedTrack | Error = TRACK): {
  port: GeneratedAudioPort;
  calls: { reference: string; allowedHosts: readonly string[] }[];
} {
  const calls: { reference: string; allowedHosts: readonly string[] }[] = [];

  return {
    calls,
    port: {
      /**
       * Records the call and returns the configured outcome.
       *
       * @param reference URL the service passed through.
       * @param allowedHosts Host list the service passed through.
       * @returns The configured track.
       * @throws {Error} The configured error, when one was given.
       */
      fetchTrack: async (reference, allowedHosts): Promise<GeneratedTrack> => {
        calls.push({ reference, allowedHosts });
        if (track instanceof Error) {
          throw track;
        }
        return track;
      }
    }
  };
}

/**
 * Builds the service with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to the nested envelope both models
 *   document.
 * @param audio Retrieval port to use.
 * @returns The service, the fakes, and the captured logs.
 */
function build(
  options: FakeInferenceOptions = {},
  audio = audioPort()
): {
  service: GenerateMusicService;
  inference: FakeInference;
  audio: ReturnType<typeof audioPort>;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({
    output: () => ({ state: 'Completed', result: { audio: TRACK_URL } }),
    ...options
  });
  const { capture, logger } = createLogCapture();
  // One clock for both. The repository prunes records past its retention window, so a service
  // writing at an injected fixed time into a repository reading the real clock would have its record
  // expire the instant it was saved.
  const now = (): number => 1_000;

  return {
    service: new GenerateMusicService({
      inference,
      runs: createMemoryRunRepository(now),
      audio: audio.port,
      logger,
      now
    }),
    inference,
    audio,
    logs: capture
  };
}

/**
 * Validates a request body, so the service receives the type it requires.
 *
 * @param overrides Fields to replace or add.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}) {
  return validateGenerateMusicRequest({
    prompt: 'A warm cinematic ambient piece',
    model: ELEVENLABS!.id,
    runId: RUN_ID,
    instrumental: true,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('generating a track', () => {
  it('returns the verified track, a receipt, and the applied controls', async () => {
    const { service } = build();
    const result = await service.generate(request({ lengthSeconds: 30 }), ACTOR);

    expect(result.track).toEqual(TRACK);
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'generate-music',
      model: ELEVENLABS!.id,
      gatewayRouted: true,
      status: 'completed',
      costStatus: 'pending'
    });
    expect(result.applied.lengthSeconds).toBe(30);
  });

  it('routes the call through the gateway with the panel\u2019s task identifier', async () => {
    const { service, inference } = build();
    await service.generate(request(), ACTOR);

    expect(inference.requests[0]).toMatchObject({
      task: 'generate-music',
      model: ELEVENLABS,
      runId: RUN_ID
    });
  });

  // The attribution rule, asserted at the boundary that reaches the gateway. A run that could be
  // made without an identity would be a run producing an unattributable charge — which on this
  // panel is a charge against prepaid credit.
  it('attributes the run to the verified actor', async () => {
    const { service, inference } = build();
    await service.generate(request(), ACTOR);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  it('sends the provider payload the domain built', async () => {
    const { service, inference } = build();
    await service.generate(request({ lengthSeconds: 20, format: 'mp3_44100_192' }), ACTOR);

    expect(inference.requests[0]?.input).toMatchObject({
      music_length_ms: 20_000,
      output_format: 'mp3_44100_192',
      force_instrumental: true
    });
  });

  // No job, no Workflow, no storage. The service completes the work inside the call because neither
  // reviewed model has a job API, so the receipt is complete when the method returns and the run
  // record is written before it does.
  it('completes within the request and leaves a readable run record', async () => {
    const { service } = build();
    const result = await service.generate(request(), ACTOR);

    expect(result.receipt.status).toBe('completed');
    expect(result.receipt.logIds).toEqual(['log-1']);
  });

  // A run with no gateway log can never resolve a cost, so the receipt says so immediately rather
  // than leaving the browser to poll for a figure that will never arrive.
  it('reports an unavailable cost when the gateway assigned no log', async () => {
    const { service } = build({ logId: null });
    const result = await service.generate(request(), ACTOR);

    expect(result.receipt.logIds).toEqual([]);
    expect(result.receipt.costStatus).toBe('unavailable');
  });

  // The cost estimate travels with its unit. A figure without one would be the exact ambiguity this
  // panel exists to remove, since the same number means different things for the two models.
  it('reports the estimate together with the billing unit, never a token count', async () => {
    const { service } = build();

    const perSecond = await service.generate(request({ lengthSeconds: 30 }), ACTOR);
    expect(perSecond.applied.pricingUnit).toBe('audio-second');
    expect(perSecond.applied.estimatedCostUsd).toBeCloseTo(0.075, 10);

    clearRunRecords();
    const perTrack = await service.generate(request({ model: MINIMAX!.id, format: 'mp3' }), ACTOR);
    expect(perTrack.applied.pricingUnit).toBe('track');
    expect(perTrack.applied.estimatedCostUsd).toBeCloseTo(0.15, 10);
    expect(perTrack.applied.lengthSeconds).toBeUndefined();
  });
});

describe('reading the audio location', () => {
  // The shape both catalogue pages document.
  it('reads the nested result envelope', async () => {
    const { service, audio } = build({
      output: () => ({ state: 'Completed', result: { audio: TRACK_URL } })
    });
    await service.generate(request(), ACTOR);

    expect(audio.calls[0]?.reference).toBe(TRACK_URL);
  });

  // The binding sometimes unwraps a Unified Catalog envelope before the application sees it, so a
  // reader that depended on the nesting would break on a shape the platform genuinely produces.
  it('reads a flattened envelope', async () => {
    const { service, audio } = build({ output: () => ({ audio: TRACK_URL }) });
    await service.generate(request(), ACTOR);

    expect(audio.calls[0]?.reference).toBe(TRACK_URL);
  });

  // Every malformed shape, because the failure mode of a careless reader is a `TypeError` the
  // toolkit renders as "An unexpected error occurred" while logging nothing at all.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'https://example.invalid/track.mp3'],
    ['a number', 42],
    ['an empty object', {}],
    ['an envelope with no audio', { state: 'Completed', result: {} }],
    ['a null result', { state: 'Completed', result: null }],
    ['a non-string audio', { state: 'Completed', result: { audio: 42 } }],
    ['a blank audio', { state: 'Completed', result: { audio: '   ' } }],
    ['an empty audio', { audio: '' }]
  ])('reports %s output as a sanitised 502', async (_label, output) => {
    const { service, audio } = build({ output: () => output });

    await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(502));
    // Nothing was fetched, so a broken envelope cannot become an outbound request.
    expect(audio.calls).toEqual([]);
  });

  // Recorded by shape only. A model that changed its response envelope is identified immediately
  // from the key list, while a short-lived credentialed URL does not end up in a log that outlives
  // it.
  it('logs a broken envelope by shape, without its content', async () => {
    const { service, logs } = build({
      output: () => ({ state: 'Completed', unexpected: TRACK_URL })
    });

    await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(502));

    const line = logs.entries.find((entry) => entry.message === 'generate_music_output_unusable');
    expect(line?.context?.['runId']).toBe(RUN_ID);
    expect(line?.context?.['outputKeys']).toEqual(['state', 'unexpected']);
    expect(logs.text()).not.toContain(TRACK_URL);
  });

  // The prompt is the visitor's content and must not reach a Worker log, even on a failure path
  // where there is a temptation to record everything.
  it('never logs the prompt', async () => {
    const { service, logs } = build({ output: () => ({}) });

    await expect(
      service.generate(request({ prompt: 'a confidential brief' }), ACTOR)
    ).rejects.toMatchObject(problemWithStatus(502));

    expect(logs.text()).not.toContain('a confidential brief');
  });
});

describe('the host allowlist', () => {
  // The allowlist belongs to the descriptor, and the service's only job is to pass it through
  // unchanged. A service that substituted its own list would either refuse every result or accept
  // any host, and the only way to catch that is to assert on what the port was given.
  it('passes the selected model\u2019s own approved hosts to the retrieval port', async () => {
    const { service, audio } = build();
    await service.generate(request(), ACTOR);

    expect(audio.calls[0]?.allowedHosts).toEqual(ELEVENLABS!.musicControls!.outputHosts);
  });

  it('passes the other model\u2019s different host list when it is selected', async () => {
    const { service, audio } = build();
    await service.generate(request({ model: MINIMAX!.id, format: 'mp3' }), ACTOR);

    expect(audio.calls[0]?.allowedHosts).toEqual(MINIMAX!.musicControls!.outputHosts);
    // The two lists genuinely differ, so this assertion is not vacuous.
    expect(MINIMAX!.musicControls!.outputHosts).not.toEqual(ELEVENLABS!.musicControls!.outputHosts);
  });

  // The retrieval port's refusal reaches the caller unchanged. The service must not catch it and
  // substitute a different status, because the panel distinguishes a `502` from a `503`.
  it('propagates the retrieval port\u2019s refusal', async () => {
    const { service } = build(
      {},
      audioPort(
        new ProblemDetailsError({
          status: 502,
          title: 'The generated track could not be retrieved',
          detail: 'The model provider returned an audio URL from an unapproved origin.'
        })
      )
    );

    await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(502));
  });

  // A run that failed to produce a usable track must not be saved as a completed run, or the session
  // meter would count a run the visitor never received.
  it('records no run when the track could not be retrieved', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    const service = new GenerateMusicService({
      inference: new FakeInference({
        output: () => ({ state: 'Completed', result: { audio: TRACK_URL } })
      }),
      runs,
      audio: audioPort(new Error('network')).port,
      now: () => 1_000
    });

    await expect(service.generate(request(), ACTOR)).rejects.toThrow();
    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('the insufficient-credit path', () => {
  // The condition an unfunded account actually meets on this panel, since every reviewed music
  // model is third-party. The inference client raises the `503` in exactly one place, and this
  // asserts the service lets it through rather than flattening it into a generic provider failure.
  it('surfaces the gateway\u2019s billing failure as a 503', async () => {
    const { service } = build({
      failWith: new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail:
          'This model uses prepaid AI Gateway credits, and this account does not have enough '
          + 'credit for the request. Add AI Gateway credits, then try again.'
      })
    });

    await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(503));
  });

  // Classified through the shared classifier rather than a local copy, so this panel cannot drift
  // onto a second opinion about what counts as a billing failure. These are the forms the live
  // gateway actually produced for a third-party model on an unfunded account.
  it.each([
    ['the sanitised 503 the inference client raises', undefined],
    ['gateway code 2021', '2021: Insufficient balance; add money to your gateway or use BYOK'],
    ['an HTTP 402', 'InferenceUpstreamError: 402 Payment Required'],
    ['the documented phrase', 'Insufficient AI Gateway credits']
  ])('classifies %s as insufficient-credit', (_label, message) => {
    const cause =
      message === undefined
        ? new ProblemDetailsError({
            status: 503,
            title: 'AI Gateway credits are unavailable',
            detail: 'Add AI Gateway credits, then try again.'
          })
        : new Error(message);

    expect(classifyMusicFailure(cause)).toBe('insufficient-credit');
  });

  // The other direction. A `502` must not be read as a billing failure, because telling someone to
  // top up a funded account is a worse outcome than the generic message.
  it.each([
    ['a provider 502', 502],
    ['a bad request', 400]
  ])('classifies %s as a provider failure', (_label, status) => {
    expect(
      classifyMusicFailure(
        new ProblemDetailsError({ status, title: 'Failed', detail: 'Something went wrong.' })
      )
    ).toBe('provider-failure');
  });

  it('classifies an unrecognised error as a provider failure', () => {
    expect(classifyMusicFailure(new Error('something else entirely'))).toBe('provider-failure');
    expect(classifyMusicFailure('not an error')).toBe('provider-failure');
  });

  // No run is recorded for a refused request, which is what makes the panel's claim that nothing was
  // charged consistent with the session meter rather than merely reassuring.
  it('records no run for a request the gateway refused on billing grounds', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    const service = new GenerateMusicService({
      inference: new FakeInference({
        failWith: new ProblemDetailsError({
          status: 503,
          title: 'AI Gateway credits are unavailable',
          detail: 'Add AI Gateway credits, then try again.'
        })
      }),
      runs,
      audio: audioPort().port,
      now: () => 1_000
    });

    await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(503));
    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('the saved run record', () => {
  it('records the owner so another identity cannot read its metrics', async () => {
    const runs = createMemoryRunRepository(() => 1_000);
    const service = new GenerateMusicService({
      inference: new FakeInference({
        output: () => ({ state: 'Completed', result: { audio: TRACK_URL } })
      }),
      runs,
      audio: audioPort().port,
      now: () => 1_000
    });

    await service.generate(request(), ACTOR);
    const record = await runs.find(RUN_ID);

    expect(record).toMatchObject({
      runId: RUN_ID,
      task: 'generate-music',
      ownerEmail: ACTOR.email,
      logIds: ['log-1']
    });
  });
});
