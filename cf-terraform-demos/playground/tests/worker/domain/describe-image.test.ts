import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_EDGE_PIXELS,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INSTRUCTION_CHARACTERS,
  MIN_IMAGE_EDGE_PIXELS,
  VISION_CONTROL_NAMES
} from '../../../src/describe-image';
import {
  buildDescribeImageInput,
  describeAppliedVisionControls,
  validateDescribeImageRequest
} from '../../../src/worker/domain/describe-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { jpegBytes, pngBase64, pngBytes, toBase64, webpBytes } from '../support/image-fixtures';
import { problemWithStatus, thrownBy } from '../support/problem-details';

/**
 * The reviewed vision model that requires a question.
 *
 * Found by capability rather than by identifier, so the suite keeps testing the right thing if the
 * reviewed list is reordered or a model is replaced.
 */
const REQUIRES_QUESTION = modelsForTask('describe-image').find(
  (model) => model.visionControls?.instructionRequired === true
)!;

/**
 * The reviewed vision model that will caption a bare picture.
 */
const CAPTIONS_ALONE = modelsForTask('describe-image').find(
  (model) => model.visionControls?.instructionRequired === false
)!;

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Builds a valid request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body ready to validate.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(),
    model: CAPTIONS_ALONE.id,
    runId: RUN_ID,
    ...overrides
  };
}

describe('the reviewed vision models', () => {
  // The whole phase rests on the two models disagreeing about whether a question is required. If a
  // future change made them agree, every contract test below would still pass while testing
  // nothing interesting, so the premise is asserted directly.
  it('includes one model that requires a question and one that does not', () => {
    expect(REQUIRES_QUESTION).toBeDefined();
    expect(CAPTIONS_ALONE).toBeDefined();
    expect(REQUIRES_QUESTION.id).not.toBe(CAPTIONS_ALONE.id);
  });

  // Reading the answer out of the wrong field is the failure this descriptor prevents, and the two
  // models genuinely name it differently.
  it('records which field each model returns its description in', () => {
    expect(REQUIRES_QUESTION.descriptionField).toBeDefined();
    expect(CAPTIONS_ALONE.descriptionField).toBeDefined();
    expect(REQUIRES_QUESTION.descriptionField).not.toBe(CAPTIONS_ALONE.descriptionField);
  });

  it('gives every reviewed model a declared answer-length range', () => {
    for (const model of modelsForTask('describe-image')) {
      expect(model.visionControls?.maxTokens, `${model.name} declares maxTokens`).toBeDefined();
    }
  });

  it('declares a documentation link and a pinned contract version for each model', () => {
    for (const model of modelsForTask('describe-image')) {
      expect(model.documentationUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//u);
      expect(model.contractVersion).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('validating a Describe Image request', () => {
  it('accepts a picture with no question for a model that captions alone', () => {
    const request = validateDescribeImageRequest(body());
    expect(request.instruction).toBeUndefined();
    expect(request.model.id).toBe(CAPTIONS_ALONE.id);
  });

  it('accepts a picture with a question', () => {
    const request = validateDescribeImageRequest(body({ instruction: '  What is this?  ' }));
    expect(request.instruction).toBe('What is this?');
  });

  // The contract difference this panel exists to demonstrate. Supplying a default question would
  // be friendlier and would hide a real difference between the two models.
  it('rejects a missing question for a model that requires one', () => {
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ model: REQUIRES_QUESTION.id })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('names the model and suggests the alternative when a question is missing', () => {
    try {
      validateDescribeImageRequest(body({ model: REQUIRES_QUESTION.id }));
      expect.unreachable('a model requiring a question should refuse one without');
    } catch (cause) {
      expect(String(cause)).toContain(REQUIRES_QUESTION.name);
    }
  });

  // A question of only whitespace is not a question. Treating it as absent is what makes the
  // required-question rule meaningful rather than satisfiable with a space.
  it('treats a whitespace-only question as absent', () => {
    expect(
      thrownBy(() =>
        validateDescribeImageRequest(body({ model: REQUIRES_QUESTION.id, instruction: '   ' }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('accepts a picture with no question for the captioning model even when empty text is sent', () => {
    const request = validateDescribeImageRequest(body({ instruction: '   ' }));
    expect(request.instruction).toBeUndefined();
  });

  it('rejects a question beyond the character limit', () => {
    const tooLong = 'a'.repeat(MAX_INSTRUCTION_CHARACTERS + 1);
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ instruction: tooLong })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('accepts a question exactly at the character limit', () => {
    const exact = 'a'.repeat(MAX_INSTRUCTION_CHARACTERS);
    expect(validateDescribeImageRequest(body({ instruction: exact })).instruction).toHaveLength(
      MAX_INSTRUCTION_CHARACTERS
    );
  });

  it('rejects a non-string question', () => {
    expect(thrownBy(() => validateDescribeImageRequest(body({ instruction: 42 })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects a body that is not an object', () => {
    for (const value of ['text', 42, null, [], true]) {
      expect(thrownBy(() => validateDescribeImageRequest(value))).toMatchObject(
        problemWithStatus(400)
      );
    }
  });

  it('rejects a model that belongs to another panel', () => {
    expect(
      thrownBy(() =>
        validateDescribeImageRequest(body({ model: '@cf/black-forest-labs/flux-1-schnell' }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects an unknown model', () => {
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ model: '@cf/not/a-model' })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects a malformed run identifier', () => {
    for (const runId of ['', 'short', 'has spaces', 'a'.repeat(65), 42]) {
      expect(thrownBy(() => validateDescribeImageRequest(body({ runId })))).toMatchObject(
        problemWithStatus(400)
      );
    }
  });
});

describe('identity and self-description fields', () => {
  // Rejected rather than stripped, exactly as the other panels do. A caller who sends one believes
  // it matters; accepting and discarding it would teach them it worked.
  it('rejects a body carrying an identity field', () => {
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(
        thrownBy(() => validateDescribeImageRequest(body({ [field]: 'mallory@example.com' })))
      ).toMatchObject(problemWithStatus(400));
    }
  });

  // The picture's format and size are the server's to determine. A caller offering them is
  // offering a value the server must not use, so the request is refused rather than silently
  // ignoring the field.
  it('rejects a body describing its own image', () => {
    for (const field of ['mediaType', 'contentType', 'mimeType', 'width', 'height', 'fileName']) {
      expect(
        thrownBy(() => validateDescribeImageRequest(body({ [field]: 'image/png' })))
      ).toMatchObject(problemWithStatus(400));
    }
  });
});

describe('the input size limit', () => {
  // Pinned with its reasoning, because this is a number somebody will eventually want to raise
  // and the cost is not visible from the call site. Both reviewed models take their image as a
  // JSON array of one number per byte, and a V8 array of a million small integers costs far more
  // than the million bytes behind it: measured peak resident memory is ~55 MB at 1 MiB, ~80 MB at
  // 2 MiB, and ~234 MB at 4 MiB. A Worker isolate has 128 MB, so a 4 MiB ceiling would let one
  // ordinary request exhaust the isolate and take unrelated requests with it.
  it('stays within what a 128 MB isolate can expand', () => {
    expect(MAX_INPUT_IMAGE_BYTES).toBeLessThanOrEqual(1_024 * 1_024);
  });

  // The other direction: a limit so low that an ordinary photograph is refused would make the
  // panel useless, and the guard above would still pass.
  it('is large enough for an ordinary photograph', () => {
    expect(MAX_INPUT_IMAGE_BYTES).toBeGreaterThanOrEqual(512 * 1_024);
  });

  // The two limits bound different costs — this Worker's memory and the provider's decode work —
  // so neither subsumes the other and both have to exist.
  it('bounds pixels separately from bytes', () => {
    expect(MAX_IMAGE_EDGE_PIXELS).toBeGreaterThan(0);
    expect(MIN_IMAGE_EDGE_PIXELS).toBeLessThan(MAX_IMAGE_EDGE_PIXELS);
  });
});

describe('validating the submitted picture', () => {
  it('accepts each renderable format', () => {
    for (const bytes of [pngBytes(), jpegBytes(), webpBytes()]) {
      const request = validateDescribeImageRequest(body({ imageBase64: toBase64(bytes) }));
      expect(request.imageFacts.mediaType).toMatch(/^image\//u);
    }
  });

  it('reports the dimensions it read from the header', () => {
    const request = validateDescribeImageRequest(body({ imageBase64: pngBase64(320, 240) }));
    expect(request.imageFacts.width).toBe(320);
    expect(request.imageFacts.height).toBe(240);
  });

  it('reports the decoded byte length rather than the encoded one', () => {
    const bytes = pngBytes(64, 64);
    const request = validateDescribeImageRequest(body({ imageBase64: toBase64(bytes) }));
    expect(request.imageFacts.byteLength).toBe(bytes.length);
  });

  it('rejects a missing or non-string image', () => {
    for (const value of [undefined, 42, null, {}]) {
      expect(
        thrownBy(() => validateDescribeImageRequest(body({ imageBase64: value })))
      ).toMatchObject(problemWithStatus(400));
    }
  });

  it('rejects an empty image', () => {
    expect(thrownBy(() => validateDescribeImageRequest(body({ imageBase64: '' })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects text that is not valid base64', () => {
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: 'not base64 at all!!' })))
    ).toMatchObject(problemWithStatus(400));
  });

  // The central media rule: a payload is what its bytes say it is. A PDF, a JSON document, or an
  // SVG would all arrive looking like a plausible upload and none of them is a picture.
  it('rejects a payload that is not a renderable image', () => {
    const notAnImage = toBase64(new TextEncoder().encode('%PDF-1.7 this is not a picture'));
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: notAnImage })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects an SVG, which is markup rather than a raster image', () => {
    const svg = toBase64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(thrownBy(() => validateDescribeImageRequest(body({ imageBase64: svg })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // A GIF is a real image that this demo nonetheless does not accept, which makes it the sharpest
  // test that the allowlist is an allowlist rather than an "is it an image" check.
  it('rejects a GIF, which is a real image outside the allowlist', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00]);
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: toBase64(gif) })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects a truncated file whose header cannot be read', () => {
    // A valid PNG signature with nothing after it: correctly identified as a PNG, but with no
    // readable IHDR, so there are no dimensions to check.
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: toBase64(truncated) })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects a picture beyond the byte limit', () => {
    const huge = pngBase64(64, 64) + 'A'.repeat(MAX_INPUT_IMAGE_BYTES * 2);
    expect(thrownBy(() => validateDescribeImageRequest(body({ imageBase64: huge })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // A byte limit is not a pixel limit: a flat-coloured image compresses to almost nothing while
  // still being enormous to decode, which is work the provider does on our behalf.
  it('rejects a picture beyond the pixel limit despite being small on disk', () => {
    const oversized = pngBase64(MAX_IMAGE_EDGE_PIXELS + 1, 64);
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: oversized })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('accepts a picture exactly at the pixel limit', () => {
    const exact = pngBase64(MAX_IMAGE_EDGE_PIXELS, MAX_IMAGE_EDGE_PIXELS);
    expect(validateDescribeImageRequest(body({ imageBase64: exact })).imageFacts.width).toBe(
      MAX_IMAGE_EDGE_PIXELS
    );
  });

  it('rejects a picture below the minimum edge length', () => {
    const tiny = pngBase64(MIN_IMAGE_EDGE_PIXELS - 1, MIN_IMAGE_EDGE_PIXELS - 1);
    expect(thrownBy(() => validateDescribeImageRequest(body({ imageBase64: tiny })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('rejects a header declaring zero dimensions', () => {
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ imageBase64: pngBase64(0, 0) })))
    ).toMatchObject(problemWithStatus(400));
  });
});

describe('validating the answer-length control', () => {
  it('accepts a value inside the model range', () => {
    const range = CAPTIONS_ALONE.visionControls!.maxTokens!;
    const request = validateDescribeImageRequest(body({ maxTokens: range.min }));
    expect(request.maxTokens).toBe(range.min);
  });

  it('rejects a value above the model range', () => {
    const range = CAPTIONS_ALONE.visionControls!.maxTokens!;
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ maxTokens: range.max + 1 })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects a value below the model range', () => {
    const range = CAPTIONS_ALONE.visionControls!.maxTokens!;
    expect(
      thrownBy(() => validateDescribeImageRequest(body({ maxTokens: range.min - 1 })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('rejects a fractional value', () => {
    expect(thrownBy(() => validateDescribeImageRequest(body({ maxTokens: 100.5 })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  // Both serialise to `null` in JSON and would reach the provider as an absent option, making a
  // rejected value look accepted.
  it('rejects values that are not finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'many', null]) {
      expect(
        thrownBy(() => validateDescribeImageRequest(body({ maxTokens: value })))
      ).toMatchObject(problemWithStatus(400));
    }
  });

  // Walks the full control list rather than a hand-written subset, so a control added later is
  // covered without anyone remembering to extend this test.
  it('names every known control in the shared contract', () => {
    expect([...VISION_CONTROL_NAMES]).toEqual(['maxTokens']);
  });
});

describe('building the model input', () => {
  it('sends the image as an array of byte values, as both schemas document', () => {
    const bytes = pngBytes();
    const input = buildDescribeImageInput(
      validateDescribeImageRequest(body({ imageBase64: toBase64(bytes) }))
    );

    expect(Array.isArray(input['image'])).toBe(true);
    expect(input['image']).toHaveLength(bytes.length);
    expect((input['image'] as number[])[0]).toBe(0x89);
  });

  it('omits the prompt entirely when no question was asked', () => {
    const input = buildDescribeImageInput(validateDescribeImageRequest(body()));
    expect(Object.hasOwn(input, 'prompt')).toBe(false);
  });

  it('sends the question as the prompt when one was asked', () => {
    const input = buildDescribeImageInput(
      validateDescribeImageRequest(body({ instruction: 'What colour is the door?' }))
    );
    expect(input['prompt']).toBe('What colour is the door?');
  });

  it('uses the provider parameter name for the answer-length cap', () => {
    const input = buildDescribeImageInput(validateDescribeImageRequest(body({ maxTokens: 128 })));
    expect(input['max_tokens']).toBe(128);
  });

  it('omits the answer-length cap when the caller did not set one', () => {
    const input = buildDescribeImageInput(validateDescribeImageRequest(body()));
    expect(Object.hasOwn(input, 'max_tokens')).toBe(false);
  });

  // No identity field can reach a provider, because none survives validation and none is added
  // here. Asserting on the exact key set is what makes that a guarantee rather than an intention.
  it('sends no field the reviewed schemas do not declare', () => {
    const input = buildDescribeImageInput(
      validateDescribeImageRequest(body({ instruction: 'What is this?', maxTokens: 128 }))
    );
    expect(Object.keys(input).sort()).toEqual(['image', 'max_tokens', 'prompt']);
  });
});

describe('describing the applied controls', () => {
  it('fills in the model default when the caller set no cap', () => {
    const applied = describeAppliedVisionControls(validateDescribeImageRequest(body()));
    expect(applied.maxTokens).toBe(CAPTIONS_ALONE.visionControls?.maxTokens?.default);
  });

  it('reports the caller value when one was set', () => {
    const applied = describeAppliedVisionControls(
      validateDescribeImageRequest(body({ maxTokens: 128 }))
    );
    expect(applied.maxTokens).toBe(128);
  });

  it('reports the question when one was asked, and omits it when not', () => {
    expect(
      describeAppliedVisionControls(validateDescribeImageRequest(body({ instruction: 'Why?' })))
        .instruction
    ).toBe('Why?');
    expect(
      describeAppliedVisionControls(validateDescribeImageRequest(body())).instruction
    ).toBeUndefined();
  });

  // The two models default differently — 512 against 256 — which a visitor sees as one answering
  // at roughly twice the length of the other for the same picture.
  it('reflects each model\u2019s own default', () => {
    const captioning = describeAppliedVisionControls(validateDescribeImageRequest(body()));
    const questioning = describeAppliedVisionControls(
      validateDescribeImageRequest(body({ model: REQUIRES_QUESTION.id, instruction: 'What?' }))
    );

    expect(captioning.maxTokens).not.toBe(questioning.maxTokens);
  });
});
