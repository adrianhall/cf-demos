# Open Roadworks Platform — Project Specification

Status: Draft for technical and customer review  
Scope: Public live and historical roadworks dashboard, with future contractor and authority collaboration  
Currency: USD; pricing is indicative and must be revalidated before launch

## 1. Purpose and outcomes

Build an accessible, approachable platform for discovering current and historical roadworks. Preserve source events indefinitely, subject to licensing, privacy and legal requirements, while keeping the live serving database compact.

Primary audiences:

- Public: locate works, understand disruption and inspect historical activity.
- Contractors: view current works and their history.
- Local authorities: understand works and coordination context across their area.

The [Street Manager API](https://department-for-transport-streetmanager.github.io/street-manager-docs/api-documentation/) is the initial source, using V7 API and both notifications and polling for catch up events. Complete UK coverage is a product goal, not an established property of this feed. Validate England, Scotland, Wales, Northern Ireland and activity-type coverage; integrate additional sources where necessary.

Success means timely live data, traceable history, visible coverage and freshness, recoverable processing, accessible map/list views and predictable operating costs.

Focus is on replicating a live-events application such as [Causeway one.network](https://one.network/), demonstrating data ingest and processing best practice alongside Basin capabilities. "Public capabilities" remain gated behind a Cloudflare Access login — anyone may sign in — to deter abuse and fraud.

## 2. Scope and phases

### MVP

- Street Manager SNS ingestion and scheduled reconciliation.
- Initial snapshot/backfill strategy with an explicit historical coverage boundary.
- EPSG:27700 geometry conversion to WGS84 for web-map display.
- Append-only event archive, current-state projection and map read model.
- Public map and equivalent accessible list; filters by area, date, authority, promoter and status.
- Record detail with event timeline and source attribution.
- Historical search and cached analytical summaries.
- Monitoring, dead-letter handling, replay and safe closed-record eviction.

### Later phases

- Additional regional data sources and cross-source identity resolution.
- Authenticated contractor/authority workspaces, annotations and coordination workflows.
- Public exports, alerts and documented external APIs, subject to reuse terms.

### Out of scope for MVP

- Writing changes back to Street Manager.
- Replacing statutory permit submission or approval workflows.
- Publishing private contractor/authority data.
- Survey-grade positioning guarantees or an unconditional claim of complete UK coverage.

## 3. Architecture

```mermaid
flowchart TD
    SNS[Street Manager SNS topics] --> WEB[HTTPS ingestion Worker]
    CRON[Scheduled trigger: default 60 minutes] --> POLL[Reconciliation poller]
    API[Street Manager polling API] --> POLL
    WEB --> Q[Cloudflare Queue]
    POLL --> Q
    Q --> PROC[Processing Worker]
    PROC --> GEO[Geometry validation and reprojection]
    GEO --> TX[Database transaction: event ledger and projection]
    TX --> LIVE[Live serving database: projection and map read model]
    TX --> PIPE[Basin Pipelines stream]
    PIPE --> ICE[Iceberg history in R2 / Basin Catalog]
    ICE --> SQL[Basin SQL]
    SQL --> SUM[Historical summaries and cache]
    LIVE --> APP[Application API Worker]
    SUM --> APP
    APP --> UI[Public map, list and history dashboard]
    PROC --> DLQ[Dead-letter queue]
    EVICT[Hourly eviction coordinator] --> LIVE
    EVICT --> ICE
    LIVESWEEP[Scheduled liveness sweep] --> LIVE
```

Workers, Queues, R2 and Basin services are billed independently of the Pro/Business website plan. Database selection is provisional: D1 may suit a bounded MVP; geographic query requirements, concurrency and limits must be benchmarked. PostgreSQL/PostGIS is an alternative with a separate hosting budget, potentially on PlanetScale or Supabase.

Basin Catalog manages Iceberg metadata. Iceberg is a table format, not a transformation engine. Basin SQL provides historical analytics; it is not the default request path for every public map interaction. Logpush is for operational logs, not the authoritative business archive.

## 4. Source integration

### 4.1 Registration and security

Register an HTTPS endpoint with Street Manager and subscribe to the required permit, activity and Section 58 topics. Handle SNS subscription confirmation and notifications separately.

Requirements:

- Verify the SNS signature and allowlisted environment-specific topic ARN before accepting content or confirming subscriptions.
- Validate certificate and confirmation URLs against expected AWS HTTPS hosts and paths; prevent SSRF and unsafe redirects.
- Handle the SNS envelope and the JSON encoded within its Message field. Do not rely solely on an application/json content type.
- Apply payload-size limits and schema checks; tolerate unknown fields and preserve the original payload.
- Acknowledge notifications only after successful durable queue insertion. Return a retryable failure when enqueueing fails.
- Keep upstream credentials in managed secrets; never expose them to browsers or logs.

Exact SNS delivery/retry behaviour and subscription settings must be verified during onboarding. Do not treat notification delivery as guaranteed.

### 4.2 Polling and reconciliation

Default polling interval: 60 minutes, configurable subject to upstream restrictions. This implies up to roughly one polling interval of recovery delay for a missed notification, plus processing time.

Persist a checkpoint per source stream/filter. Poll from the last successful checkpoint using an overlap window, enumerate all pages and advance the checkpoint only after the complete range is durably enqueued. Serialize overlapping poll runs or use a lease. Honour upstream rate limits and retry with bounded exponential backoff and jitter.

Before implementation, verify polling availability for Open Data credentials, request fields, pagination, time-window inclusivity, ordering, maximum lookback, rate limits and payload completeness. The V7 documentation references /works/updates, but its exact contract was not verified during initial design.

V7 is labelled under development and V6 stable in the reviewed documentation; select a supported version with the provider.

### 4.3 Bootstrap and backfill

Establish the subscription and durable capture before importing a baseline. Reconcile baseline records against events using verified source ordering. Evaluate archived notifications and other approved exports for historical import; confirm date ranges, completeness and licences.

Display historical coverage start dates and source gaps. An archive of captured notifications does not prove every upstream state transition was captured; polling may recover only the latest snapshot depending on its contract.

## 5. Event processing and delivery semantics

Cloudflare Queues uses at-least-once delivery. Duplicates can also arise from webhook/polling overlap. No end-to-end exactly-once claim is made.

```mermaid
sequenceDiagram
    participant S as Street Manager
    participant W as Ingest Worker
    participant Q as Queue
    participant P as Processor
    participant D as Database
    participant B as Basin Pipelines stream
    S->>W: Signed SNS notification
    W->>W: Validate envelope and source
    W->>Q: Enqueue event
    Q-->>W: Durable acceptance
    W-->>S: HTTP success
    Q->>P: Deliver message, possibly repeated
    P->>P: Validate, normalize and transform geometry
    P->>D: Transaction: ledger + conditional projection
    D-->>P: Commit
    P->>B: Publish event with stable event key
    B-->>P: Durable stream acceptance
    P-->>Q: Acknowledge
    Note over P,B: A crash or timeout after commit may cause duplicate submissions on redelivery
```

Event identity:

- Prefer a verified upstream event identity namespaced by source and environment.
- SNS MessageId may identify delivery but must not be assumed to match polling identity.
- Use a documented deterministic fallback only when needed; preserve identity provenance.

Record identity:

- Use source + environment + object type + object reference.
- Model work and permit references separately; one work may have multiple permits.

Ordering:

- Do not use arrival order as record order.
- Verify whether event_reference or another field provides ordering; do not assume version means record revision.
- Use a confirmed source ordering rule, with explicit handling of equal timestamps and conflicts.
- Archive legitimate older events even when they do not update the live projection.
- Accept full-record replacement only where payload completeness is confirmed; otherwise merge or fetch an authoritative snapshot using an approved API.

The event ledger and projection update must commit atomically in the selected database. The processor commits, publishes to the Basin stream, then acknowledges the Queue, so a failed publish leaves the message eligible for retry without blocking live state.

Every redelivery republishes the same event key, even when the ledger already records the event, because a prior attempt may have failed before, during or after submission. Historical queries and materializations must therefore deduplicate by event key.

Retain the ledger payload and verification metadata until archival is verified; bound retention only then, or the supposedly small live database grows indefinitely. Validate records before submission and monitor stream schema-drop errors. Drain persistent failures through Queue retries and a dead-letter workflow, replaying before Queue retention expires.

## 6. Coordinate conversion

Source CRS: EPSG:27700, OSGB36 / British National Grid, easting/northing in metres. Display CRS: WGS84 geographic coordinates associated with EPSG:4326, longitude/latitude in degrees.

Use Proj4js in the processing Worker as the initial implementation candidate. Native CRS transformation is not documented in the reviewed Basin SQL and Pipelines function references; do not depend on ST_Transform support without explicit verification.

```mermaid
flowchart LR
    RAW[Original WKT or geometry: EPSG 27700] --> PARSE[Parse geometry without changing structure]
    PARSE --> VERT[Transform every vertex]
    GRID[Versioned OSTN15 grid] --> VERT
    VERT --> CHECK[Validate finite values and coverage]
    CHECK --> GOOD[WGS84 geometry and bounding box]
    CHECK --> BAD[Conversion error retained for retry]
    RAW --> KEEP[Retain original geometry]
```

Implementation requirements:

- Register EPSG:27700 explicitly; the EPSG name alone does not load definitions or grid data.
- Evaluate OSTN15 first for contractor/authority use. A Helmert approximation is an explicit, validated alternative, not a silent fallback.
- OSTN15 maps OSGB36 to ETRS89; document the ETRS89/WGS84 assumption and positional tolerance. Do not promise survey-grade WGS84 accuracy.
- Pin proj4 and, for GeoTIFF grids, geotiff versions. Verify library/grid compatibility in Workers.
- Load a controlled, checksummed grid from a bundled asset or R2. Share initialization through a promise per isolate; reload safely after isolate restarts.
- Avoid per-event external grid downloads and optional-grid configurations that silently degrade accuracy.
- Parse WKT/GeoJSON separately. Transform every vertex of supported point, line, polygon, multipart and collection geometries; preserve ring closure and topology. Consider densification where required by accuracy tests.
- Output GeoJSON using longitude-first order. Do not relabel projected coordinates as WGS84, invent altitude, or assume horizontal transformation converts vertical datums.
- Preserve source date/time null semantics independently of geometry conversion.
- Record original geometry, original CRS, derived geometry, bounding box, method, library/grid version and conversion status.
- Test independent control points across the coverage area, axis order, malformed/empty geometry, out-of-grid coordinates, ring closure and large vertex counts. Round-trip tests alone do not prove absolute accuracy.

Malformed geometry must not discard an otherwise valid source event. Archive it with an error flag and retryable conversion status; suppress misleading map display.

## 7. Data model

### Immutable logical event history

| Field | Purpose |
| --- | --- |
| event_key | Stable application deduplication identity |
| source / environment | Dataset provenance |
| source_event_reference | Original upstream event identifier |
| object_type / object_reference | Record identity |
| work_reference / permit_reference | Parent-child linkage where supplied |
| event_type / event_time / received_at | Business time and observation time |
| ingest_channel | Webhook, polling or backfill |
| source_order_value | Verified ordering value and rule |
| raw_payload | Original business payload for replay |
| source_geometry / source_crs | Original coordinates |
| display_geometry / bounds | Derived WGS84 representation |
| transformation_metadata | Method, version, grid and status |
| normalized_fields | Status, dates, authority, promoter, USRN and other query fields |
| activity_category / impact_level | Works or restriction class and traffic-management severity |
| effective_from / effective_to | Activity window used to decide what is in force at a given instant |
| schema_version / payload_hash | Processing provenance and integrity |

Archive the complete source business payload; isolate any retained SNS envelope/security fields under an appropriate access policy. Do not store credentials or signed URLs in publicly accessible analytical fields.

### Operational tables

- current_objects: latest accepted snapshot, last source ordering marker, state, dates, geometry and query fields.
- map_features: the interactive map's read model. One row per currently displayable object, holding a simplified display geometry, a representative point, the bounding box as four indexed scalar columns, an `is_live` flag, the activity window, and the small set of fields a popup needs. Maintained in the same transaction as `current_objects`.
- tile_cache: rendered tile or clustered-response bodies keyed by tile coordinate and filter signature, with the generation marker they were built from.
- object_catalogue: compact lookup and last-seen marker retained after live eviction.
- event_ledger: deduplication/processing records with the source payload, stable event key, stream-submission observations and archive-verification metadata; retained until verified archive durability permits managed retention.
- poll_checkpoints: source/filter, completed range and execution lease.
- archive_batches: batch identity, expected event keys/versions, manifest and verification result.

Iceberg history is append-only at the business level. Use validated partitioning, initially considering event date and source/object type; avoid high-cardinality per-object partitions. Normalised query columns coexist with raw payloads. Schema evolution must preserve unknown source fields and historical readability.

## 8. Closed-record lifecycle and safe eviction

Do not treat work stop as irreversible: Street Manager includes work-stop-reverted events. Define terminal/eligible states separately for permits, works, activities and Section 58 records.

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> ArchiveEligible: Verified closure rule
    ArchiveEligible --> Active: Newer reopening or correction
    ArchiveEligible --> AwaitingVerification: Grace period elapsed
    AwaitingVerification --> ArchiveEligible: Archive failed or unverified
    AwaitingVerification --> Archived: Matching version confirmed durable
    Archived --> Evicted: Conditional live-row deletion
    Archived --> Active: Newer update before deletion
    Evicted --> Active: Newer reopening event
```

Run an hourly coordinator with a configurable closure grace period and recent-history window.

1. Select eligible record versions in bounded batches.
2. Confirm all required events and the selected final snapshot exist durably in the archive. Write an additional snapshot only if required.
3. Persist a batch manifest with keys, versions, hashes/counts and archive verification metadata.
4. Delete only rows whose version still matches and whose state remains eligible.
5. Delete the object's `map_features` row in the same step, so an evicted object cannot linger on the map.
6. Retain the compact catalogue/ordering marker and historic lookup path.

No distributed transaction spans the database, Pipelines and Iceberg. Use a retry-safe state machine. Stream acceptance alone is not proof that an Iceberg table commit has completed. Establish a supported commit/visibility verification method before enabling eviction; if verification is unavailable, retain records and alert.

## 9. Application and historical querying

Public capabilities:

- Current and planned works map plus equivalent keyboard/screen-reader accessible list.
- Geographic/date/status filters, record detail and deduplicated event timeline.
- Visible source attribution, last successful synchronization, stale-data warnings and coverage boundaries.
- Shareable URLs without exposing upstream identifiers that are confidential.

Serving strategy:

- Serve live map requests from `map_features`, never from the event ledger or Iceberg.
- Bound geographic extent, result size and pagination; use tiles or clustered results when necessary.
- Use Basin SQL for historical research and producing summaries; cache/materialize repeatable dashboard queries.
- Precompute historical facets and bounding boxes where appropriate. Bounding-box filtering is not a substitute for exact spatial predicates.
- Choose a spatial-capable serving engine if the product requires exact intersection, containment or distance queries beyond the selected database's capabilities.
- Rate-limit public endpoints and historical scans. Keep catalog, R2 and database credentials server-side.

### The map read model

The ledger and projection answer "what happened to this record". A map asks a different question: "which objects are in force, inside this viewport, at this zoom". Serving that from `current_objects` means scanning and filtering geometry per request, so the map has its own read model.

```mermaid
flowchart LR
    TX[Ledger and projection commit] --> MF[map_features upsert]
    MF --> GEN[Generation marker increments]
    REQ[Map request: viewport, zoom, filters] --> TC{tile_cache hit for this generation?}
    TC -->|Yes| OUT[Tile or clustered response]
    TC -->|No| BUILD[Query map_features by bbox and filters]
    BUILD --> OUT
    BUILD --> TC
```

Requirements:

- **Liveness is computed, not inferred from status alone.** An object is live when its state is non-terminal and the request instant falls inside its activity window. Store `effective_from`/`effective_to` and recompute `is_live` both on event application and on a scheduled sweep, because an activity becomes live or lapses with the passage of time, with no upstream event to trigger it. Planned future works must remain distinguishable from works in force today.
- **Index the bounding box as four scalar columns** (`min_lon`, `min_lat`, `max_lon`, `max_lat`), not as a serialized blob. A viewport query is then an indexable range scan. In D1 this is the only way to avoid a full-table scan, and D1 bills rows scanned rather than rows returned.
- **Store a representative point per object** so low zooms can cluster and count without parsing full geometry.
- **Store simplified geometry per zoom band.** Full-fidelity line and polygon geometry is wasted at low zoom and expensive to transfer. Precompute a small number of simplified variants at write time; keep the exact geometry for record detail and download. Never simplify the archived original.
- **Serve zoom levels below the detail threshold as clusters or counts**, not as individual features, to bound response size over a dense urban area.
- **Carry a generation marker** that increments on every `map_features` write, and key `tile_cache` entries by it so a cached tile cannot outlive the data it was built from.
- **Treat an unconvertible geometry as absent from the map, not as a point at (0, 0).** Objects whose conversion failed are listed in the accessible list view with a stated reason, so a geometry failure degrades to a known gap rather than a false location.
- **Keep the list view equivalent.** The same `map_features` query backs both, so the keyboard and screen-reader path cannot drift from the map.
- Rebuild `map_features` from `current_objects` at any time; it is a derived cache and must never be the only copy of anything.

Target WCAG 2.2 AA, responsive mobile layouts, clear language and no map-only navigation. Authenticated collaboration, when added, requires separate tenant-scoped private data, roles, audit trails and publication controls.

## 10. Reliability, operations and security

Monitor:

- Notification acceptance/rejection, signature failures and enqueue failures.
- Poll completion, checkpoint age, upstream throttling and missed ranges.
- Queue backlog age, retry age, duplicate rate and dead-letter depth.
- Conversion failures, grid initialization time, CPU per vertex and vertex distributions.
- Projection lag, stale-event rejection and ordering conflicts.
- Map request latency by zoom, tile-cache hit rate, rows scanned per viewport query, response size at the densest tile, liveness-sweep age and count of live objects lacking usable geometry.
- Unverified-ledger age, archive visibility delay, stream schema-drop errors, verification failures and blocked eviction.
- Live database size/read-write usage, stored archive growth, SQL scanned bytes and cost.

Provisional targets, to validate rather than promise:

- Normal webhook-to-live latency: p95 under 60 seconds.
- Missed-notification recovery: within polling interval plus processing delay, while upstream history remains available.
- Zero intentional purge before verified archival success.
- Load tests support at least twice measured peak ingestion and forecast dashboard concurrency.

Use managed secrets, least-privilege bindings, private R2 access, HTTPS, appropriate retention policies and separate dev/test/production resources. Avoid recording full payloads in routine logs. Configure budget alerts and request/CPU/query bounds; alerts are not hard spending caps.

Test a crash at each boundary of the section 5 sequence, plus archive verification and deletion. Rebuild a fresh projection from deduplicated archived events during restore drills. Define incident, replay and dead-letter review runbooks, including recovery before Queue retention expires. R2 persistence alone is not a complete accidental-deletion recovery strategy; define backups and recovery objectives before launch.

## 11. Retention, licensing and privacy

Intended business retention is indefinite. Validate source terms, attribution, commercial redistribution, caching, historical retention and additional-source licences. Confirm the grid asset's redistribution terms.

Review source free text and identifiers for personal or restricted data. Source corrections, deletion obligations and privacy requests may require removal/redaction even from the historical archive. Define authorized deletion workflows across raw objects, Iceberg data, snapshots, summaries and caches, with audit receipts that do not retain prohibited content.

Expire obsolete Iceberg metadata snapshots and superseded compacted files without deleting the retained business-event rows. Distinguish technical snapshot retention from indefinite historical event retention.

## 12. Cost model

Pro/Business website pricing and application usage are separate. Published rates from design research:

| Component | Included / base | Overage |
| --- | --- | --- |
| Pro website plan | $25 monthly, or $20/month equivalent annually | Add-ons separate |
| Business website plan | $250 monthly, or $200/month equivalent annually | Add-ons separate |
| Workers Paid | $5/month; 10M requests, 30M CPU-ms | $0.30/M requests; $0.02/M CPU-ms |
| Queues | 1M operations/month | $0.40/M operations; normally 3 per message under 64 KB |
| D1 | 25B rows read, 50M rows written, 5 GB | $0.001/M reads; $1/M writes; $0.75/GB-month |
| R2 Standard | 10 GB-month; 1M Class A, 10M Class B operations | $0.015/GB-month; $4.50/M Class A; $0.36/M Class B |
| Basin Pipelines | 50 GB transforms and 50 GB sink delivery/month | $0.04/GB transformed; $0.06/GB Iceberg output |
| Basin SQL | 10 GB scanned/month | $0.0025/GB; minimum 10 MB/query |
| Basin Catalog | 1M operations; 10 GB and 1M objects compacted/month | $9/M operations; $0.005/GB and $2/M objects compacted |

Pipeline output billing uses uncompressed data; SQL scans use compressed bytes. Included allowances may be shared with other account workloads. R2 billing rounding applies. Multiple archive copies, retained snapshots and repeated compaction increase costs.

Illustrative monthly scenario, not measured feed volume:

- 1M distinct 5 KB events; 2M queued deliveries including overlap.
- 3M public API calls; total Worker requests and CPU remain within included allowances.
- D1 remains within allowances including ledger, indexes, verification metadata and deletion.
- 60 GB average archive storage; 1 TB SQL scans; 100 GB compaction.
- Pipeline output, R2 operations, catalog operations and compaction object counts remain within their allowances.

Application subtotal is approximately $10.68/month: Workers $5, Queues $2, R2 $0.75, SQL $2.48 and compaction $0.45. With monthly-billed Pro: approximately $35.68; with Business: approximately $260.68. Direct stream delivery removes outbox writes and publisher execution at negligible saving here, because D1 allowances already cover the workload. OSTN15 CPU/memory/loading, archive verification, tile serving and operational overhead must be measured before relying on the assumed included allowances.

Excluded: tax, development, support, map tiles/geocoding, additional feeds, initial backfill, external database hosting, backups and additional observability. Indefinite storage grows: approximately $15/month per retained TB at R2 Standard rates before operations. Measure at least a week of events and representative dashboard queries before issuing a budget.

## 13. Delivery plan

1. Validate data access/version, licences, coverage, payloads and source ordering. Capture a representative volume sample.
2. Prototype SNS verification, durable queueing and checkpointed polling.
3. Benchmark Proj4js/OSTN15 with reference coordinates and real geometry sizes.
4. Select the live database by benchmarking viewport queries over a dense urban extent at realistic object counts, alongside transaction throughput.
5. Implement commit-first ledger/projection processing, direct Basin stream delivery and duplicate-safe queries.
6. Prove archival verification, crash recovery, replay and conditional eviction.
7. Build the map read model, tile/cluster serving and the equivalent accessible list, then the historic views with cached summaries.
8. Validate cost, security and restore runbooks; launch with explicit coverage limitations.
9. Add regional feeds and authenticated collaboration after MVP evidence.

## 14. Acceptance criteria

- Valid SNS messages enqueue durably before acknowledgement; invalid signatures/topics and unsafe URLs are rejected.
- Repeated and out-of-order deliveries cannot regress current state or create duplicate logical historical events.
- Polling covers every page, survives interruptions and never skips a range through premature checkpoint advancement.
- Verified reference points satisfy the agreed positional tolerance; full geometry structure is preserved and originals remain available.
- Archived events can rebuild a clean current projection with the same accepted states.
- A crash or newer update during archival cannot cause premature deletion; reopened objects return to the live view.
- Historical search resolves evicted objects and visibly states historical coverage and known gaps.
- The map shows exactly the objects in force at the request instant for the requested viewport: a lapsed activity disappears without an upstream event, a planned future work is distinguishable from a current one, and an evicted or reopened object leaves or returns within one coordinator cycle.
- A dense urban viewport meets the agreed latency and response-size budget at every zoom level, and an object whose geometry failed conversion appears in the list view with a stated reason rather than at a false location.
- Public map/list workflows meet the agreed accessibility checks; no private credentials or tenant data are exposed.
- Measured load, lag and cost meet approved targets. Dead-letter, backup and recovery drills are completed.

## 15. Decisions required before implementation

| Decision | Required evidence |
| --- | --- |
| Source/API version and access | Supported version, Open Data polling authorization and exact contract |
| Coverage claim | Regional and activity coverage, additional-source plan |
| Record ordering and identity | Verified event identity, ordering and payload completeness |
| Historical starting point | Baseline/backfill availability, dates and terms |
| Positional tolerance | Public versus operational use, reference-point comparison |
| Database selection | Geographic queries, concurrency, limits and atomic ledger/projection support |
| Map serving shape | Measured viewport latency, rows scanned and response size at the densest tile; whether bounding-box columns suffice or exact spatial predicates require PostGIS |
| Liveness definition | Per-object-type rule for "in force now", sweep frequency and planned-versus-current presentation |
| Archive verification | Supported commit/visibility check and maximum retention during failures |
| Closure/eviction policy | Per-object rules, grace period and recent-history window |
| Retention and correction | Legal terms, privacy assessment and authorized deletion process |
| Budget and service targets | Measured events, geometry sizes, public traffic and scanned bytes |

## 16. References

Source documents and product capabilities are mutable; revalidate at implementation and launch.

- Street Manager V7: <https://department-for-transport-streetmanager.github.io/street-manager-docs/api-documentation/V7/V7.0/>
- Street Manager Open Data: <https://department-for-transport-streetmanager.github.io/street-manager-docs/open-data/>
- Proj4js: <https://proj4js.org/>
- EPSG:27700 definition and operations: <https://epsg.io/27700>
- Basin Catalog: <https://developers.cloudflare.com/basin-catalog/>
- Basin Pipelines: <https://developers.cloudflare.com/basin-pipelines/>
- Basin SQL functions: <https://developers.cloudflare.com/basin-sql/sql-reference/scalar-functions/>
- Queues delivery guarantees: <https://developers.cloudflare.com/queues/reference/delivery-guarantees/>
- Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Queues pricing: <https://developers.cloudflare.com/queues/platform/pricing/>
- D1 pricing: <https://developers.cloudflare.com/d1/platform/pricing/>
- R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Basin Pipelines pricing: <https://developers.cloudflare.com/basin-pipelines/platform/pricing/>
- Basin SQL pricing: <https://developers.cloudflare.com/basin-sql/platform/pricing/>
- Basin Catalog pricing: <https://developers.cloudflare.com/basin-catalog/platform/pricing/>
- Website plans: <https://www.cloudflare.com/plans/network-cdn>
