/**
 * @file Direct DOM tests of the reusable custom components' public APIs (props in, events out),
 *   independent of the views that use them: `PipelineBoard`, `ActionStreamRow`, and
 *   `CustomerTimeline`. Each is mounted with a real Vuetify instance in both the light and dark
 *   themes, so the theme tokens they rely on resolve in either.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { VApp, VList } from 'vuetify/components';
import { mount } from '@vue/test-utils';
import ActionStreamRow from '../../src/client/components/ActionStreamRow.vue';
import ActivityList from '../../src/client/components/ActivityList.vue';
import ContactPicker from '../../src/client/components/ContactPicker.vue';
import CustomerTimeline from '../../src/client/components/CustomerTimeline.vue';
import DealList from '../../src/client/components/DealList.vue';
import HistoryList from '../../src/client/components/HistoryList.vue';
import PipelineBoard from '../../src/client/components/PipelineBoard.vue';
import ProjectList from '../../src/client/components/ProjectList.vue';
import type { PickedContact } from '../../src/client/services/deal-draft.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import type { TimelineEntry } from '../../src/shared/api/overview.ts';
import type { ActionItem, Activity, Deal, Stage } from '../../src/shared/api/sales.ts';
import { settle } from './support.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it('the record lists show empty states, tombstoned contacts, and optional details', async () => {
    const activity: Activity = {
      id: '00000000-0000-4000-8000-0000000000e1',
      type: 'meeting',
      subject: 'Review',
      summary: null,
      occurredAt: '2026-10-01T09:00:00.000Z',
      durationMinutes: null,
      author: USER,
      contacts: [
        { ...CONTACT, deleted: false },
        { id: '00000000-0000-4000-8000-0000000000e2', displayName: 'Gone', deleted: true }
      ],
      company: null,
      deal: { id: '00000000-0000-4000-8000-0000000000e3', title: 'Renewal' },
      createdAt: '2026-10-01T09:00:00.000Z'
    };
    const lists = await mountIn(
      () =>
        h('div', [
          h(ActivityList, { activities: [activity] }),
          h(ActivityList, { activities: [] }),
          h(HistoryList, { entries: [] }),
          h(DealList, {
            deals: [
              {
                ...deal('d1', STAGES[0]!, 100),
                project: { id: '00000000-0000-4000-8000-0000000000e4', name: 'Rollout' },
                // The schema pairs these (CHECK: both or neither).
                nextActionText: 'Call back',
                nextActionDate: '2026-10-20'
              }
            ]
          }),
          h(DealList, { deals: [] }),
          h(DealList, { deals: [], emptyText: 'Nothing for this contact.' }),
          h(ProjectList, { projects: [] }),
          h(ProjectList, { projects: [], emptyText: 'No projects here.' })
        ]),
      theme
    );
    const text = lists.text();
    expect(text).toContain('Meeting: Review');
    expect(text).not.toContain(' min');
    expect(lists.get('s').text()).toBe('Gone (deleted)');
    expect(lists.find('a[href="/deal/00000000-0000-4000-8000-0000000000e3"]').exists()).toBe(true);
    expect(text).toContain('No calls or meetings logged yet.');
    expect(text).toContain('No history recorded.');
    expect(text).toContain('Converted to Rollout');
    expect(text).toContain('Next: Call back');
    expect(text).toContain('No deals yet.');
    expect(text).toContain('Nothing for this contact.');
    expect(text).toContain('No projects yet.');
    expect(text).toContain('No projects here.');
    lists.unmount();
  });

  it('ContactPicker adds with a keyboard-operable button, replaces in single mode, and survives a failed search', async () => {
    let fail = false;
    vi.stubGlobal('fetch', (input: string) =>
      Promise.resolve(
        fail
          ? new Response('{}', { status: 503 })
          : Response.json({
              items: [
                {
                  id: CONTACT.id,
                  displayName: 'Ada',
                  email: null,
                  jobTitle: null,
                  companyId: null,
                  companyName: null,
                  updatedAt: '2026-10-01T09:00:00.000Z'
                }
              ].filter(() => input.startsWith('/api/v1/contacts')),
              nextCursor: null
            })
      )
    );
    const single = ref<PickedContact | PickedContact[] | null>({
      id: USER.id,
      displayName: 'Earlier choice'
    });
    const multiple = ref<PickedContact | PickedContact[] | null>([
      { id: CONTACT.id, displayName: 'Ada' }
    ]);
    const wrapper = await mountIn(
      () =>
        h('div', [
          h(ContactPicker, {
            'label': 'Primary contact',
            'modelValue': single.value,
            'onUpdate:modelValue': (value: PickedContact | PickedContact[] | null) => {
              single.value = value;
            }
          }),
          h(ContactPicker, {
            'label': 'Contacts involved',
            'multiple': true,
            'modelValue': multiple.value,
            'onUpdate:modelValue': (value: PickedContact | PickedContact[] | null) => {
              multiple.value = value;
            }
          })
        ]),
      theme
    );
    const [primarySearch, involvedSearch] = wrapper.findAll('input[type="search"]');
    await primarySearch!.setValue('ad');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(wrapper.findAll('[data-testid="picker-status"]')[0]!.text()).toBe('1 matching contact');
    // Enter in the search field picks the first result rather than submitting a parent form.
    await primarySearch!.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(single.value).toMatchObject({ id: CONTACT.id });
    single.value = null;
    await settle();
    await primarySearch!.setValue('ad');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    const add = wrapper.get('[aria-label="Add Ada to Primary contact"]');
    await add.trigger('click');
    await settle();
    expect(single.value).toMatchObject({ id: CONTACT.id, displayName: 'Ada' });
    // Ada is already involved, so the multiple picker offers no Add for her.
    await involvedSearch!.setValue('ad');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(wrapper.find('[aria-label="Add Ada to Contacts involved"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="picker-status"]')[1]!.text()).toBe(
      'No matching contacts'
    );
    // Clearing the selection entirely (the autocomplete's clear button) is allowed.
    wrapper.findAllComponents({ name: 'VAutocomplete' })[1]!.vm.$emit('update:modelValue', null);
    await settle();
    expect(multiple.value).toBeNull();
    // An outage clears stale results rather than offering them.
    fail = true;
    await involvedSearch!.setValue('zz');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(wrapper.find('[aria-label^="Add "]').exists()).toBe(false);
    wrapper.unmount();
  });
});
