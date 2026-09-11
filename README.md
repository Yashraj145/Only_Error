# Only_Error — Disaster Relief & Emergency Resource Coordinator

PS20 implementation of **master architecture v2**: nine component design reports
unified into one system, with the v2 upgrade (dynamic re-allocation loop) built in.

- **Backend:** Node.js (zero frameworks), in-memory tables, all agents as plain testable functions
- **Frontend:** vanilla-JS mobile-responsive web client (no build step)
- **Tests:** `node:test` — 15 unit + end-to-end tests

## Run

```bash
npm install
node server.js        # → http://localhost:3000
node --test           # run the test suite
```

The server auto-seeds the §12 demo scenario (4 zones at mixed tiers; medical
deliberately scarce — one batch of 12 kits pre-committed to Ward 3, undelivered).
`POST /api/seed` resets to this state at any time.

## Architecture mapping (doc → code)

| Spec section | Code |
|---|---|
| §3 layers | `server.js` (API + static client) → `src/pipeline.js` (agents) → `src/store.js` (tables) |
| §4 data model | `src/store.js` — AGENCIES, RESOURCE_ITEMS, ZONES, ALLOCATIONS, CLAIMS, AUDIT_LOG |
| §5 optimization rule | `src/agents/allocation.js` (`rankZones`: tier → severity → gap ratio; greedy fill with partials) |
| §5 re-allocation agent | `src/agents/reallocation.js` (MIN_RANK_ADVANTAGE, one open proposal per resource, no-op logging) |
| §6 pipeline | `src/pipeline.js` (`submitReport` / `updateZone` / `mergeIntoZone`) |
| §8 screen map | `public/` — Dashboard / Report / Inventory / Audit Log |
| §9 agents | `src/agents/` — duplicate-report, claims, reallocation, allocation (+ needs/severity in `src/`) |
| §10 API contract | `server.js` routes |
| §12 demo script | seeded by `seedDemoData()`; reproducible via the UI |

## API summary

```
GET  /api/zones                    GET  /zones/:id/score-breakdown
POST /api/reports                  POST /zones/:id/claim
POST /zones/:id/update             POST /zones/:id/deliver
GET/POST /api/resource-items       GET  /api/allocations
GET  /api/claims                   GET  /api/audit-log?zone=&actor=
GET  /api/reallocations            POST /api/reallocations/:id/accept | :id/dismiss
POST /api/allocations/:id/deliver  GET/POST /api/duplicate-flags(/:id/resolve)
GET  /api/dashboard                POST /api/seed
```

## Demo flow (§12)

1. Dashboard: 4 zones at mixed tiers, 12 medical kits committed to Ward 3.
2. Submit **Ward 9** report with *Rescue needed* → hard override → **critical**
   → re-allocation check → proposal card *"Divert 12 medical units Ward 3 → Ward 9?"*
3. **Accept** → Ward 3's allocation becomes `diverted`; **Confirm delivery** on
   Ward 9 → inventory decrements 12 → 0 (§6.9: decrement at delivery only).
4. Update **Ward 7** (population doubles) → score jumps live → re-allocation
   check posts its **no-op** row — the check is provably always on.
5. Duplicate-report detection: resubmit Ward 3's location → banner → merge/dismiss.
6. Ward 14 claims medical with empty stock → `partial` allocation + shortfall logged.
7. Audit Log screen traces any zone end-to-end (§13 checklist).

## Documented deviations from v2 spec

- `DUPLICATE_FLAGS`: a seventh in-memory collection carrying structured flag
  state (components, open/merged/dismissed) for the dashboard banner; every flag
  change still posts its own `AUDIT_LOG` row.
- Delivery endpoints (`/zones/:id/deliver`, `/api/allocations/:id/deliver`)
  implement §6.8–6.9 delivery confirmation; §4's `proposed → confirmed →
  fulfilled` lifecycle is canonical (accepted diversions deliver directly).
- `populationPressure` term in severity scoring (named, justified in code) makes
  "population doubles → score jumps" (§12 step 4) observable.
