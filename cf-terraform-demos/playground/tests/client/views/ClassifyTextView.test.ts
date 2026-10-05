import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import ClassifyTextView from '../../../src/client/views/ClassifyTextView.vue';
import { clickTeleported, openDialogText, panelStubs } from '../support/panel';

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
      { code: 'POSITIVE', name: 'Positive', description: 'Favourable sentiment.' },
      { code: 'NEGATIVE', name: 'Negative', description: 'Unfavourable sentiment.' }
    ],
    topK: { min: 1, max: 10, step: 1, default: 2 },
    minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
    appliedBy: 'playground',
    contextWindowTokens: 512
  }
};

/**
 * A verdict model with no ranking controls, matching Llama Guard.
 */
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
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [SCORING, VERDICT]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(ClassifyTextView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  await flushPromises();

  return { wrapper };
}

/**
 * Builds a successful scored response body.
 *
 * @returns A JSON-ready payload.
 */
function scoredPayload(): unknown {
  return {
    outcome: {
      kind: 'scored-labels',
      labels: [
        { rank: 1, label: 'POSITIVE', name: 'Positive', score: 0.98 },
        { rank: 2, label: 'NEGATIVE', name: 'Negative', score: 0.02 }
      ],
      totalLabels: 2
    },
    receipt: {
      runId: 'run-1',
      task: 'classify-text',
      model: SCORING.id,
      gatewayRouted: true,
      logIds: [],
      status: 'completed',
      costStatus: 'unavailable',
      elapsedMs: 12,
      startedAt: new Date().toISOString()
    },
    applied: {
      model: SCORING.id,
      labelSetName: 'Sentiment (test)',
      topK: 2,
      minimumConfidence: 0,
      characterCount: 24
    }
  };
}

/**
 * Runs one classification through the real composable by stubbing `fetch`.
 *
 * @param payload Response body the server should return.
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper, after the run has settled.
 */
async function classifyOnce(payload: unknown = scoredPayload(), models?: CatalogueModel[]) {
  const mounted = await render(models);

  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  );

  await mounted.wrapper.find('#classify-text-input').setValue('The staff were wonderful.');
  await mounted.wrapper.find('.classify-button').trigger('click');
  await flushPromises();

  return mounted;
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('the view should not reach the network in a test');
    })
  );
});

describe('the panel\u2019s disclosures', () => {
  // Required of every inference panel by `tests/client/privacy-claims.test.ts`. Asserted here too
  // so a reworded disclosure fails in the panel's own test rather than only in the global guard.
  it('warns that the text is logged and advises against confidential input', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your text is logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  // The panel's central teaching point, and the deliverable that distinguishes it from Evaluate
  // Choices.
  it('explains that this is fixed-label classification', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/fixed-label classification/iu);
    expect(text).toMatch(/cannot add to them or ask your own question/iu);
  });

  it('cross-links Evaluate Choices as the task for caller-defined questions', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/Evaluate Choices/u);
    expect(text).toMatch(/separate task with a separate API/iu);
  });

  // A confidence bar is extremely good at implying a score is a probability of correctness.
  it('warns that a score is not a probability of being correct', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/not a probability that the label is correct/iu);
  });

  it('notes that one model reports no score at all', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/reports no score at all/iu);
  });
});

describe('publishing the label set before any run', () => {
  // The panel's central teaching device: a visitor can see every answer the model is capable of
  // giving without submitting anything.
  it('lists every possible label for the selected model', async () => {
    const { wrapper } = await render();
    const entries = wrapper.findAll('.label-entry').map((entry) => entry.text());

    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('POSITIVE');
    expect(entries[0]).toContain('Positive');
  });

  it('names the label set', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toContain('Sentiment (test)');
  });

  it('states that the model cannot return anything outside the set', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toMatch(/cannot return anything outside them/iu);
  });

  it('switches to the other model\u2019s taxonomy', async () => {
    const { wrapper } = await render();
    await wrapper.find('#classify-model').setValue(VERDICT.id);

    expect(wrapper.text()).toContain('Test hazard taxonomy');
    const entries = wrapper.findAll('.label-entry').map((entry) => entry.text());
    expect(entries.join(' ')).toContain('S10');
  });

  it('shows a description where the reviewed label carries one', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toContain('Favourable sentiment.');
  });
});

describe('the per-model controls', () => {
  it('offers the ranking controls for a scoring model', async () => {
    const { wrapper } = await render();

    expect(wrapper.find('#classify-top-k').exists()).toBe(true);
    expect(wrapper.find('#classify-minimum-confidence').exists()).toBe(true);
  });

  // Absent rather than disabled: the model has no such field, and the server refuses one.
  it('offers no ranking controls for a verdict model', async () => {
    const { wrapper } = await render();
    await wrapper.find('#classify-model').setValue(VERDICT.id);

    expect(wrapper.find('#classify-top-k').exists()).toBe(false);
    expect(wrapper.find('#classify-minimum-confidence').exists()).toBe(false);
  });

  it('explains why the verdict model has no controls', async () => {
    const { wrapper } = await render();
    await wrapper.find('#classify-model').setValue(VERDICT.id);

    expect(wrapper.text()).toMatch(/nothing to rank or filter/iu);
  });

  // The distinction the contract publishes: asking a model for its top 3 is a different operation
  // from asking for everything and keeping three.
  it('states that this application applies the controls, not the model', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toMatch(/applied by\s+this application/iu);
    expect(wrapper.text()).toMatch(/the model was not asked to filter/iu);
  });

  it('binds the control ranges from the model declaration', async () => {
    const { wrapper } = await render();
    const topK = wrapper.find('#classify-top-k');

    expect(topK.attributes('min')).toBe('1');
    expect(topK.attributes('max')).toBe('10');
  });
});

describe('the composer', () => {
  it('reports the character count against the limit', async () => {
    const { wrapper } = await render();
    await wrapper.find('#classify-text-input').setValue('hello');

    expect(wrapper.find('#classify-text-hint').text()).toMatch(/5 of 1,500 characters/u);
  });

  it('is disabled until there is text', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.classify-button').attributes('disabled')).toBeDefined();
  });

  it('offers prepared passages without running them', async () => {
    const { wrapper } = await render();
    const examples = wrapper.findAll('.example');
    expect(examples.length).toBeGreaterThan(0);

    await examples[0]?.trigger('click');

    const textarea = wrapper.find<HTMLTextAreaElement>('#classify-text-input').element;
    expect(textarea.value).not.toBe('');
    // A prepared passage that spent credit the moment it was clicked would be a trap.
    expect(wrapper.find('.structured').exists()).toBe(false);
  });

  // The most instructive example in the panel: a binary classifier has no "neutral" label, so
  // neutral text splits the scores instead.
  it('includes a neutral example that demonstrates the closed label set', async () => {
    const { wrapper } = await render();
    const notes = wrapper.findAll('.example').map((entry) => entry.text());

    expect(notes.join(' ')).toMatch(/no "neutral" label/iu);
  });

  // An unsafe verdict is the half of the safety model nobody can see without triggering one, and
  // inventing a prompt on the spot tends to mean typing something genuinely unpleasant.
  it('offers examples that reach a cited safety category', async () => {
    const { wrapper } = await render();
    const labels = wrapper.findAll('.example').map((entry) => entry.text());

    expect(labels.join(' ')).toMatch(/S7/u);
    expect(labels.join(' ')).toMatch(/S13/u);
  });

  // Both flagging examples describe mishandling data or spreading misinformation rather than
  // depicting harm, so the panel can demonstrate a verdict without asking anyone to write
  // something they would rather not.
  it('keeps the flagging examples mild', async () => {
    const { wrapper } = await render();
    const text = wrapper.text().toLowerCase();

    for (const word of ['bomb', 'weapon', 'kill', 'suicide', 'explosive']) {
      expect(text, `examples avoid "${word}"`).not.toContain(word);
    }
  });

  it('links to the selected model\u2019s catalogue page', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.docs-link a').attributes('href')).toBe(SCORING.documentationUrl);
  });

  it('shows no output column before a run', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.structured').exists()).toBe(false);
  });
});

describe('rendering a scored result', () => {
  it('renders the ranked labels', async () => {
    const { wrapper } = await classifyOnce();

    expect(wrapper.find('table.ranked-labels').exists()).toBe(true);
    expect(wrapper.text()).toContain('Positive');
  });

  it('names the label set the scores came from', async () => {
    const { wrapper } = await classifyOnce();
    expect(wrapper.text()).toContain('Sentiment (test)');
  });

  // Phrased as "showing all N" rather than "top N", because the model was not asked for N.
  it('describes how much of the model\u2019s output is shown', async () => {
    const { wrapper } = await classifyOnce();
    expect(wrapper.text()).toMatch(/showing all 2 labels this model returned/iu);
  });

  it('says what was hidden when the result was truncated', async () => {
    const truncated = {
      ...(scoredPayload() as Record<string, unknown>),
      outcome: {
        kind: 'scored-labels',
        labels: [{ rank: 1, label: 'POSITIVE', name: 'Positive', score: 0.98 }],
        totalLabels: 2
      }
    };
    const { wrapper } = await classifyOnce(truncated);

    expect(wrapper.text()).toMatch(/showing 1 of the 2 labels this model returned/iu);
  });

  // A real outcome of a successful run rather than a failure, said plainly with the remedy.
  it('explains an empty result rather than showing an error', async () => {
    const empty = {
      ...(scoredPayload() as Record<string, unknown>),
      outcome: { kind: 'scored-labels', labels: [], totalLabels: 2 }
    };
    const { wrapper } = await classifyOnce(empty);

    expect(wrapper.find('.error').exists()).toBe(false);
    expect(wrapper.find('.empty').text()).toMatch(/lower it to see what the model returned/iu);
  });
});

describe('rendering a verdict result', () => {
  /**
   * A verdict response body.
   *
   * @returns A JSON-ready payload.
   */
  function verdictPayload(): unknown {
    return {
      outcome: {
        kind: 'verdict',
        verdict: {
          safe: true,
          categories: [],
          unrecognisedCategories: []
        }
      },
      receipt: {
        runId: 'run-1',
        task: 'classify-text',
        model: VERDICT.id,
        gatewayRouted: true,
        logIds: [],
        status: 'completed',
        costStatus: 'unavailable',
        elapsedMs: 12,
        startedAt: new Date().toISOString()
      },
      applied: {
        model: VERDICT.id,
        labelSetName: 'Test hazard taxonomy',
        characterCount: 24
      }
    };
  }

  // Switched on the outcome's discriminant, so a verdict never reaches the ranking renderer.
  it('uses the verdict renderer rather than a ranked table', async () => {
    const { wrapper } = await classifyOnce(verdictPayload(), [VERDICT]);

    expect(wrapper.find('.verdict').exists()).toBe(true);
    expect(wrapper.find('table.ranked-labels').exists()).toBe(false);
  });

  it('shows no percentage anywhere for a verdict', async () => {
    const { wrapper } = await classifyOnce(verdictPayload(), [VERDICT]);

    expect(wrapper.find('.verdict').text()).not.toMatch(/\d+(\.\d+)?%/u);
  });

  it('names the taxonomy the verdict came from', async () => {
    const { wrapper } = await classifyOnce(verdictPayload(), [VERDICT]);
    expect(wrapper.text()).toContain('Test hazard taxonomy');
  });
});

describe('the structured disclosure', () => {
  // The deliverable asks for the structured response to be available; it stays one disclosure away
  // because the rendered result is the answer.
  it('offers the raw response behind a closed disclosure', async () => {
    const { wrapper } = await classifyOnce();
    const details = wrapper.find('details.structured');

    expect(details.exists()).toBe(true);
    expect(details.attributes('open')).toBeUndefined();
    expect(details.find('summary').text()).toMatch(/structured response/iu);
  });

  // The rendered view rounds for legibility, and this is where someone checks what the rounding
  // hid — so it must carry the model's actual output.
  it('shows the full-precision outcome as JSON', async () => {
    const { wrapper } = await classifyOnce();
    const json = wrapper.find('.structured-json').text();

    expect(json).toContain('"score": 0.98');
    expect(json).toContain('"totalLabels": 2');
  });

  it('is available for a verdict too', async () => {
    const verdict = {
      outcome: {
        kind: 'verdict',
        verdict: { safe: true, categories: [], unrecognisedCategories: [] }
      },
      receipt: {
        runId: 'run-1',
        task: 'classify-text',
        model: VERDICT.id,
        gatewayRouted: true,
        logIds: [],
        status: 'completed',
        costStatus: 'unavailable',
        elapsedMs: 12,
        startedAt: new Date().toISOString()
      },
      applied: {
        model: VERDICT.id,
        labelSetName: 'Test hazard taxonomy',
        characterCount: 24
      }
    };
    const { wrapper } = await classifyOnce(verdict, [VERDICT]);

    expect(wrapper.find('.structured-json').text()).toContain('"safe": true');
  });
});

describe('the Evaluate Choices cross-link', () => {
  // The phase brief asks for a cross-link that does not share the API. Placed in the result area,
  // because the moment someone wants their own criteria is when they see an answer drawn from a
  // list they did not choose.
  it('links to Evaluate Choices beside the result', async () => {
    const { wrapper } = await classifyOnce();
    const link = wrapper.find('.cross-link a');

    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('/evaluate-choices');
  });

  it('explains that it is a separate task with its own API', async () => {
    const { wrapper } = await classifyOnce();

    expect(wrapper.find('.cross-link').text()).toMatch(/separate task with its own API/iu);
    expect(wrapper.find('.cross-link').text()).toMatch(/labels are fixed by the model/iu);
  });

  it('shows no cross-link before a run', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.cross-link').exists()).toBe(false);
  });
});
