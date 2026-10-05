/**
 * @file Domain coverage for Detect Objects: request validation, the reviewed Moondream payload
 *   shape, and the applied-control record. The geometry rules this panel depends on are tested in
 *   `tests/worker/application/detect-objects-service.test.ts`, beside the normaliser that enforces
 *   them.
 */

import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_DETECTION_TARGET_LENGTH } from '../../../src/shared/detect-objects';
import {
  buildDetectObjectsInput,
  describeAppliedDetectionControls,
  validateDetectObjectsRequest
} from '../../../src/worker/domain/detect-objects';
import { defaultModelForTask } from '../../../src/worker/domain/models';
import { pngBase64 } from '../support/image-fixtures';

const MODEL = defaultModelForTask('detect-objects')!;
const IMAGE_BASE64 = pngBase64();

/**
 * Builds a request body that passes validation, so each test can change one field.
 *
 * @param overrides Fields replacing the valid defaults.
 * @returns A request body for {@link validateDetectObjectsRequest}.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: IMAGE_BASE64,
    model: MODEL.id,
    runId: '11111111-2222-4333-8444-555555555555',
    target: 'dog',
    ...overrides
  };
}

describe('validateDetectObjectsRequest', () => {
  it('accepts a well-formed request and trims the target', () => {
    const request = validateDetectObjectsRequest(body({ target: '  red car  ' }));

    expect(request.target).toBe('red car');
    expect(request.model.id).toBe(MODEL.id);
    expect(request.maxObjects).toBe(MODEL.detectionControls?.maxObjects.default);
  });

  // The whole panel rests on the model being asked to locate something, so an absent or blank
  // target is refused rather than defaulted. Moondream's own default is "person", and silently
  // adopting it would mean a visitor who cleared the field got results for a word they never typed.
  it.each([
    ['empty', { target: '' }],
    ['whitespace only', { target: '   ' }],
    ['not a string', { target: 42 }]
  ])('rejects a %s target', (_label, overrides) => {
    expect(() => validateDetectObjectsRequest(body(overrides))).toThrow(ProblemDetailsError);
  });

  it('rejects a request with no target field at all', () => {
    const withoutTarget = body();
    delete withoutTarget.target;

    expect(() => validateDetectObjectsRequest(withoutTarget)).toThrow(ProblemDetailsError);
  });

  it('rejects a target longer than this demo allows and says the limit is its own', () => {
    const tooLong = 'a'.repeat(MAX_DETECTION_TARGET_LENGTH + 1);

    try {
      validateDetectObjectsRequest(body({ target: tooLong }));
      expect.unreachable('an over-long target must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProblemDetailsError);
      const detail = (cause as ProblemDetailsError).problemDetails.detail ?? '';
      expect(detail).toContain(String(MAX_DETECTION_TARGET_LENGTH));
      // The limit is this application's, not the provider's, and the message must not imply
      // otherwise — the same honesty rule Generate Music's length cap follows.
      expect(detail).toMatch(/demo'?s own/iu);
    }
  });

  it('accepts a target exactly at the limit', () => {
    const exact = 'a'.repeat(MAX_DETECTION_TARGET_LENGTH);

    expect(validateDetectObjectsRequest(body({ target: exact })).target).toBe(exact);
  });

  // Classify Image refuses a generative field rather than ignoring it, because a caller who sent a
  // prompt has formed a belief about what the panel does. Detect Objects localises a phrase; it
  // does not take an instruction, and the refusal names the difference.
  it.each(['instruction', 'prompt', 'question', 'negativePrompt'])(
    'rejects the generative field %s with an explanation',
    (fieldName) => {
      try {
        validateDetectObjectsRequest(body({ [fieldName]: 'draw a dog' }));
        expect.unreachable('a generative field must be refused');
      } catch (cause) {
        expect(cause).toBeInstanceOf(ProblemDetailsError);
        expect((cause as ProblemDetailsError).problemDetails.detail).toContain(fieldName);
      }
    }
  );

  // The verified identity comes from the Access middleware and image facts come from the bytes.
  // A caller supplying either is attempting to override a server-derived value.
  it.each(['user', 'email', 'actor', 'sub', 'mediaType', 'width', 'height', 'fileName'])(
    'rejects the server-derived field %s',
    (fieldName) => {
      expect(() => validateDetectObjectsRequest(body({ [fieldName]: 'x' }))).toThrow(
        ProblemDetailsError
      );
    }
  );

  it('rejects a model that is not reviewed for this panel', () => {
    expect(() => validateDetectObjectsRequest(body({ model: '@cf/microsoft/resnet-50' }))).toThrow(
      ProblemDetailsError
    );
  });

  it('rejects a body that is not a JSON object', () => {
    for (const value of [null, 'text', 42, []]) {
      expect(() => validateDetectObjectsRequest(value)).toThrow(ProblemDetailsError);
    }
  });

  describe('maxObjects', () => {
    const range = MODEL.detectionControls!.maxObjects;

    it('defaults to the reviewed model default when omitted', () => {
      expect(validateDetectObjectsRequest(body()).maxObjects).toBe(range.default);
    });

    it.each([
      ['below the minimum', range.min - 1],
      ['above the maximum', range.max + 1],
      ['fractional', 1.5],
      ['not a number', 'ten']
    ])('rejects a %s value', (_label, maxObjects) => {
      expect(() => validateDetectObjectsRequest(body({ maxObjects }))).toThrow(ProblemDetailsError);
    });

    it.each([range.min, range.max])('accepts the boundary value %i', (maxObjects) => {
      expect(validateDetectObjectsRequest(body({ maxObjects })).maxObjects).toBe(maxObjects);
    });
  });
});

describe('buildDetectObjectsInput', () => {
  // Captured from a live `cf ai run` call. Every key here was verified against the provider, and
  // the absent ones matter as much as the present ones: `max_tokens`, `question`, `reasoning`, and
  // `caption_length` belong to the query/caption tasks, and the schema sets no additional
  // properties, so sending one would be a rejected request rather than an ignored field.
  it('builds exactly the reviewed detect payload', () => {
    const input = buildDetectObjectsInput(
      validateDetectObjectsRequest(body({ target: 'dog', maxObjects: 10 }))
    );

    expect(input).toEqual({
      task: 'detect',
      image: expect.stringMatching(/^data:image\/png;base64,/u),
      target: 'dog',
      max_objects: 10,
      stream: false
    });
  });

  // `point` and `detect` do not support streaming, so the flag is sent explicitly rather than
  // omitted and left to a default that could change.
  it('always disables streaming', () => {
    expect(buildDetectObjectsInput(validateDetectObjectsRequest(body())).stream).toBe(false);
  });

  // The media type comes from the sniffed bytes rather than from anything the browser declared,
  // so a mislabelled upload cannot produce a data URI that contradicts its own content.
  it('derives the data URI media type from the verified bytes', () => {
    const request = validateDetectObjectsRequest(body());
    const input = buildDetectObjectsInput(request);

    expect(input.image).toBe(
      `data:${request.source.facts.mediaType};base64,${IMAGE_BASE64.replace(/^data:[^,]+,/u, '')}`
    );
  });
});

describe('describeAppliedDetectionControls', () => {
  it('records the model, target, and provider-applied limit', () => {
    const request = validateDetectObjectsRequest(body({ target: 'cat', maxObjects: 7 }));

    expect(describeAppliedDetectionControls(request)).toEqual({
      model: MODEL.id,
      target: 'cat',
      maxObjects: 7
    });
  });
});
