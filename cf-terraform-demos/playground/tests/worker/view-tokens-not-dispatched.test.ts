import { describe, expect, it } from 'vitest';
import { findTask, TASK_DESCRIPTORS } from '../../src/tasks';
import { GATEWAY_EXCEPTIONS } from '../../src/worker/domain/gateway-exceptions';
import { modelsForTask } from '../../src/worker/domain/models';

describe('View Tokens is not a server-side task', () => {
  // Tokenization runs in the browser. A reviewed model registered against this panel would be a
  // model nothing calls, and the first person to notice would reasonably "fix" it by wiring the
  // panel to the server — losing the offline, zero-cost property that is the panel's point.
  it('has no reviewed model', () => {
    expect(modelsForTask('view-tokens')).toEqual([]);
  });

  it('declares that it performs no inference', () => {
    expect(findTask('view-tokens')?.gateway).toBe('none');
  });

  // The distinction the register is built around. An exception is an inference call that cannot
  // reach the gateway; View Tokens makes no inference call at all. Filing it as an exception
  // would make the register describe local arithmetic as a gateway bypass, and would make the
  // demo's "no exceptions" claim read as a concession rather than a guarantee.
  it('is not an entry in the gateway exception register', () => {
    expect(GATEWAY_EXCEPTIONS.some((exception) => exception.panel.includes('View Tokens'))).toBe(
      false
    );
  });

  it('is the only panel exempt from gateway routing', () => {
    const exempt = TASK_DESCRIPTORS.filter((task) => task.gateway === 'none');
    expect(exempt.map((task) => task.id)).toEqual(['view-tokens']);
  });
});
