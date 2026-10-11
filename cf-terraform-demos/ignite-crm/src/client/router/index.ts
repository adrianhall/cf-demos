/**
 * @file Client routes. The dashboard (the landing page) and the not-found page are part of the main
 *   chunk; every other view is a lazily loaded route component, so the first page load only
 *   downloads the shell and the dashboard. Vite emits one chunk per view (shared components are
 *   split out automatically), which also keeps every chunk below Vite's 500 kB warning without
 *   raising the limit. Router navigation waits for a view's chunk before rendering it, and the
 *   shell shows a progress bar meanwhile (`App.vue`).
 */

import {
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw
} from 'vue-router';
import DashboardView from '../views/DashboardView.vue';
import NotFoundView from '../views/NotFoundView.vue';

/**
 * Route table.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'dashboard', component: DashboardView, meta: { title: 'Dashboard' } },
  {
    path: '/actions',
    name: 'actions',
    component: () => import('../views/ActionStreamView.vue'),
    meta: { title: 'Action stream' }
  },
  {
    path: '/deals',
    name: 'deals',
    component: () => import('../views/DealsView.vue'),
    meta: { title: 'Deals' }
  },
  {
    path: '/deals/:id',
    name: 'deal',
    component: () => import('../views/DealView.vue'),
    props: true,
    meta: { title: 'Deal' }
  },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('../views/ProjectsView.vue'),
    meta: { title: 'Projects' }
  },
  {
    path: '/projects/:id',
    name: 'project',
    component: () => import('../views/ProjectView.vue'),
    props: true,
    meta: { title: 'Project' }
  },
  {
    path: '/my-work',
    name: 'my-work',
    component: () => import('../views/MyWorkView.vue'),
    meta: { title: 'My work' }
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../views/ReportsView.vue'),
    meta: { title: 'Reports' }
  },
  {
    path: '/team',
    name: 'team',
    component: () => import('../views/TeamView.vue'),
    meta: { title: 'Team' }
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('../views/AuditView.vue'),
    meta: { title: 'Audit trail' }
  },
  {
    path: '/notes',
    name: 'notes',
    component: () => import('../views/NotesView.vue'),
    meta: { title: 'Notes' }
  },
  {
    path: '/notes/:id',
    name: 'note',
    component: () => import('../views/NoteView.vue'),
    props: true,
    meta: { title: 'Note' }
  },
  {
    path: '/contacts',
    name: 'contacts',
    component: () => import('../views/ContactsView.vue'),
    meta: { title: 'Contacts' }
  },
  {
    path: '/contacts/:id',
    name: 'contact',
    component: () => import('../views/ContactView.vue'),
    props: true,
    meta: { title: 'Contact' }
  },
  {
    path: '/companies',
    name: 'companies',
    component: () => import('../views/CompaniesView.vue'),
    meta: { title: 'Companies' }
  },
  {
    path: '/companies/:id',
    name: 'company',
    component: () => import('../views/CompanyView.vue'),
    props: true,
    meta: { title: 'Company' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundView,
    meta: { title: 'Not found' }
  }
];

/**
 * Create the router.
 *
 * @param history History implementation (memory history in tests).
 * @returns The router, which keeps the document title in step with the route. Titles use the
 *   route's generic label, never record content, so contact names are not exposed to browser
 *   history or tab titles.
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({ history, routes });
  router.afterEach((to) => {
    const title = typeof to.meta.title === 'string' ? to.meta.title : 'Ignite CRM';
    document.title = `${title} · Ignite CRM`;
  });
  return router;
}
