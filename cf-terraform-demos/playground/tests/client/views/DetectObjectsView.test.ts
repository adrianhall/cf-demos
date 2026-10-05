/**
 * @file Tests for the Detect Objects view. Two things carry the weight here. The first is the
 *   **accessibility guard**: the overlay is an enhancement on a result that must already be
 *   complete without it, so a test removes every box and asserts that nothing a visitor needs has
 *   gone with them. That is the same promise Classify Image makes about its confidence bars, and it
 *   is the one most easily broken by a change that moves a detail into the overlay because there
 *   was room for it there. The second is **honesty about what this model does not return**. A
 *   detection is four numbers; the label beside it is the visitor's own target phrase echoed back,
 *   and there is no confidence anywhere. A panel that implied otherwise would teach the wrong thing
 *   about object detection, so the copy is asserted rather than left to review.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { buildRoutes } from '../../../src/client/router';
import { useCatalogueStore, type CatalogueModel } from '../../../src/client/stores/catalogue';
import ClassifyImageView from '../../../src/client/views/ClassifyImageView.vue';
import DetectObjectsView from '../../../src/client/views/DetectObjectsView.vue';
import { findTask } from '../../../src/shared/tasks';
import {
  clickTeleported,
  createPanelTitleTarget,
  openDialogText,
  panelStubs
} from '../support/panel';

/**
 * The reviewed detector, as the catalogue publishes it.
 */
const MOONDREAM: CatalogueModel = {
  id: '@cf/moondream/moondream3.1-9B-A2B',
  name: 'Moondream 3.1',
  provider: 'workers-ai',
  task: 'detect-objects',
  pricingUnit: 'token',
  documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/',
  detectionControls: {
    target: { required: true },
    maxObjects: { min: 1, max: 500, step: 1, default: 150 },
    appliedBy: 'model',
    scoreFloor: false
  }
};

/**
 * Two boxes in the shape the normaliser produces, matching a live two-object response.
 */
const DETECTIONS = [
  { index: 1, label: 'dog', xMin: 0.06, yMin: 0.24, xMax: 0.31, yMax: 0.75, region: 'left' },
  { index: 2, label: 'dog', xMin: 0.68, yMin: 0.24, xMax: 0.93, yMax: 0.75, region: 'right' }
];

/**
 * Wrappers mounted by the current test, unmounted before the next one runs.
 */
const mounted: { unmount: () => void }[] = [];

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [MOONDREAM]) {
  createPanelTitleTarget();

  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(DetectObjectsView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/**
 * Runs one detection against a stubbed endpoint and returns the mounted panel.
 *
 * Drives the real composable over a stubbed `fetch` rather than injecting a result, because what is
 * being tested is the wiring between a completed run and what the panel renders.
 *
 * @param detections Regions the endpoint should report.
 * @returns The mounted wrapper, after the run has completed.
 */
async function renderWithResult(detections = DETECTIONS) {
  const result = {
    detections,
    image: { mediaType: 'image/png', width: 640, height: 400, byteLength: 1024 },
    receipt: {
      runId: 'run-1',
      task: 'detect-objects',
      model: MOONDREAM.id,
      gatewayRouted: true,
      logIds: ['log-abc'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 120,
      startedAt: '2026-04-01T09:15:00.000Z'
    },
    applied: { model: MOONDREAM.id, target: 'dog', maxObjects: 150 }
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/metrics')
              ? { runId: 'run-1', costStatus: 'available', totalCostUsd: 0.000_003, requests: [] }
              : result
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
  );

  const wrapper = await render();

  // A picture has to be staged before the panel will run, and the picker reads a real file.
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', {
    type: 'image/png'
  });
  wrapper.findComponent({ name: 'SourceImagePicker' }).vm.$emit('selected', file);
  await flushPromises();

  // Found by its label rather than by position: the picker contributes Replace and Remove buttons
  // ahead of this one, so `find('button')` would click the wrong control and silently assert
  // nothing.
  const detect = wrapper
    .findAll('button')
    .find((candidate) => candidate.text() === 'Detect objects');
  await detect!.trigger('click');
  // Twice: the first settles the detection request, the second the metrics poll that follows it.
  // One flush leaves the result rendered but the receipt still resolving.
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
  // Each test mounts its own panel, and a wrapper left mounted by the previous one keeps rendering
  // against a `fetch` stub that has since been replaced. Its next update then throws, which
  // surfaces as the *following* test seeing an empty result rather than as a failure where the
  // fault is. Unmounting between tests keeps each one reading only its own render.
  for (const wrapper of mounted.splice(0)) {
    wrapper.unmount();
  }
});

describe('Detect Objects is its own panel', () => {
  // Share code, not tabs. Detect Objects reuses Classify Image's picker and result conventions,
  // but a visitor who wants to know *where* something is has their own destination.
  it('has its own top-level route bound to its own view', () => {
    const route = buildRoutes().find((candidate) => candidate.path === '/detect-objects');

    expect(route).toBeDefined();
    expect(route?.component).toBe(DetectObjectsView);
    expect(route?.component).not.toBe(ClassifyImageView);
  });

  it('is a sibling of Classify Image rather than nested beneath it', () => {
    const routes = buildRoutes();
    const detect = routes.find((candidate) => candidate.path === '/detect-objects');
    const classify = routes.find((candidate) => candidate.path === '/classify-image');

    expect(detect?.children).toBeUndefined();
    expect(classify?.children).toBeUndefined();
    expect(detect?.path.startsWith('/classify-image')).toBe(false);
  });

  it('is a delivered catalogue panel with its own name and task type', () => {
    const task = findTask('detect-objects');

    expect(task?.name).toBe('Detect Objects');
    expect(task?.taskType).toBe('Object detection');
    expect(task?.availability).toBe('available');
  });
});

describe('the overlay is an enhancement, not the result', () => {
  // The guard the phase asks for, and the counterpart to Classify Image's "removing every bar
  // loses no information". Every fact in a box must also exist as text, because a visitor using a
  // screen reader, or one whose image fails to load, still has to get the whole answer.
  it('loses no information when every box is removed', async () => {
    const wrapper = await renderWithResult();

    // Detached clone rather than mutating the live tree: removing a node Vue still owns corrupts
    // its virtual DOM, and the damage shows up as an unrelated later test rendering nothing.
    const detached = wrapper.element.cloneNode(true) as HTMLElement;
    for (const box of detached.querySelectorAll('.box')) {
      box.remove();
    }
    const withoutOverlay = (detached.textContent ?? '').replaceAll(/\s+/gu, ' ');

    expect(detached.querySelectorAll('.box')).toHaveLength(0);

    // The count, the target, and every region description survive without a single box.
    for (const detection of DETECTIONS) {
      expect(withoutOverlay).toContain(detection.label);
      expect(withoutOverlay).toContain(detection.region);
    }
    expect(withoutOverlay).toContain(String(DETECTIONS.length));
  });

  it('renders a table row for every detected region', async () => {
    const wrapper = await renderWithResult();

    expect(wrapper.findAll('tbody tr')).toHaveLength(DETECTIONS.length);
  });

  it('describes each region in words rather than only in coordinates', async () => {
    const wrapper = await renderWithResult();
    const text = wrapper.text();

    expect(text).toContain('left');
    expect(text).toContain('right');
    // A raw coordinate is not a description a person can act on, so it must not be the only form
    // the region appears in.
    expect(text).not.toContain('0.06');
  });
});

describe('overlay geometry', () => {
  // Percentages rather than pixels, so a box tracks the image as the preview is resized. Pinning
  // to natural pixel size is the intuitive implementation and is wrong on every layout but one.
  it('positions each box as a percentage so it scales with the preview', async () => {
    const wrapper = await renderWithResult();
    const style = wrapper.findAll('.box')[0]!.attributes('style') ?? '';

    expect(style).toContain('%');
    expect(style).not.toContain('px');
    expect(style).toContain('left: 6%');
    expect(style).toContain('width: 25%');
  });

  it('gives every box an accessible name carrying its target and region', async () => {
    const wrapper = await renderWithResult();

    expect(wrapper.findAll('.box')[0]!.attributes('aria-label')).toBe('dog, left');
  });
});

describe('what the model does not return', () => {
  /**
   * Opens the panel's pre-request disclosure, which lives in the info modal.
   *
   * @returns The modal's text.
   */
  async function disclosures(): Promise<string> {
    await render();
    await clickTeleported('.about-button');
    return openDialogText();
  }

  // The panel's central teaching point. Classify Image picks from a fixed label set it was trained
  // on; this model localises a phrase the visitor supplies, and returns no confidence at all.
  it('states that it localises a supplied phrase and returns no score', async () => {
    const text = await disclosures();

    expect(text).toMatch(/localises the phrase you supply/iu);
    expect(text).toMatch(/no confidence score/iu);
  });

  it('shows no confidence or score column in the results table', async () => {
    const wrapper = await renderWithResult();
    const headers = wrapper.findAll('th').map((cell) => cell.text().toLowerCase());

    expect(headers).not.toContain('score');
    expect(headers).not.toContain('confidence');
    expect(headers).toContain('region');
  });

  it('describes the maximum as a limit the model itself applies', async () => {
    const wrapper = await render();

    expect(wrapper.text()).toMatch(/model applies this limit/iu);
  });
});

describe('result states', () => {
  // A target the picture does not contain is a real answer, not a failure, and there is no score
  // floor here that could have hidden anything — so the wording must not hedge.
  it('reports an empty detection set as a successful run', async () => {
    const wrapper = await renderWithResult([]);
    const text = wrapper.text();

    expect(text).toMatch(/no objects matching/iu);
    expect(text).toMatch(/successful run/iu);
    expect(wrapper.findAll('.box')).toHaveLength(0);
  });

  // The output column appears when a picture is chosen rather than when a run finishes, so the
  // waiting state is reachable and has to say something different from "found nothing". A visitor
  // who cannot tell those apart does not know whether to press the button.
  it('distinguishes "not run yet" from "nothing found"', async () => {
    const wrapper = await render();

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', {
      type: 'image/png'
    });
    wrapper.findComponent({ name: 'SourceImagePicker' }).vm.$emit('selected', file);
    await flushPromises();

    expect(wrapper.text()).toMatch(/will appear here/iu);
    expect(wrapper.text()).not.toMatch(/no objects matching/iu);
  });
});
