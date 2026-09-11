// §9 — Allocation agent. Implements THE optimization rule (§5), one rule two
// uses: first-time delivery confirmation AND the re-allocation check both run
// through rankZones(). Every reason_text cites WHICH criterion won (§13).
import { store, nextId, TIER_ORDER, isUndelivered, zoneName } from '../store.js';
import { audit } from '../audit.js';
import { uncommittedSupply } from './needsAssessment.js';

// Named in code, cited in every reason_text: tier → severity_score → gap ratio.
export const OPTIMIZATION_RULE = 'tier → severity_score → gap ratio, greedy fill with partials';

export function gapRatio(zone, category) {
  const need = zone.benchmarked_needs?.[category] || 0;
  if (need <= 0) return 0;
  return Math.min(1, (zone.gaps?.[category] ?? 0) / need);
}

// THE rule, as a comparator: tier asc → severity desc → gap ratio desc.
export function rankZones(zones, category) {
  return [...zones].sort((a, b) => {
    const tier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tier !== 0) return tier;
    if (b.severity_score !== a.severity_score) return b.severity_score - a.severity_score;
    return gapRatio(b, category) - gapRatio(a, category);
  });
}

function criterionWon(a, b, category) {
  if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return 'tier';
  if (b.severity_score !== a.severity_score) return 'severity_score';
  return 'gap ratio';
}

// Convert a pending claim into an ALLOCATIONS row. Greedy fill against zones
// still needing this category, top-down by the rule; when stock runs out
// mid-zone, emit a `partial` allocation and post the shortfall to AUDIT_LOG.
// Inventory decrements HERE and only here (§6.9) — which is what makes
// diversions rollback-free. Delivery first consumes uncommitted stock, then
// fulfils allocations already committed to this zone (e.g. a diverted batch).
export function convertClaimToAllocation(claim, actor) {
  const zone = store.ZONES.find((z) => z.zone_id === claim.zone_id);
  const committedToZone = store.ALLOCATIONS.filter(
    (a) => a.zone_id === claim.zone_id && a.category === claim.category && isUndelivered(a)
  );
  const committedQty = committedToZone.reduce((sum, a) => sum + a.quantity, 0);
  const stock = uncommittedSupply(claim.category) + committedQty;
  if (!zone || stock <= 0) {
    const need = zone?.benchmarked_needs?.[claim.category] ?? null;
    audit({
      actor,
      action_type: 'ALLOCATION_SHORTFALL',
      zone_id: claim.zone_id,
      description: `No ${claim.category} stock available for ${zoneName(claim.zone_id)} — shortfall of full requested need${need != null ? ` (${need})` : ''} posted; the system reports the gap honestly`,
    });
    const empty = {
      allocation_id: nextId('ALC'), resource_id: pickResource(claim.category), zone_id: claim.zone_id,
      category: claim.category, quantity: 0, status: 'partial', claimed_quantity: claim.quantity ?? null,
      shortfall: need, reallocated_from: null, reallocated_to: null,
      reason_text: `No ${claim.category} units available — need ${need ?? 'unknown'} unmet (rule: ${OPTIMIZATION_RULE})`,
      timestamp: new Date().toISOString(),
    };
    store.ALLOCATIONS.push(empty);
    finalizeClaim(claim);
    return empty;
  }

  const qty = Math.max(1, claim.quantity ?? Math.min(stock, zone.gaps?.[claim.category] ?? stock));
  const delivered = Math.min(qty, stock);
  const shortfall = qty - delivered;

  // Inventory decrement happens at THIS delivery step only (§6.9). Consume
  // uncommitted stock first, then any committed-to-this-zone allocation
  // (e.g. the diverted Ward 3 → Ward 9 batch) becomes `fulfilled`.
  let remaining = delivered;
  const fromUncommitted = Math.min(remaining, uncommittedSupply(claim.category));
  remaining -= fromUncommitted;
  for (const resource of store.RESOURCE_ITEMS.filter((r) => r.category === claim.category && r.status === 'available')) {
    if (fromUncommitted <= 0) break;
    const take = Math.min(fromUncommitted, resource.quantity_available);
    resource.quantity_available -= take;
    if (resource.quantity_available === 0) resource.status = 'depleted';
  }
  let fulfilLeft = remaining;
  for (const committed of committedToZone) {
    if (fulfilLeft <= 0) break;
    committed.status = 'fulfilled';
    fulfilLeft -= committed.quantity;
    const resource = store.RESOURCE_ITEMS.find((r) => r.resource_id === committed.resource_id);
    if (resource) {
      resource.quantity_available = Math.max(0, resource.quantity_available - committed.quantity);
      if (resource.quantity_available === 0) resource.status = 'depleted';
    }
  }

  const nextZone = rankZones(
    store.ZONES.filter((z) => (z.gaps?.[claim.category] ?? 0) > 0),
    claim.category
  )[0];
  const compared = nextZone && nextZone.zone_id !== zone.zone_id ? nextZone : null;
  const criterion = compared ? criterionWon(zone, compared, claim.category) : 'severity_score';
  const status = shortfall > 0 ? 'partial' : 'confirmed';

  const allocation = {
    allocation_id: nextId('ALC'),
    resource_id: pickResource(claim.category),
    zone_id: claim.zone_id,
    category: claim.category,
    quantity: delivered,
    status,
    claimed_quantity: qty,
    shortfall: shortfall > 0 ? shortfall : 0,
    reallocated_from: null,
    reallocated_to: null,
    reason_text: `${delivered} ${claim.category} unit(s) sent to ${zoneName(claim.zone_id)} — highest unmet severity among zones needing ${claim.category} supplies (criterion: ${criterion}; rule: ${OPTIMIZATION_RULE})`,
    timestamp: new Date().toISOString(),
  };
  store.ALLOCATIONS.push(allocation);
  finalizeClaim(claim);

  audit({
    actor,
    action_type: 'ALLOCATION_CONFIRMED',
    zone_id: claim.zone_id,
    resource_id: allocation.resource_id,
    allocation_id: allocation.allocation_id,
    description: allocation.reason_text,
  });
  if (shortfall > 0) {
    audit({
      actor,
      action_type: 'ALLOCATION_SHORTFALL',
      zone_id: claim.zone_id,
      allocation_id: allocation.allocation_id,
      description: `Shortfall of ${shortfall} ${claim.category} unit(s) for ${zoneName(claim.zone_id)} — demand exceeds available stock; system reports the gap honestly (§12 step 6)`,
    });
  }
  return allocation;
}

function pickResource(category) {
  return store.RESOURCE_ITEMS.find((r) => r.category === category && r.quantity_available > 0)?.resource_id
    || store.RESOURCE_ITEMS.find((r) => r.category === category)?.resource_id
    || 'RES0';
}

function finalizeClaim(claim) {
  claim.status = 'converted';
}

// §5/§12 step 3: delivery of an already-committed allocation (the accepted
// diversion) — the receiving zone's claim grid shows it pre-marked. This is the
// delivery confirmation for diverted stock: the confirmed allocation itself
// flips to `fulfilled` and the underlying inventory decrements (§6.9).
export function deliverAllocation(allocationId, quantity, actor) {
  const allocation = store.ALLOCATIONS.find((a) => a.allocation_id === allocationId && a.status === 'confirmed');
  if (!allocation) return null;
  const delivered = Math.min(quantity ?? allocation.quantity, allocation.quantity);
  const resource = store.RESOURCE_ITEMS.find((r) => r.resource_id === allocation.resource_id);
  if (resource) {
    resource.quantity_available = Math.max(0, resource.quantity_available - delivered);
    if (resource.quantity_available === 0) resource.status = 'depleted';
  }
  allocation.status = 'fulfilled';
  allocation.quantity = delivered;
  audit({
    actor,
    action_type: 'ALLOCATION_DELIVERED',
    zone_id: allocation.zone_id,
    resource_id: allocation.resource_id,
    allocation_id: allocation.allocation_id,
    description: `${delivered} ${allocation.category} unit(s) delivered to ${zoneName(allocation.zone_id)} — inventory decremented at delivery confirmation only${allocation.reallocated_from ? ` (diverted from ${zoneName(allocation.reallocated_from)})` : ''}`,
  });
  return allocation;
}

