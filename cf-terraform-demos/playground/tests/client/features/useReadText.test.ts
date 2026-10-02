import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useReadText } from '../../../src/client/features/read-text/useReadText';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { MAX_SPEECH_CHARACTERS, type ReadTextResponse } from '../../../src/shared/read-text';

/**
 * A voice-based model billed per character, matching the reviewed Aura 2 contract.
 */
const AURA: CatalogueModel = {
  id: '@cf/test/aura',
  name: 'Test Aura',
  provider: 'workers-ai',
  task: 'read-text',
  pricingUnit: 'provider-reported',
  documentationUrl: 'https://example.invalid/aura',
  speechControls: {
    textParameterName: 'text',
    voices: ['luna', 'orion', 'hera'],
    defaultVoice: 'luna',
    formats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    pricePerThousandCharactersUsd: 0.03
  }
};

/**
 * A second voice-based model whose voice list only partially overlaps the first, mirroring the two
 * reviewed Aura generations. The partial overlap is the point: it is what makes carrying a voice
 * across a model change dangerous rather than merely untidy.
 */
const AURA_OLD: CatalogueModel = {
  id: '@cf/test/aura-old',
  name: 'Test Aura Old',
  provider: 'workers-ai',
  task: 'read-text',
  pricingUnit: 'provider-reported',
  documentationUrl: 'https://example.invalid/aura-old',
  speechControls: {
    textParameterName: 'text',
    voices: ['angus', 'orion'],
    defaultVoice: 'angus',
    formats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    pricePerThousandCharactersUsd: 0.015
  }
};

/**
 * A language-based model with no voice control and no character pricing, matching MeloTTS.
 */
const MELO: CatalogueModel = {
  id: '@cf/test/melo',
  name: 'Test Melo',
  provider: 'workers-ai',
  task: 'read-text',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/melo',
  speechControls: {
    textParameterName: 'prompt',
    languages: ['en', 'fr'],
    defaultLanguage: 'en',
    languageSelectsVoice: true
  }
};

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<ReadTextResponse> = {}): ReadTextResponse {
  return {
    speech: { base64: 'SUQzAwA=', mediaType: 'audio/mpeg', byteLength: 2_048 },
    receipt: {
      runId: 'run-1',
      task: 'read-text',
      model: AURA.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 120,
      startedAt: new Date().toISOString()
    },
    applied: { model: AURA.id, characterCount: 12, voice: 'luna', format: 'mp3' },
    ...overrides
  };
}

/**
 * Builds the composable with an injected transport.
 *
 * @param models Catalogue models to offer.
 * @param speak Transport to use.
 * @returns The composable result.
 */
function build(
  models: CatalogueModel[] = [AURA, AURA_OLD, MELO],
  transport = vi.fn().mockResolvedValue(response())
) {
  const result = useReadText({
    models: ref(models),
    speak: transport,
    // Resolve polls immediately rather than waiting seconds of real time.
    runOptions: { sleep: async () => undefined }
  });
  // Exposed as `transport` rather than merged over the composable's own `speak` action, which it
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
    expect(build().model.value).toBe(AURA.id);
  });

  it('exposes the selected model descriptor', () => {
    expect(build().selectedModel.value?.name).toBe('Test Aura');
  });

  it('offers no model when the catalogue is empty', () => {
    const panel = build([]);
    expect(panel.model.value).toBe('');
    expect(panel.selectedModel.value).toBeUndefined();
  });
});

describe('resetting controls when the model changes', () => {
  // The dangerous case. The two Aura generations share `orion` and differ on everything else, so a
  // voice carried blindly across a switch would produce a request the server refuses.
  it('clears a voice the new model does not publish', async () => {
    const panel = build();
    panel.voice.value = 'hera';

    panel.model.value = AURA_OLD.id;
    await nextTick();

    expect(panel.voice.value).toBeUndefined();
  });

  // The other half of the rule: a value both models publish is worth keeping, because resetting it
  // would discard a choice that is still valid.
  it('keeps a voice the new model also publishes', async () => {
    const panel = build();
    panel.voice.value = 'orion';

    panel.model.value = AURA_OLD.id;
    await nextTick();

    expect(panel.voice.value).toBe('orion');
  });

  it('clears a voice when the new model has no voice control at all', async () => {
    const panel = build();
    panel.voice.value = 'luna';

    panel.model.value = MELO.id;
    await nextTick();

    expect(panel.voice.value).toBeUndefined();
  });

  it('clears a format when the new model offers no format choice', async () => {
    const panel = build();
    panel.format.value = 'wav';

    panel.model.value = MELO.id;
    await nextTick();

    expect(panel.format.value).toBeUndefined();
  });

  it('clears a language when the new model has no language control', async () => {
    const panel = build();
    panel.model.value = MELO.id;
    await nextTick();
    panel.language.value = 'fr';

    panel.model.value = AURA.id;
    await nextTick();

    expect(panel.language.value).toBeUndefined();
  });
});

describe('the character count and cost estimate', () => {
  it('counts the trimmed text', () => {
    const panel = build();
    panel.text.value = '  hello  ';
    expect(panel.characterCount.value).toBe(5);
  });

  // Counted in code points, matching the server's own limit, so the editor's counter cannot
  // disagree with the validation and refuse a passage the UI called acceptable.
  it('counts a non-BMP character once', () => {
    const panel = build();
    panel.text.value = '\u{1F600}\u{1F600}';
    expect(panel.characterCount.value).toBe(2);
  });

  it('estimates the cost from the published rate', () => {
    const panel = build();
    panel.text.value = 'a'.repeat(1_000);
    expect(panel.estimatedCostUsd.value).toBeCloseTo(0.03, 6);
  });

  it('estimates less for the cheaper model', async () => {
    const panel = build();
    panel.text.value = 'a'.repeat(1_000);
    panel.model.value = AURA_OLD.id;
    await nextTick();

    expect(panel.estimatedCostUsd.value).toBeCloseTo(0.015, 6);
  });

  // Absent rather than zero: the billable quantity does not exist until the audio does, and a zero
  // would read as "free".
  it('has no estimate for a model billed per minute of audio', async () => {
    const panel = build();
    panel.text.value = 'a'.repeat(1_000);
    panel.model.value = MELO.id;
    await nextTick();

    expect(panel.estimatedCostUsd.value).toBeUndefined();
  });
});

describe('whether the panel can be submitted', () => {
  it('refuses empty and whitespace-only text', () => {
    const panel = build();
    expect(panel.canSpeak.value).toBe(false);

    panel.text.value = '   ';
    expect(panel.canSpeak.value).toBe(false);
  });

  it('accepts text once something is typed', () => {
    const panel = build();
    panel.text.value = 'hello';
    expect(panel.canSpeak.value).toBe(true);
  });

  // Checked in the browser as a courtesy; the server validates independently. Allowing the request
  // would spend credit on something certain to be refused.
  it('refuses text beyond the limit', () => {
    const panel = build();
    panel.text.value = 'a'.repeat(MAX_SPEECH_CHARACTERS + 1);
    expect(panel.canSpeak.value).toBe(false);
  });

  it('accepts text exactly at the limit', () => {
    const panel = build();
    panel.text.value = 'a'.repeat(MAX_SPEECH_CHARACTERS);
    expect(panel.canSpeak.value).toBe(true);
  });

  it('refuses while a run is in flight', async () => {
    const panel = build();
    panel.text.value = 'hello';

    const running = panel.speak();
    expect(panel.canSpeak.value).toBe(false);
    await running;
  });
});

describe('building the request', () => {
  it('sends the trimmed text and the selected model', async () => {
    const panel = build();
    panel.text.value = '  hello  ';
    await panel.speak();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', model: AURA.id, runId: 'run-1' }),
      expect.anything()
    );
  });

  // Omitted so the server fills in the model's own documented default, which it then reports back
  // as applied. Sending a value the browser guessed would make the reported default this demo's
  // claim rather than the provider's.
  it('omits a control the visitor did not set', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('voice');
    expect(sent).not.toHaveProperty('format');
  });

  it('sends a chosen voice and format', async () => {
    const panel = build();
    panel.text.value = 'hello';
    panel.voice.value = 'hera';
    panel.format.value = 'wav';
    await panel.speak();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'hera', format: 'wav' }),
      expect.anything()
    );
  });

  // The server would refuse a control the model does not declare, so the browser does not offer the
  // chance to send one. This is the assertion that would catch a stale value surviving a model
  // switch and being forwarded.
  it('never sends a control the selected model does not declare', async () => {
    const panel = build();
    panel.text.value = 'hello';
    panel.model.value = MELO.id;
    await nextTick();
    // Set directly, as a stale value surviving a reset would be.
    panel.voice.value = 'luna';
    panel.format.value = 'wav';

    await panel.speak();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('voice');
    expect(sent).not.toHaveProperty('format');
  });

  it('never sends rate or pitch, which no model supports', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('rate');
    expect(sent).not.toHaveProperty('pitch');
  });

  // No identity field, and no way to supply one: the actor comes from the verified Access JWT.
  it('never sends an identity field', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });
});

describe('a successful run', () => {
  it('exposes the audio, receipt, and applied controls', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.speech.value?.mediaType).toBe('audio/mpeg');
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.voice).toBe('luna');
  });

  // A `data:` URI rather than a blob URL: the payload is small, and a blob would need revoking on
  // every replacement and on unmount — a leak that only appears after comparing several voices.
  it('builds a playable data URI from the returned bytes', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.audioUri.value).toBe('data:audio/mpeg;base64,SUQzAwA=');
  });

  it('has no audio URI before a run', () => {
    expect(build().audioUri.value).toBeUndefined();
  });

  it('clears the busy flag when the run finishes', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.speaking.value).toBe(false);
  });
});

describe('failures', () => {
  it('shows the server\u2019s own message for an API failure', async () => {
    const speak = vi.fn().mockRejectedValue(new ApiError(400, 'Test Aura does not support that.'));
    const panel = build([AURA], speak);
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.error.value).toBe('Test Aura does not support that.');
  });

  it('falls back to a generic message for a transport failure', async () => {
    const panel = build([AURA], vi.fn().mockRejectedValue(new Error('offline')));
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.error.value).toMatch(/could not be read aloud/u);
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message. Showing one
  // would make a deliberate action look broken.
  it('reports no error when the visitor cancels', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const panel = build([AURA], vi.fn().mockRejectedValue(abort));
    panel.text.value = 'hello';
    await panel.speak();

    expect(panel.error.value).toBeNull();
  });

  it('clears a previous error on the next attempt', async () => {
    const speak = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'Provider failed.'))
      .mockResolvedValueOnce(response());
    const panel = build([AURA], speak);
    panel.text.value = 'hello';

    await panel.speak();
    expect(panel.error.value).toBe('Provider failed.');

    await panel.speak();
    expect(panel.error.value).toBeNull();
  });

  it('aborts the request when cancelled', async () => {
    const panel = build();
    panel.text.value = 'hello';

    const running = panel.speak();
    panel.cancel();
    await running;

    const signal = panel.transport.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});

describe('accepting text handed over from another panel', () => {
  it('loads the text and reports its provenance', () => {
    const panel = build();
    panel.acceptHandoff({
      text: 'Bonjour le monde',
      origin: 'Translated into French',
      truncated: false
    });

    expect(panel.text.value).toBe('Bonjour le monde');
    expect(panel.notice.value).toBe('Translated into French');
  });

  // Reported rather than silently applied, so the panel can say some of the translation was left
  // behind instead of appearing to have mis-read it.
  it('says so when the text had to be shortened', () => {
    const panel = build();
    panel.acceptHandoff({ text: 'long', origin: 'Translated into French', truncated: true });

    expect(panel.notice.value).toMatch(/longer than this panel can read/u);
  });

  // The whole reason the handoff is worth having: a French translation read by an English voice is
  // a worse result than no handoff at all.
  it('preselects a language the selected model publishes', async () => {
    const panel = build();
    panel.model.value = MELO.id;
    await nextTick();

    panel.acceptHandoff({
      text: 'Bonjour',
      origin: 'Translated',
      truncated: false,
      language: 'fr'
    });

    expect(panel.language.value).toBe('fr');
  });

  // The code comes from another panel's model, which has no obligation to agree with this one's
  // list, so trusting it would stage a value the server rejects.
  it('ignores a language the selected model does not publish', async () => {
    const panel = build();
    panel.model.value = MELO.id;
    await nextTick();

    panel.acceptHandoff({ text: 'Hallo', origin: 'Translated', truncated: false, language: 'de' });

    expect(panel.language.value).toBeUndefined();
  });

  it('ignores a language when the model has no language control', () => {
    const panel = build();
    panel.acceptHandoff({
      text: 'Bonjour',
      origin: 'Translated',
      truncated: false,
      language: 'fr'
    });

    expect(panel.language.value).toBeUndefined();
  });

  // Audio left on screen beside a different passage reads as a recording *of* the new passage.
  it('discards the previous run\u2019s audio', async () => {
    const panel = build();
    panel.text.value = 'hello';
    await panel.speak();
    expect(panel.speech.value).toBeDefined();

    panel.acceptHandoff({ text: 'something else', origin: 'Translated', truncated: false });

    expect(panel.speech.value).toBeUndefined();
    expect(panel.receipt.value).toBeUndefined();
  });
});
