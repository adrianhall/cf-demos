# Bugs

## Resolved

### 1. Local Access login was not shown

The shared Access policy no longer bypasses every unmatched path. Local navigation to `/` and `/admin` now enters the toolkit's Access login flow, management API requests return `401` instead of login HTML, and only `/l/*` is explicitly public.

### 2. The UI could render without Access

The browser bootstrap performs a document-level redirect from `/` to `/admin` before mounting Vue. This forces the request through the existing `/admin*` Access application and prevents an anonymous client-side router redirect from displaying the UI.

### 3. The create form wasted horizontal space

The create form now uses a compact responsive layout: the URL field and action are side by side from the small breakpoint upward and stack on narrow screens.

### 5. Client coverage was incomplete

Tests now cover browser bootstrap, Pinia CRUD and error behavior, Access path policies, component interactions, dialog behavior, and defensive error branches. The combined suite reports 100% statement, branch, function, and line coverage.

## Open For Design Discussion

### 4. A first deployment cannot attach the custom domain

Terraform currently attempts to attach the custom domain before Wrangler has created the Worker's first deployment, and Cloudflare rejects that ordering with error `100124`. No Terraform resources or deployment scripts were changed; the ownership and orchestration approach must be agreed before implementation.

### 6. When I run `npm start` and log in, I get 404 Not Found

Url: <https://localhost:5173/admin>
Output: {"type":"about:blank","status":404,"title":"Not Found"}
