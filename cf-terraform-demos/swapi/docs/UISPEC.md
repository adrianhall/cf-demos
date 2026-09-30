# SWAPI Explorer — UI specification

The experience to build on top of the read-only GraphQL API in this demo. This describes
**behaviour, not technology**: no framework, component library, state-management, or styling choices
are made here, and an implementer is expected to choose those according to the repository's
conventions.

Written to be consumed by another agent or developer without reading the Worker source first.
Everything asserted about the API below was verified against the current schema; where the API
cannot yet support the experience, that is called out explicitly as
[required API work](#12-required-api-work).

## 1. The idea

An explorer for a small, densely interconnected dataset. The value is not in any single record — it
is in **traversal**: noticing that Tatooine is Luke's homeworld, that it appears in five films, that
those films share characters, and following that chain without ever typing a query.

The interface is therefore built around one repeated action: **see a list, pick a thing, see its
details and everything it connects to, pick one of those.** Every click answers a question and
offers the next one.

The user never writes GraphQL. The GraphiQL console remains available for people who want to (see
[§11](#11-relationship-to-graphiql)), but this UI is for people who do not.

## 2. The data

Six entity types, ~260 records in total. The dataset is **fixed, public, and read-only** — there is
no per-user state and nothing to save.

| Type     | Records | Reachable from                             |
| -------- | ------- | ------------------------------------------ |
| Film     | 6       | Person, Planet, Species, Starship, Vehicle |
| Person   | 82      | Film, Planet, Species, Starship, Vehicle   |
| Planet   | 60      | Film, Person, Species                      |
| Species  | 37      | Film, Person                               |
| Starship | 36      | Film, Person                               |
| Vehicle  | 39      | Film, Person                               |

Two consequences the design must respect:

- **The collections are small.** The largest is 82 records. No list in this UI needs pagination,
  infinite scroll, or virtualization. Designing for those would add machinery the data does not
  justify.
- **The graph is not complete.** Film and Person connect to everything; Planet, Species, Starship,
  and Vehicle connect only to a subset. A Starship has no relation to a Planet. The UI must present
  whatever relations a type actually has rather than assuming a uniform set — see
  [§6.3](#63-relation-panels).

### 2.1 Fields are text, including the numeric-looking ones

Every scalar the API exposes is a string, including `mass`, `diameter`, `population`, and
`episodeId`. The source dataset uses sentinel text in those positions, and it is common: `"unknown"`
appears 313 times, `"none"` 76 times, `"n/a"` 20 times, `"indefinite"` once.

**The UI must not attempt to parse, format, or unit-annotate these values.** Rendering `population`
as `1,000,000,000` would be wrong the moment the value is `"unknown"`.

Sentinel values should be presented as _absence of information_ rather than as data — visually
de-emphasised, and ideally normalised so that `"unknown"`, `"n/a"`, and `"none"` read consistently
rather than exposing three different upstream spellings for the same idea. Distinguish "the dataset
does not say" from "the value is genuinely nothing" only where that distinction is real: a droid's
`gender` of `"n/a"` means _not applicable_, whereas a planet's `population` of `"unknown"` means
_unrecorded_.

This is common enough to be a main case rather than an edge case — 17 of 60 planets have an unknown
population.

## 3. Layout

Three fixed columns beneath a persistent top banner:

```text
┌──────────────────────────────────────────────────────────────────────┐
│  BANNER: identity · global search · (account / sign-out)             │
├────────────┬─────────────────────┬───────────────────────────────────┤
│ NAVIGATION │ COLLECTION          │ DETAIL                            │
│            │                     │                                   │
│ Films      │ [search this list]  │  Breadcrumb trail                 │
│ People   ▸ │ ┌─────────────────┐ │  ─────────────────────────────    │
│ Planets    │ │ Luke Skywalker  │ │  Luke Skywalker                   │
│ Species    │ │ Leia Organa     │ │                                   │
│ Starships  │ │ Han Solo      ◂ │ │  [ attributes ]                   │
│ Vehicles   │ │ ...             │ │                                   │
│            │ └─────────────────┘ │  [ Homeworld ] [ Species ]        │
│            │  82 people          │  [ Films 4 ] [ Starships 2 ]      │
└────────────┴─────────────────────┴───────────────────────────────────┘
```

The columns are **fixed in position and purpose**. They do not accumulate: selecting a related
entity **replaces** the contents of the collection and detail columns rather than appending a fourth
column. Continuity of place is carried by the breadcrumb trail ([§7](#7-the-breadcrumb-trail)), not
by a growing strip.

Column widths: navigation is narrow and can be fixed; collection is fixed or modestly resizable;
detail takes the remaining space and is the only column that should ever feel spacious. Detail is
where the user spends their attention, so it gets the room.

Each column scrolls independently. The banner never scrolls. A long detail view must not push the
collection list out of reach.

## 4. The banner

Persistent, always visible, and holds three things:

1. **Identity** — the application name, which doubles as a "return to the start" affordance
   ([§9.1](#91-the-empty-state)).
2. **Global search** — see [§5.1](#51-global-search).
3. **Session** — the signed-in identity and a way to sign out. Every user of this application is
   authenticated ([§10](#10-authentication)), so showing who they are is honest and makes the Access
   integration visible, which this demo exists partly to demonstrate.

## 5. Search

Two distinct searches with different jobs. Both are **server-backed** — see
[§12](#12-required-api-work), which is prerequisite work.

### 5.1 Global search

In the banner. Searches **across all six types at once** and answers the question "where is this
thing?" when the user does not know or care what type it is.

- Results are **grouped by type**, with the type named as a group heading. A search for `tat` should
  show Tatooine under Planets and Tatooine-related entries elsewhere without the user having to
  guess which collection to look in.
- Each result identifies itself well enough to be chosen unambiguously: its display name plus enough
  context to disambiguate similar entries.
- Choosing a result navigates exactly as clicking that entity anywhere else would: it selects the
  matching type in navigation, loads that collection, and opens the entity in detail
  ([§8](#8-navigation-rules)).
- The results surface is transient — it dismisses on selection, on `Escape`, and on click-away — and
  it does not disturb the three columns underneath until a selection is made.
- Reachable by keyboard from anywhere via a documented shortcut, with the shortcut visibly hinted in
  the field itself rather than left to be discovered.

### 5.2 Collection search

At the top of the collection column, scoped to the currently selected type only. This is a
**filter**, not a search: it narrows a list the user is already looking at.

- Filters as the user types, without a submit action.
- Shows how many of how many are matching, so the filter's effect is legible: `12 of 82`.
- Clearing it is a single, obvious action and restores the full list with the current selection
  intact if that entity still exists in the list.
- The filter is **cleared when the selected type changes**, because it belongs to the list it
  filters. It **persists** when the user merely changes which entity is selected within that same
  list.

### 5.3 What search matches

Search should match against the fields a person would reasonably search by — principally the display
name, and for films the title. It should be case-insensitive and match substrings, not just
prefixes: searching `walker` must find Luke Skywalker.

Search must **not** match against the `created`, `edited`, `url`, or `id` fields. Those are
provenance, not content ([§6.2](#62-attributes)), and matching them produces results a user cannot
explain.

## 6. The detail column

The heart of the interface. It has three parts, in this order: a header, the entity's own
attributes, and panels for its relations.

### 6.1 Header

The entity's display name, prominently. Beneath or beside it, the type, so a user who arrived via
global search knows what kind of thing they are looking at. For films, the episode number belongs
here — `Episode IV` is part of how a film is identified, not an incidental attribute.

### 6.2 Attributes

The entity's own scalar fields. Between 10 and 17 depending on type, which is too many for an
undifferentiated list, so they must be **ordered by usefulness and grouped**:

- **Identifying and descriptive fields first** — the ones a user came to read. For a planet:
  climate, terrain, population, gravity. For a starship: model, manufacturer, class, crew.
- **Measurements together**, since they are scanned as a set rather than read individually.
- **Long-form text last and given room.** A film's `openingCrawl` is ~500 characters containing ~20
  real newline characters, and those breaks are the crawl's original line structure. It must be
  rendered with them preserved — collapsing whitespace turns it into a wall of prose — and must not
  be crammed into a table cell. It may be collapsed by default provided expanding it is obvious.
- **Provenance de-emphasised or hidden.** `created`, `edited`, and `url` describe the _record_, not
  the subject. They should be available — `url` usefully links to the canonical upstream resource —
  but visually subordinate, or behind a disclosure. `id` is not shown as an attribute at all; it is
  plumbing, though it should be reachable for someone who wants to use it in GraphiQL.

Labels must be human, not schema field names: `Maximum atmosphering speed`, not
`maxAtmospheringSpeed`. The API's own field descriptions are a good source of wording and can be
surfaced as tooltips.

### 6.3 Relation panels

Below the attributes, one panel per relation the type has. **This is the mechanism that makes the
explorer an explorer**, and it deserves the most care.

Each panel:

- Names the relationship from the current entity's point of view — `Residents`, `Pilots`,
  `Appears in`, `Homeworld` — not the raw field name. `Film.characters` reads as `Characters`;
  `Person.films` reads as `Appears in`.
- States **how many** related entities there are, visible without expanding. The count is often the
  interesting fact by itself: that a planet has 10 residents, or that a character appears in 4
  films.
- Lists the related entities as **individually clickable** targets, each showing its display name
  and enough secondary detail to be recognised without navigating.
- Is **collapsible**, with a sensible default. A type may have five relation panels, and expanding
  all of them at once buries the attributes.

Two shapes of relation, presented differently:

- **Single-valued** (`Person.homeworld`, `Person.species`, `Species.homeworld`) — one entity or
  nothing. Present as a single clickable item, not a list of one. These are nullable in the schema,
  and one of them is **null for a large minority of records**: 32 of 82 characters have no recorded
  species, so an implementer will meet this case immediately rather than as an edge case. (For
  contrast, all 82 characters do have a homeworld, and 36 of 37 species do — but the UI must not
  rely on that, since the schema permits null and the data may change.) An absent single relation
  must render as an explicit "not recorded" rather than as an empty panel or a broken link.
- **Multi-valued** (everything else) — zero or more. An empty multi-valued relation is a real and
  meaningful answer ("this vehicle has no recorded pilots") and must say so, not render as blank
  space.

**Relations differ by type and the UI must not assume otherwise.** The actual relations are:

| Type     | Relations                                                     |
| -------- | ------------------------------------------------------------- |
| Film     | Characters, Planets, Species, Starships, Vehicles             |
| Person   | Homeworld*, Species*, Appears in (films), Starships, Vehicles |
| Planet   | Residents, Appears in (films)                                 |
| Species  | Homeworld*, Members (people), Appears in (films)              |
| Starship | Pilots, Appears in (films)                                    |
| Vehicle  | Pilots, Appears in (films)                                    |

`*` single-valued and nullable.

Note the asymmetry: a Planet can reach its residents and films, but there is no relation from a
Planet to the Species native to it, even though the underlying data records it. See
[§12.3](#123-optional-a-missing-reverse-relation).

## 7. The breadcrumb trail

Because columns replace rather than accumulate, the breadcrumb is what preserves the sense of a
journey. It sits at the top of the detail column.

- Shows the **path the user actually took** to arrive at the current entity, not a synthetic
  hierarchy: `Films › A New Hope › Luke Skywalker › Tatooine`.
- Every segment is clickable and returns to that point, truncating the trail beyond it.
- Truncates from the **middle** when long, preserving the origin and the most recent few steps,
  since those are the ends a user reasons about.
- Resets when the user starts a new line of enquiry by choosing a type in the navigation column, or
  by selecting a global search result.

The trail must stay honest. If a user navigates to an entity already present in the trail, the trail
should collapse back to that point rather than appending a duplicate and implying a longer path than
was taken.

## 8. Navigation rules

One consistent rule governs every click, and stating it once avoids per-surface special cases.

**Selecting an entity of type `T`** — from a relation panel, a global search result, or a breadcrumb
— always results in:

1. Navigation column highlights `T`.
2. Collection column shows the full list of `T`, with that entity selected and scrolled into view.
3. Detail column shows that entity.
4. Breadcrumb extends (or truncates, per [§7](#7-the-breadcrumb-trail)).

Because the collection column always shows the full list of the selected entity's type, the user can
immediately pivot sideways — having arrived at Tatooine from a film, the other 59 planets are right
there. That sideways move is as valuable as the drill-down and falls out of this rule for free.

**Selecting a type in the navigation column** shows that collection with nothing selected, clears
the collection filter, and resets the breadcrumb. The detail column returns to a prompt to choose
something ([§9.1](#91-the-empty-state)).

### 8.1 Addressability

Any state a user can reach by clicking must be reachable by URL, and the URL must update as they
navigate. Specifically: the selected type, the selected entity, and enough of the trail to
reconstruct the breadcrumb.

This is not optional polish. Without it, a user cannot share "look at this", browser back/forward do
not work, and a reload loses the user's place — all of which break the exploratory loop this UI
exists to support. Back and forward must step through the navigation history in the order it
happened.

## 9. States

Every column needs all four of these specified, not just the happy path.

### 9.1 The empty state

On first load, nothing is selected. The detail column is the largest area on screen and must not be
blank. It should orient a first-time visitor: what this dataset is, that there are six collections
to explore, and an invitation to pick one or to search. This is also a natural place to link to
GraphiQL ([§11](#11-relationship-to-graphiql)).

### 9.2 Loading

Relation counts and lists arrive from the API and are not instant. Loading must:

- Preserve layout, so content does not jump as it arrives. Reserve the space.
- Be **scoped to what is actually loading**. Expanding one relation panel must not blank the
  attributes above it or the list beside it.
- Stay silent for very short waits rather than flashing a spinner for 80ms.

### 9.3 Empty results

Three distinct emptinesses, three distinct messages:

- **A filter matched nothing** — say so, name the filter term, and offer to clear it. Never leave
  the user staring at an empty list wondering whether it failed.
- **A relation is genuinely empty** — a positive statement of fact: "No recorded pilots."
- **A single-valued relation is null** — "Homeworld not recorded."

### 9.4 Errors

The API returns structured errors, and requests can fail. An error must be:

- **Scoped** — a failed relation panel shows an error in that panel, not a whole-screen failure.
  Everything already on screen remains usable.
- **Recoverable** — offer a retry for anything transient.
- **Honest but not raw.** Never surface a stack trace or a GraphQL error path. A deployed build
  masks unexpected error detail server-side anyway, so the UI must be useful with only a generic
  message.
- **Distinct for session expiry.** An expired session is not a data error; it needs a path back to
  sign-in ([§10](#10-authentication)).

## 10. Authentication

Every path in this application sits behind Cloudflare Access — there is no anonymous surface. The UI
can assume a signed-in identity, and should:

- Show who is signed in, in the banner.
- Handle **session expiry during use** gracefully. An unauthenticated API call is answered with a
  `401` rather than a redirect, precisely so a client can react to it rather than trying to parse a
  login page as data. The UI must detect that case and prompt a re-authentication that returns the
  user to where they were, not to the empty state.
- Never treat authentication as an authorization signal for content. Every authenticated identity
  sees exactly the same data; there is no per-user filtering to reflect.

## 11. Relationship to GraphiQL

GraphiQL remains at `/graphql` and remains the demo's technical showcase. The explorer should treat
it as a sibling, not hide it:

- The empty state links to it.
- An entity's detail view may offer "view this as a query" — opening GraphiQL prefilled with the
  query that produced the current view. This is a genuinely useful teaching bridge: a user who
  explored by clicking can see the query shape their clicking corresponded to.

The root path currently redirects to `/graphql`. When this UI ships, **the root should serve the
explorer instead**, and GraphiQL stays reachable at its own path. The existing redirect is
deliberately temporary (`302`) so this change costs nothing.

## 12. Required API work

The experience above needs two API capabilities that **do not exist today**. Both are prerequisites,
not follow-ups.

### 12.1 Search arguments on collection fields

Today every collection field — `films`, `people`, `planets`, `speciesList`, `starships`, `vehicles`
— takes **no arguments** and returns everything. Both searches in [§5](#5-search) therefore have
nothing to call.

Each collection field needs an optional search argument that filters server-side,
case-insensitively, on substring matches against that type's name-like fields
([§5.3](#53-what-search-matches)).

Requirements on that work:

- **Filtering happens in SQL**, not by fetching everything and filtering in the resolver. The
  repository ports and statement builders are the right place; the existing `queries/statements.ts`
  already collects every statement in one reviewable file.
- The argument must be **validated in the domain tier**, consistent with how the per-relation
  `first` limit is handled — bounded length, and rejected rather than silently coerced.
- Search must not become an injection surface. The existing statement builders only ever interpolate
  source-controlled identifiers and bind every caller-supplied value; search terms must be bound
  parameters.
- Indexes should support the filter. Note that a leading-wildcard substring match cannot use a
  standard index, so this needs a deliberate decision rather than an assumption — and at 260
  records, correctness and simplicity outweigh index cleverness.
- Cover it with tests at the same levels as existing behaviour: statement construction as a unit
  test, and real filtering against migrated data in the Workers-runtime suite.

### 12.2 Cross-type search

Global search ([§5.1](#51-global-search)) needs results from all six types for one term. This can be
composed client-side by querying the six fields in a single GraphQL operation, which the schema
already permits — no additional API surface is strictly required, provided §12.1 exists.

An implementer should confirm this stays within the schema's **query complexity budget**: operations
are limited to a depth of 10 and a breadth of 50 fields, and an oversized query is rejected during
validation before any data is read. Six collections requesting a handful of fields each is
comfortably inside that, but a global search that also pulled relations for every result would not
be.

### 12.3 Optional: a missing reverse relation

The data records each species' homeworld, and `Species.homeworld` exposes it — but there is no
`Planet.species` to traverse it in reverse. A planet cannot show the species native to it, while it
can show its residents.

This is a genuine gap in the graph rather than a UI concern, and closing it would make Planet's
detail view symmetrical with the relation it already has. It is optional for a first release; the UI
must work without it ([§6.3](#63-relation-panels)).

## 13. Responsive behaviour

Three fixed columns assume width. Narrower viewports need a defined degradation, and it should
follow from the same navigation model rather than introducing a second one:

- **Wide** — three columns as described.
- **Medium** — navigation collapses to icons or to a toggle, leaving collection and detail.
- **Narrow** — one column at a time, showing the deepest meaningful level, with the breadcrumb doing
  double duty as the way back up. The breadcrumb is already the mechanism that preserves place,
  which makes it the natural back affordance here.

Touch targets must be adequate at every size — relation panel entries are the primary interactive
element and are list items, which are easy to make too small.

## 14. Accessibility

Not a final pass; it constrains the structure.

- **Keyboard-complete.** Every action must be reachable and operable without a pointer: moving
  between columns, moving within a list, selecting, expanding a panel, focusing search, dismissing
  results. A three-column explorer driven only by clicking is unusable for keyboard users.
- **Focus must be managed across replacement.** Because selecting an entity _replaces_ column
  contents, focus has to be deliberately placed afterwards — it cannot be left on an element that no
  longer exists. Moving focus to the new detail heading is usually right.
- **Announce what changed.** Replacing the detail column is a significant change with no page
  navigation. Assistive technology needs to be told, via a live region or an equivalent, or the
  change is silent.
- **Structure semantically.** The columns are landmarks; the lists are lists; the collapsible
  relation panels have proper expanded/collapsed state; the breadcrumb is a navigation landmark.
  Selection state in the collection list must be conveyed, not implied by colour alone.
- **Meet contrast requirements**, including for the de-emphasised sentinel and provenance values in
  [§2.1](#21-fields-are-text-including-the-numeric-looking-ones) and [§6.2](#62-attributes) —
  "de-emphasised" must not become "unreadable".
- **Respect reduced-motion preferences** for any column or panel transition.

## 15. Performance expectations

The dataset is small and the API is efficient; the UI should not squander either.

- **Fetch per view, not per row.** The API resolves relations in a bounded number of database
  statements, and the client should match that shape: one operation per view, requesting the
  attributes and relation data that view needs. Issuing a request per relation panel or per list row
  wastes the batching the API provides.
- **Request only what is displayed.** Do not fetch an entity's full relation lists to display a
  count, and do not fetch every scalar to render a list row.
- **Relation lists accept a per-parent limit** of 1–100 and reject anything outside it. Where a
  panel shows a preview rather than a full list, use that limit rather than fetching everything and
  truncating client-side.
- **Cache within a session.** The data is immutable for the lifetime of a session, so an entity once
  fetched never needs refetching. This is what makes backward navigation through the breadcrumb feel
  instant, and it is safe here in a way it would not be for mutable data.
- **Keep the first view fast.** A user should reach the empty state and a usable navigation column
  without waiting for all six collections to load.

## 16. Out of scope

Stated so an implementer does not infer them:

- **No editing.** The API is read-only and has no mutation type at all. A data editor is planned
  separately and will introduce its own authorization boundary; this specification covers reading
  only.
- **No user-specific state** — no favourites, no history beyond the session, no preferences.
- **No pagination or virtualization.** The largest collection is 82 records ([§2](#2-the-data)).
- **No graph or map visualisation.** The traversal metaphor here is columns and panels. A
  force-directed graph of 260 nodes is a different product.
- **No offline support**, beyond whatever session caching in [§15](#15-performance-expectations)
  naturally provides.

## 17. Acceptance

The build is complete when a user can, without writing a query:

1. Land on the application, understand what it is, and choose a collection.
2. Filter a collection by typing, and see the match count.
3. Open an entity and read its attributes with units and sentinels presented honestly.
4. See every relation that entity has, each with a count.
5. Click a related entity, land on it with the full collection of its type beside it, and see the
   path they took.
6. Click back through that path to any earlier point.
7. Find an entity by name from the banner without knowing its type.
8. Share the URL of anything they are looking at, and have the recipient see the same thing.
9. Do all of the above by keyboard alone, and with a screen reader.
10. Encounter an empty relation, a null relation, a failed request, and an expired session, and in
    each case understand what happened and what to do next.

## Vue Notes

Implementation issues discovered while building this specification with Vue 3, Vuetify, Pinia, and
Vue Router. These notes are intentionally short and practical: each records the symptom, the cause,
and the fix so a future UI agent does not reintroduce the same class of bug.

### Collection selection handler discarded its payload

**Root cause:** The parent used `@select="void selectCollection"`. In a Vue template this evaluates
the function reference expression but does not call the handler with the emitted collection ID. The
Vuetify list item therefore showed its selection animation, while no route changed, no collection
load started, and no GraphQL request was made.

**Fix:** Use an explicit event handler that accepts and forwards the payload:
`@select="(typeId) => void selectCollection(typeId)"`. Add a component test that emits the event and
asserts navigation changes to `/films`.

### Flex layout stretched search controls

**Root cause:** The banner search field and collection filter were flex children without an explicit
non-growing basis. Their parent layouts allowed them to stretch into the available height, making a
single-line input occupy most or all of the banner or collection column.

**Fix:** Use Vuetify compact density, vertical margins where appropriate, and `flex: 0 0 auto` on
both search controls. Give the collection's record list `flex: 1 1 auto`, `min-block-size: 0`, and
its own `overflow-y: auto` so the list—not the filter—consumes remaining space.

### Breadcrumb hydration created a reactive update loop

**Root cause:** Restoring a deep link creates breadcrumb steps with placeholder labels. Once an
entity loaded, `labelStep()` always replaced the trail array, even when the label was already
correct. A watcher observing that same trail then loaded the cached entity and replaced the array
again through resolved promises. This starved interaction without producing a browser or Worker
error, leaving the detail progress line visible and the rest of the interface unresponsive.

**Fix:** Make label hydration idempotent. Locate the matching step and return without replacing the
array when it is missing or already has the requested label. Replace the array only when a real
placeholder-to-label change occurs. Add tests for both the no-op case and the single placeholder
replacement case.

### Selected collection row did not scroll into view

**Root cause:** Navigation updated the selected entity and correctly applied its highlight, but the
collection list is an independent scrolling surface. Nothing connected selection changes or newly
rendered rows to `scrollIntoView`, so a relation target such as Tholothian could remain off-screen
while appearing selected.

**Fix:** Put the collection rows inside an explicit native scrolling wrapper, mark each row with its
stable entity ID, and watch both the selected ID and rendered row IDs. After `nextTick()`, locate
the row and call `scrollIntoView({ block: 'nearest', inline: 'nearest' })`. This preserves the
current position when the row is already visible and moves only enough to reveal an off-screen
selection. Keep focus in the detail heading; scrolling is visual context and should not steal
keyboard focus. Add tests for initial selection and selection changes after the list is already
loaded.
