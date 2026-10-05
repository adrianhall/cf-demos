/**
 * @file Prepared scenarios for the Evaluate Choices panel. Each one exists to make a specific claim
 *   checkable rather than merely to fill the form, because "the model answers typed questions" is
 *   the kind of statement a visitor should be able to _test_ rather than take on trust. The four
 *   scenarios are chosen to cover the three question types and both state formats, and two of them
 *   make a point no single-question demo can. **Support triage** asks all three types at once about
 *   one ticket, which is the panel's central claim: three answers, one gateway call. Verified live
 *   on Clef Flash — `urgent` at `0.9573`, `department` at `ENGINEERING`/`0.8588` with confidence
 *   `0.6257`, and `frustration` at `3.5101` on a five-point legend with confidence `0.3462`.
 *   **Refund eligibility** uses a JSON state, and is the clearest demonstration that a structured
 *   state is read as structure. The order is 40 days old and the policy window is 30 days; the
 *   model answered `0.0306`, which it could only do by comparing two fields rather than matching
 *   words. None of them runs automatically. A prepared scenario that spent credit the moment it was
 *   clicked would be a trap, and the panel's own lesson about per-token billing would be the first
 *   casualty.
 */

import type { EvaluationQuestion, EvaluationStateFormat } from '../../../shared/evaluate-choices';

/**
 * One prepared evaluation, ready to load into the panel.
 */
export interface EvaluationExample {
  /**
   * Short name for the button.
   */
  label: string;
  /**
   * What this scenario demonstrates, shown as a tooltip and to screen readers.
   */
  note: string;
  /**
   * The state to load.
   */
  state: string;
  /**
   * How the state should be interpreted.
   */
  stateFormat: EvaluationStateFormat;
  /**
   * The questions to load.
   */
  questions: EvaluationQuestion[];
}

/**
 * The prepared scenarios offered by the panel.
 */
export const EVALUATION_EXAMPLES: readonly EvaluationExample[] = [
  {
    label: 'Support triage',
    note:
      'Asks all three question types about one ticket in a single model call: is it urgent, who '
      + 'should handle it, and how frustrated is the customer.',
    stateFormat: 'text',
    state:
      'The checkout page returns a 500 error and I cannot pay. This is blocking my launch '
      + 'tomorrow. I have emailed twice with no reply and I am extremely frustrated.',
    questions: [
      {
        name: 'urgent',
        question: {
          type: 'noul',
          instructions: 'Is this ticket urgent?',
          whenTrue: 'The customer is blocked from working, or names a deadline.',
          whenFalse: 'The customer can reasonably wait several days.'
        }
      },
      {
        name: 'department',
        question: {
          type: 'choice',
          instructions: 'Which team should handle this ticket?',
          options: [
            { name: 'BILLING', description: 'Payments, invoices, and refunds.' },
            { name: 'ENGINEERING', description: 'Bugs, outages, and error messages.' },
            { name: 'SALES', description: 'Pricing questions and new purchases.' }
          ]
        }
      },
      {
        name: 'frustration',
        question: {
          type: 'score',
          instructions: 'How frustrated is the customer?',
          legend: [
            'Calm and polite',
            'Mildly annoyed',
            'Clearly irritated',
            'Angry',
            'Furious and threatening to leave'
          ]
        }
      }
    ]
  },
  {
    label: 'Refund against a policy',
    note:
      'A JSON state holding an order and the policy it should be judged against. The question '
      + 'refers to fields by name, so the model compares values rather than matching words.',
    stateFormat: 'json',
    state: JSON.stringify(
      {
        request: 'I would like a refund for my order, it did not suit me.',
        order: { id: 'A-4821', total_usd: 149.0, days_since_delivery: 40, condition: 'unopened' },
        policy: { refund_window_days: 30, requires_unopened: true, restocking_fee_percent: 10 }
      },
      null,
      2
    ),
    questions: [
      {
        name: 'within_window',
        question: {
          type: 'noul',
          instructions:
            'Is this refund request inside the policy window? Compare '
            + 'order.days_since_delivery against policy.refund_window_days.',
          whenTrue: 'The days since delivery is less than or equal to the refund window.',
          whenFalse: 'The days since delivery exceeds the refund window.'
        }
      },
      {
        name: 'decision',
        question: {
          type: 'choice',
          instructions: 'What should happen to this refund request?',
          options: [
            { name: 'APPROVE_FULL', description: 'Refund in full; the request meets the policy.' },
            {
              name: 'APPROVE_PARTIAL',
              description: 'Refund less the restocking fee, or as a store credit.'
            },
            { name: 'DECLINE', description: 'Decline; the request falls outside the policy.' },
            {
              name: 'ESCALATE',
              description: 'A human should decide; the policy is ambiguous here.'
            }
          ]
        }
      }
    ]
  },
  {
    label: 'Content moderation',
    note:
      'A single judgement with explicit criteria, showing a probability rather than a verdict. '
      + 'Compare with Classify Text, where the categories belong to the model instead.',
    stateFormat: 'text',
    state:
      'Honestly this update is a disaster. Whoever signed off on the new navigation clearly never '
      + 'used the product. Please revert it before you lose the rest of your users.',
    questions: [
      {
        name: 'needs_review',
        question: {
          type: 'noul',
          instructions: 'Does this comment need human moderation before being published?',
          whenTrue: 'It attacks a person, threatens someone, or contains abuse.',
          whenFalse: 'It is critical or blunt about a product, but not abusive towards a person.'
        }
      },
      {
        name: 'tone',
        question: {
          type: 'score',
          instructions: 'How hostile is the tone?',
          legend: ['Constructive', 'Blunt', 'Harsh', 'Hostile', 'Abusive']
        }
      }
    ]
  },
  {
    label: 'Lead qualification',
    note:
      'A deliberately thin state. Watch the confidence collapse while the probabilities still '
      + 'pick a winner \u2014 the model is telling you it is guessing.',
    stateFormat: 'text',
    state: 'Hi, saw your website. Can you send me some information? Thanks, Sam',
    questions: [
      {
        name: 'sales_ready',
        question: {
          type: 'noul',
          instructions: 'Is this lead ready for a sales conversation?',
          whenTrue: 'They describe a need, a budget, a timeline, or a team size.',
          whenFalse: 'They ask only for general information with no detail about their situation.'
        }
      },
      {
        name: 'segment',
        question: {
          type: 'choice',
          instructions: 'Which segment does this lead most likely belong to?',
          options: [
            {
              name: 'ENTERPRISE',
              description: 'A large organisation with procurement and a team.'
            },
            { name: 'MID_MARKET', description: 'An established company of moderate size.' },
            { name: 'STARTUP', description: 'A small or early-stage company.' },
            { name: 'INDIVIDUAL', description: 'One person, hobbyist, or student.' }
          ]
        }
      }
    ]
  }
];
