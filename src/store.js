// §4 — Unified data model. Six tables, in-memory for the 24-hour build.
// Every table is written only by the agents listed in §9 and is read fresh by
// every screen — no screen holds a private copy, which is what keeps the
// dashboard, inventory, and audit log from drifting out of sync.
//
// The one deliberate addition to §4 is DUPLICATE_FLAGS: the duplicate-report
// banner needs structured flag state (components, open/merged/dismissed) that
// a flat AUDIT_LOG row cannot carry. Every flag change also posts an AUDIT_LOG
// row, so the audit trail stays complete (see README — documented deviation).

export const CATEGORIES = ['water', 'medical', 'food', 'shelter', 'rescue'];
export const TIER_ORDER = { critical: 0, high: 1, moderate: 2, low: 3 };
export const ALLOCATION_STATUSES = ['proposed', 'confirmed', 'partial', 'fulfilled', 'diverted'];
export const CLAIM_STATUSES = ['pending', 'expired', 'converted'];

export const store = {
  AGENCIES: [],
  RESOURCE_ITEMS: [],
  ZONES: [],
  ALLOCATIONS: [],
  CLAIMS: [],
  AUDIT_LOG: [],
  DUPLICATE_FLAGS: [],
  SEVERITY_HISTORY: [],  // track severity changes for trend analysis
  _seq: {},
};

export function nextId(prefix) {
  store._seq[prefix] = (store._seq[prefix] || 0) + 1;
  return `${prefix}${String(store._seq[prefix]).padStart(3, '0')}`;
}

export function resetStore() {
  for (const key of Object.keys(store)) {
    if (key === '_seq') store._seq = {};
    else store[key].length = 0;
  }
}

export function getZone(zoneId) {
  return store.ZONES.find((z) => z.zone_id === zoneId) || null;
}

export function getAgency(agencyId) {
  return store.AGENCIES.find((a) => a.agency_id === agencyId) || null;
}

export function getResource(resourceId) {
  return store.RESOURCE_ITEMS.find((r) => r.resource_id === resourceId) || null;
}

export function zoneName(zoneId) {
  return getZone(zoneId)?.name || zoneId;
}

// Undelivered allocations: committed but not yet delivered, and not re-targeted.
// Inventory only decrements at delivery confirmation (§6.9), so a diversion is a
// pure re-target of undelivered stock — no rollback logic anywhere (§4 v2 rule).
export function isUndelivered(allocation) {
  return allocation.status === 'confirmed';
}

export function availableQuantity(category) {
  return store.RESOURCE_ITEMS
    .filter((r) => r.category === category && r.status === 'available')
    .reduce((sum, r) => sum + r.quantity_available, 0);
}

export function recordSeveritySnapshot(zone) {
  store.SEVERITY_HISTORY.push({
    zone_id: zone.zone_id,
    severity_score: zone.severity_score,
    tier: zone.tier,
    timestamp: new Date().toISOString(),
  });
  // Keep only last 100 entries to prevent memory growth
  if (store.SEVERITY_HISTORY.length > 100) store.SEVERITY_HISTORY.shift();
}

// §12 setup — "seed exactly 4 zones at mixed tiers", medical deliberately scarce
// (one batch of 12 kits) to power the partial-allocation and diversion demos.
// Zones are seeded as raw reports, then the real pipeline (needs assessment +
// severity scoring) fills gaps/score/tier — no fake precomputed values.
export function seedDemoData() {
  resetStore();

  store.AGENCIES.push(
    { agency_id: 'AG1', name: 'Relief Corps', type: 'ngo' },
    { agency_id: 'AG2', name: 'City Fire Department', type: 'government' },
    { agency_id: 'AG3', name: 'MedAir International', type: 'ngo' },
  );

  store.RESOURCE_ITEMS.push(
    // §12: "Inventory fully stocked except medical supplies are scarce"
    { resource_id: 'RES1', agency_id: 'AG3', category: 'medical', unit: 'kit', quantity_available: 12, status: 'available' },
    { resource_id: 'RES2', agency_id: 'AG2', category: 'water', unit: 'L', quantity_available: 60000, status: 'available' },
    { resource_id: 'RES3', agency_id: 'AG1', category: 'food', unit: 'kit', quantity_available: 400, status: 'available' },
    { resource_id: 'RES4', agency_id: 'AG3', category: 'shelter', unit: 'family-kit', quantity_available: 80, status: 'available' },
    { resource_id: 'RES5', agency_id: 'AG2', category: 'rescue', unit: 'team', quantity_available: 2, status: 'available' },
  );

  const zones = [
    // §12: Zone 1 high/medical — holds the scarce medical stock
    { zone_id: 'Z1', name: 'Ward 3', location: 'Ward 3, North District', population_affected: 1200, needs: ['medical', 'food'], rescue_needed: false, urgency_high: false },
    // §12: Zone 2 moderate/water
    { zone_id: 'Z2', name: 'Ward 7', location: 'Ward 7, East District', population_affected: 800, needs: ['water'], rescue_needed: false, urgency_high: false },
    // §12: Zone 3 low/food
    { zone_id: 'Z3', name: 'Ward 11', location: 'Ward 11, South District', population_affected: 300, needs: ['food'], rescue_needed: false, urgency_high: false },
    // §12: Zone 4 critical/shelter (rescue flag fires the hard override)
    { zone_id: 'Z4', name: 'Ward 14', location: 'Ward 14, Riverside', population_affected: 900, needs: ['shelter'], rescue_needed: true, urgency_high: true },
  ];
  const now = new Date().toISOString();
  for (const z of zones) {
    store.ZONES.push({ ...z, gaps: {}, benchmarked_needs: {}, severity_score: 0, tier: 'low', override_applied: false, created_at: now, updated_at: now });
  }

  // §12: the scarce medical batch is already committed (confirmed, NOT yet
  // delivered) to Ward 3 — this is the stock the re-allocation demo diverts.
  store.ALLOCATIONS.push({
    allocation_id: 'ALC001', resource_id: 'RES1', zone_id: 'Z1', category: 'medical',
    quantity: 12, status: 'confirmed', claimed_quantity: 12, shortfall: 0,
    reallocated_from: null, reallocated_to: null,
    reason_text: '12 medical kits sent to Ward 3 — highest unmet severity among zones needing medical supplies (criterion: severity_score)',
    timestamp: now,
  });

  return { zones: store.ZONES.length, resource_items: store.RESOURCE_ITEMS.length, allocations: store.ALLOCATIONS.length };
}
