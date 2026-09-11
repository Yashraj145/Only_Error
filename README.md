# Sanjeevani — Disaster Relief & Emergency Resource Coordinator

PS20 prototype with a Node/Express server, plain-function agents, shared in-memory collections and a responsive browser client.

## Run and verify

```sh
npm install
npm start
npm test
```

Open http://localhost:3000. Set PORT to choose a different port.
See [DEMO.md](DEMO.md) for exact report values, expected scores and the rehearsal sequence.

## Implemented workflow

- Four assessed demo zones at critical/high/moderate/low tiers; Reset Demo clears the server scenario and ID counters.
- Four-step reporting with review, manual location or optional browser GPS, and an offline local-storage queue.
- Weighted duplicate-report detection with human Merge or Keep as New decisions.
- Separate needs assessment and weighted severity scoring with a rescue override.
- Tier → severity → gap-ratio allocation, reserving higher-ranked shares before consuming stock for lower-ranked zones.
- Separate pending agency claims and delivery confirmation; duplicate-effort rejection names the commitment holder.
- Category-specific, human-approved diversion proposals with stale-state checks and partial-balance preservation.
- Per-resource inventory conservation, delivery history, restocking and committed-stock validation.
- Existing-zone updates, critical-needs alerts, eight-second polling, score breakdowns and expandable audit entries.
- Audit filters for zone, actor, action and resource.

## Tests

23 tests cover the original agents plus deterministic seeding, allocation priority, multiple inventory rows, partial delivery, partial diversion, stale proposals, offline retry, and the complete HTTP demo including duplicate resolution and scarcity.

## Layout

- src/store.js — seeded agencies, resources, zones, allocations, claims, audit rows and duplicate flags
- src/pipeline.js — report creation, merge/update and assessment pipeline
- src/agents/ — needs, severity, report matching, claims, allocation and re-allocation
- server.js — Express API and static client
- public/ — dashboard, report wizard, inventory, audit and offline queue
- tests/ — agent, regression, API and offline tests

## Scope and limitations

This is the architecture's responsive-web fallback, not an Expo/Flutter app. The backend is intentionally in memory. Restarting it clears reports, deliveries and request-id deduplication. Offline reports stay in browser storage and retry while the page is active; offline-first cold launch and native background sync are not implemented. Agency selection is for a demo, not authenticated authorization. Severity constants are illustrative, not operationally validated emergency-response models.

Allocation lifecycle is explicit: confirmed means committed and undelivered; fulfilled/partial means delivery was recorded. Diverted rows preserve history and are excluded from active-allocation totals. A seventh collection stores duplicate-review flags. Scoring refreshes after inventory or allocation changes so displayed needs reflect the shared state.
