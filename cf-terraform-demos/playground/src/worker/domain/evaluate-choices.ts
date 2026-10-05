/**
 * @file Evaluate Choices request validation and model-input construction. The rule that shapes this
 *   module is the exact inverse of the one next door in Classify Text, and the pair is deliberate.
 *   There, the caller may not name a label, because a classifier's categories were fixed at
 *   training time and accepting one would misrepresent what a classifier is. **Here the questions,
 *   the types, the instructions, and the criteria are all the caller's**, supplied per request —
 *   that is what a decision model is for, and a panel that fixed its own questions would be a demo
 *   of nothing. What the caller still cannot supply is a **prompt**. See {@link GENERATIVE_FIELDS}.
 *   The whole lesson is that this is a typed contract rather than a text generator being coaxed
 *   into returning JSON, and an endpoint that appeared to accept `prompt`, `system`, or
 *   `temperature` would teach the opposite of the thing it exists to demonstrate. Several of the
 *   rules below are **the provider's own**, reimplemented here rather than left to the provider,
 *   and each one is annotated with the live error it produces. That is not duplication for its own
 *   sake: a provider rejection names a field in a payload the visitor never saw, while a local
 *   rejection can name the question they are looking at. Both were verified with `cf ai run`.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  EVALUATION_QUESTION_NAME_PATTERN,
  EVALUATION_QUESTION_TYPES,
  MAX_EVALUATION_INSTRUCTION_CHARACTERS,
  MAX_EVALUATION_OPTIONS,
  MAX_EVALUATION_QUESTIONS,
  MAX_EVALUATION_STATE_CHARACTERS,
  MIN_EVALUATION_OPTIONS,
  type AppliedEvaluationControls,
  type EvaluationQuestion,
  type EvaluationQuestionBody,
  type EvaluationQuestionType,
  type EvaluationStateFormat
} from '../../shared/evaluate-choices';
import { isPlausibleRunId } from './chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * An Evaluate Choices request that has passed validation.
 *
 * A distinct type from the untrusted wire shape, as in every other panel, so a function requiring
 * it cannot be handed unvalidated input.
 */
export interface ValidatedEvaluateChoicesRequest {
  /**
   * The state as submitted, still a string.
   */
  state: string;
  /**
   * The parsed state, for a `json` request.
   *
   * Parsed once here rather than in the service, so the only code that can see an unparsed
   * structured state is the code that validated it.
   */
  parsedState: unknown;
  /**
   * How the state is to be interpreted.
   */
  stateFormat: EvaluationStateFormat;
  /**
   * The questions, in the caller's order, with names already checked for duplicates.
   */
  questions: readonly EvaluationQuestion[];
  /**
   * The reviewed descriptor the requested identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
}

/**
 * Fields a request body must not contain.
 *
 * Identical in purpose to every other panel's list: the actor comes from the verified Access
 * identity, so a body carrying one of these is attempting to choose who the request is attributed
 * to, and is rejected rather than quietly corrected.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub'];

/**
 * Fields through which a caller might try to turn this into a text generator.
 *
 * **The regression guard that keeps this panel a typed contract.** Every panel in this demo refuses
 * something, and what it refuses says what it is. Classify Text refuses `questions`, because its
 * labels belong to the model. This panel accepts questions and refuses _prose controls_, because
 * its whole claim is that no prompt engineering, no JSON mode, and no parsing step is involved.
 *
 * Someone who sent `temperature` would reasonably believe it had been applied and had simply made
 * little difference. In fact these models have no sampling step to vary: they return calibrated
 * probabilities, not a sampled token sequence, so a temperature would be a control that cannot do
 * anything. Refusing it says that; ignoring it would imply the opposite.
 *
 * The list covers plausible spellings rather than one, because this is a semantic boundary rather
 * than a schema detail.
 */
const GENERATIVE_FIELDS: readonly string[] = [
  'prompt',
  'system',
  'systemPrompt',
  'system_prompt',
  'messages',
  'temperature',
  'topP',
  'top_p',
  'maxTokens',
  'max_tokens',
  'stream',
  'responseFormat',
  'response_format'
];

/**
 * Reads a plain object property without inheriting from the prototype chain.
 *
 * @param source Parsed JSON object.
 * @param key Property to read.
 * @returns The value, or `undefined` when the property is absent.
 */
function property(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Narrows a value to a plain object.
 *
 * @param value Untrusted value.
 * @returns The value as a record, or `undefined` when it is not a plain object.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Validates one bounded free-text field belonging to a question.
 *
 * @param value The untrusted value.
 * @param label What the field is, named in the error so the visitor can find it.
 * @param position The question's 1-based position, named in the error for the same reason.
 * @returns The trimmed string.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is absent, not a string, blank,
 *   or longer than {@link MAX_EVALUATION_INSTRUCTION_CHARACTERS}.
 */
function requireText(value: unknown, label: string, position: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest({ detail: `Question ${position} needs ${label}.` });
  }

  if ([...value].length > MAX_EVALUATION_INSTRUCTION_CHARACTERS) {
    throw badRequest({
      detail:
        `Question ${position}: ${label} is longer than `
        + `${MAX_EVALUATION_INSTRUCTION_CHARACTERS} characters. Instructions and criteria share `
        + 'the context window with the state, so they are kept short.'
    });
  }

  return value.trim();
}

/**
 * Validates the option list of a `choice` question, or the legend of a `score` question.
 *
 * The minimum of two is **the provider's own rule**, reimplemented so the refusal names the
 * question the visitor is editing. Verified live: a one-option `choice` is rejected with
 * `Dictionary should have at least 2 items after validation, not 1`, and a one-entry `score` legend
 * with `List should have at least 2 items after validation, not 1`.
 *
 * @param raw The untrusted list.
 * @param kind What the list is called in this question type, for the error message.
 * @param position The question's 1-based position.
 * @returns Nothing; the caller reads the validated entries itself.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not an array, is shorter
 *   than {@link MIN_EVALUATION_OPTIONS}, or is longer than {@link MAX_EVALUATION_OPTIONS}.
 */
function requireListBounds(raw: unknown, kind: string, position: number): readonly unknown[] {
  if (!Array.isArray(raw)) {
    throw badRequest({ detail: `Question ${position} needs a list of ${kind}.` });
  }

  if (raw.length < MIN_EVALUATION_OPTIONS) {
    throw badRequest({
      detail:
        `Question ${position} needs at least ${MIN_EVALUATION_OPTIONS} ${kind}. A question with `
        + 'one possible answer has nothing to decide between, and the model rejects it too.'
    });
  }

  if (raw.length > MAX_EVALUATION_OPTIONS) {
    throw badRequest({
      detail: `Question ${position} may have at most ${MAX_EVALUATION_OPTIONS} ${kind}.`
    });
  }

  return raw;
}

/**
 * Validates one question body against its declared type.
 *
 * @param raw The untrusted question body.
 * @param position The question's 1-based position, named in every error.
 * @param model The selected model, so an unsupported type names the model that cannot answer it.
 * @returns The validated, normalised question body.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object, declares no
 *   type or an unknown one, declares a type the selected model does not answer, omits its
 *   instructions, or supplies options or a legend that are malformed, too few, too many, blank, or
 *   duplicated.
 */
function validateQuestionBody(
  raw: unknown,
  position: number,
  model: ModelDescriptor
): EvaluationQuestionBody {
  const source = plainObject(raw);
  if (source === undefined) {
    throw badRequest({ detail: `Question ${position} must be an object.` });
  }

  const type = property(source, 'type');
  if (
    typeof type !== 'string'
    || !(EVALUATION_QUESTION_TYPES as readonly string[]).includes(type)
  ) {
    throw badRequest({
      detail:
        `Question ${position} must have a "type" of `
        + `${EVALUATION_QUESTION_TYPES.map((name) => `"${name}"`).join(', ')}.`
    });
  }

  const questionType = type as EvaluationQuestionType;
  const supported = model.evaluationControls?.supportedQuestionTypes ?? [];

  // Checked against the reviewed descriptor rather than globally, as in every other panel. Both
  // reviewed models answer all three types today, so this guard protects a model added later
  // rather than one present now — which is exactly when a missing check would be discovered the
  // expensive way.
  if (!supported.includes(questionType)) {
    throw badRequest({
      detail: `${model.name} does not answer "${questionType}" questions.`
    });
  }

  const instructions = requireText(property(source, 'instructions'), 'instructions', position);

  if (questionType === 'noul') {
    const whenTrue = property(source, 'whenTrue');
    const whenFalse = property(source, 'whenFalse');

    // Criteria are genuinely optional here — verified live, the models accept a `noul` question
    // with none. They are validated only when present, rather than required, because requiring
    // them would be this application inventing a rule the contract does not have.
    return {
      type: 'noul',
      instructions,
      ...(whenTrue === undefined
        ? {}
        : { whenTrue: requireText(whenTrue, 'a description of a true answer', position) }),
      ...(whenFalse === undefined
        ? {}
        : { whenFalse: requireText(whenFalse, 'a description of a false answer', position) })
    };
  }

  if (questionType === 'choice') {
    const rawOptions = requireListBounds(property(source, 'options'), 'options', position);
    const seen = new Set<string>();
    const options = rawOptions.map((entry, index) => {
      const option = plainObject(entry);
      if (option === undefined) {
        throw badRequest({
          detail: `Question ${position}, option ${index + 1} must be an object.`
        });
      }

      const name = requireText(property(option, 'name'), `option ${index + 1}'s name`, position);

      // A duplicate name is refused rather than deduplicated. The provider's schema is an object
      // keyed by option name, so two options sharing one would silently collapse into a single
      // option — and the visitor would get a probability distribution over a list shorter than the
      // one they wrote, with nothing to say which option disappeared.
      if (seen.has(name)) {
        throw badRequest({
          detail:
            `Question ${position} lists the option "${name}" twice. Each option needs a distinct `
            + 'name, because the answer reports one probability per option name.'
        });
      }
      seen.add(name);

      return {
        name,
        description: requireText(
          property(option, 'description'),
          `option ${index + 1}'s description`,
          position
        )
      };
    });

    return { type: 'choice', instructions, options };
  }

  const rawLegend = requireListBounds(property(source, 'legend'), 'legend entries', position);
  const legend = rawLegend.map((entry, index) =>
    requireText(entry, `legend entry ${index + 1}`, position)
  );

  return { type: 'score', instructions, legend };
}

/**
 * Validates an untrusted Evaluate Choices request body.
 *
 * @param body Parsed JSON body of the request, from an untrusted caller.
 * @returns The validated request, carrying the resolved model descriptor and the parsed state; see
 *   {@link ValidatedEvaluateChoicesRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not a JSON object, carries an
 *   identity field, carries a generative control such as `prompt` or `temperature`, omits or
 *   malforms `runId`, names a model that is not reviewed for this panel, omits the state or submits
 *   a blank or over-long one, declares a `json` state that does not parse or is not an object or
 *   array, omits the questions or submits none, too many, a duplicate name, a name that does not
 *   match the provider's pattern, or a question that is malformed for its declared type.
 */
export function validateEvaluateChoicesRequest(body: unknown): ValidatedEvaluateChoicesRequest {
  const source = plainObject(body);
  if (source === undefined) {
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The user is taken from the verified `
          + 'Cloudflare Access identity.'
      });
    }
  }

  for (const field of GENERATIVE_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". Evaluate Choices asks a decision model typed `
          + 'questions and receives calibrated probabilities back. There is no prompt, no system '
          + 'message, no sampling temperature, and no JSON mode, because nothing here generates '
          + 'or parses text. For free-form generation, use the Chat panel.'
      });
    }
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({
      detail:
        'Request body must contain a "runId" of 8 to 64 characters, using letters, digits, '
        + 'hyphens, and underscores only.'
    });
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  }

  // Resolved against this panel specifically. Looking a model up by identifier alone is how a
  // narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('evaluate-choices', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Evaluate Choices.'
    });
  }

  if (model.evaluationControls === undefined) {
    throw badRequest({ detail: 'That model has no reviewed evaluation controls.' });
  }

  const stateFormat = property(source, 'stateFormat');
  if (stateFormat !== 'text' && stateFormat !== 'json') {
    throw badRequest({
      detail: 'Request body must contain a "stateFormat" of "text" or "json".'
    });
  }

  const state = property(source, 'state');
  if (typeof state !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "state" string to evaluate.' });
  }

  if (state.trim() === '') {
    throw badRequest({ detail: 'Enter the situation you want the model to judge.' });
  }

  // Counted in code points rather than UTF-16 units, matching every other panel's limit, so a
  // non-BMP character counts once rather than twice.
  if ([...state].length > MAX_EVALUATION_STATE_CHARACTERS) {
    throw badRequest({
      detail:
        `The state is longer than ${MAX_EVALUATION_STATE_CHARACTERS} characters. A state beyond `
        + 'the model\u2019s context window is truncated by the model, which would answer every '
        + 'question about only the part it read while the result claimed to describe the whole '
        + 'situation.'
    });
  }

  let parsedState: unknown = state;

  if (stateFormat === 'json') {
    try {
      parsedState = JSON.parse(state);
    } catch {
      // Refused rather than forwarded as text. A structured state that quietly degrades to a
      // string still produces confident answers, and the visitor would have no way to tell that
      // the field references in their instructions resolved against nothing.
      throw badRequest({
        detail:
          'The state is marked as JSON but could not be parsed. Fix the JSON, or switch the state '
          + 'to plain text.'
      });
    }

    if (plainObject(parsedState) === undefined && !Array.isArray(parsedState)) {
      throw badRequest({
        detail:
          'A JSON state must be an object or an array. A bare string or number carries no fields '
          + 'for a question to refer to, so it is plain text with extra steps.'
      });
    }
  }

  const rawQuestions = property(source, 'questions');
  if (!Array.isArray(rawQuestions)) {
    throw badRequest({
      detail: 'Request body must contain a "questions" array holding the questions to ask.'
    });
  }

  if (rawQuestions.length === 0) {
    throw badRequest({ detail: 'Add at least one question to ask about this state.' });
  }

  if (rawQuestions.length > MAX_EVALUATION_QUESTIONS) {
    throw badRequest({
      detail:
        `An evaluation may ask at most ${MAX_EVALUATION_QUESTIONS} questions. They are answered `
        + 'in one call, so the limit is about how much of the context window the questions take '
        + 'from the state rather than about the number of requests.'
    });
  }

  const questions: EvaluationQuestion[] = [];
  const names = new Set<string>();

  for (const [index, raw] of rawQuestions.entries()) {
    const position = index + 1;
    const entry = plainObject(raw);
    if (entry === undefined) {
      throw badRequest({ detail: `Question ${position} must be an object.` });
    }

    const name = property(entry, 'name');
    if (typeof name !== 'string' || !EVALUATION_QUESTION_NAME_PATTERN.test(name)) {
      // The provider's own pattern, enforced here so the message names the question being edited.
      // Verified live: a name containing a space is rejected with
      // `String should match pattern '^[A-Za-z0-9_.-]{1,100}$'`.
      throw badRequest({
        detail:
          `Question ${position} needs a name of 1 to 100 characters using letters, digits, `
          + 'underscores, dots, and hyphens only. The name is the key the answer comes back under.'
      });
    }

    // Refused rather than overwritten. The provider's schema keys questions by name, so a
    // duplicate would silently discard the earlier question and return fewer answers than
    // questions asked.
    if (names.has(name)) {
      throw badRequest({
        detail:
          `Two questions are both named "${name}". Each question needs a distinct name, because `
          + 'the answers come back keyed by it.'
      });
    }
    names.add(name);

    questions.push({
      name,
      question: validateQuestionBody(property(entry, 'question'), position, model)
    });
  }

  return { state, parsedState, stateFormat, questions, model, runId };
}

/**
 * Builds the provider request body for one evaluation.
 *
 * Three details here come from the live contract rather than from the published schema, and each
 * would be a runtime failure if guessed.
 *
 * **The body carries its own `model` field, and it must match the endpoint.** Verified live:
 * sending `"clef"` to the `clef-flash` endpoint fails with `Unsupported model 'clef'. Use
 * 'clef-flash'.` The exact string comes from the reviewed descriptor rather than from trimming the
 * identifier.
 *
 * **A `score` question's legend is an array, while a `choice` question's options are an object.**
 * Verified live: sending a `score` legend as an object fails with `Input should be a valid list`.
 * The two question types genuinely disagree about the shape of their criteria, which is why they
 * are built separately below rather than through one shared helper.
 *
 * **A `noul` question's criteria are keyed `true` and `false`.** Omitted entirely when the caller
 * supplied neither, rather than sent as empty strings, which would tell the model that a true
 * answer looks like nothing.
 *
 * @param request A validated request.
 * @returns The provider-shaped input payload.
 */
export function buildEvaluationInput(
  request: ValidatedEvaluateChoicesRequest
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};

  for (const { name, question } of request.questions) {
    if (question.type === 'noul') {
      const criteria: Record<string, string> = {};
      if (question.whenTrue !== undefined) {
        criteria['true'] = question.whenTrue;
      }
      if (question.whenFalse !== undefined) {
        criteria['false'] = question.whenFalse;
      }

      questions[name] = {
        type: 'noul',
        instructions: question.instructions,
        ...(Object.keys(criteria).length === 0 ? {} : { criteria })
      };
      continue;
    }

    if (question.type === 'choice') {
      questions[name] = {
        type: 'choice',
        instructions: question.instructions,
        // An object keyed by option name. The answer's `probabilities` come back under these same
        // keys, which is why a duplicate name is refused during validation.
        criteria: Object.fromEntries(
          question.options.map((option) => [option.name, option.description])
        )
      };
      continue;
    }

    questions[name] = {
      type: 'score',
      instructions: question.instructions,
      // An array, not an object. The response's legend is keyed by stringified position, and the
      // score is a continuous position along it, so the ordering here is the meaning.
      criteria: [...question.legend]
    };
  }

  return {
    model: request.model.evaluationControls?.requestModelName ?? '',
    // The parsed document for a JSON state, so the model receives structured data rather than a
    // string that happens to contain braces. Verified live: both forms are accepted, and the
    // structured one lets a question refer to a field by name.
    state: request.parsedState,
    questions
  };
}

/**
 * Counts how many questions of each type an evaluation asked.
 *
 * @param questions The validated questions.
 * @returns One count per question type, including zeros, so a log line has a stable shape.
 */
export function countQuestionTypes(
  questions: readonly EvaluationQuestion[]
): Record<EvaluationQuestionType, number> {
  const counts: Record<EvaluationQuestionType, number> = { noul: 0, choice: 0, score: 0 };
  for (const { question } of questions) {
    counts[question.type] += 1;
  }
  return counts;
}

/**
 * Summarises the settings an evaluation was produced with.
 *
 * The state and the questions are deliberately absent: they are already in the browser, and echoing
 * them would create a second copy of the visitor's content for no benefit.
 *
 * @param request The validated request.
 * @returns The applied controls, for the response and the completion log.
 */
export function describeAppliedEvaluationControls(
  request: ValidatedEvaluateChoicesRequest
): AppliedEvaluationControls {
  return {
    model: request.model.id,
    stateFormat: request.stateFormat,
    questionCount: request.questions.length,
    questionTypeCounts: countQuestionTypes(request.questions),
    stateCharacterCount: [...request.state].length
  };
}
