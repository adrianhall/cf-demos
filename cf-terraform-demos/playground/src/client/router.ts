import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory
} from 'vue-router';
import { TASK_DESCRIPTORS, type TaskId } from '../tasks';
import ActivityView from './views/ActivityView.vue';
import ChatView from './views/ChatView.vue';
import CreateImageView from './views/CreateImageView.vue';
import PlannedPanelView from './views/PlannedPanelView.vue';
import ViewTokensView from './views/ViewTokensView.vue';

/**
 * Views for the panels that are built, keyed by task identifier.
 *
 * A panel absent from this map renders the placeholder. Each phase adds one entry rather than
 * restructuring the route table, and a panel marked `available` in the catalogue without a view
 * here would show a placeholder while the sidebar claimed otherwise — which
 * `tests/client/router.test.ts` treats as a failure.
 */
const DELIVERED_VIEWS: Partial<Record<TaskId, RouteRecordRaw['component']>> = {
  'chat': ChatView,
  'create-image': CreateImageView,
  'view-tokens': ViewTokensView
};

/**
 * Builds the Playground's routes from the panel catalogue.
 *
 * Generating the routes rather than listing them is what keeps the promise that the sidebar and the
 * router cannot disagree: both read `TASK_DESCRIPTORS`, so a panel is either present in both or in
 * neither. It also means a panel's route is `/create-image` — the task identifier itself — rather
 * than a separately invented path that could drift from the API's task parameter.
 *
 * Every panel gets a top-level path. There are no nested routes, no mode query parameters, and no
 * panel reachable only through another, because the navigation is deliberately one level deep.
 *
 * @returns The ordered route table: one route per panel, the activity page, and a catch-all.
 */
export function buildRoutes(): RouteRecordRaw[] {
  const panelRoutes: RouteRecordRaw[] = TASK_DESCRIPTORS.map((task) => ({
    path: `/${task.id}`,
    name: task.id,
    component: DELIVERED_VIEWS[task.id] ?? PlannedPanelView,
    props: { taskId: task.id },
    meta: { taskId: task.id }
  }));

  return [
    // The Playground has no dashboard worth the name, so `/` goes straight to the one panel that
    // works. Landing on an empty overview would make a visitor's first click a wasted one.
    { path: '/', redirect: '/view-tokens' },
    ...panelRoutes,
    { path: '/activity', name: 'activity', component: ActivityView },
    { path: '/:pathMatch(.*)*', redirect: '/view-tokens' }
  ];
}

/**
 * Creates the application router.
 *
 * @param history History implementation to use. Defaults to HTML5 history; tests pass a memory
 *   history so navigation can be exercised without a browser URL bar.
 * @returns A router configured with every panel route.
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({ history, routes: buildRoutes() });
}
