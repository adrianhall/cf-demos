import { beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { TranslateTextService } from '../../../src/worker/application/translate-text/translate-text-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { validateTranslateTextRequest } from '../../../src/worker/domain/translate-text';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

/**
 * The reviewed translation models, in catalogue order.
 */
const [M2M100, INDIC] = modelsForTask('translate-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity runs are attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Builds the service with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to the single-string envelope.
 * @returns The service, the fake port, the run repository, and the captured logs.
 */
function build(options: FakeInferenceOptions = {}): {
  service: TranslateTextService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({
    output: () => ({ translated_text: 'une traduction' }),
    ...options
  });
  const { capture, logger } = createLogCapture();
  // One clock for both. The repository prunes records past its retention window, so a service
  // writing at an injected fixed time into a repository reading the real clock would have its
  // record expire the instant it was saved.
  const now = (): number => 1_000;
  const runs = createMemoryRunRepository(now);

  return {
    service: new TranslateTextService({ inference, runs, logger, now }),
    inference,
    runs,
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
  return validateTranslateTextRequest({
    text: 'The water is cold today.',
    model: M2M100!.id,
    runId: RUN_ID,
    targetLanguage: 'fr',
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('translating text', () => {
  it('returns a translation, a receipt, and the applied controls', async () => {
    const { service } = build();
    const result = await service.translate(request(), ACTOR);

    expect(result.translation.text).toBe('une traduction');
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'translate-text',
      model: M2M100!.id,
      gatewayRouted: true,
      status: 'completed'
    });
    expect(result.applied.targetLanguage).toBe('fr');
  });

  it('routes the call through the gateway with the panel\u2019s task identifier', async () => {
    const { service, inference } = build();
    await service.translate(request(), ACTOR);

    expect(inference.requests[0]).toMatchObject({ task: 'translate-text', model: M2M100 });
  });

  // The attribution rule, asserted at the boundary that reaches the gateway. A run that could be
  // made without an identity would be a run producing an unattributable charge.
  it('attributes the run to the verified actor', async () => {
    const { service, inference } = build();
    await service.translate(request(), ACTOR);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  // Written before the method returns, so there is no window in which the browser holds a receipt
  // the server cannot resolve.
  it('persists the run record before returning', async () => {
    const { service, runs } = build();
    await service.translate(request(), ACTOR);

    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'translate-text',
      ownerEmail: ACTOR.email,
      status: 'completed'
    });
  });
});

describe('the variable number of inference calls', () => {
  // The substance of this panel. The same passage costs one call or one per line depending purely
  // on what the selected model's contract accepts.
  it('makes one call per line for a model that takes a single string', async () => {
    const { service, inference } = build();
    const result = await service.translate(request({ text: 'one\ntwo\nthree' }), ACTOR);

    expect(inference.requests).toHaveLength(3);
    expect(result.translation.inferenceCallCount).toBe(3);
  });

  it('makes one call for a model that accepts an array', async () => {
    const { service, inference } = build({
      output: () => ({ translations: ['एक', 'दो', 'तीन'] })
    });
    const result = await service.translate(
      request({ model: INDIC!.id, targetLanguage: 'hin_Deva', text: 'one\ntwo\nthree' }),
      ACTOR
    );

    expect(inference.requests).toHaveLength(1);
    expect(result.translation.inferenceCallCount).toBe(1);
  });

  it('sends every line in the single batched call', async () => {
    const { service, inference } = build({ output: () => ({ translations: ['A', 'B'] }) });
    await service.translate(
      request({ model: INDIC!.id, targetLanguage: 'hin_Deva', text: 'one\ntwo' }),
      ACTOR
    );

    const sent = inference.requests[0];
    expect(sent).toBeDefined();
    expect((sent?.input as Record<string, unknown> | undefined)?.['text']).toEqual(['one', 'two']);
  });

  // Blank lines are structure, never content, so they must not become paid calls.
  it('never spends a call on a blank line', async () => {
    const { service, inference } = build();
    await service.translate(request({ text: 'one\n\n\ntwo' }), ACTOR);

    expect(inference.requests).toHaveLength(2);
  });

  // This is the first panel whose receipt routinely carries several log identifiers. The cost
  // aggregation has always supported that; a receipt that reported only the last call's log would
  // under-report the run's cost.
  it('collects a gateway log identifier from every call', async () => {
    const { service } = build({ logId: 'log-x' });
    const result = await service.translate(request({ text: 'one\ntwo\nthree' }), ACTOR);

    expect(result.receipt.logIds).toHaveLength(3);
    expect(result.receipt.costStatus).toBe('pending');
  });

  it('records every log identifier on the persisted run', async () => {
    const { service, runs } = build({ logId: 'log-x' });
    await service.translate(request({ text: 'one\ntwo' }), ACTOR);

    expect((await runs.find(RUN_ID))?.logIds).toHaveLength(2);
  });

  // A run with no log will never resolve a cost, so it must not be reported as pending.
  it('does not mark the cost pending when no log was assigned', async () => {
    const { service } = build({ logId: null });
    const result = await service.translate(request(), ACTOR);

    expect(result.receipt.logIds).toEqual([]);
    expect(result.receipt.costStatus).not.toBe('pending');
  });

  // Sequential rather than parallel, deliberately. A failure partway through a parallel fan-out
  // would leave an unknown number of paid calls in flight with no way to report what was spent.
  it('makes the calls one after another', async () => {
    let concurrent = 0;
    let peak = 0;
    const { service } = build({
      output: () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        concurrent -= 1;
        return { translated_text: 'x' };
      }
    });

    await service.translate(request({ text: 'one\ntwo\nthree' }), ACTOR);

    expect(peak).toBe(1);
  });
});

describe('preserving line structure end to end', () => {
  it('reassembles the lines in order', async () => {
    let call = 0;
    const { service } = build({
      output: () => ({ translated_text: ['un', 'deux', 'trois'][call++] ?? 'x' })
    });

    const result = await service.translate(request({ text: 'one\ntwo\nthree' }), ACTOR);

    expect(result.translation.text).toBe('un\ndeux\ntrois');
  });

  // The promise this panel makes, asserted through the real service rather than only against the
  // reassembly helper.
  it('keeps an internal blank line in position', async () => {
    let call = 0;
    const { service } = build({
      output: () => ({ translated_text: ['un', 'trois'][call++] ?? 'x' })
    });

    const result = await service.translate(request({ text: 'one\n\nthree' }), ACTOR);

    expect(result.translation.text).toBe('un\n\ntrois');
    expect(result.translation.segments).toHaveLength(3);
  });

  it('aligns each source line with its own translation', async () => {
    const { service } = build({ output: () => ({ translations: ['A', 'B'] }) });
    const result = await service.translate(
      request({ model: INDIC!.id, targetLanguage: 'hin_Deva', text: 'one\n\ntwo' }),
      ACTOR
    );

    expect(result.translation.segments.map((s) => [s.source, s.translated])).toEqual([
      ['one', 'A'],
      ['', ''],
      ['two', 'B']
    ]);
  });
});

describe('refusing unusable output', () => {
  it('rejects a non-object response', async () => {
    const { service } = build({ output: () => 'just a string' });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('rejects an unrecognised envelope', async () => {
    const { service } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // A model returning another model's shape is a contract break, and it has to be loud rather than
  // silently producing an empty translation.
  it('rejects a response in the other model\u2019s envelope', async () => {
    const { service } = build({ output: () => ({ translations: ['wrong shape'] }) });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // Neither a routing fault nor a contract break is fixed by retrying, and saying "try again" would
  // send someone to spend credit on the same outcome.
  it('says retrying will not help for a contract fault', async () => {
    const { service } = build({ output: () => ({ request_id: 'queued-123' }) });

    await expect(service.translate(request(), ACTOR)).rejects.toThrow(/unlikely to help/u);
  });

  it('suggests rephrasing for an empty translation', async () => {
    const { service } = build({ output: () => ({ translated_text: '' }) });

    await expect(service.translate(request(), ACTOR)).rejects.toThrow(/rephrasing/u);
  });

  // A passage half-translated is not a translation, and returning one would both look like a model
  // that trails off and charge for lines the visitor cannot use.
  it('fails the whole run when a later line fails', async () => {
    let call = 0;
    const { service } = build({
      output: () => (call++ === 2 ? { unexpected: 'envelope' } : { translated_text: 'ok' })
    });

    await expect(
      service.translate(request({ text: 'one\ntwo\nthree\nfour' }), ACTOR)
    ).rejects.toThrow(ProblemDetailsError);
  });

  it('does not persist a run record for a refused output', async () => {
    const { service, runs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('diagnosing a partial failure', () => {
  // For a non-batching model the interesting question is *which line* broke, and a status code
  // cannot answer it. This is the diagnostic that makes a nine-of-twelve failure understandable.
  it('records which call failed and how many had completed', async () => {
    let call = 0;
    const { service, logs } = build({
      output: () => (call++ === 2 ? { unexpected: 'envelope' } : { translated_text: 'ok' })
    });

    await expect(
      service.translate(request({ text: 'one\ntwo\nthree\nfour' }), ACTOR)
    ).rejects.toThrow();

    const refused = logs.entries.find(
      (entry) => entry.message === 'translate_text_output_unusable'
    );
    expect(refused?.context).toMatchObject({
      reason: 'missing_translation',
      failedCall: 3,
      totalCalls: 4,
      // Already billed for two calls when the third failed, which is the number someone
      // reconciling a bill needs.
      callsCompleted: 2,
      expectedField: 'translated_text'
    });
  });

  it('records the run identifier on the refusal, so one search returns the whole story', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find(
      (entry) => entry.message === 'translate_text_output_unusable'
    );
    expect(refused?.context?.['runId']).toBe(RUN_ID);
  });

  it('records the expected field for the batching model too', async () => {
    const { service, logs } = build({ output: () => ({ translated_text: 'wrong shape' }) });
    await expect(
      service.translate(request({ model: INDIC!.id, targetLanguage: 'hin_Deva' }), ACTOR)
    ).rejects.toThrow();

    const refused = logs.entries.find(
      (entry) => entry.message === 'translate_text_output_unusable'
    );
    expect(refused?.context?.['expectedField']).toBe('translations');
  });
});

describe('provider failures', () => {
  // Thrown as the real inference client throws it: the client logs the provider's own message and
  // raises a sanitised problem-details error, so a fake throwing a bare `Error` would exercise a
  // path production never takes.
  it('propagates a sanitised provider failure', async () => {
    const { service } = build({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });

    await expect(service.translate(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('does not persist a run record for a failed call', async () => {
    const { service, runs } = build({ failWith: new Error('upstream failure') });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('privacy', () => {
  // The source text is the visitor's content and must not reach a Worker log, even on the failure
  // path where a developer might reasonably want to see it.
  it('never logs the source text', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await service
      .translate(request({ text: 'my confidential sentence' }), ACTOR)
      .catch(() => undefined);

    expect(logs.text()).not.toContain('my confidential sentence');
  });

  it('never logs the translation', async () => {
    const { service, logs } = build({
      output: () => ({ translated_text: 'ma phrase confidentielle', translations: 'broken' })
    });
    await service.translate(request(), ACTOR).catch(() => undefined);

    expect(logs.text()).not.toContain('ma phrase confidentielle');
  });

  // The email belongs in AI Gateway metadata, which is a different retention domain with different
  // access control.
  it('never logs the verified email', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.translate(request(), ACTOR)).rejects.toThrow();

    expect(logs.text()).not.toContain(ACTOR.email);
  });
});
