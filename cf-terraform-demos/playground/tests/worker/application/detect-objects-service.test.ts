/**
 * @file Use-case tests for Detect Objects, where the interesting surface is geometry. Every earlier
 *   structured panel validated _values_ — a score inside 0–1, a label that is a string. This one
 *   validates _shape_: a box carries four coordinates that are rendered as a position on the
 *   visitor's own picture, so a malformed one does not show up as a wrong answer. It shows up as a
 *   rectangle painted outside its container, which reads as a layout bug in this application rather
 *   than as bad output from a model. That is why each geometric failure below is refused with a
 *   `502` instead of being clamped into something plausible. The second theme is what a detection
 *   does _not_ carry. Moondream returns four numbers and nothing else — no label, no score — so
 *   these tests also pin the honest consequences: the label is the caller's own target phrase, and
 *   no confidence is invented from anywhere.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DetectObjectsService,
  normaliseDetections
} from '../../../src/worker/application/detect-objects/detect-objects-service';
import {
  validateDetectObjectsRequest,
  type ValidatedDetectObjectsRequest
} from '../../../src/worker/domain/detect-objects';
import { modelsForTask } from '../../../src/worker/domain/models';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';
import { problemWithStatus, thrownBy } from '../support/problem-details';

const MOONDREAM = modelsForTask('detect-objects')[0]!;
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * A detection envelope in the shape captured from a live `cf ai run` call.
 *
 * @param objects Boxes the provider reports.
 * @returns The provider's documented response envelope.
 */
function envelope(objects: unknown): unknown {
  return {
    result: {
      answer: null,
      caption: null,
      finish_reason: 'stop',
      metrics: { input_tokens: 736, output_tokens: 4 },
      objects,
      points: null,
      reasoning: null
    }
  };
}

/**
 * Records every log a service emitted, so a test can assert on what was _not_ logged.
 *
 * @returns The recorded entries, a logger writing into them, and their serialised form.
 */
function createRecorder(): {
  entries: { level: string; message: string; context?: Record<string, unknown> }[];
  logger: { warn: typeof console.warn; error: typeof console.error };
  text: () => string;
} {
  const entries: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  return {
    entries,
    logger: {
      warn: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: 'warn', message, context });
      },
      error: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: 'error', message, context });
      }
    } as never,
    text: () => JSON.stringify(entries)
  };
}

/**
 * Builds a validated request through real validation rather than hand-building the type.
 *
 * @param overrides Extra body fields.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}): ValidatedDetectObjectsRequest {
  return validateDetectObjectsRequest({
    imageBase64: pngBase64(120, 80),
    model: MOONDREAM.id,
    runId: RUN_ID,
    target: 'dog',
    ...overrides
  });
}

describe('detecting objects', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it('returns the provider boxes in the order the model gave them', async () => {
    const inference = new FakeInference({
      output: () =>
        envelope([
          { x_min: 0.6, y_min: 0.2, x_max: 0.9, y_max: 0.8 },
          { x_min: 0.06, y_min: 0.24, x_max: 0.31, y_max: 0.75 }
        ])
    });
    const service = new DetectObjectsService({ inference, runs });

    const result = await service.detect(request(), ACTOR);

    // No score exists to rank by, so the provider's own order is preserved rather than a ranking
    // being invented. `index` records that position so the table and the overlay agree.
    expect(result.detections.map((entry) => entry.index)).toEqual([1, 2]);
    expect(result.detections[0]!.xMin).toBeCloseTo(0.6);
    expect(result.detections[1]!.xMin).toBeCloseTo(0.06);
  });

  // The decisive contract fact: the model returns four numbers per box and nothing else. The label
  // a visitor sees is the phrase they typed, echoed back beside the region it was found in.
  it('labels every box with the caller target rather than a model label', async () => {
    const inference = new FakeInference({
      output: () =>
        envelope([
          { x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 },
          { x_min: 0.5, y_min: 0.5, x_max: 0.8, y_max: 0.8 }
        ])
    });
    const service = new DetectObjectsService({ inference, runs });

    const result = await service.detect(request({ target: 'red bicycle' }), ACTOR);

    expect(result.detections.map((entry) => entry.label)).toEqual(['red bicycle', 'red bicycle']);
  });

  // Asserted structurally rather than by reading the type, because the temptation a future change
  // would face is deriving a "confidence" from box area or token counts. There is no score in the
  // provider's contract, so there must be no score-shaped field in the result.
  it('invents no score or confidence field', async () => {
    const inference = new FakeInference({
      output: () => envelope([{ x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }])
    });
    const service = new DetectObjectsService({ inference, runs });

    const result = await service.detect(request(), ACTOR);
    const keys = Object.keys(result.detections[0]!);

    expect(keys).not.toContain('score');
    expect(keys).not.toContain('confidence');
    expect(keys).not.toContain('probability');
    expect(new Set(keys)).toEqual(
      new Set(['index', 'label', 'xMin', 'yMin', 'xMax', 'yMax', 'region'])
    );
  });

  // A target the picture does not contain is a successful run with an empty result, verified
  // live against the model with the target "giraffe". It must not read as a failure, and because
  // this model has no score there is no "the floor hid everything" case to confuse it with.
  it('treats an empty detection set as a successful run', async () => {
    const inference = new FakeInference({ output: () => envelope([]) });
    const service = new DetectObjectsService({ inference, runs });

    const result = await service.detect(request({ target: 'giraffe' }), ACTOR);

    expect(result.detections).toEqual([]);
    expect(result.receipt.status).toBe('completed');
  });

  it('records a gateway-routed receipt and the applied controls', async () => {
    const inference = new FakeInference({
      logId: 'log-detect-1',
      output: () => envelope([{ x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }])
    });
    const service = new DetectObjectsService({ inference, runs });

    const result = await service.detect(request({ maxObjects: 12 }), ACTOR);

    expect(result.receipt.gatewayRouted).toBe(true);
    expect(result.receipt.logIds).toEqual(['log-detect-1']);
    expect(result.applied).toEqual({ model: MOONDREAM.id, target: 'dog', maxObjects: 12 });
  });

  // `max_objects` is genuinely enforced by the provider — verified live, where a limit of 1 against
  // a two-object picture returned one box. The panel must therefore forward it rather than
  // truncating locally, which is the opposite of Classify Image's playground-applied top-k.
  it('forwards the output limit to the provider instead of truncating locally', async () => {
    const inference = new FakeInference({
      output: () => envelope([{ x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }])
    });
    const service = new DetectObjectsService({ inference, runs });

    await service.detect(request({ maxObjects: 3 }), ACTOR);

    const sent = inference.requests[0]!.input as Record<string, unknown>;
    expect(sent.max_objects).toBe(3);
  });
});

describe('normalising a detection response', () => {
  const req = request();

  /**
   * Asserts that a provider payload is refused as a contract violation.
   *
   * @param objects The `objects` value the provider returned.
   */
  function expectRefused(objects: unknown): void {
    expect(thrownBy(() => normaliseDetections(envelope(objects), req))).toMatchObject(
      problemWithStatus(502)
    );
  }

  it('accepts boxes spanning the full image', () => {
    // Verified live: the target "sky" returned x_min 0 and x_max 1 exactly. An inclusive bound is
    // correct, so a full-width detection must not be mistaken for an out-of-range one.
    const detections = normaliseDetections(
      envelope([{ x_min: 0, y_min: 0, x_max: 1, y_max: 1 }]),
      req
    );

    expect(detections).toHaveLength(1);
  });

  // `objects` is `null` for every non-detect task and is absent from the schema's `required` list,
  // so a detect call that comes back without it means the request was not run as a detection. That
  // is a changed contract rather than an empty result, and reporting it as "nothing found" would
  // hide the fault behind a plausible answer.
  it.each([
    ['null', null],
    ['absent', undefined],
    ['a string', 'none'],
    ['an object', {}]
  ])('refuses a response whose objects field is %s', (_label, objects) => {
    expectRefused(objects);
  });

  it('refuses a response that is not the documented envelope', () => {
    expect(thrownBy(() => normaliseDetections({ unexpected: true }, req))).toMatchObject(
      problemWithStatus(502)
    );
    expect(thrownBy(() => normaliseDetections(null, req))).toMatchObject(problemWithStatus(502));
  });

  it.each([
    ['an element that is not an object', ['box']],
    ['an element that is null', [null]],
    ['a missing coordinate', [{ x_min: 0.1, y_min: 0.1, x_max: 0.4 }]],
    ['a non-numeric coordinate', [{ x_min: '0.1', y_min: 0.1, x_max: 0.4, y_max: 0.4 }]],
    ['a NaN coordinate', [{ x_min: Number.NaN, y_min: 0.1, x_max: 0.4, y_max: 0.4 }]],
    [
      'an infinite coordinate',
      [{ x_min: 0, y_min: 0.1, x_max: Number.POSITIVE_INFINITY, y_max: 1 }]
    ]
  ])('refuses %s', (_label, objects) => {
    expectRefused(objects);
  });

  // A zero-area or inverted box is the case that would render as an invisible or backwards
  // rectangle rather than as an error, so it is refused rather than normalised into something
  // drawable.
  it.each([
    ['a zero-width box', [{ x_min: 0.4, y_min: 0.1, x_max: 0.4, y_max: 0.5 }]],
    ['a zero-height box', [{ x_min: 0.1, y_min: 0.4, x_max: 0.5, y_max: 0.4 }]],
    ['an inverted horizontal box', [{ x_min: 0.8, y_min: 0.1, x_max: 0.2, y_max: 0.5 }]],
    ['an inverted vertical box', [{ x_min: 0.1, y_min: 0.8, x_max: 0.5, y_max: 0.2 }]]
  ])('refuses %s', (_label, objects) => {
    expectRefused(objects);
  });

  it.each([
    ['a negative origin', [{ x_min: -0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }]],
    ['an overflowing right edge', [{ x_min: 0.1, y_min: 0.1, x_max: 1.2, y_max: 0.4 }]],
    ['an overflowing bottom edge', [{ x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 1.5 }]]
  ])('refuses %s, which would paint outside the picture', (_label, objects) => {
    expectRefused(objects);
  });

  // Captured verbatim from a live `cf ai run` call, so the normaliser is pinned against a real
  // envelope rather than only against the shape this file invents. The coordinates are the ones
  // the model actually returned for the target "tree" against a generated scene, including the
  // long binary fractions it reports rather than the round numbers a hand-written fixture uses.
  it('normalises a response captured from the live model', () => {
    const live = {
      result: {
        answer: null,
        caption: null,
        finish_reason: 'stop',
        metrics: {
          decode_time_ms: 69.004,
          input_tokens: 736,
          output_tokens: 4,
          prefill_time_ms: 67.956,
          ttft_ms: 109.939
        },
        objects: [
          { x_max: 0.765_625, x_min: 0.5625, y_max: 0.719_726_562_5, y_min: 0.241_210_937_5 }
        ],
        points: null,
        reasoning: null
      }
    };

    const detections = normaliseDetections(live, request({ target: 'tree' }));

    expect(detections).toEqual([
      {
        index: 1,
        label: 'tree',
        xMin: 0.5625,
        yMin: 0.241_210_937_5,
        xMax: 0.765_625,
        yMax: 0.719_726_562_5,
        region: 'centre'
      }
    ]);
  });

  it('describes each region in words so the table stands alone', () => {
    const detections = normaliseDetections(
      envelope([
        { x_min: 0.02, y_min: 0.02, x_max: 0.2, y_max: 0.2 },
        { x_min: 0.8, y_min: 0.8, x_max: 0.98, y_max: 0.98 },
        { x_min: 0.4, y_min: 0.4, x_max: 0.6, y_max: 0.6 }
      ]),
      req
    );

    expect(detections.map((entry) => entry.region)).toEqual([
      'upper left',
      'lower right',
      'centre'
    ]);
  });

  // The reason a refusal is diagnosable at all: the log says which run and model produced the
  // unusable payload, without carrying the payload itself.
  it('logs a reason code when it refuses a payload', () => {
    const recorder = createRecorder();

    expect(() => normaliseDetections(envelope(null), req, recorder.logger as never)).toThrow();

    expect(recorder.entries[0]?.message).toBe('detect_objects_output_unusable');
    expect(recorder.entries[0]?.context?.runId).toBe(RUN_ID);
    expect(recorder.entries[0]?.context?.model).toBe(MOONDREAM.id);
  });
});

describe('privacy of detection diagnostics', () => {
  // The target phrase is visitor-supplied free text that goes to a model, so it is prompt content
  // under the cross-phase rule and must never be logged. Written as "must not contain", because
  // that is the direction that silently rots.
  it('logs neither the target phrase, the geometry, nor the verified email', async () => {
    const recorder = createRecorder();
    const runs = createMemoryRunRepository();
    const inference = new FakeInference({ output: () => envelope('not-an-array') });
    const service = new DetectObjectsService({ inference, runs, logger: recorder.logger as never });

    await expect(
      service.detect(request({ target: 'a man in a yellow hat' }), ACTOR)
    ).rejects.toThrow();

    const text = recorder.text();
    expect(text).not.toContain('a man in a yellow hat');
    expect(text).not.toContain('yellow');
    expect(text).not.toContain(ACTOR.email);
    expect(text).not.toContain(ACTOR.sub);
  });
});
