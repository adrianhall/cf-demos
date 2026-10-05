/**
 * @file Workers-runtime tests for the Evaluate Choices surface. These dispatch real requests
 *   through the real Worker in a real workerd isolate, which is the only way to prove that Access
 *   verification, the body limit, and the problem-details contract behave as deployed. No model is
 *   called: the `AI` binding is not available in this harness, so a request that passes validation
 *   fails at the inference boundary. That is deliberate — these tests cover the authenticated HTTP
 *   surface, the authorization outcomes, and the input rules, all of which are exercised fully
 *   without spending a cent. The typed answer shapes are covered against a fake inference port in
 *   the Worker suite. The boundary tests below are the counterpart of the ones in
 *   `classify-text.test.ts`. That panel refuses caller-defined questions; this one accepts them and
 *   refuses prompts. Proving both directions in the real runtime is what makes the pair a boundary
 *   rather than a convention.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import {
  MAX_EVALUATION_QUESTIONS,
  MAX_EVALUATION_STATE_CHARACTERS
} from '../../src/shared/evaluate-choices';
import { EVALUATE_CHOICES_BODY_LIMIT_BYTES } from '../../src/worker/routes/evaluate-choices';

/**
 * Audience the Worker is configured to accept, matching `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * The default reviewed decision model.
 */
const CLEF = '@cf/cloudflare/clef';

/**
 * A well-formed run identifier.
 */
const RUN_ID = 'c0ffee00-2222-4333-8444-555566667777';

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Builds a valid request body.
 *
 * @param overrides Fields to replace or add.
 * @returns The body to send.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'The checkout page returns a 500 error and I cannot pay.',
    stateFormat: 'text',
    questions: [
      {
        name: 'urgent',
        question: {
          type: 'noul',
          instructions: 'Is this ticket urgent?',
          whenTrue: 'Blocks the customer.',
          whenFalse: 'Can wait.'
        }
      }
    ],
    model: CLEF,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Builds an authenticated `POST` to the Evaluate Choices route.
 *
 * @param email Identity to sign the token for.
 * @param payload Request body to send.
 * @param extraHeaders Additional headers, used to attempt header-based identity smuggling.
 * @returns A request ready to dispatch.
 */
async function postAs(
  email: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Request> {
  const token = await signDevJwt(email, { audience: AUD });
  return new Request('https://playground.example/api/evaluate-choices', {
    method: 'POST',
    headers: { [JWT_HEADER]: token, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await send(
      new Request('https://playground.example/api/evaluate-choices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Every Access application in a team shares a JWKS, so a token minted for an unrelated
  // application would be accepted without this check.
  it('refuses a token minted for another audience', async () => {
    const token = await signDevJwt('alice@example.com', { audience: 'b'.repeat(64) });
    const response = await send(
      new Request('https://playground.example/api/evaluate-choices', {
        method: 'POST',
        headers: { [JWT_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body())
      })
    );

    expect(response.status).toBe(401);
  });

  // Validation runs for an authenticated caller, so reaching a `400` proves the request got past
  // Access rather than being turned away at the edge.
  it('admits an authenticated caller to validation', async () => {
    const response = await send(await postAs('alice@example.com', { nonsense: true }));
    expect(response.status).toBe(400);
  });

  it('refuses an identity supplied in the body rather than attributing the run to it', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ email: 'mallory@example.com' }))
    );
    expect(response.status).toBe(400);
  });
});

/**
 * The regression guard that keeps this a typed contract, at the deployed surface.
 *
 * Classify Text refuses caller-defined questions; this panel refuses prompts. Both halves are
 * proven in the real runtime because together they are what makes the two panels genuinely
 * different APIs rather than two front-ends over one.
 */
describe('generative controls are rejected by this task', () => {
  it('rejects a prompt-shaped field under any plausible spelling', async () => {
    const attempts: Record<string, unknown> = {
      prompt: 'Judge this ticket and reply in JSON.',
      system: 'You are a helpful triage assistant.',
      systemPrompt: 'You are a helpful triage assistant.',
      messages: [{ role: 'user', content: 'Judge this.' }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 256,
      stream: true,
      response_format: { type: 'json_object' }
    };

    for (const [field, value] of Object.entries(attempts)) {
      const response = await send(await postAs('alice@example.com', body({ [field]: value })));
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  it('explains that nothing is generated and names the panel that generates', async () => {
    const response = await send(await postAs('alice@example.com', body({ prompt: 'Judge this.' })));
    const problem = (await response.json()) as { detail: string };

    expect(problem.detail).toMatch(/no prompt/u);
    expect(problem.detail).toMatch(/Chat panel/u);
  });

  // The inverse of the Classify Text guard: a request shaped for that panel is not partially
  // honoured here either.
  it('rejects a Classify Text-shaped request outright', async () => {
    const response = await send(
      await postAs('alice@example.com', {
        text: 'The staff were wonderful.',
        model: CLEF,
        runId: RUN_ID
      })
    );

    expect(response.status).toBe(400);
  });
});

describe('request validation at the deployed surface', () => {
  it('rejects an absent or blank state', async () => {
    expect((await send(await postAs('alice@example.com', body({ state: undefined })))).status).toBe(
      400
    );
    expect((await send(await postAs('alice@example.com', body({ state: '   ' })))).status).toBe(
      400
    );
  });

  it('rejects a state beyond the panel ceiling', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({ state: 'a'.repeat(MAX_EVALUATION_STATE_CHARACTERS + 1) })
      )
    );
    expect(response.status).toBe(400);
  });

  it('rejects a JSON state that does not parse, rather than evaluating it as text', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ stateFormat: 'json', state: '{ broken' }))
    );
    expect(response.status).toBe(400);
  });

  it('rejects an empty or over-large question set', async () => {
    expect((await send(await postAs('alice@example.com', body({ questions: [] })))).status).toBe(
      400
    );

    const many = Array.from({ length: MAX_EVALUATION_QUESTIONS + 1 }, (_, index) => ({
      name: `question_${index}`,
      question: { type: 'noul', instructions: 'Is this urgent?' }
    }));
    expect((await send(await postAs('alice@example.com', body({ questions: many })))).status).toBe(
      400
    );
  });

  // The provider's own name pattern, enforced locally so the message names the question.
  it('rejects a question name the provider would reject', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({
          questions: [{ name: 'my question', question: { type: 'noul', instructions: 'Urgent?' } }]
        })
      )
    );
    expect(response.status).toBe(400);
  });

  // The provider's own floor of two options, enforced locally for the same reason.
  it('rejects a single-option choice question', async () => {
    const response = await send(
      await postAs(
        'alice@example.com',
        body({
          questions: [
            {
              name: 'department',
              question: {
                type: 'choice',
                instructions: 'Which team?',
                options: [{ name: 'ONLY', description: 'The only one.' }]
              }
            }
          ]
        })
      )
    );
    expect(response.status).toBe(400);
  });

  it('rejects a model that is not reviewed for this panel', async () => {
    const response = await send(
      await postAs('alice@example.com', body({ model: '@cf/meta/llama-3.1-8b-instruct' }))
    );
    expect(response.status).toBe(400);
  });

  it('rejects a malformed run identifier', async () => {
    const response = await send(await postAs('alice@example.com', body({ runId: 'short' })));
    expect(response.status).toBe(400);
  });
});

describe('request limits at the deployed surface', () => {
  // Refused on the declared length, before the body is read, so an oversized request costs
  // nothing to reject.
  it('rejects a body over the transport size limit', async () => {
    const token = await signDevJwt('alice@example.com', { audience: AUD });
    const oversized = 'x'.repeat(EVALUATE_CHOICES_BODY_LIMIT_BYTES + 1_024);

    const response = await send(
      new Request('https://playground.example/api/evaluate-choices', {
        method: 'POST',
        headers: {
          [JWT_HEADER]: token,
          'content-type': 'application/json',
          'content-length': String(oversized.length)
        },
        body: oversized
      })
    );

    expect(response.status).toBe(400);
  });

  it('answers a problem-details document rather than prose', async () => {
    const response = await send(await postAs('alice@example.com', body({ questions: [] })));

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as { status: number; title: string };
    expect(problem.status).toBe(400);
    expect(problem.title).toBeTruthy();
  });
});
