import { describe, expect, it } from 'vitest';
import {
  assessEvidence,
  boundEvidenceForPrompt,
  parseDecisionVerdict
} from '../../../src/worker/domain/answer-decision';
import type { Evidence } from '../../../src/worker/domain/conversation';
import {
  validateAskInput,
  validateClientFrame
} from '../../../src/worker/domain/conversation-validation';

function evidence(score: number, content = 'A documented answer.'): Evidence {
  return {
    sourceType: 'documentation',
    reference: 'docs/example.md',
    title: 'Example',
    content,
    audience: 'public',
    score
  };
}

describe('answer evidence decisions', () => {
  it('answers only from sufficiently scored evidence and bounds the prompt', () => {
    const sources = Array.from({ length: 7 }, (_, index) =>
      evidence(0.9 - index / 100, 'x'.repeat(2_500))
    );
    const result = assessEvidence(sources, 0);
    expect(result.outcome).toBe('answer');
    if (result.outcome === 'answer') {
      expect(result.evidence).toHaveLength(5);
      expect(result.evidence[0]?.content).toHaveLength(2_000);
    }
  });

  it('escalates weak evidence and distinguishes restricted-only matches', () => {
    expect(assessEvidence([evidence(0.49)], 0)).toEqual({
      outcome: 'escalate',
      reason: 'insufficient_evidence'
    });
    expect(assessEvidence([], 2)).toEqual({ outcome: 'escalate', reason: 'restricted_evidence' });
  });

  it('parses valid model verdicts and fails closed on malformed output', () => {
    expect(parseDecisionVerdict('text {"grounded":true,"reason":"direct"} text')).toEqual({
      grounded: true,
      reasonCode: 'direct'
    });
    expect(parseDecisionVerdict('{"grounded":"yes"}')).toEqual({
      grounded: false,
      reasonCode: 'unparseable_verdict'
    });
    expect(parseDecisionVerdict('not json')).toEqual({
      grounded: false,
      reasonCode: 'unparseable_verdict'
    });
  });

  it('validates bounded authorless question frames and cancellation frames', () => {
    expect(
      validateAskInput({ question: '  How does D1 work? ', idempotencyKey: '12345678' })
    ).toEqual({ question: 'How does D1 work?', idempotencyKey: '12345678' });
    expect(validateClientFrame({ type: 'cancel' })).toEqual({ type: 'cancel' });
    expect(() =>
      validateClientFrame({
        type: 'ask',
        question: 'Hi',
        idempotencyKey: '12345678',
        author: 'forged'
      })
    ).toThrow();
    expect(() => validateAskInput({ question: '', idempotencyKey: '12345678' })).toThrow();
  });

  it('keeps the prompt selection deterministic', () => {
    expect(
      boundEvidenceForPrompt([evidence(0.5), evidence(0.8)]).map((item) => item.score)
    ).toEqual([0.8, 0.5]);
  });
});
