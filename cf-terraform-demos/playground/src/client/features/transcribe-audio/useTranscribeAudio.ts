/**
 * @file Stateful composable behind the Transcribe Audio panel: choosing or recording audio, setting
 *   whichever controls the selected model declares, running the transcription, and handing the
 *   completed run to {@link useRun} for cost resolution. Two things make this harder than the
 *   panels before it. **The size limit changes with the model.** Every earlier panel had one upload
 *   ceiling; here the limit is published per model, because one reviewed model's schema demands the
 *   audio as a JSON array of byte values and cannot safely be given as much as the others. So a
 *   file already loaded can become invalid by switching model, and the composable re-checks rather
 *   than letting the visitor discover it at the server. It keeps the file and reports the problem,
 *   because discarding a large upload the visitor waited to read would be a worse answer than
 *   telling them to pick a different model. **Recording is optional and must stay optional.** The
 *   microphone is a progressive enhancement: the panel is fully usable by upload alone, and a
 *   browser without `MediaRecorder` — or a visitor who denies permission — loses nothing but that
 *   one route. The recording states are modelled explicitly rather than as booleans so the UI can
 *   tell a denial apart from a device fault, since those need opposite advice.
 */

import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import {
  estimateTranscriptionCostUsd,
  MAX_CONTEXT_PROMPT_CHARACTERS,
  type AppliedTranscriptionControls,
  type Transcript,
  type TranscribeAudioRequest,
  type VerifiedAudioFacts
} from '../../../shared/transcribe-audio';
import {
  canRecordAudio,
  classifyRecordingFailure,
  preferredRecordingMimeType,
  prepareAudio,
  recordingFileName,
  type PreparedAudio,
  type RecordingState
} from '../../components/media/audio-input';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, transcribeAudio } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useTranscribeAudio}.
 */
export interface UseTranscribeAudioOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Transcription transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  transcribe?: typeof transcribeAudio;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
  /**
   * Clock used to name a recording, injected so a test can assert on the generated file name.
   */
  now?: () => number;
}

/**
 * What the Transcribe Audio panel binds to.
 */
export interface UseTranscribeAudioResult {
  /**
   * The chosen or recorded audio, or `undefined` before anything is selected.
   */
  audio: Ref<PreparedAudio | undefined>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Selected language hint, or `undefined` to send none.
   */
  language: Ref<string | undefined>;
  /**
   * Whether to ask the model to detect the language.
   */
  detectLanguage: Ref<boolean>;
  /**
   * Whether to ask the model to label speakers.
   */
  diarize: Ref<boolean>;
  /**
   * Whether to ask the model to punctuate.
   */
  punctuate: Ref<boolean>;
  /**
   * Domain vocabulary to bias the transcript towards.
   */
  contextPrompt: Ref<string>;
  /**
   * The selected model's descriptor, so the view can render only its declared controls.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Largest file the selected model accepts, in bytes.
   */
  maxAudioBytes: Ref<number>;
  /**
   * Whether a transcription is in flight.
   */
  transcribing: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * A note about the current audio that is information rather than failure, or `null`.
   *
   * Used when a loaded file became too large for a newly selected model. Distinct from `error`,
   * because nothing has gone wrong — the visitor simply has to choose between the file and the
   * model.
   */
  notice: Ref<string | null>;
  /**
   * Where the microphone flow stands; see {@link RecordingState}.
   */
  recordingState: Ref<RecordingState>;
  /**
   * How many seconds the current recording has been running.
   */
  recordingSeconds: Ref<number>;
  /**
   * The most recent transcript, or `undefined` before a run.
   */
  transcript: Ref<Transcript | undefined>;
  /**
   * What the server verified about the submitted audio, or `undefined` before a run.
   */
  verifiedAudio: Ref<VerifiedAudioFacts | undefined>;
  /**
   * Receipt of the most recently completed run, or `undefined`.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Resolved gateway metrics for the most recent run, or `undefined` while unresolved.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether the most recent run's cost is still being polled for.
   */
  costPending: Ref<boolean>;
  /**
   * The controls the server reported applying, or `undefined` before a run.
   */
  applied: Ref<AppliedTranscriptionControls | undefined>;
  /**
   * Estimated cost of the loaded audio, or `undefined` when the duration is unknown.
   *
   * Almost always `undefined` before a run: only WAV declares a duration the browser reads here.
   * The panel says so rather than implying an estimate is coming.
   */
  estimatedCostUsd: Ref<number | undefined>;
  /**
   * Whether the panel can be submitted.
   */
  canTranscribe: Ref<boolean>;
  /**
   * Accepts a chosen file.
   *
   * @param file The file a visitor picked or dropped.
   * @returns A promise fulfilled once the file has been read and validated.
   */
  selectFile: (file: File) => Promise<void>;
  /**
   * Discards the loaded audio.
   *
   * @returns Nothing.
   */
  clearAudio: () => void;
  /**
   * Asks for microphone permission and starts recording.
   *
   * @returns A promise fulfilled once recording has started or failed.
   */
  startRecording: () => Promise<void>;
  /**
   * Stops recording and loads the result as the current audio.
   *
   * @returns Nothing; the recorder's stop handler loads the audio.
   */
  stopRecording: () => void;
  /**
   * Transcribes the loaded audio.
   *
   * @returns A promise fulfilled when the run has completed or failed and its cost has been
   *   tracked.
   */
  run: () => Promise<void>;
  /**
   * Stops waiting for the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted.
   */
  cancel: () => void;
}

/**
 * Drives the Transcribe Audio panel.
 *
 * @param options Catalogue models, injectable transport, run-tracking options, and clock; see
 *   {@link UseTranscribeAudioOptions}.
 * @returns Reactive form state and actions; see {@link UseTranscribeAudioResult}.
 */
export function useTranscribeAudio(options: UseTranscribeAudioOptions): UseTranscribeAudioResult {
  const transport = options.transcribe ?? transcribeAudio;
  const clock = options.now ?? Date.now;
  const runTracker = useRun(options.runOptions);

  const audio = shallowRef<PreparedAudio | undefined>(undefined);
  const model = ref('');
  const language = ref<string | undefined>(undefined);
  const detectLanguage = ref(false);
  const diarize = ref(false);
  const punctuate = ref(false);
  const contextPrompt = ref('');

  const transcribing = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const transcript = shallowRef<Transcript | undefined>(undefined);
  const verifiedAudio = shallowRef<VerifiedAudioFacts | undefined>(undefined);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedTranscriptionControls | undefined>(undefined);

  // `unsupported` until proven otherwise, so a browser without the APIs never offers the button.
  const recordingState = ref<RecordingState>(canRecordAudio() ? 'idle' : 'unsupported');
  const recordingSeconds = ref(0);

  let controller: AbortController | undefined;
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let tickHandle: ReturnType<typeof setInterval> | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * The selected model's declared transcription controls, or `undefined` before the catalogue
   * loads.
   */
  const controls = computed(() => selectedModel.value?.transcriptionControls);

  /**
   * Largest file the selected model accepts.
   *
   * Falls back to zero before the catalogue arrives, which makes the picker refuse rather than
   * accept a file it cannot yet size-check — the safer direction when the limit is unknown.
   */
  const maxAudioBytes = computed(() => controls.value?.maxAudioBytes ?? 0);

  // The first reviewed model becomes the default once the catalogue arrives, so the catalogue's
  // order is the preference order and there is no second list to keep in step with it.
  watch(
    options.models,
    (available) => {
      const first = available[0];
      if (model.value === '' && first !== undefined) {
        model.value = first.id;
      }
    },
    { immediate: true }
  );

  // Switching model re-settles every control against the new model's declared support, and
  // re-checks the loaded file against its size ceiling.
  //
  // The file is kept rather than discarded. A visitor who waited for a 3 MB upload and then
  // switched model should be told the file is too large for that model, not silently emptied —
  // switching back must restore a working state, which it cannot do if the bytes were thrown away.
  watch(selectedModel, (current) => {
    const support = current?.transcriptionControls;

    const languages = support?.languages;
    language.value =
      languages !== undefined && language.value !== undefined && languages.includes(language.value)
        ? language.value
        : undefined;

    if (support?.supportsLanguageDetection !== true) {
      detectLanguage.value = false;
    }
    if (support?.supportsDiarization !== true) {
      diarize.value = false;
    }
    if (support?.supportsPunctuation !== true) {
      punctuate.value = false;
    }
    if (support?.supportsContextPrompt !== true) {
      contextPrompt.value = '';
    }

    const loaded = audio.value;
    const limit = support?.maxAudioBytes;

    notice.value =
      loaded !== undefined && limit !== undefined && loaded.byteLength > limit
        ? `${current?.name ?? 'This model'} accepts smaller files than the recording you loaded. `
          + 'Choose a different model, or load a shorter recording.'
        : null;
  });

  /**
   * Whether the loaded audio is within the selected model's limit.
   *
   * @returns `true` when there is audio and it fits.
   */
  const audioFits = computed(
    () => audio.value !== undefined && audio.value.byteLength <= maxAudioBytes.value
  );

  const estimatedCostUsd = computed(() =>
    // Always `undefined` in practice before a run: the browser does not parse a WAV header here,
    // and the server is what establishes a duration. Wired anyway so the figure appears the moment
    // a duration becomes available, rather than needing a second code path after the run.
    estimateTranscriptionCostUsd(
      verifiedAudio.value?.durationSeconds,
      controls.value?.pricePerAudioMinuteUsd
    )
  );

  const canTranscribe = computed(
    () =>
      !transcribing.value
      && recordingState.value !== 'recording'
      && audioFits.value
      && selectedModel.value !== undefined
      && [...contextPrompt.value.trim()].length <= MAX_CONTEXT_PROMPT_CHARACTERS
  );

  /**
   * Discards the previous run's results.
   *
   * Called whenever new audio is loaded. A transcript left on screen beside a different recording
   * is worse than an empty space: it reads as a transcript _of_ the new recording.
   *
   * @returns Nothing.
   */
  function clearResult(): void {
    transcript.value = undefined;
    verifiedAudio.value = undefined;
    receipt.value = undefined;
    applied.value = undefined;
  }

  /**
   * Releases the microphone and stops the elapsed-time ticker.
   *
   * Every track is stopped explicitly. Dropping the reference alone leaves the browser's recording
   * indicator lit, which a visitor reasonably reads as the page still listening to them.
   *
   * @returns Nothing.
   */
  function releaseRecorder(): void {
    if (tickHandle !== undefined) {
      clearInterval(tickHandle);
      tickHandle = undefined;
    }

    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = undefined;
    recorder = undefined;
  }

  // Runs when the owning component unmounts, including mid-recording. Without it, navigating away
  // while recording would leave the microphone open for the lifetime of the page.
  onScopeDispose(() => {
    releaseRecorder();
    controller?.abort();
  });

  /**
   * Loads prepared audio, or reports why it was refused.
   *
   * @param file The file to read.
   * @param recorded Whether it came from the microphone.
   * @returns A promise fulfilled once the file has been read.
   */
  async function load(file: File, recorded: boolean): Promise<void> {
    const outcome = await prepareAudio(file, maxAudioBytes.value, recorded);

    if (!outcome.ok) {
      error.value = outcome.message;
      return;
    }

    audio.value = outcome.audio;
    error.value = null;
    notice.value = null;
    clearResult();
  }

  /**
   * Builds the request from the form, including only controls the selected model declares.
   *
   * @param runId Identifier for this run.
   * @param loaded The audio to send.
   * @returns The request to send.
   */
  function buildRequest(runId: string, loaded: PreparedAudio): TranscribeAudioRequest {
    const support = controls.value;
    const prompt = contextPrompt.value.trim();

    return {
      audioBase64: loaded.base64,
      model: model.value,
      runId,
      // Each control is sent only when the model publishes it *and* the visitor set it. Sending a
      // `false` the visitor never touched would be a request they did not make, and for
      // `detectLanguage` it would actively conflict with a language hint.
      //
      // The language is checked against the model's actual list rather than merely against the
      // list existing. The two models that take a language use different standards, so a stale
      // `en-GB` surviving a switch to a model that publishes plain ISO codes would be a value the
      // server refuses — a membership check here is what keeps the browser from making a request
      // it can already tell is invalid.
      ...(language.value !== undefined && support?.languages?.includes(language.value) === true
        ? { language: language.value }
        : {}),
      ...(support?.supportsLanguageDetection === true && detectLanguage.value
        ? { detectLanguage: true }
        : {}),
      ...(support?.supportsDiarization === true && diarize.value ? { diarize: true } : {}),
      ...(support?.supportsPunctuation === true && punctuate.value ? { punctuate: true } : {}),
      ...(support?.supportsContextPrompt === true && prompt !== '' ? { contextPrompt: prompt } : {})
    };
  }

  return {
    audio,
    model,
    language,
    detectLanguage,
    diarize,
    punctuate,
    contextPrompt,
    selectedModel,
    maxAudioBytes,
    transcribing,
    error,
    notice,
    recordingState,
    recordingSeconds,
    transcript,
    verifiedAudio,
    receipt,
    metrics: runTracker.metrics,
    costPending: runTracker.costPending,
    applied,
    estimatedCostUsd,
    canTranscribe,
    selectFile: async (file): Promise<void> => {
      await load(file, false);
    },
    clearAudio: (): void => {
      audio.value = undefined;
      error.value = null;
      notice.value = null;
      clearResult();
    },
    startRecording: async (): Promise<void> => {
      if (recordingState.value === 'unsupported' || recordingState.value === 'recording') {
        return;
      }

      // `requesting` is a distinct state because the permission prompt can sit open indefinitely,
      // and a button that looks idle during that time invites a second click that does nothing.
      recordingState.value = 'requesting';
      error.value = null;

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (cause) {
        recordingState.value = classifyRecordingFailure(cause);
        return;
      }

      const mimeType = preferredRecordingMimeType();
      const chunks: Blob[] = [];

      try {
        recorder = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
      } catch {
        // A browser that advertised the type and then refused it. Rare, and worth handling rather
        // than letting an exception escape into a click handler.
        releaseRecorder();
        recordingState.value = 'failed';
        return;
      }

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });

      recorder.addEventListener('error', () => {
        releaseRecorder();
        recordingState.value = 'failed';
      });

      recorder.addEventListener('stop', () => {
        const type = mimeType ?? 'audio/webm';
        const blob = new Blob(chunks, { type });
        releaseRecorder();
        recordingState.value = 'idle';

        void load(new File([blob], recordingFileName(mimeType, clock()), { type }), true);
      });

      recorder.start();
      recordingState.value = 'recording';
      recordingSeconds.value = 0;

      // A visible elapsed time, because a recording with no indication of length is one a visitor
      // cannot judge against the panel's size limit until it is already too long.
      tickHandle = setInterval(() => {
        recordingSeconds.value += 1;
      }, 1_000);
    },
    stopRecording: (): void => {
      // The `stop` handler is what loads the audio; calling `stop()` here only triggers it. Doing
      // the work in the handler means a recorder that stops for any other reason — a device
      // disappearing — still produces whatever was captured.
      recorder?.stop();
    },
    run: async (): Promise<void> => {
      const loaded = audio.value;
      if (!canTranscribe.value || loaded === undefined) {
        return;
      }

      const runId = crypto.randomUUID();

      error.value = null;
      transcribing.value = true;
      controller = new AbortController();

      try {
        const result = await transport(buildRequest(runId, loaded), controller.signal);

        transcript.value = result.transcript;
        verifiedAudio.value = result.audio;
        receipt.value = result.receipt;
        applied.value = result.applied;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The audio could not be transcribed. Check your connection and try again.';
        }
      } finally {
        transcribing.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none and contributes
      // nothing to the session meter.
      if (receipt.value !== undefined) {
        await runTracker.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    }
  };
}
