<script setup lang="ts">
/**
 * Open deals laid out in one column per pipeline stage, with column totals.
 *
 * A reusable component in Vuetify's style (README "Vuetify component library"): Vuetify has no
 * kanban/column layout. Columns are `VCard`s in a `VRow`, deals are `VCard`s with links, and moving
 * a deal uses a **keyboard-first** `VMenu` listing the other stages — the specification requires a
 * keyboard alternative for every reordering control, so drag-and-drop is deliberately not the
 * primary interaction (and is not offered in release one). The board never calls the API: it emits
 * `move` and the parent performs the versioned update.
 *
 * On narrow screens the columns stack vertically.
 *
 * @fires move With the deal and the target stage when the user chooses a new stage.
 */
import { computed } from 'vue';
import { mdiSwapHorizontal } from '@mdi/js';
import type { Deal, Stage } from '../../shared/api/sales.ts';
import { useFormat } from '../composables/useFormat.ts';

const props = defineProps<{
  /**
   * Stages in pipeline order.
   */
  stages: readonly Stage[];
  /**
   * Open deals to place on the board (others are ignored).
   */
  deals: readonly Deal[];
  /**
   * Whether the user may move deals.
   */
  editable?: boolean;
  /**
   * Id of a deal whose move is in flight.
   */
  movingId?: string | null;
}>();

const emit = defineEmits<{
  /**
   * The user chose a new stage for a deal.
   */
  move: [deal: Deal, stage: Stage];
}>();

const format = useFormat();

const columns = computed(() =>
  props.stages.map((stage) => {
    const deals = props.deals.filter(
      (deal) => deal.status === 'pending' && deal.stage.id === stage.id
    );
    return {
      stage,
      deals,
      total: deals.reduce((sum, deal) => sum + deal.amountMinor, 0)
    };
  })
);
</script>

<template>
  <v-row role="list" aria-label="Pipeline stages" data-testid="pipeline-board">
    <v-col v-for="column in columns" :key="column.stage.id" cols="12" sm="6" lg="3" role="listitem">
      <v-card variant="tonal" color="secondary-strong" class="h-100">
        <v-card-title>
          <h2 :id="`stage-${column.stage.id}`" class="text-subtitle-1 font-weight-bold">
            {{ column.stage.label }}
          </h2>
          <div class="text-caption">
            {{ column.deals.length }} {{ column.deals.length === 1 ? 'deal' : 'deals' }} ·
            {{ format.money(column.total) }}
          </div>
        </v-card-title>
        <v-card-text>
          <ul class="board-list" :aria-labelledby="`stage-${column.stage.id}`">
            <li v-for="deal in column.deals" :key="deal.id" class="mb-2">
              <v-card :data-testid="`board-deal-${deal.id}`">
                <v-card-text class="pb-2">
                  <router-link
                    :to="{ name: 'deal', params: { id: deal.id } }"
                    class="font-weight-medium"
                    >{{ deal.title }}</router-link
                  >
                  <div class="text-body-2">{{ format.money(deal.amountMinor) }}</div>
                  <div class="text-caption text-medium-emphasis">
                    {{ deal.company?.name ?? deal.primaryContact.displayName }} ·
                    {{ deal.owner.displayName }}
                  </div>
                  <div v-if="deal.statusLine" class="text-caption">{{ deal.statusLine }}</div>
                </v-card-text>
                <div v-if="editable" class="px-2 pb-2">
                  <v-menu>
                    <template #activator="{ props: menu }">
                      <v-btn
                        v-bind="menu"
                        size="small"
                        variant="text"
                        :prepend-icon="mdiSwapHorizontal"
                        :loading="movingId === deal.id"
                        :aria-label="`Move ${deal.title} to another stage`"
                        >Move</v-btn
                      >
                    </template>
                    <v-list density="compact" :aria-label="`Stages for ${deal.title}`">
                      <v-list-item
                        v-for="stage in stages.filter(
                          (candidate) => candidate.id !== deal.stage.id
                        )"
                        :key="stage.id"
                        :title="stage.label"
                        @click="emit('move', deal, stage)"
                      />
                    </v-list>
                  </v-menu>
                </div>
              </v-card>
            </li>
            <li v-if="column.deals.length === 0" class="text-body-2 text-medium-emphasis">
              No open deals.
            </li>
          </ul>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.board-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
</style>
