# Sanjeevani — Disaster Relief & Emergency Resource Coordinator

PS20 prototype with a Node/Express server, plain-function agents, shared operational collections with local snapshot persistence, and a responsive browser client.

## Run and verify

```sh
npm install
npm start
npm test
```

The current local development server is available at [http://localhost:3300](http://localhost:3300).

To run the project on that port in PowerShell:

```powershell
$env:PORT = "3300"
npm start
```

Without a `PORT` override, the server uses [http://localhost:3000](http://localhost:3000).
For voice analysis, create a project virtual environment (Python 3.12 recommended) and install the audio dependencies:

```sh
python -m venv .venv
# Windows:
.venv/Scripts/python -m pip install -r requirements-audio.txt
# macOS/Linux:
.venv/bin/python -m pip install -r requirements-audio.txt
```

The server automatically uses `.venv`; set `SANJEEVANI_PYTHON` to override the interpreter path. The environment is local and excluded from Git. Run `npm test` after setup to verify voice ingestion.

See [DEMO.md](DEMO.md) for exact report values, expected scores and the rehearsal sequence.

## Implemented workflow

- Local snapshots preserve incidents, inventories, allocations, commitments, audit history and request deduplication across restarts. The default file is `data/workspace.json`, excluded from Git. Set `SANJEEVANI_STATE_FILE` to choose a different file. Run only one server per snapshot file. Tests normally disable persistence or use isolated files.
- Voice analysis produces a draft. Review/edit its transcript and incident fields in the existing form, then use Confirm Report to create the incident. Audio without a transcript leaves the location blank and asks for manual details.

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

37 tests cover agents, allocation conservation, the complete HTTP demo, simulation events, voice review without automatic submission, missing transcripts, restart snapshot restoration, corrupt snapshot handling, and offline retry.

## Layout

- src/store.js — seeded agencies, resources, zones, allocations, claims, audit rows and duplicate flags
- src/pipeline.js — report creation, merge/update and assessment pipeline
- src/agents/ — needs, severity, report matching, claims, allocation and re-allocation
- server.js — Express API and static client
- public/ — dashboard, report wizard, inventory, audit and offline queue
- tests/ — agent, regression, API and offline tests

## Scope and limitations

This is the architecture's responsive-web fallback, not an Expo/Flutter app. The backend loads a local JSON snapshot on startup and saves before acknowledging changes and publishing events. Atomic replacement protects against partial snapshot writes. An invalid snapshot stops startup instead of silently resetting history. This single-process storage is not a multi-user production database or a backup service. Reset Demo and Launch Simulation intentionally replace the workspace with seeded data and save that reset. Simulation timers do not resume after restart, but completed event history remains. Older running versions have no snapshot export, so their memory is not automatically migrated. Offline reports stay in browser storage and retry while the page is active; offline-first cold launch and native background sync are not implemented. Agency selection is for a demo, not authenticated authorization. Severity constants are illustrative, not operationally validated emergency-response models.

Allocation lifecycle is explicit: confirmed means committed and undelivered; fulfilled/partial means delivery was recorded. Diverted rows preserve history and are excluded from active-allocation totals. A seventh collection stores duplicate-review flags. Scoring refreshes after inventory or allocation changes so displayed needs reflect the shared state.
