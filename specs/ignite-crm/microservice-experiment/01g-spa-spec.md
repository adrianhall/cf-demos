# Ignite CRM — Vue SPA specification

## 1. Purpose and boundary

The SPA is Ignite CRM's browser presentation and interaction layer. It renders API view models,
collects validated user input, provides optimistic feedback only where safe, and presents role-based
capabilities. It owns no authorization or durable business data and never calls domain services, D1,
Access APIs, or MCP directly.

## 2. Technology and organization

Use Vue 3, TypeScript, Composition API, `<script setup>`, Vue Router 4, and Vite. Use native `fetch`
through one typed API client. Do not add Pinia or a server-state query library initially: the
product state is route-scoped and explicit composables are sufficient. Revisit only if
implementation proves cross-view mutation invalidation unmanageable.

```text
src/client/
├── components/{app,crm,projects,notes,forms,feedback}/
├── composables/{useApiResource,useMutation,useIdentity,useUnsavedChanges}/
├── router/{index,routes}/
├── services/{api-client,problem-details,view-models}/
├── views/{Dashboard,ActionStream,Contacts,Companies,Deals,Projects,MyWork,Notes,Reports,Admin}/
├── styles/{tokens,base,components,utilities}.css
├── App.vue
└── main.ts
```

Rules:

- Components take typed props/emit events; they do not fetch except route/view containers.
- `useIdentity` is the one module-scoped singleton cache: it loads `/api/me` and `/api/v1/session`
  once, shares identity/capabilities with navigation and guards, and clears on a 401/403. Business
  resources remain route-scoped.
- `api-client.ts` is the only `fetch` caller. It sets JSON headers, request/idempotency IDs, ETags,
  credentials, timeouts, and parses RFC 9457.
- Server records remain immutable in client state. Forms edit explicit drafts and submit patches.
- Route loaders cancel stale requests with `AbortController`.
- No business content is persisted in localStorage. Theme/navigation preferences may be.

## 3. Information architecture and routes

| Route                                | View                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `/`                                  | Dashboard: own action stream, pipeline summary, active delivery summary |
| `/actions`                           | Prioritized contact/deal follow-ups                                     |
| `/contacts`, `/contacts/:id`         | Search/list and customer overview                                       |
| `/companies`, `/companies/:id`       | Company detail, contacts/deals/activity/notes                           |
| `/deals`, `/deals/:id`               | Pipeline/list and deal detail/conversion                                |
| `/projects`, `/projects/:id`         | Project list and task board                                             |
| `/my-work`                           | Cross-project assigned tasks                                            |
| `/notes`, `/notes/:id`, `/notes/new` | Search, view, Markdown edit, typed links                                |
| `/reports`                           | Pipeline and delivery summaries                                         |
| `/admin/users`                       | Owner-only user/role management                                         |

Navigation items derive from `/api/me` capability hints, but deep routes still call API and
handle 403. Unknown client route renders a useful not-found page.

## 4. Core interaction specifications

### Customer/company/deal

- Lists have debounced search, URL-backed filters/cursor, skeleton then empty/error states.
- Customer overview sections show partial-data warnings per API.
- Activity form supports multiple searchable contacts plus optional company and deal; selected links
  remain visible chips with keyboard removal.
- Company primary contact selector includes only active company contacts. Deleting that person warns
  which deterministic fallback will become primary.
- Deal form clearly separates fixed outcome/stage from free-text status line and dated next action.
- Won deal offers Convert to project; 202 pending result displays project link and Retry linkage.

### Projects/tasks

- Project board columns are fixed statuses. Keyboard-accessible status menu is primary; drag/drop is
  an enhancement and must have equivalent controls.
- Mutations send current version. A 409 preserves draft and offers reload/compare, never blind
  retry.
- My Work orders overdue/due/priority and links to project context.

### Notes

- Editor is a labelled textarea with preview, not an opaque contenteditable surface.
- Link picker groups contacts, companies, deals, projects; multiple targets are required and shown
  as removable chips.
- Preview disables raw HTML and sanitizes links. Source Markdown is always editable.
- Search highlights matching text without injecting server HTML.
- Autosave is not release one; explicit Save plus unsaved-navigation guard avoids ambiguous
  conflicts.

### Administration

Owner invites user, assigns one or more seeded roles, and suspends/reactivates. The UI blocks the
obvious last-owner action but relies on server invariant. Confirm destructive/status changes.

## 5. State, loading, and errors

Each resource composable uses discriminated state `idle|loading|success|error`. Existing content
remains visible during refresh with `aria-busy`; initial load uses skeleton. Mutations disable only
the affected control and prevent duplicate submission while keeping Cancel/navigation behavior
clear.

RFC 9457 field errors map to fields; global errors use an alert summary focusing the first error.
403 explains lack of permission; 404 does not speculate; 409 explains concurrent edit; 503 offers
retry and displays request ID. Never render raw server detail as HTML.

## 6. Accessibility and responsive design

WCAG 2.2 AA is required:

- semantic landmarks and one `h1`; logical heading hierarchy;
- every control has visible label; errors linked with `aria-describedby`;
- keyboard-complete navigation, dialogs, link pickers, board movements, menus;
- visible focus, skip link, focus return after dialogs, focus heading after route navigation;
- no color-only status/priority; text/icons accompany color;
- 44×44 CSS pixel target where practical, minimum 24×24;
- reduced-motion support; no required animation;
- tables reflow to cards or horizontal labelled regions at mobile widths;
- polite live regions for saves/status moves, assertive only for blocking errors;
- light/dark contrast at AA if dark mode ships.

## 7. Security and privacy

Vue text interpolation is default. `v-html` is forbidden except one reviewed Markdown renderer
output through a sanitizer. External links use protocol allowlist and `rel="noopener noreferrer"`.
Do not place contact/note content in document titles beyond a safe display name, analytics, browser
storage, or console logs. Logout is Cloudflare Access logout navigation, not a local auth state
toggle.

## 8. Testing

### Unit/DOM

- API client headers, ETag/idempotency/problem parsing, cancellation.
- Forms: validation, field errors, drafts preserved on conflict.
- Multi-contact activity and multi-link note picker.
- Deal fixed/free status distinction and conversion pending state.
- Task keyboard movement and accessible announcements.
- Route guards/capability navigation and 403 deep link.
- Markdown XSS payloads, unsafe links, search highlights.
- Focus management, labels, landmarks, keyboard, reduced motion.

Use Vue Test Utils + Vitest in DOM. Mock only the API client boundary, not internal composables.

### E2E

Playwright against local full stack: owner invite; rep creates customer/deal/activity;
wins/converts; contributor moves task; user creates/searches multi-linked note; read-only user is
denied mutation. Run desktop and mobile, keyboard-only critical flow, and automated accessibility
checks supplemented by manual review.

## 9. Acceptance criteria

- All Must-have browser stories are reachable and keyboard operable.
- SPA has no direct platform/service bindings or duplicated authorization logic.
- Concurrency and partial failure are visible and recoverable.
- Notes/activity multi-link model is reflected accurately, not collapsed to one parent.
- DOM and local E2E suites are offline and deterministic.

## 10. Open questions

1. Should release one include dark mode? Current decision: only if design tokens make it low-cost;
   accessibility is required either way.
2. Is drag-and-drop task movement required? Current decision: optional enhancement after accessible
   buttons/menu work.
3. Should layout use a persistent desktop sidebar and mobile drawer (recommended), or top nav?
4. Should Markdown preview be side-by-side desktop/tabs mobile, or one toggle everywhere?
5. Do we need Pinia after route implementation? Current decision: do not add it speculatively.
6. Which visual identity (colors/logo/type) should Ignite use? This blocks visual design, not
   architecture.
