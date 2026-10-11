/**
 * @file Direct DOM tests of the reusable custom components' public APIs (props in, events out),
 *   independent of the views that use them: `PipelineBoard`, `ActionStreamRow`, and
 *   `CustomerTimeline`. Each is mounted with a real Vuetify instance in both the light and dark
 *   themes, so the theme tokens they rely on resolve in either.
 */

import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { VApp, VList } from 'vuetify/components';
import { mount } from '@vue/test-utils';
import ActionStreamRow from '../../src/client/components/ActionStreamRow.vue';
import CustomerTimeline from '../../src/client/components/CustomerTimeline.vue';
import PipelineBoard from '../../src/client/components/PipelineBoard.vue';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import type { TimelineEntry } from '../../src/shared/api/overview.ts';
import type { ActionItem, Deal, Stage } from '../../src/shared/api/sales.ts';
import { settle } from './support.ts';

const USER = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Sam Sales' };
const CONTACT = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Ada' };

const STAGES: Stage[] = [
  { id: '10000000-0000-4000-8000-000000000011', key: 'lead', label: 'Lead', position: 1 },
  { id: '10000000-0000-4000-8000-000000000012', key: 'qualified', label: 'Qualified', position: 2 }
];

/**
 * A pending deal in a stage.
 *
 * @param id Deal id suffix.
 * @param stage Its stage.
 * @param amountMinor Its value.
 * @returns The deal.
 */
function deal(id: string, stage: Stage, amountMinor: number): Deal {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    title: `Deal ${id}`,
    status: 'pending',
    stage,
    pipeline: { id: '10000000-0000-4000-8000-000000000001', name: 'Sales pipeline' },
    company: null,
    primaryContact: CONTACT,
    owner: USER,
    statusLine: null,
    nextActionText: null,
    nextActionDate: null,
    amountMinor,
    currency: 'GBP',
    expectedCloseDate: null,
    closedAt: null,
    project: null,
    version: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z'
  };
}

/**
 * Mount a component inside `v-app` with a router and the app's Vuetify, in a given theme.
 *
 * @param render Render function for the content.
 * @param theme Theme name.
 * @returns The wrapper.
 */
async function mountIn(render: () => ReturnType<typeof h>, theme: 'light' | 'dark') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      ...['deal', 'contact', 'company', 'project', 'note'].map((name) => ({
        path: `/${name}/:id`,
        name,
        component: { render: () => null }
      }))
    ]
  });
  await router.push('/');
  const vuetify = createAppVuetify();
  await vuetify.theme.change(theme);
  const wrapper = mount(
    { render: () => h(VApp, () => render()) },
    { global: { plugins: [router, vuetify] }, attachTo: document.body }
  );
  await settle();
  return wrapper;
}

describe.each(['light', 'dark'] as const)('reusable components in the %s theme', (theme) => {
  it('PipelineBoard shows pending deals per stage with totals and emits a keyboard move', async () => {
    const deals = [deal('a1', STAGES[0]!, 10_000), deal('a2', STAGES[0]!, 5_000)];
    const moves: unknown[] = [];
    const wrapper = await mountIn(
      () =>
        h(PipelineBoard, {
          stages: STAGES,
          deals: [...deals, { ...deal('a3', STAGES[1]!, 1), status: 'won' as const }],
          editable: true,
          onMove: (moved: Deal, stage: Stage) => moves.push([moved.id, stage.key])
        }),
      theme
    );
    const board = wrapper.get('[data-testid="pipeline-board"]');
    expect(board.attributes('role')).toBe('list');
    expect(board.text()).toContain('2 deals · £150.00');
    // Won deals are not on the board.
    expect(board.text()).toContain('0 deals · £0.00');
    const move = document.body.querySelector<HTMLButtonElement>(`[aria-label^="Move Deal a1"]`);
    expect(move).not.toBeNull();
    move!.click();
    await settle();
    const target = [...document.body.querySelectorAll('.v-list-item')].find(
      (item) => item.textContent?.trim() === 'Qualified'
    ) as HTMLElement;
    target.click();
    await settle();
    expect(moves).toEqual([[deals[0]!.id, 'qualified']]);
    wrapper.unmount();
  });

  it('ActionStreamRow shows urgency and links, and emits complete only when completable', async () => {
    // "Done" applies to contact next actions; deal actions are completed on the deal itself.
    const item: ActionItem = {
      kind: 'contact',
      id: '00000000-0000-4000-8000-0000000000b1',
      text: 'Send contract',
      dueDate: '2026-10-01',
      urgency: 'overdue',
      contact: CONTACT,
      deal: { id: '00000000-0000-4000-8000-0000000000b2', title: 'Renewal' },
      company: null
    };
    const completed: ActionItem[] = [];
    const wrapper = await mountIn(
      () =>
        h(VList, () => [
          h(ActionStreamRow, {
            item,
            completable: true,
            onComplete: (value: ActionItem) => completed.push(value)
          }),
          h(ActionStreamRow, { item: { ...item, id: '00000000-0000-4000-8000-0000000000b3' } })
        ]),
      theme
    );
    expect(wrapper.text()).toContain('Send contract');
    expect(wrapper.text()).toContain('Overdue');
    expect(wrapper.find('a[href="/contact/00000000-0000-4000-8000-000000000002"]').exists()).toBe(
      true
    );
    const done = wrapper.findAll('button').filter((button) => button.text().includes('Done'));
    expect(done).toHaveLength(1);
    await done[0]!.trigger('click');
    expect(completed).toEqual([item]);
    wrapper.unmount();
  });

  it('CustomerTimeline lists entries with links for records that have pages', async () => {
    const entries: TimelineEntry[] = [
      {
        key: 'note:1',
        kind: 'note',
        at: '2026-10-02T09:00:00.000Z',
        title: 'Plan',
        actor: USER,
        target: { type: 'note', id: '00000000-0000-4000-8000-0000000000c1' }
      },
      {
        key: 'call:2',
        kind: 'call',
        at: '2026-10-01T09:00:00.000Z',
        title: 'Intro call',
        actor: null,
        target: null
      }
    ];
    const wrapper = await mountIn(() => h(CustomerTimeline, { entries }), theme);
    const list = wrapper.get('[aria-label="Customer timeline"]');
    expect(list.attributes('role')).toBe('list');
    expect(list.findAll('[role="listitem"]')).toHaveLength(2);
    expect(list.get('a').attributes('href')).toBe('/note/00000000-0000-4000-8000-0000000000c1');
    expect(list.text()).toContain('Call:Intro call');
    expect(list.text()).toContain('Sam Sales');
    wrapper.unmount();

    const empty = await mountIn(() => h(CustomerTimeline, { entries: [] }), theme);
    expect(empty.text()).toContain('Nothing has happened yet.');
    empty.unmount();
  });
});
