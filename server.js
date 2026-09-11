// §10 — API contract (master list). Express server over the in-memory store.
// Reads are computed fresh from the same tables every call (§6.11) so no screen
// ever holds a private copy.
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  store, seedDemoData, getZone, getAgency, getResource, availableQuantity,
  TIER_ORDER, isUndelivered, zoneName,
} from './src/store.js';
import { audit, auditTrailForZone } from './src/audit.js';
import { submitReport, mergeIntoZone, updateZone } from './src/pipeline.js';
import { resolveFlag, scoreMatch } from './src/agents/duplicateReport.js';
import { attemptClaim } from './src/agents/claims.js';
import { convertClaimToAllocation, deliverAllocation } from './src/agents/allocation.js';
import { acceptProposal, dismissProposal } from './src/agents/reallocation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

seedDemoData(); // §12 setup — reset via POST /api/seed

const actorOf = (req) => req.get('x-actor') || req.body?.actor || 'coordinator';

// ---------- reads ----------

app.get('/api/zones', (_req, res) => {
  const zones = [...store.ZONES]
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.severity_score - a.severity_score)
    .map((z) => ({
      ...z,
      claims: store.CLAIMS.filter((c) => c.zone_id === z.zone_id),
      allocations: store.ALLOCATIONS.filter((a) => a.zone_id === z.zone_id && a.status !== 'proposed'),
      unclaimed_categories: (z.gaps && Object.entries(z.gaps).filter(([, gap]) => gap > 0).map(([category]) => category))
        .filter((category) => !store.CLAIMS.some((c) => c.zone_id === z.zone_id && c.category === category && c.status === 'pending')
          && !store.ALLOCATIONS.some((a) => a.zone_id === z.zone_id && a.category === category && isUndelivered(a))),
    }));
  res.json(zones);
});

app.get('/zones/:id/score-breakdown', (req, res) => {
  const zone = getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'zone not found' });
  // Read-only: the breakdown stored by the last scoring pass (§13 — one tap
  // from the dashboard, never mutates state).
  res.json({
    zone_id: zone.zone_id,
    name: zone.name,
    gaps: zone.gaps,
    benchmarked_needs: zone.benchmarked_needs,
    severity_score: zone.severity_score,
    tier: zone.tier,
    override_applied: zone.override_applied,
    breakdown: zone.score_breakdown ?? null,
  });
});

app.get('/api/resource-items', (_req, res) => {
  res.json(store.RESOURCE_ITEMS.map((r) => ({ ...r, agency_name: getAgency(r.agency_id)?.name || r.agency_id })));
});

app.post('/api/resource-items', (req, res) => {
  const { agency_id, category, unit, quantity_available, resource_id } = req.body;
  if (resource_id) {
    const item = getResource(resource_id);
    if (!item) return res.status(404).json({ error: 'resource not found' });
    if (quantity_available != null) item.quantity_available = Math.max(0, quantity_available);
    if (item.quantity_available === 0) item.status = 'depleted';
    audit({ actor: actorOf(req), action_type: 'INVENTORY_UPDATED', resource_id, description: `Inventory updated: ${resource_id} now ${item.quantity_available} ${item.unit}` });
    return res.json(item);
  }
  const item = { resource_id: `RES${String(store.RESOURCE_ITEMS.length + 1).padStart(2, '0')}`, agency_id, category, unit: unit || 'unit', quantity_available: quantity_available ?? 0, status: quantity_available > 0 ? 'available' : 'depleted' };
  store.RESOURCE_ITEMS.push(item);
  audit({ actor: actorOf(req), action_type: 'INVENTORY_ADDED', resource_id: item.resource_id, description: `Inventory added: ${item.quantity_available} ${item.unit} of ${category} by ${getAgency(agency_id)?.name || agency_id}` });
  res.status(201).json(item);
});

app.get('/api/allocations', (_req, res) => {
  res.json(store.ALLOCATIONS.map((a) => ({
    ...a,
    from_zone: a.reallocated_from,
    to_zone: a.reallocated_to,
    zone_name: zoneName(a.zone_id),
  })));
});

app.get('/api/claims', (_req, res) => res.json(store.CLAIMS));

app.get('/api/audit-log', (req, res) => {
  let rows = [...store.AUDIT_LOG].reverse(); // newest first
  if (req.query.zone) rows = rows.filter((r) => r.zone_id === req.query.zone);
  if (req.query.actor) rows = rows.filter((r) => r.actor.includes(req.query.actor));
  res.json(rows);
});

// v2 — re-allocation: open proposals only.
app.get('/api/reallocations', (_req, res) => {
  res.json(store.ALLOCATIONS.filter((a) => a.status === 'proposed').map((a) => ({
    allocation_id: a.allocation_id,
    resource_id: a.resource_id,
    from_zone: a.reallocated_from,
    from_zone_name: zoneName(a.reallocated_from),
    to_zone: a.reallocated_to,
    to_zone_name: zoneName(a.reallocated_to),
    quantity: a.quantity,
    category: a.category,
    reason_text: a.reason_text,
    status: a.status,
  })));
});

app.post('/api/reallocations/:id/accept', (req, res) => {
  const result = acceptProposal(req.params.id, actorOf(req));
  if (!result) return res.status(404).json({ error: 'no open proposal with that id' });
  res.json({ status: 'confirmed', source_allocation: 'diverted', reallocated_to: result.proposal.reallocated_to });
});

app.post('/api/reallocations/:id/dismiss', (req, res) => {
  const proposal = dismissProposal(req.params.id, actorOf(req));
  if (!proposal) return res.status(404).json({ error: 'no open proposal with that id' });
  res.json({ status: 'dismissed' });
});

// Duplicate-report flags (dashboard banner + coordinator resolve).
app.get('/api/duplicate-flags', (_req, res) => {
  res.json(store.DUPLICATE_FLAGS.filter((f) => f.status === 'open').map((f) => ({
    ...f,
    matched_zone_name: zoneName(f.matched_zone_id),
    match_detail: scoreMatch(f.incoming, getZone(f.matched_zone_id)),
  })));
});

app.post('/api/duplicate-flags/:id/resolve', (req, res) => {
  const action = req.body?.action;
  if (!['merge', 'dismiss'].includes(action)) return res.status(400).json({ error: "action must be 'merge' or 'dismiss'" });
  const flag = resolveFlag(req.params.id, action);
  if (!flag) return res.status(404).json({ error: 'no open flag with that id' });
  if (action === 'merge') {
    const result = mergeIntoZone(flag.matched_zone_id, flag.incoming, actorOf(req));
    return res.json({ status: 'merged', zone_id: result.zone.zone_id, tier: result.zone.tier, severity_score: result.zone.severity_score });
  }
  res.json({ status: 'dismissed' });
});

// ---------- actions ----------

app.post('/api/reports', (req, res) => {
  const { name, location, population_affected, needs, rescue_needed, urgency_high } = req.body;
  if (!name || !location) return res.status(400).json({ error: 'name and location are required' });
  const result = submitReport({ name, location, population_affected, needs, rescue_needed, urgency_high }, actorOf(req));
  res.status(result.status === 'duplicate' ? 409 : 201).json({
    status: result.status,
    zone_id: result.zone_id,
    message: result.message || `Zone ${result.zone?.name} recorded at tier ${result.zone?.tier} (score ${result.zone?.severity_score})`,
    flag: result.flag ? { flag_id: result.flag.flag_id, score: result.flag.score } : null,
    proposal: result.proposal ? { allocation_id: result.proposal.allocation_id, reason_text: result.proposal.reason_text } : null,
  });
});

app.post('/zones/:id/claim', (req, res) => {
  const { category, agency_id, quantity } = req.body;
  const zone = getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'zone not found' });
  if (!category || !agency_id) return res.status(400).json({ error: 'category and agency_id are required' });
  const result = attemptClaim({ zone_id: zone.zone_id, category, agency_id, quantity });
  res.status(result.accepted ? 201 : 409).json(result);
});

// §6.8–6.9: delivery confirmation converts a pending claim into an allocation.
app.post('/zones/:id/deliver', (req, res) => {
  const { category, agency_id, quantity } = req.body;
  const claim = store.CLAIMS.find(
    (c) => c.zone_id === req.params.id && c.category === category && c.agency_id === agency_id && c.status === 'pending'
  );
  if (!claim) return res.status(404).json({ error: 'no pending claim for that zone/category/agency' });
  if (quantity != null) claim.quantity = quantity;
  const allocation = convertClaimToAllocation(claim, actorOf(req));
  res.json({ allocation, inventory: availableQuantity(category) });
});

// Delivery of an already-committed allocation (e.g. an accepted diversion).
app.post('/api/allocations/:id/deliver', (req, res) => {
  const allocation = deliverAllocation(req.params.id, req.body?.quantity, actorOf(req));
  if (!allocation) return res.status(404).json({ error: 'no confirmed allocation with that id' });
  res.json({ allocation, inventory: availableQuantity(allocation.category) });
});

app.post('/zones/:id/update', (req, res) => {
  const result = updateZone(req.params.id, req.body, actorOf(req));
  if (!result) return res.status(404).json({ error: 'zone not found' });
  res.json({ zone_id: result.zone.zone_id, tier: result.zone.tier, severity_score: result.zone.severity_score, proposal: result.proposal ? { allocation_id: result.proposal.allocation_id, reason_text: result.proposal.reason_text } : null });
});

// Dashboard status strip (§8): one read, fresh from the tables.
app.get('/api/dashboard', (_req, res) => {
  const critical = store.ZONES.filter((z) => z.tier === 'critical');
  res.json({
    active_zones: store.ZONES.length,
    critical_zones: critical.length,
    resources_allocated: store.ALLOCATIONS.filter((a) => a.status !== 'proposed').reduce((s, a) => s + a.quantity, 0),
    pending_reports: store.DUPLICATE_FLAGS.filter((f) => f.status === 'open').length,
    open_proposals: store.ALLOCATIONS.filter((a) => a.status === 'proposed').length,
    critical_zone_categories: critical.map((z) => ({ zone_id: z.zone_id, name: z.name, unclaimed_categories: (z.gaps && Object.entries(z.gaps).filter(([, g]) => g > 0).map(([c]) => c)) })),
    inventory_totals: Object.fromEntries(['water', 'medical', 'food', 'shelter', 'rescue'].map((c) => [c, availableQuantity(c)])),
    audit_excerpt: [...store.AUDIT_LOG].slice(-8).reverse(),
  });
});

// Demo reset (§12 setup) — reseeds the exact 4-zone scenario.
app.post('/api/seed', (_req, res) => res.json(seedDemoData()));

// ---------- static client (§8 screen map) ----------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Only_Error relief coordinator on http://localhost:${PORT}`));
}

export default app;
