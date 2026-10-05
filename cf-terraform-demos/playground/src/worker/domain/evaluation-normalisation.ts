/**
 * @file Reads typed answers out of untrusted provider responses. Kept separate from validation for
 *   the same reason every other panel separates them: what a _caller_ may ask for and what a
 *   _provider_ is allowed to answer are different questions with different failure modes, and a
 *   module that mixed them would make a provider contract change look like a user error. The
 *   reviewed envelope was verified with `cf ai run` against both models and is identical for each:
 *   `{ model, answers: { <name>: <typed answer> }, usage: { input_tokens, output_tokens } }`. The
 *   three answer shapes differ in exactly the way their questions do.
 *
 *   - `noul` → `{ type, noul }`. **No confidence field**, on any call.
 *   - `choice` → `{ type, choice, probabilities: { <option>: number }, confidence }`.
 *   - `score` → `{ type, score, legend: { "0": label }, probabilities: { "0": number }, confidence
 *     }`. Two decisions shape the reading. **An answer is matched to its question by name and
 *     checked against the type that was asked**, rather than trusted to be well-formed: an answer
 *     of the wrong type would otherwise be rendered by the wrong card, and a `score` card reading a
 *     `choice`'s fields produces a plausible-looking gauge positioned on nothing. **A single
 *     unreadable answer does not fail the run**, because the other questions were asked, paid for,
 *     and answered correctly; it is reported in `unansweredQuestions` so a visitor who asked five
 *     questions and sees four cards is told why, rather than left to count.
 */

import type {
  ChoiceQuestion,
  EvaluatedQuestion,
  EvaluationAnswer,
  EvaluationQuestion,
  EvaluationUsage,
  OptionProbability,
  ScoreQuestion
} from '../../shared/evaluate-choices';

/**
 * Why a provider response could not be used at all.
 *
 * Distinguished from a single bad answer, which is survivable, because these are whole-response
 * failures where there is nothing to show.
 */
export type EvaluationRejection =
  /**
   * The response was not an object, or carried no `answers` object.
   */
  | 'unrecognised_shape'
  /**
   * The response carried an `answers` object in which no question had a usable answer.
   */
  | 'no_usable_answers';

/**
 * The result of reading one evaluation response.
 */
export type ReadEvaluationOutcome =
  | {
      ok: true;
      answers: EvaluatedQuestion[];
      unansweredQuestions: string[];
      usage: EvaluationUsage;
    }
  | { ok: false; reason: EvaluationRejection };

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
 * Reads a finite number from an untrusted value.
 *
 * @param value Untrusted value.
 * @returns The number, or `undefined` when it is absent, not a number, `NaN`, or infinite. A
 *   non-finite probability would render as a bar of width `NaN` and sort unpredictably.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a probability, requiring it to lie within the unit interval.
 *
 * Bounded rather than merely finite because every renderer in this panel treats the value as a
 * proportion. A value outside 0–1 is not a probability, and clamping it silently would present a
 * contract violation as a full bar.
 *
 * @param value Untrusted value.
 * @returns The probability, or `undefined` when it is unusable.
 */
function probability(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

/**
 * Reads the per-option probabilities of a `choice` answer.
 *
 * Built from the **question's** option list rather than from the response's keys, so the rendered
 * rows are the options the visitor actually offered, in the order they wrote them. An option the
 * model omitted is therefore detectable, and an unexpected key the model invented cannot introduce
 * a row for an option nobody offered.
 *
 * @param raw The response's `probabilities` object.
 * @param question The question as asked, supplying the option names and their order.
 * @param choice The option the model selected, used to mark the winning row.
 * @returns One entry per offered option, or `undefined` when any option has no usable probability.
 */
function readChoiceProbabilities(
  raw: unknown,
  question: ChoiceQuestion,
  choice: string
): OptionProbability[] | undefined {
  const source = plainObject(raw);
  if (source === undefined) {
    return undefined;
  }

  const entries: OptionProbability[] = [];

  for (const option of question.options) {
    const value = probability(source[option.name]);
    if (value === undefined) {
      return undefined;
    }
    entries.push({ name: option.name, probability: value, selected: option.name === choice });
  }

  return entries;
}

/**
 * Reads the legend and per-position probabilities of a `score` answer.
 *
 * The response returns both keyed by stringified position (`{ "0": ..., "1": ... }`), verified
 * live. The legend is read from the **response** rather than the request, so the axis rendered is
 * the one the score was actually computed against; if the model returned a legend of a different
 * length than was asked for, the answer is refused rather than drawn against a mismatched axis.
 *
 * @param rawLegend The response's `legend` object.
 * @param rawProbabilities The response's `probabilities` object.
 * @param question The question as asked, supplying the expected legend length.
 * @returns The ordered legend and its probabilities, or `undefined` when either is unusable.
 */
function readScoreDistribution(
  rawLegend: unknown,
  rawProbabilities: unknown,
  question: ScoreQuestion
): { legend: string[]; probabilities: OptionProbability[] } | undefined {
  const legendSource = plainObject(rawLegend);
  const probabilitySource = plainObject(rawProbabilities);

  if (legendSource === undefined || probabilitySource === undefined) {
    return undefined;
  }

  const legend: string[] = [];
  const probabilities: OptionProbability[] = [];

  // Walked by position rather than by `Object.keys`, because object key order is not part of the
  // contract and a legend read out of order would mislabel every point on the axis.
  for (let position = 0; position < question.legend.length; position += 1) {
    const key = String(position);
    const label = legendSource[key];
    const value = probability(probabilitySource[key]);

    if (typeof label !== 'string' || value === undefined) {
      return undefined;
    }

    legend.push(label);
    probabilities.push({ name: label, probability: value, selected: false });
  }

  // The highest position is marked rather than the rounded score, because the score is continuous
  // and may sit between two legend entries while the distribution has a clear mode.
  let best = 0;
  for (const [index, entry] of probabilities.entries()) {
    if (entry.probability > (probabilities[best]?.probability ?? 0)) {
      best = index;
    }
  }
  const winner = probabilities[best];
  if (winner !== undefined) {
    winner.selected = true;
  }

  return { legend, probabilities };
}

/**
 * Reads one typed answer, checked against the question that was asked.
 *
 * @param raw The untrusted answer.
 * @param question The question as asked, supplying both the expected type and the option list.
 * @returns The typed answer, or `undefined` when it is missing, of the wrong type, or malformed.
 */
function readAnswer(raw: unknown, question: EvaluationQuestion): EvaluationAnswer | undefined {
  const source = plainObject(raw);
  if (source === undefined) {
    return undefined;
  }

  // The declared type must match the question. An answer of a different type is refused rather
  // than coerced: rendering a `choice` answer with the `score` card would produce a gauge
  // positioned against a legend that was never computed.
  if (source['type'] !== question.question.type) {
    return undefined;
  }

  if (question.question.type === 'noul') {
    const value = probability(source['noul']);
    // No confidence is read, because the reviewed models return none for this type. Reading an
    // absent field as zero would display "no confidence" for a perfectly ordinary answer.
    return value === undefined ? undefined : { type: 'noul', probability: value };
  }

  if (question.question.type === 'choice') {
    const choice = source['choice'];
    const confidence = probability(source['confidence']);

    if (typeof choice !== 'string' || confidence === undefined) {
      return undefined;
    }

    // The selected option must be one the caller actually offered. A model naming something else
    // would otherwise mark no row as the winner while still claiming a choice was made.
    if (!question.question.options.some((option) => option.name === choice)) {
      return undefined;
    }

    const probabilities = readChoiceProbabilities(
      source['probabilities'],
      question.question,
      choice
    );

    return probabilities === undefined
      ? undefined
      : { type: 'choice', choice, probabilities, confidence };
  }

  const score = finiteNumber(source['score']);
  const confidence = probability(source['confidence']);

  if (score === undefined || confidence === undefined) {
    return undefined;
  }

  const distribution = readScoreDistribution(
    source['legend'],
    source['probabilities'],
    question.question
  );

  return distribution === undefined
    ? undefined
    : {
        type: 'score',
        score,
        legend: distribution.legend,
        probabilities: distribution.probabilities,
        confidence
      };
}

/**
 * Reads the model's own usage report.
 *
 * `output_tokens` is read rather than assumed to be zero, even though every live call reported
 * zero. Asserting the zero in code would turn a genuine contract change into an invisible one; the
 * panel's claim about asymmetric pricing is worth making from the reported figure.
 *
 * @param raw The response's `usage` object.
 * @returns The usage, with zeros where the provider reported nothing usable.
 */
function readUsage(raw: unknown): EvaluationUsage {
  const source = plainObject(raw);

  return {
    inputTokens: finiteNumber(source?.['input_tokens']) ?? 0,
    outputTokens: finiteNumber(source?.['output_tokens']) ?? 0
  };
}

/**
 * Reads the answers from one evaluation response.
 *
 * @param output The provider's raw output.
 * @param questions The questions as asked, supplying the names to look up, the expected types, and
 *   the order the answers are returned in.
 * @returns The typed answers, the names of any questions that came back unusable, and the model's
 *   own usage report; or a refusal when the response has no usable answer at all. See
 *   {@link ReadEvaluationOutcome}.
 */
export function readEvaluationAnswers(
  output: unknown,
  questions: readonly EvaluationQuestion[]
): ReadEvaluationOutcome {
  const root = plainObject(output);
  const answers = plainObject(root?.['answers']);

  if (answers === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const read: EvaluatedQuestion[] = [];
  const unansweredQuestions: string[] = [];

  // Walked in the caller's question order rather than the response's key order, so the result
  // cards appear in the order the questions were written regardless of how the provider serialised
  // its object.
  for (const question of questions) {
    const answer = readAnswer(answers[question.name], question);
    if (answer === undefined) {
      unansweredQuestions.push(question.name);
      continue;
    }
    read.push({ name: question.name, answer });
  }

  // A run where nothing could be read is a failure, not a result with every question missing:
  // there is no partial answer to show, and presenting an empty card list as success would hide a
  // contract change behind a blank panel.
  if (read.length === 0) {
    return { ok: false, reason: 'no_usable_answers' };
  }

  return { ok: true, answers: read, unansweredQuestions, usage: readUsage(root?.['usage']) };
}
