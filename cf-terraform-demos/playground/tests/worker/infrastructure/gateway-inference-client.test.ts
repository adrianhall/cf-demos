import { describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '../../../src/worker/domain/models';
import { GatewayInferenceClient } from '../../../src/worker/infrastructure/ai/gateway-inference-client';
import { problemWithStatus } from '../support/problem-details';

/**
 * A reviewed descriptor standing in for whatever model a panel eventually uses.
 *
 * The client is model-agnostic by design, so a fixture is enough here; the real descriptors arrive
 * with the panels that need them.
 */
const MODEL: ModelDescriptor = {
  id: '@cf/test/model',
  name: 'Test model',
  provider: 'workers-ai',
  task: 'chat',
  contractVersion: 2,
  pricingUnit: 'token',
  invocation: 'synchronous',
  documentationUrl: 'https://developers.cloudflare.com/ai/models/'
};

/**
 * Builds a fake Workers AI binding that records how it was called.
 *
 * @param overrides Behaviour to replace: `run` to simulate an outcome, `log` to supply a gateway
 *   log record, `logId` to control the reported identifier.
 * @returns The fake binding and the spies the assertions read.
 */
function fakeAi(
  overrides: {
    run?: () => unknown;
    log?: unknown;
    logId?: string | null;
  } = {}
): {
  ai: Ai;
  run: ReturnType<typeof vi.fn>;
  gateway: ReturnType<typeof vi.fn>;
  getLog: ReturnType<typeof vi.fn>;
} {
  const behaviour = overrides.run ?? (() => ({ response: 'ok' }));
  const run = vi.fn((_model: string, _input: unknown, _options: unknown) => behaviour());
  const getLog = vi.fn(() =>
    overrides.log === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(overrides.log)
  );
  const gateway = vi.fn(() => ({ getLog }));
  const ai = {
    run,
    gateway,
    aiGatewayLogId: overrides.logId === undefined ? 'log-1' : overrides.logId
  };
  return { ai: ai as unknown as Ai, run, gateway, getLog };
}

/**
 * Builds an inference request for the fixture model.
 *
 * @param email Verified email of the actor making the call.
 * @returns A request ready to pass to the client.
 */
function requestFrom(email = 'alice@example.com') {
  return {
    task: 'chat' as const,
    model: MODEL,
    runId: 'run-1',
    actor: { email, sub: 'sub-alice' },
    input: { prompt: 'hello' }
  };
}

describe('GatewayInferenceClient', () => {
  // A deployment with no gateway identifier is broken, and the loud failure happens at
  // construction so it cannot first surface as a request that reached a provider unobserved.
  it('refuses to construct without a gateway identifier', () => {
    expect(() => new GatewayInferenceClient({ ai: fakeAi().ai, gatewayId: '' })).toThrow(
      /AI_GATEWAY_ID/u
    );
  });

  it('refuses to construct with a blank gateway identifier', () => {
    expect(() => new GatewayInferenceClient({ ai: fakeAi().ai, gatewayId: '   ' })).toThrow(
      /AI_GATEWAY_ID/u
    );
  });

  // The whole demo rests on this: there is no code path through the client that omits the gateway
  // option, so "every inference request is routed through AI Gateway" is checkable rather than
  // merely stated.
  it('always passes the configured gateway and collects a log', async () => {
    const { ai, run } = fakeAi();
    await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).run(requestFrom());

    const options = run.mock.calls[0]![2] as { gateway: { id: string; collectLog: boolean } };
    expect(options.gateway.id).toBe('playground');
    expect(options.gateway.collectLog).toBe(true);
  });

  it('attaches the verified email and panel to the gateway metadata', async () => {
    const { ai, run } = fakeAi();
    await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).run(requestFrom());

    const options = run.mock.calls[0]![2] as {
      gateway: { metadata: Record<string, unknown> };
    };
    expect(options.gateway.metadata).toEqual({
      task: 'chat',
      runId: 'run-1',
      user: 'alice@example.com',
      contractVersion: 2
    });
  });

  // Metadata-only logging is what lets the demo tell a visitor their prompt is not retained. The
  // header is easy to drop in a refactor and its absence is invisible at runtime, so it is pinned.
  it('asks the gateway not to store request and response payloads', async () => {
    const { ai, run } = fakeAi();
    await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).run(requestFrom());

    const options = run.mock.calls[0]![2] as { extraHeaders: Record<string, string> };
    expect(options.extraHeaders['cf-aig-collect-log-payload']).toBe('false');
  });

  it('returns the model output and the gateway log identifier', async () => {
    const { ai } = fakeAi({ run: () => ({ response: 'hello back' }), logId: 'log-42' });
    const result = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).run(
      requestFrom()
    );

    expect(result.output).toEqual({ response: 'hello back' });
    expect(result.logId).toBe('log-42');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // The binding reports `null` before it has a log identifier. Surfacing that as `undefined`
  // rather than the string "null" keeps the caller's "do I have a log to read?" check honest.
  it('reports an absent log identifier as undefined', async () => {
    const { ai } = fakeAi({ logId: null });
    const result = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).run(
      requestFrom()
    );
    expect(result.logId).toBeUndefined();
  });

  it('refuses to dispatch a request with no verified email', async () => {
    const { ai, run } = fakeAi();
    const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

    await expect(client.run(requestFrom(''))).rejects.toThrow(/verified user/iu);
    // The guard must run before dispatch, not after: an unattributable request that still reached
    // the provider would already have cost money.
    expect(run).not.toHaveBeenCalled();
  });

  // A provider error can contain prompt fragments and internal endpoint details. The client
  // replaces it with a sanitised problem rather than forwarding it to a browser.
  it('maps a provider failure to a 502', async () => {
    const { ai } = fakeAi({
      run: () => {
        throw new Error('upstream 500: prompt "my secret prompt" rejected by internal-host-7');
      }
    });
    const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

    await expect(client.run(requestFrom())).rejects.toMatchObject(problemWithStatus(502));
  });

  it('discards the provider message rather than forwarding it to the caller', async () => {
    const { ai } = fakeAi({
      run: () => {
        throw new Error('upstream 500: prompt "my secret prompt" rejected by internal-host-7');
      }
    });
    const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

    const error = await client.run(requestFrom()).catch((cause: unknown) => cause);
    const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialised).not.toContain('secret prompt');
    expect(serialised).not.toContain('internal-host-7');
  });

  describe('runStream', () => {
    /**
     * Builds a `ReadableStream` of SSE text, as Workers AI returns for a streamed call.
     *
     * @param frames Raw frame strings to emit, in order.
     * @param chunkSize Bytes per stream chunk, so a test can split frames across chunk boundaries
     *   the way a real network does.
     * @returns A byte stream carrying those frames.
     */
    function sseStream(frames: string[], chunkSize?: number): ReadableStream<Uint8Array> {
      const bytes = new TextEncoder().encode(frames.join(''));
      const size = chunkSize ?? bytes.length;

      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += size) {
            controller.enqueue(bytes.slice(offset, offset + size));
          }
          controller.close();
        }
      });
    }

    /**
     * Collects every chunk a stream yields.
     *
     * @param iterable The chunk stream.
     * @returns The yielded text, in order.
     */
    async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
      const chunks: string[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }
      return chunks;
    }

    it('yields the generated text from each frame', async () => {
      const { ai } = fakeAi({
        run: () =>
          sseStream([
            'data: {"response":"Hel"}\n\n',
            'data: {"response":"lo"}\n\n',
            'data: [DONE]\n\n'
          ])
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(await collect(stream.chunks)).toEqual(['Hel', 'lo']);
    });

    // The gateway option cannot be omitted on this path either. Streaming is where a shortcut is
    // most tempting, so it is pinned the same way the synchronous path is.
    it('always passes the configured gateway and collects a log', async () => {
      const { ai, run } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']) });
      await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(requestFrom());

      const options = run.mock.calls[0]![2] as { gateway: { id: string; collectLog: boolean } };
      expect(options.gateway.id).toBe('playground');
      expect(options.gateway.collectLog).toBe(true);
    });

    it('attaches the verified email to the streamed call\u2019s metadata', async () => {
      const { ai, run } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']) });
      await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(requestFrom());

      const options = run.mock.calls[0]![2] as { gateway: { metadata: Record<string, unknown> } };
      expect(options.gateway.metadata).toMatchObject({
        task: 'chat',
        user: 'alice@example.com'
      });
    });

    it('asks the gateway not to store payloads on a streamed call', async () => {
      const { ai, run } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']) });
      await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(requestFrom());

      const options = run.mock.calls[0]![2] as { extraHeaders: Record<string, string> };
      expect(options.extraHeaders['cf-aig-collect-log-payload']).toBe('false');
    });

    // Set by the client rather than trusted from the caller's input, so there is no way to call
    // this method and receive a non-streamed response — a mismatch that would look like an empty
    // answer.
    it('sets the streaming flag itself', async () => {
      const { ai, run } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']) });
      await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(requestFrom());

      expect((run.mock.calls[0]![1] as { stream: boolean }).stream).toBe(true);
    });

    it('refuses to dispatch a streamed request with no verified email', async () => {
      const { ai, run } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']) });
      const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

      await expect(client.runStream(requestFrom(''))).rejects.toThrow(/verified user/iu);
      expect(run).not.toHaveBeenCalled();
    });

    // A chunk boundary falls wherever the network puts it, routinely mid-frame. Reassembly is the
    // difference between a correct answer and a silently truncated one.
    it('reassembles frames split across chunk boundaries', async () => {
      const { ai } = fakeAi({
        run: () =>
          sseStream(
            ['data: {"response":"one"}\n\n', 'data: {"response":"two"}\n\n', 'data: [DONE]\n\n'],
            7
          )
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect((await collect(stream.chunks)).join('')).toBe('onetwo');
    });

    // A multi-byte character split across chunks must not decode to a replacement character, which
    // would corrupt any non-ASCII answer.
    it('decodes a multi-byte character split across chunks', async () => {
      const { ai } = fakeAi({
        run: () => sseStream(['data: {"response":"\u3053\u3093\u306b\u3061\u306f"}\n\n'], 5)
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect((await collect(stream.chunks)).join('')).toBe('\u3053\u3093\u306b\u3061\u306f');
    });

    it('accepts the OpenAI-compatible delta shape', async () => {
      const { ai } = fakeAi({
        run: () => sseStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'])
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(await collect(stream.chunks)).toEqual(['hi']);
    });

    // A single malformed or novel frame should cost one increment of text, not the whole answer the
    // visitor is already reading.
    it('skips an unparseable frame rather than failing the stream', async () => {
      const { ai } = fakeAi({
        run: () =>
          sseStream([
            'data: {"response":"good"}\n\n',
            'data: not json\n\n',
            'data: {"response":"also good"}\n\n'
          ])
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(await collect(stream.chunks)).toEqual(['good', 'also good']);
    });

    it('does not yield the completion marker as text', async () => {
      const { ai } = fakeAi({
        run: () => sseStream(['data: {"response":"x"}\n\n', 'data: [DONE]\n\n'])
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(await collect(stream.chunks)).toEqual(['x']);
    });

    it('skips an empty text increment', async () => {
      const { ai } = fakeAi({
        run: () => sseStream(['data: {"response":""}\n\n', 'data: {"response":"x"}\n\n'])
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(await collect(stream.chunks)).toEqual(['x']);
    });

    // The log identifier is only meaningful once the stream has settled: the binding reports the
    // identifier of its most recent request, so reading it mid-stream reads it too early.
    it('reports the gateway log identifier only after the stream settles', async () => {
      const { ai } = fakeAi({
        run: () => sseStream(['data: {"response":"x"}\n\n']),
        logId: 'log-stream'
      });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      expect(stream.logId()).toBeUndefined();

      await collect(stream.chunks);
      expect(stream.logId()).toBe('log-stream');
    });

    it('reports an absent log identifier as undefined after streaming', async () => {
      const { ai } = fakeAi({ run: () => sseStream(['data: [DONE]\n\n']), logId: null });

      const stream = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).runStream(
        requestFrom()
      );
      await collect(stream.chunks);
      expect(stream.logId()).toBeUndefined();
    });

    it('maps a provider failure before streaming to a sanitised 502', async () => {
      const { ai } = fakeAi({
        run: () => {
          throw new Error('upstream 500: prompt "my secret prompt" rejected');
        }
      });
      const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

      await expect(client.runStream(requestFrom())).rejects.toMatchObject(problemWithStatus(502));
    });

    // Asking for a stream and receiving an object is a contract mismatch that would otherwise
    // surface as an answer that never arrives.
    it('maps a non-stream response to a 502', async () => {
      const { ai } = fakeAi({ run: () => ({ response: 'not a stream' }) });
      const client = new GatewayInferenceClient({ ai, gatewayId: 'playground' });

      await expect(client.runStream(requestFrom())).rejects.toMatchObject(problemWithStatus(502));
    });
  });

  describe('readMetric', () => {
    it('normalises a gateway log record', async () => {
      const { ai, gateway } = fakeAi({
        log: {
          id: 'log-7',
          model: '@cf/test/model',
          provider: 'workers-ai',
          cached: true,
          success: true,
          duration: 412,
          cost: 0.000_12,
          tokens_in: 11,
          tokens_out: 42
        }
      });

      const metric = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).readMetric(
        'log-7'
      );

      expect(gateway).toHaveBeenCalledWith('playground');
      expect(metric).toEqual({
        logId: 'log-7',
        model: '@cf/test/model',
        provider: 'workers-ai',
        cached: true,
        success: true,
        durationMs: 412,
        costUsd: 0.000_12,
        tokensIn: 11,
        tokensOut: 42
      });
    });

    // Gateway logs are written asynchronously, so a lookup moments after the answer routinely
    // misses. That is a retryable absence, not a failure, and throwing here would turn an ordinary
    // timing gap into an error the UI had to explain.
    it('reports an unpropagated log as undefined rather than throwing', async () => {
      const { ai } = fakeAi();
      await expect(
        new GatewayInferenceClient({ ai, gatewayId: 'playground' }).readMetric('log-missing')
      ).resolves.toBeUndefined();
    });

    // A model billed per track or per second of audio reports no token counts. Absence has to stay
    // absence: a zero would read as "this used no tokens", which is a different claim.
    it('leaves unreported usage and cost absent rather than zero', async () => {
      const { ai } = fakeAi({
        log: {
          id: 'log-8',
          model: 'elevenlabs/music-v2',
          provider: 'elevenlabs',
          cached: false,
          success: true,
          duration: 9_100
        }
      });

      const metric = await new GatewayInferenceClient({ ai, gatewayId: 'playground' }).readMetric(
        'log-8'
      );

      expect(metric?.costUsd).toBeUndefined();
      expect(metric?.tokensIn).toBeUndefined();
      expect(metric?.tokensOut).toBeUndefined();
    });
  });
});
