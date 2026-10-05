import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useClassifyText } from '../../../src/client/features/classify-text/useClassifyText';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  type ClassifyTextResponse
} from '../../../src/shared/classify-text';

/**
 * A scoring classifier with both ranking controls, matching DistilBERT.
 */
const SCORING: CatalogueModel = {
  id: '@cf/test/scoring',
  name: 'Test Scoring',
  provider: 'workers-ai',
  task: 'classify-text',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/scoring',
  textClassificationControls: {
    outcomeKind: 'scored-labels',
    inputShape: 'text',
    labelSetName: 'Sentiment (test)',
    labelSet: [
      { code: 'POSITIVE', name: 'Positive' },
      { code: 'NEGATIVE', name: 'Negative' }
    ],
    topK: { min: 1, max: 10, step: 1, default: 2 },
    minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
    appliedBy: 'playground',
    contextWindowTokens: 512
  }
};

/**
 * A verdict model with no ranking controls at all, matching Llama Guard.
 *
 * The absence of `topK` and `minimumConfidence` is the point: it is what proves the composable
 * clears controls the new model cannot accept.
 */
const CLEF_SENTIMENT: CatalogueModel = {
  id: '@cf/cloudflare/clef-flash',
  name: 'Clef Flash (three-way sentiment)',
  provider: 'workers-ai',
  task: 'classify-text',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/clef',
  textClassificationControls: {
    outcomeKind: 'scored-labels',
    inputShape: 'clef-choice',
    labelSetName: 'Sentiment (reviewed Clef choice)',
    labelSet: [
      { code: 'POSITIVE', name: 'Positive' },
      { code: 'NEGATIVE', name: 'Negative' },
      { code: 'NEUTRAL', name: 'Neutral' }
    ],
    topK: { min: 1, max: 10, step: 1, default: 3 },
    minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
    appliedBy: 'playground',
    contextWindowTokens: 65_536
  }
};

const VERDICT: CatalogueModel = {
  id: '@cf/test/verdict',
  name: 'Test Verdict',
  provider: 'workers-ai',
  task: 'classify-text',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/verdict',
  textClassificationControls: {
    outcomeKind: 'verdict',
    inputShape: 'messages',
    labelSetName: 'Test hazard taxonomy',
    labelSet: [
      { code: 'S1', name: 'Violent Crimes' },
      { code: 'S10', name: 'Hate' }
    ],
    appliedBy: 'playground',
    contextWindowTokens: 131_072
  }
};

/**
 * Builds a successful scored response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<ClassifyTextResponse> = {}): ClassifyTextResponse {
  return {
    outcome: {
      kind: 'scored-labels',
      labels: [{ rank: 1, label: 'POSITIVE', name: 'Positive', score: 0.98 }],
      totalLabels: 2
    },
    receipt: {
      runId: 'run-1',
      task: 'classify-text',
      model: SCORING.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 120,
      startedAt: new Date().toISOString()
    },
    applied: {
      model: SCORING.id,
      labelSetName: 'Sentiment (test)',
      topK: 2,
      minimumConfidence: 0,
      characterCount: 24
    },
    ...overrides
  };
}

/**
 * Builds the composable with an injected transport.
 *
 * @param models Catalogue models to offer.
 * @param transport Transport to use.
 * @returns The composable result, with the transport exposed under its own name.
 */
function build(
  models: CatalogueModel[] = [SCORING, VERDICT],
  transport = vi.fn().mockResolvedValue(response())
) {
  const result = useClassifyText({
    models: ref(models),
    classify: transport,
    // Resolve polls immediately rather than waiting seconds of real time.
    runOptions: { sleep: async () => undefined }
  });

  // Exposed as `transport` rather than merged over the composable's own `run` action, which it
  // would otherwise shadow — leaving every test calling the mock directly instead of the code
  // under test, and passing for the wrong reason.
  return { ...result, transport };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
});

describe('selecting a model', () => {
  it('defaults to the first reviewed model once the catalogue arrives', () => {
    expect(build().model.value).toBe(SCORING.id);
  });

  // Settled in the same tick as the model choice: without it the first paint after the catalogue
  // loads has a model selected but no control defaults.
  it('applies the selected model\u2019s control defaults immediately', () => {
    const panel = build();

    expect(panel.topK.value).toBe(2);
    expect(panel.minimumConfidence.value).toBe(0);
  });

  it('exposes the selected model descriptor', () => {
    expect(build().selectedModel.value?.name).toBe('Test Scoring');
  });
});

describe('the Clef fixed-label bridge', () => {
  it('publishes the reviewed neutral label', () => {
    const panel = build([CLEF_SENTIMENT]);

    expect(panel.labelSet.value.map((label) => label.code)).toEqual([
      'POSITIVE',
      'NEGATIVE',
      'NEUTRAL'
    ]);
  });

  // The browser sends no criteria: Clef's normal API permits them, but the one choice schema is
  // immutable Worker configuration so this remains fixed-label classification.
  it('sends no caller-defined Clef question or criteria', async () => {
    const panel = build([CLEF_SENTIMENT]);
    panel.text.value = 'The train departs from platform four.';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.model).toBe(CLEF_SENTIMENT.id);
    for (const field of ['question', 'questions', 'criteria', 'labels', 'choices']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });
});

describe('the two outcome kinds', () => {
  // Decides which renderer the view uses. A panel that assumed a score would draw a bar of width
  // `NaN` against a perfectly valid verdict.
  it('reports whether the selected model scores its labels', async () => {
    const panel = build();
    expect(panel.scoresLabels.value).toBe(true);

    panel.model.value = VERDICT.id;
    await nextTick();

    expect(panel.scoresLabels.value).toBe(false);
  });

  it('publishes the selected model\u2019s label set and its name', async () => {
    const panel = build();
    expect(panel.labelSetName.value).toBe('Sentiment (test)');
    expect(panel.labelSet.value.map((l) => l.code)).toEqual(['POSITIVE', 'NEGATIVE']);

    panel.model.value = VERDICT.id;
    await nextTick();

    expect(panel.labelSetName.value).toBe('Test hazard taxonomy');
    expect(panel.labelSet.value.map((l) => l.code)).toEqual(['S1', 'S10']);
  });
});

describe('re-settling controls when the model changes', () => {
  // A retained floor would be sent to a model whose output has no score to compare it against —
  // a request the server refuses and the visitor never knowingly made.
  it('clears controls the new model does not have', async () => {
    const panel = build();
    panel.topK.value = 1;
    panel.minimumConfidence.value = 0.5;

    panel.model.value = VERDICT.id;
    await nextTick();

    expect(panel.topK.value).toBeUndefined();
    expect(panel.minimumConfidence.value).toBeUndefined();
  });

  it('restores defaults when switching back to a model that has them', async () => {
    const panel = build();
    panel.model.value = VERDICT.id;
    await nextTick();

    panel.model.value = SCORING.id;
    await nextTick();

    expect(panel.topK.value).toBe(2);
    expect(panel.minimumConfidence.value).toBe(0);
  });

  it('keeps a chosen value when the new model also has the control', async () => {
    const other: CatalogueModel = { ...SCORING, id: '@cf/test/other', name: 'Other Scoring' };
    const panel = build([SCORING, other]);
    panel.topK.value = 1;

    panel.model.value = other.id;
    await nextTick();

    expect(panel.topK.value).toBe(1);
  });
});

describe('whether the panel can be submitted', () => {
  it('refuses with no text', () => {
    expect(build().canClassify.value).toBe(false);
  });

  it('accepts once there is text', () => {
    const panel = build();
    panel.text.value = 'something';

    expect(panel.canClassify.value).toBe(true);
  });

  it('refuses while a run is in flight', async () => {
    const panel = build();
    panel.text.value = 'something';

    const running = panel.run();
    expect(panel.canClassify.value).toBe(false);
    await running;
  });

  it('refuses whitespace-only text', () => {
    const panel = build();
    panel.text.value = '   \n  ';

    expect(panel.canClassify.value).toBe(false);
  });

  // Said rather than left to a disabled button, and the reason names the context window so the
  // limit does not look arbitrary beside the other text panels.
  it('refuses and explains when the text is too long', () => {
    const panel = build();
    panel.text.value = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS + 1);

    expect(panel.canClassify.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/context window/u);
  });

  it('counts characters in code points', () => {
    const panel = build();
    panel.text.value = '\u{1F600}\u{1F600}';

    expect(panel.characterCount.value).toBe(2);
  });

  it('reports no blocking reason when the form is valid', () => {
    const panel = build();
    panel.text.value = 'something';

    expect(panel.blockedReason.value).toBeNull();
  });
});

describe('building the request', () => {
  it('sends the text, model, and run identifier', async () => {
    const panel = build();
    panel.text.value = 'The staff were wonderful.';
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'The staff were wonderful.',
        model: SCORING.id,
        runId: 'run-1'
      }),
      expect.anything()
    );
  });

  it('sends the ranking controls a scoring model declares', async () => {
    const panel = build();
    panel.text.value = 'x';
    panel.topK.value = 1;
    panel.minimumConfidence.value = 0.25;
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 1, minimumConfidence: 0.25 }),
      expect.anything()
    );
  });

  // The server refuses a ranking control on a verdict model, so offering the chance to send one
  // would stage a request already known to be invalid.
  it('never sends a ranking control to a verdict model', async () => {
    const panel = build();
    panel.model.value = VERDICT.id;
    await nextTick();
    panel.text.value = 'x';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(sent).not.toHaveProperty('topK');
    expect(sent).not.toHaveProperty('minimumConfidence');
  });

  // The assertion that would catch a stale value surviving a model switch and being forwarded to
  // a model that would refuse it.
  it('never sends a control the selected model does not declare', async () => {
    const panel = build();
    panel.model.value = VERDICT.id;
    await nextTick();
    // Set directly, as a stale value surviving a reset would be.
    panel.topK.value = 3;
    panel.text.value = 'x';
    await panel.run();

    expect(panel.transport.mock.calls[0]?.[0]).not.toHaveProperty('topK');
  });

  // The panel's defining property: there is no field through which a label could travel.
  it('never sends caller-defined labels, categories, or questions', async () => {
    const panel = build();
    panel.text.value = 'x';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['labels', 'categories', 'criteria', 'question', 'choices']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });

  it('never sends an identity field', async () => {
    const panel = build();
    panel.text.value = 'x';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });
});

describe('a successful run', () => {
  it('exposes the outcome, receipt, and applied controls', async () => {
    const panel = build();
    panel.text.value = 'The staff were wonderful.';
    await panel.run();

    expect(panel.outcome.value?.kind).toBe('scored-labels');
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.labelSetName).toBe('Sentiment (test)');
  });

  it('exposes a verdict outcome unchanged', async () => {
    const verdictResponse = response({
      outcome: {
        kind: 'verdict',
        verdict: {
          safe: false,
          categories: [{ code: 'S10', name: 'Hate' }],
          unrecognisedCategories: []
        }
      }
    });
    const panel = build([VERDICT], vi.fn().mockResolvedValue(verdictResponse));
    panel.text.value = 'x';
    await panel.run();

    if (panel.outcome.value?.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }
    expect(panel.outcome.value.verdict.safe).toBe(false);
  });

  it('clears the busy flag when the run finishes', async () => {
    const panel = build();
    panel.text.value = 'x';
    await panel.run();

    expect(panel.classifying.value).toBe(false);
  });

  // An empty ranking from a floor nobody reached is a real outcome of a successful run, not a
  // failure, so it must not set an error.
  it('treats an empty ranking as a result rather than a failure', async () => {
    const empty = response({
      outcome: { kind: 'scored-labels', labels: [], totalLabels: 2 }
    });
    const panel = build([SCORING], vi.fn().mockResolvedValue(empty));
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toBeNull();
    expect(panel.outcome.value?.kind).toBe('scored-labels');
  });
});

describe('failures', () => {
  it('shows the server\u2019s own message for an API failure', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'Test Verdict does not accept "topK".'));
    const panel = build([SCORING], transport);
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toBe('Test Verdict does not accept "topK".');
  });

  it('falls back to a generic message for a transport failure', async () => {
    const panel = build([SCORING], vi.fn().mockRejectedValue(new Error('offline')));
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toMatch(/could not be classified/u);
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
  it('reports no error when the visitor cancels', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const panel = build([SCORING], vi.fn().mockRejectedValue(abort));
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toBeNull();
  });

  it('aborts the request when cancelled', async () => {
    const panel = build();
    panel.text.value = 'x';

    const running = panel.run();
    panel.cancel();
    await running;

    const signal = panel.transport.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('clears a previous error on the next attempt', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'Provider failed.'))
      .mockResolvedValueOnce(response());
    const panel = build([SCORING], transport);
    panel.text.value = 'x';

    await panel.run();
    expect(panel.error.value).toBe('Provider failed.');

    await panel.run();
    expect(panel.error.value).toBeNull();
  });
});
