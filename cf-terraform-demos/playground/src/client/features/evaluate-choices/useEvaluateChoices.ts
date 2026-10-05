/**
 * @file Stateful composable behind the Evaluate Choices panel: the state, the question builder,
 *   running the evaluation, and handing the result to {@link useRun} for cost resolution. Two
 *   things make this panel's state unlike any before it. **The panel owns a list of heterogeneous
 *   editable objects, not a field.** Every earlier panel's input is a string plus some numeric
 *   controls. Here a question has a type, and the type decides which other fields even exist: a
 *   `choice` has options, a `score` has an ordered legend, and a `noul` has two optional criteria.
 *   Changing a question's type therefore cannot preserve the old fields — see
 *   {@link changeQuestionType} — because carrying a legend onto a `choice` would leave a shape the
 *   server correctly refuses and the visitor never knowingly built. **A result is invalidated by
 *   any edit, including a reordering.** Answers are keyed by question name, and the panel renders
 *   each answer beside the question it belongs to. Leaving a result on screen after a question's
 *   wording changed would show an answer to a question nobody asked, so the whole result is
 *   discarded on any change to the state or the questions. The alternative — keeping answers whose
 *   question is textually unchanged — would be a partial result that looks complete.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  EVALUATION_QUESTION_NAME_PATTERN,
  MAX_EVALUATION_OPTIONS,
  MAX_EVALUATION_QUESTIONS,
  MAX_EVALUATION_STATE_CHARACTERS,
  MIN_EVALUATION_OPTIONS,
  type AppliedEvaluationControls,
  type EvaluateChoicesRequest,
  type EvaluationQuestion,
  type EvaluationQuestionType,
  type EvaluationResult,
  type EvaluationStateFormat
} from '../../../shared/evaluate-choices';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, evaluateChoices } from '../../services/playground-api';
import type { CatalogueModel } from '../../stores/catalogue';

/**
 * Options for {@link useEvaluateChoices}.
 */
export interface UseEvaluateChoicesOptions {
  /**
   * Reviewed models for this panel, as reported by the catalogue. Reactive, because the catalogue
   * is fetched after mount and the form has to settle once it arrives.
   */
  models: Ref<CatalogueModel[]>;
  /**
   * Evaluation transport, injected so tests drive outcomes directly instead of over HTTP.
   */
  evaluate?: typeof evaluateChoices;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Evaluate Choices panel binds to.
 */
export interface UseEvaluateChoicesResult {
  /**
   * The situation being judged.
   */
  state: Ref<string>;
  /**
   * How the state is interpreted.
   */
  stateFormat: Ref<EvaluationStateFormat>;
  /**
   * The questions, in the order they will be asked and rendered.
   */
  questions: Ref<EvaluationQuestion[]>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * The selected model's descriptor, so the view can render only its declared capabilities.
   */
  selectedModel: Ref<CatalogueModel | undefined>;
  /**
   * Whether an evaluation is in flight.
   */
  evaluating: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * The most recent result, or `undefined` before a run or after any edit.
   */
  result: Ref<EvaluationResult | undefined>;
  /**
   * The questions the displayed result answers, as they were when it was produced.
   *
   * A result is rendered question-beside-answer, so the card list must read from the snapshot
   * rather than from the live builder; otherwise an edit mid-flight would relabel an answer.
   */
  resultQuestions: Ref<readonly EvaluationQuestion[]>;
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
  applied: Ref<AppliedEvaluationControls | undefined>;
  /**
   * How many characters the state currently holds, in code points.
   */
  stateCharacterCount: Ref<number>;
  /**
   * The exact JSON this panel would post, for the request preview.
   *
   * The panel's strongest single claim is that there is no prompt anywhere, and the only convincing
   * way to make it is to show the whole request. A visitor can read it and see typed questions and
   * nothing else.
   */
  requestPreview: Ref<string>;
  /**
   * Whether the panel can be submitted.
   */
  canEvaluate: Ref<boolean>;
  /**
   * Why the panel cannot be submitted, or `null` when it can.
   */
  blockedReason: Ref<string | null>;
  /**
   * Whether another question may be added.
   */
  canAddQuestion: Ref<boolean>;
  /**
   * Adds a question of the given type to the end of the list.
   *
   * @param type Which kind of question to add. Defaults to `noul`, the simplest.
   * @returns Nothing; the list has grown by one.
   */
  addQuestion: (type?: EvaluationQuestionType) => void;
  /**
   * Removes one question.
   *
   * @param index Position of the question to remove.
   * @returns Nothing; the list has shrunk and any displayed result is discarded.
   */
  removeQuestion: (index: number) => void;
  /**
   * Moves one question up or down.
   *
   * Order matters to the visitor rather than to the model — the answers come back keyed by name —
   * but the panel renders cards in question order, so being able to group related questions is what
   * makes a five-question evaluation readable.
   *
   * @param index Position of the question to move.
   * @param direction `-1` to move earlier, `1` to move later.
   * @returns Nothing; out-of-range moves are ignored rather than wrapping around.
   */
  moveQuestion: (index: number, direction: -1 | 1) => void;
  /**
   * Changes one question's type, replacing its type-specific fields.
   *
   * @param index Position of the question to change.
   * @param type The new type.
   * @returns Nothing; the question keeps its name and instructions and gains a fresh body.
   */
  changeQuestionType: (index: number, type: EvaluationQuestionType) => void;
  /**
   * Adds an option to a `choice` question, or a legend entry to a `score` question.
   *
   * @param index Position of the question.
   * @returns Nothing; a non-`noul` question has gained an entry, up to the maximum.
   */
  addOption: (index: number) => void;
  /**
   * Removes an option or legend entry.
   *
   * @param index Position of the question.
   * @param optionIndex Position of the entry within that question.
   * @returns Nothing; refuses to go below {@link MIN_EVALUATION_OPTIONS}, which the model rejects.
   */
  removeOption: (index: number, optionIndex: number) => void;
  /**
   * Replaces the state and the questions with a prepared scenario.
   *
   * @param example The scenario to load.
   * @returns Nothing; the form holds the scenario and any displayed result is discarded.
   */
  loadExample: (example: {
    state: string;
    stateFormat: EvaluationStateFormat;
    questions: readonly EvaluationQuestion[];
  }) => void;
  /**
   * Evaluates the current questions against the current state.
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
 * Builds a fresh question body of one type.
 *
 * Each type gets usable defaults rather than empty fields, because an empty `choice` would fail
 * validation the moment it was added and the visitor would see an error for something they had not
 * written yet. A `choice` and a `score` start at {@link MIN_EVALUATION_OPTIONS} entries, which is
 * the fewest the model accepts.
 *
 * @param type The question type to build.
 * @returns A new body with placeholder content.
 */
function emptyQuestionBody(type: EvaluationQuestionType): EvaluationQuestion['question'] {
  if (type === 'choice') {
    return {
      type: 'choice',
      instructions: '',
      options: [
        { name: 'OPTION_A', description: '' },
        { name: 'OPTION_B', description: '' }
      ]
    };
  }

  if (type === 'score') {
    return { type: 'score', instructions: '', legend: ['Lowest', 'Highest'] };
  }

  return { type: 'noul', instructions: '', whenTrue: '', whenFalse: '' };
}

/**
 * Deep-copies a question, detaching it from Vue's reactivity.
 *
 * A JSON round-trip rather than `structuredClone`, which **throws** on a reactive value:
 * `questions` is a `ref`, so its entries are `Proxy` objects and the structured-clone algorithm
 * refuses them with `DataCloneError`. The round-trip is safe for this data by construction — a
 * question holds only strings, arrays, and plain objects, and the value is about to be
 * JSON-serialised onto the wire regardless.
 *
 * @param question The question to copy.
 * @returns An independent plain-object copy.
 */
function detach(question: EvaluationQuestion): EvaluationQuestion {
  return JSON.parse(JSON.stringify(question)) as EvaluationQuestion;
}

/**
 * Strips the optional `noul` criteria when they are blank.
 *
 * Sent as absent rather than as empty strings, because an empty criterion tells the model that a
 * true answer looks like nothing — which is worse than not describing it at all.
 *
 * @param question The question as edited.
 * @returns The question ready to send.
 */
function forWire(question: EvaluationQuestion): EvaluationQuestion {
  if (question.question.type !== 'noul') {
    return question;
  }

  const { type, instructions, whenTrue, whenFalse } = question.question;

  return {
    name: question.name,
    question: {
      type,
      instructions,
      ...(whenTrue === undefined || whenTrue.trim() === '' ? {} : { whenTrue }),
      ...(whenFalse === undefined || whenFalse.trim() === '' ? {} : { whenFalse })
    }
  };
}

/**
 * Drives the Evaluate Choices panel.
 *
 * @param options Catalogue models, injectable transport, and run-tracking options; see
 *   {@link UseEvaluateChoicesOptions}.
 * @returns Reactive form state and actions; see {@link UseEvaluateChoicesResult}.
 */
export function useEvaluateChoices(options: UseEvaluateChoicesOptions): UseEvaluateChoicesResult {
  const transport = options.evaluate ?? evaluateChoices;
  const runTracker = useRun(options.runOptions);

  const state = ref('');
  const stateFormat = ref<EvaluationStateFormat>('text');
  const questions = ref<EvaluationQuestion[]>([
    { name: 'urgent', question: emptyQuestionBody('noul') }
  ]);
  const model = ref('');

  const evaluating = ref(false);
  const error = ref<string | null>(null);
  const result = shallowRef<EvaluationResult | undefined>(undefined);
  const resultQuestions = shallowRef<readonly EvaluationQuestion[]>([]);
  const receipt = shallowRef<RunReceipt | undefined>(undefined);
  const applied = shallowRef<AppliedEvaluationControls | undefined>(undefined);

  let controller: AbortController | undefined;

  const selectedModel = computed(() =>
    options.models.value.find((candidate) => candidate.id === model.value)
  );

  /**
   * Discards the displayed result.
   *
   * @returns Nothing; the result area is empty again.
   */
  function discardResult(): void {
    result.value = undefined;
    resultQuestions.value = [];
  }

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

  // Switching model discards the result. Two models' probabilities for the same question are
  // genuinely different judgements — that comparison is a feature of this panel — so leaving the
  // previous model's answers on screen under the new model's name would misattribute them.
  watch(selectedModel, (current, previous) => {
    if (previous !== undefined && previous.id !== current?.id) {
      discardResult();
    }
  });

  // Any edit to the state or the questions invalidates the result, because answers are rendered
  // beside the question they belong to. `deep` so a change to one option's wording counts, not
  // only adding or removing a question.
  watch([state, stateFormat], discardResult);
  watch(questions, discardResult, { deep: true });

  const stateCharacterCount = computed(() => [...state.value].length);

  const canAddQuestion = computed(() => questions.value.length < MAX_EVALUATION_QUESTIONS);

  /**
   * The questions that would actually be sent, with blank optional criteria removed.
   */
  const wireQuestions = computed(() => questions.value.map(forWire));

  const requestPreview = computed(() =>
    JSON.stringify(
      {
        state: stateFormat.value === 'json' ? '<parsed JSON document>' : state.value,
        stateFormat: stateFormat.value,
        questions: wireQuestions.value,
        model: model.value
      },
      null,
      2
    )
  );

  const blockedReason = computed(() => {
    if (stateCharacterCount.value > MAX_EVALUATION_STATE_CHARACTERS) {
      return (
        `That state is ${stateCharacterCount.value.toLocaleString()} characters, and this panel `
        + `evaluates up to ${MAX_EVALUATION_STATE_CHARACTERS.toLocaleString()}.`
      );
    }

    if (stateFormat.value === 'json' && state.value.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(state.value);
        if (typeof parsed !== 'object' || parsed === null) {
          return (
            'A JSON state must be an object or an array. A bare string or number has no fields '
            + 'for a question to refer to.'
          );
        }
      } catch {
        // Reported in the browser as well as on the server, because this is the one validation a
        // visitor can hit while typing rather than on submit.
        return 'That is not valid JSON. Fix it, or switch the state to plain text.';
      }
    }

    for (const [index, entry] of questions.value.entries()) {
      if (!EVALUATION_QUESTION_NAME_PATTERN.test(entry.name)) {
        return (
          `Question ${index + 1} needs a name using letters, digits, underscores, dots, and `
          + 'hyphens only. It is the key its answer comes back under.'
        );
      }

      if (entry.question.instructions.trim() === '') {
        return `Question ${index + 1} needs instructions saying what is being judged.`;
      }

      if (entry.question.type === 'choice') {
        const blank = entry.question.options.findIndex(
          (option) => option.name.trim() === '' || option.description.trim() === ''
        );
        if (blank !== -1) {
          return `Question ${index + 1}, option ${blank + 1} needs a name and a description.`;
        }
      }

      if (entry.question.type === 'score') {
        const blank = entry.question.legend.findIndex((label) => label.trim() === '');
        if (blank !== -1) {
          return `Question ${index + 1}, legend entry ${blank + 1} needs a label.`;
        }
      }
    }

    const names = questions.value.map((entry) => entry.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) {
      return (
        `Two questions are both named "${duplicate}". Answers come back keyed by name, so each `
        + 'needs a distinct one.'
      );
    }

    return null;
  });

  const canEvaluate = computed(
    () =>
      !evaluating.value
      && state.value.trim() !== ''
      && questions.value.length > 0
      && selectedModel.value !== undefined
      && blockedReason.value === null
  );

  return {
    state,
    stateFormat,
    questions,
    model,
    selectedModel,
    evaluating,
    error,
    result,
    resultQuestions,
    receipt,
    metrics: runTracker.metrics,
    costPending: runTracker.costPending,
    applied,
    stateCharacterCount,
    requestPreview,
    canEvaluate,
    blockedReason,
    canAddQuestion,
    addQuestion: (type: EvaluationQuestionType = 'noul'): void => {
      if (questions.value.length >= MAX_EVALUATION_QUESTIONS) {
        return;
      }
      questions.value = [
        ...questions.value,
        { name: `question_${questions.value.length + 1}`, question: emptyQuestionBody(type) }
      ];
    },
    removeQuestion: (index: number): void => {
      questions.value = questions.value.filter((_, position) => position !== index);
    },
    moveQuestion: (index: number, direction: -1 | 1): void => {
      const target = index + direction;
      if (target < 0 || target >= questions.value.length) {
        return;
      }
      const reordered = [...questions.value];
      const moved = reordered[index];
      const displaced = reordered[target];
      if (moved === undefined || displaced === undefined) {
        return;
      }
      reordered[index] = displaced;
      reordered[target] = moved;
      questions.value = reordered;
    },
    changeQuestionType: (index: number, type: EvaluationQuestionType): void => {
      questions.value = questions.value.map((entry, position) => {
        if (position !== index || entry.question.type === type) {
          return entry;
        }

        // The instructions survive because they describe what is being judged, which usually
        // still applies. The type-specific fields cannot: a legend is not a set of options, and
        // carrying one across would build a question the server refuses.
        const body = emptyQuestionBody(type);
        return {
          name: entry.name,
          question: { ...body, instructions: entry.question.instructions }
        };
      });
    },
    addOption: (index: number): void => {
      questions.value = questions.value.map((entry, position) => {
        if (position !== index) {
          return entry;
        }

        if (entry.question.type === 'choice') {
          if (entry.question.options.length >= MAX_EVALUATION_OPTIONS) {
            return entry;
          }
          return {
            name: entry.name,
            question: {
              ...entry.question,
              options: [
                ...entry.question.options,
                { name: `OPTION_${entry.question.options.length + 1}`, description: '' }
              ]
            }
          };
        }

        if (entry.question.type === 'score') {
          if (entry.question.legend.length >= MAX_EVALUATION_OPTIONS) {
            return entry;
          }
          return {
            name: entry.name,
            question: { ...entry.question, legend: [...entry.question.legend, ''] }
          };
        }

        return entry;
      });
    },
    removeOption: (index: number, optionIndex: number): void => {
      questions.value = questions.value.map((entry, position) => {
        if (position !== index) {
          return entry;
        }

        // Held at the model's own floor of two. Allowing one would build a question the provider
        // rejects, and the visitor would see a server error for a button the panel offered them.
        if (entry.question.type === 'choice') {
          if (entry.question.options.length <= MIN_EVALUATION_OPTIONS) {
            return entry;
          }
          return {
            name: entry.name,
            question: {
              ...entry.question,
              options: entry.question.options.filter((_, at) => at !== optionIndex)
            }
          };
        }

        if (entry.question.type === 'score') {
          if (entry.question.legend.length <= MIN_EVALUATION_OPTIONS) {
            return entry;
          }
          return {
            name: entry.name,
            question: {
              ...entry.question,
              legend: entry.question.legend.filter((_, at) => at !== optionIndex)
            }
          };
        }

        return entry;
      });
    },
    loadExample: (example): void => {
      state.value = example.state;
      stateFormat.value = example.stateFormat;
      // Structured-cloned so editing a loaded scenario cannot mutate the shared example object,
      // which would quietly change what the button loads next time.
      questions.value = example.questions.map(detach);
    },
    run: async (): Promise<void> => {
      if (!canEvaluate.value) {
        return;
      }

      const runId = crypto.randomUUID();
      const submitted = wireQuestions.value;

      error.value = null;
      evaluating.value = true;
      controller = new AbortController();

      const request: EvaluateChoicesRequest = {
        state: state.value,
        stateFormat: stateFormat.value,
        questions: submitted.map(detach),
        model: model.value,
        runId
      };

      try {
        const response = await transport(request, controller.signal);

        result.value = response.result;
        receipt.value = response.receipt;
        applied.value = response.applied;
        // Snapshotted together with the result, so each answer is rendered beside the question it
        // actually answers even if the builder is edited while the request is in flight.
        resultQuestions.value = submitted;
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The questions could not be evaluated. Check your connection and try again.';
        }
      } finally {
        evaluating.value = false;
        controller = undefined;
      }

      // Tracked only when a receipt exists. A failed or cancelled run has none.
      if (receipt.value !== undefined) {
        await runTracker.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    }
  };
}
