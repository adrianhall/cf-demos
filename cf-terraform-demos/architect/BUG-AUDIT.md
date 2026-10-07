# Source Bug Regression Audit

This is the Phase 7 audit of the 35 numbered findings in the source specification,
`~/gitlab/cf-demos/docs/09-ARCHITECT.md`. It turns fixes learned in the source application into
checks that this port can rerun. The source calls number 7 an issue rather than a bug; it is
included here so the sequence is complete.

## Verification methods

- **Client/worker test** means a focused Vitest assertion checks DOM semantics or behaviour.
- **Built CSS** means [`tests/worker/built-css.test.ts`](tests/worker/built-css.test.ts) checks the
  minified production artifact, not merely the source stylesheet. That catches build transformations
  and accidental loss of a rule.
- **Browser** means a real rendering engine was used locally. jsdom has no layout engine, font
  metrics, viewport geometry, media-query evaluation, paint order, or React Flow measurement. It can
  assert that a class exists, but cannot prove that a panel fits, an overlay receives the click, a
  focus ring is visible, or nodes are inside a measured viewport.

## Bugs 1–8

|   # | Source finding                                                         | Regression evidence                                                                                                                                                                                                                                                             |
| --: | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Sign out was an unclear text link.                                     | `AppHeader.test.tsx` verifies the named sign-out control and Cloudflare Access destination; `AppHeader.tsx` renders the `LogOut` icon. Browser: the icon-plus-text control is visible in the common banner.                                                                     |
|   2 | Editor actions were separate text banners instead of one icon toolbar. | `Toolbar.test.tsx`, `ExportButton.test.tsx`, and `PrintButton.test.tsx` exercise the icon-only named controls and groups. Browser: one editor toolbar is present.                                                                                                               |
|   3 | Product catalog lacked collapse/expand all.                            | `ServicePalette.test.tsx` verifies both bulk actions and persistence.                                                                                                                                                                                                           |
|   4 | Properties panel started open and did not follow selection.            | `diagramStore.test.ts` verifies the closed default, opening on node/edge selection, and explicit close; `Toolbar.test.tsx` checks its toggle.                                                                                                                                   |
|   5 | Administrator status was verbose text.                                 | Superseded by Bug 27: `AppHeader.test.tsx` verifies only the Admin navigation link is rendered for the administrator.                                                                                                                                                           |
|   6 | “Architect” appeared in both banner and editor toolbar.                | `EditorView.test.tsx` and `views.test.tsx` verify that the editor has no app banner; `Toolbar.test.tsx` verifies the icon-only “Back to dashboard” link.                                                                                                                        |
|   7 | Catalog and icons were stale.                                          | `catalog.test.ts` verifies the documented product count, unique ids, official icon files, categories, handles, and valid documentation links; `ProductIcon.test.tsx` exercises both icon sources.                                                                               |
|   8 | Connecting nodes required dragging.                                    | `connect.test.ts`, `ConnectNodesModal.test.tsx`, and `diagramStore.test.ts` verify the native-select keyboard route, validation, handle choice, history and selection. Browser: the named **Connect nodes** control opens a native-form path independent of React Flow handles. |

## Bugs 9–17

|   # | Source finding                                   | Regression evidence                                                                                                                                                                                                                                                |
| --: | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   9 | Form borders failed 3:1 non-text contrast.       | Built CSS asserts the theme-aware `--cf-field-border` values and their use survives minification. Browser computed styles confirmed visible input borders in light mode.                                                                                           |
|  10 | Unselected node borders failed 3:1.              | `graph-elements.test.tsx` verifies full-opacity borders in both states; `catalog.test.ts` verifies category colours are defined. The source comments preserve the measured contrast rationale for the corrected storage/network colours.                           |
|  11 | Danger text failed dark-theme contrast.          | Built CSS asserts the theme-aware `--cf-danger` pair and separate solid-button token.                                                                                                                                                                              |
|  12 | Canvas had no visible keyboard focus.            | `DiagramCanvas.test.tsx` verifies the canvas is keyboard reachable; built CSS asserts its `:focus-visible` outline. Browser is required for visibility because jsdom does not paint focus.                                                                         |
|  13 | Modals did not move, trap, or restore focus.     | `hooks.test.ts` exhaustively checks initial focus, forward/reverse wrapping, Escape, no-focusable fallback, dynamic controls and restoration. Modal component tests verify dialog semantics and close paths. Browser confirmed initial focus in the create dialog. |
|  14 | Layout menu semantics differed from other menus. | `Toolbar.test.tsx`, `ExportButton.test.tsx`, and `DiagramGrid.test.tsx` verify menu/menuitem roles and expanded state.                                                                                                                                             |
|  15 | Menus could not be dismissed by keyboard.        | `hooks.test.ts` covers the shared dismiss hook; all three component suites verify Escape and outside dismissal.                                                                                                                                                    |
|  16 | Diagram card nested a button in an anchor.       | `DiagramGrid.test.tsx` explicitly verifies that no control is nested in the stretched title link.                                                                                                                                                                  |
|  17 | Modal/card close targets were under 24 CSS px.   | Built CSS asserts 24 px minima for modal close and card menu controls. Browser measured the create-modal close control at 24 × 28 CSS px. Geometry needs a browser because jsdom has no rendered box dimensions.                                                   |

## Bugs 18–25

|   # | Source finding                                                | Regression evidence                                                                                                                                                                                                                                                                                                                     |
| --: | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  18 | Service descriptions existed only as hover tooltips.          | `ServicePalette.test.tsx` verifies visible description text connected with `aria-describedby`; built CSS retains the two-line treatment.                                                                                                                                                                                                |
|  19 | Editor lacked an h1 and skipped heading levels.               | `DiagramCanvas.test.tsx` verifies the diagram-specific h1. Browser accessibility snapshot exposes “API Gateway — Diagram editor”.                                                                                                                                                                                                       |
|  20 | Share viewer had no landmark.                                 | `ShareView.test.tsx` verifies its `main` landmark in loading, error, and success states.                                                                                                                                                                                                                                                |
|  21 | Sidebars squeezed the canvas at narrow widths.                | Built CSS asserts the 900 px breakpoint. Browser at 390 px measured the canvas at 375 px wide while the 332 px palette/properties drawers were absolutely overlaid, not added beside it. Geometry requires a browser because CSS positioning and viewport reflow are not implemented by jsdom.                                          |
|  22 | Edge animation ignored reduced motion.                        | `graph-elements.test.tsx` verifies only data-flow edges receive the application animation class; built CSS verifies the production `prefers-reduced-motion: reduce` override disables it. Browser/OS emulation is the final paint check.                                                                                                |
|  23 | Editor still showed two stacked banners.                      | `EditorView.test.tsx` and `views.test.tsx` verify no banner on the editor route; browser showed one toolbar at the top of the viewport.                                                                                                                                                                                                 |
|  24 | Data-flow animation class never matched a live path.          | `graph-elements.test.tsx` verifies `cf-edge-animated` is applied directly to the rendered path; built CSS verifies the matching keyframes/class.                                                                                                                                                                                        |
|  25 | Production light mode gave icon buttons the wrong background. | Built CSS verifies native `light-dark()` survives minification, no media-query polyfill is emitted, root `color-scheme` remains, and buttons opt out of native appearance. `DarkModeToggle.test.tsx` and `theme.test.ts` cover the three-state override. This must target built output because development CSS never exhibited the bug. |

## Bugs 26–35

|   # | Source finding                                            | Regression evidence                                                                                                                                                                                                                                                                                                                                                         |
| --: | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  26 | Sign-out icon and text were cramped/misaligned.           | Built CSS retains `.app-shell__logout` as `inline-flex` with centered alignment and a gap. Browser showed a 116 × 36 CSS px aligned control. Geometry requires browser paint.                                                                                                                                                                                               |
|  27 | Redundant admin shield remained beside the identity.      | `AppHeader.test.tsx` verifies the admin link and identity state; the component renders no shield or administrator badge.                                                                                                                                                                                                                                                    |
|  28 | Properties inputs overflowed the panel edge.              | Built CSS verifies global `border-box` and 100%-width inputs. Browser at 390 px measured the overlaid panel with 16 px inner padding. Box-model overflow cannot be measured in jsdom.                                                                                                                                                                                       |
|  29 | New blueprint nodes opened outside the viewport.          | `DiagramCanvas.test.tsx` verifies fit waits for measurement and runs once. Built CSS verifies the editor main has a definite `100vh` height. Browser created an API Gateway diagram, measured an 1184 × 820 CSS px canvas, and confirmed all seven nodes fitted within it. React Flow fit calculations require real element geometry.                                       |
|  30 | Sign out was underlined.                                  | Built CSS asserts `.button { text-decoration: none }`; browser rendered the sign-out anchor as button chrome.                                                                                                                                                                                                                                                               |
|  31 | Only the card heading, not its preview, was clickable.    | Built CSS verifies the stretched link is above React Flow (`z-index: 5`), the menu remains above it (`6`), and the preview ignores pointer events. `DiagramGrid.test.tsx` verifies the block-link structure. Paint-order hit testing requires a browser.                                                                                                                    |
|  32 | Every service category started expanded.                  | `ServicePalette.test.tsx` verifies Compute-only initial expansion and guarded persistence of single/bulk toggles; `editor-preferences.test.ts` covers corrupt/unavailable storage.                                                                                                                                                                                          |
|  33 | Decorative React Flow previews polluted the tab order.    | `BlueprintPreview.test.tsx` verifies `nodesFocusable={false}` and `edgesFocusable={false}` inside the `aria-hidden` preview.                                                                                                                                                                                                                                                |
|  34 | Blueprint/header chrome used ad-hoc underlined links.     | `AppHeader.test.tsx`, `views.test.tsx`, and `BlueprintsView.test.tsx` verify the shared header and `nav-link` treatment; built CSS asserts that treatment survives production build. Prose links deliberately remain underlined for WCAG 1.4.1.                                                                                                                             |
|  35 | Card timestamp squeezed the title and had poor semantics. | `DiagramGrid.test.tsx` verifies stacked heading content, relative text, `<time dateTime>`, exact assistive text and valid structure; `datetime.test.ts` covers relative/absolute formatting. Built CSS verifies the timestamp/title stacking and timestamp hit-test layer. Width/ellipsis behaviour receives final browser verification because it depends on font metrics. |

## WCAG 2.2 AA review

No new Level A/AA defect was found in the reviewed Layer 1 flows.

- **Keyboard and dragging (2.1.1, 2.5.7):** palette buttons provide click/keyboard node creation;
  the Connect nodes dialog provides native form controls as the non-drag edge path. Pointer drag is
  therefore not the only way to complete either core task.
- **Focus order, visible focus, and dialogs (2.4.3, 2.4.7, 4.1.2):** the shared modal hook moves,
  traps and restores focus; canvas and chrome controls have focus-visible treatments; dialogs carry
  names and modal semantics.
- **Structure (1.3.1, 2.4.6):** every top-level view has a `main`; editor/share canvas has a
  diagram-specific h1; tables retain headers and cell relationships; menus use consistent roles.
- **Contrast (1.4.3, 1.4.11):** theme-aware text, field-border, danger and category values retain
  the source's measured ratios. The browser pass confirmed the expected computed light-theme values;
  production built CSS proves the dark/explicit theme mechanism is not transformed away.
- **Reflow and targets (1.4.10, 2.5.8):** narrow sidebars overlay rather than squeeze the canvas;
  modal close and card menu targets have at least 24 CSS px boxes.
- **Motion (2.3.3):** data-flow dash motion is removed under the OS reduced-motion preference.
- **Hidden content (4.1.2):** decorative previews disable node and edge focusability before being
  hidden from assistive technology.

The browser checklist remains mandatory for painted focus visibility, contrast/computed colour, text
clipping, hit-test stacking, responsive geometry, React Flow fit/drag/connect behaviour and
reduced-motion animation. Those properties do not exist in jsdom's DOM-only model.

## Web performance review

ELK is browser-only and lazy. [`src/client/lib/auto-layout.ts`](src/client/lib/auto-layout.ts) has
no static `elkjs` import; `computeAutoLayout()` performs `await import('elkjs/lib/elk.bundled.js')`
only after the visitor activates auto-layout. The production build emitted:

| Artifact                         |        Size | Initial?          |
| -------------------------------- | ----------: | ----------------- |
| Application entry (`index-*.js`) |   602.34 kB | Yes               |
| ELK (`elk.bundled-*.js`)         | 1,431.11 kB | No; dynamic chunk |
| Stylesheet                       |    40.06 kB | Yes               |

`tests/worker/built-bundle.test.ts` proves the ELK chunk exists exactly once, that ELK's layered
algorithm marker appears only there, and that every non-ELK chunk stays below the tripwire that
would catch accidental inlining. The entry refers to ELK only through the emitted dynamic-chunk
boundary; activating **Auto layout** calls the `import()` that resolves it. This is stronger than
checking the source import spelling alone because it verifies the emitted bundle graph.

## Phase 7 local browser record

Reviewed on 2026-10-07 with `pnpm start`, Chromium, at 1440 × 900 and 390 × 844:

- landing, shared header, explicit light/dark/system appearance and visible sign-out chrome;
- blueprint cards and non-focusable miniature diagrams;
- create-dialog initial focus, 24 px close target, labelled fields, keyboard close path;
- blueprint creation and first editor fit (seven nodes/six edges visible);
- single editor toolbar, keyboard-named icon controls and Connect nodes dialog;
- full-height desktop canvas and overlay side drawers at narrow width;
- properties panel padding, canvas focus treatment and responsive toolbar wrapping.

No intentional source-UI deviation was found in this audit. The generated project export remains the
one already documented platform deviation: it emits the repository's `cf`-based scaffold rather than
the source demo's obsolete Wrangler scaffold.
