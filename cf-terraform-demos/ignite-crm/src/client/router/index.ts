/**
 * @file Client routes.
 */

import {
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw
} from 'vue-router';
import ActionStreamView from '../views/ActionStreamView.vue';
import AuditView from '../views/AuditView.vue';
import CompaniesView from '../views/CompaniesView.vue';
import CompanyView from '../views/CompanyView.vue';
import ContactsView from '../views/ContactsView.vue';
import ContactView from '../views/ContactView.vue';
import DashboardView from '../views/DashboardView.vue';
import DealsView from '../views/DealsView.vue';
import DealView from '../views/DealView.vue';
import MyWorkView from '../views/MyWorkView.vue';
import NotesView from '../views/NotesView.vue';
import NoteView from '../views/NoteView.vue';
import NotFoundView from '../views/NotFoundView.vue';
import ProjectsView from '../views/ProjectsView.vue';
import ProjectView from '../views/ProjectView.vue';
import TeamView from '../views/TeamView.vue';

/**
 * Route table.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'dashboard', component: DashboardView, meta: { title: 'Dashboard' } },
  {
    path: '/actions',
    name: 'actions',
    component: ActionStreamView,
    meta: { title: 'Action stream' }
  },
  { path: '/deals', name: 'deals', component: DealsView, meta: { title: 'Deals' } },
  {
    path: '/deals/:id',
    name: 'deal',
    component: DealView,
    props: true,
    meta: { title: 'Deal' }
  },
  { path: '/projects', name: 'projects', component: ProjectsView, meta: { title: 'Projects' } },
  {
    path: '/projects/:id',
    name: 'project',
    component: ProjectView,
    props: true,
    meta: { title: 'Project' }
  },
  { path: '/my-work', name: 'my-work', component: MyWorkView, meta: { title: 'My work' } },
  { path: '/team', name: 'team', component: TeamView, meta: { title: 'Team' } },
  { path: '/audit', name: 'audit', component: AuditView, meta: { title: 'Audit trail' } },
  { path: '/notes', name: 'notes', component: NotesView, meta: { title: 'Notes' } },
  {
    path: '/notes/:id',
    name: 'note',
    component: NoteView,
    props: true,
    meta: { title: 'Note' }
  },
  { path: '/contacts', name: 'contacts', component: ContactsView, meta: { title: 'Contacts' } },
  {
    path: '/contacts/:id',
    name: 'contact',
    component: ContactView,
    props: true,
    meta: { title: 'Contact' }
  },
  { path: '/companies', name: 'companies', component: CompaniesView, meta: { title: 'Companies' } },
  {
    path: '/companies/:id',
    name: 'company',
    component: CompanyView,
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
