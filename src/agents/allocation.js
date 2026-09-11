import { store, nextId, TIER_ORDER, isUndelivered, getZone, getResource, zoneName } from '../store.js';
import { audit } from '../audit.js';
import { benchmarkedNeed, assessNeeds } from './needsAssessment.js';
import { scoreZone } from './severityScoring.js';
import { runReallocationCheck } from './reallocation.js';

export const OPTIMIZATION_RULE = 'tier → severity_score → gap ratio, greedy fill with partials';
export function gapRatio(zone, category) {
  const need = zone.benchmarked_needs?.[category] || 0;
  return need ? Math.min(1, (zone.gaps?.[category] || 0) / need) : 0;
}
export function rankZones(zones, category) {
  return [...zones].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.severity_score - a.severity_score || gapRatio(b, category) - gapRatio(a, category) || a.zone_id.localeCompare(b.zone_id));
}
export function criterionWon(a, b, category) {
  if (!b) return 'only eligible zone';
  if (a.tier !== b.tier) return 'tier';
  if (a.severity_score !== b.severity_score) return 'severity_score';
  return gapRatio(a, category) !== gapRatio(b, category) ? 'gap ratio' : 'stable zone ID tie-break';
}
export function outstandingNeed(zone, category) {
  const supplied = store.ALLOCATIONS.filter(a => a.zone_id === zone.zone_id && a.category === category && ['confirmed', 'fulfilled', 'partial'].includes(a.status)).reduce((s, a) => s + a.quantity, 0);
  return Math.max(0, benchmarkedNeed(category, zone.population_affected, zone.rescue_needed) - supplied);
}
export function freeResourceQuantity(resource) {
  if (resource.status !== 'available') return 0;
  const reserved = store.ALLOCATIONS.filter(a => a.resource_id === resource.resource_id && isUndelivered(a)).reduce((s, a) => s + a.quantity, 0);
  return Math.max(0, resource.quantity_available - reserved);
}
// Reserve each higher-ranked zone's entitlement before servicing lower ranks.
export function allocationPlan(category) {
  let remaining = store.RESOURCE_ITEMS.filter(r => r.category === category).reduce((s, r) => s + freeResourceQuantity(r), 0);
  return rankZones(store.ZONES.filter(z => (z.needs.includes(category) || category === 'rescue' && z.rescue_needed) && outstandingNeed(z, category) > 0), category).map(zone => {
    const quantity = Math.min(remaining, outstandingNeed(zone, category));
    remaining -= quantity;
    return { zone, quantity };
  });
}
export function refreshAssessments(actor) {
  for (const z of store.ZONES) {
    assessNeeds(z);
    audit({ actor, action_type: 'NEEDS_ASSESSED', zone_id: z.zone_id, description: JSON.stringify(z.gaps) });
    scoreZone(z);
    audit({ actor, action_type: 'SCORED', zone_id: z.zone_id, description: z.name + ' scored ' + z.severity_score + ' → ' + z.tier });
  }
  // All scores are fresh before checking diversions.
  for (const z of store.ZONES) runReallocationCheck(z, actor);
}
export function convertClaimToAllocation(claim, actor) {
  if (!claim || claim.status !== 'pending') throw Object.assign(new Error('Pending claim required'), { status: 409 });
  const zone = getZone(claim.zone_id);
  const requested = claim.quantity ?? outstandingNeed(zone, claim.category);
  if (!Number.isFinite(requested) || requested <= 0) throw Object.assign(new Error('No outstanding quantity to deliver'), { status: 400 });
  const plan = allocationPlan(claim.category);
  const entitlement = plan.find(p => p.zone.zone_id === zone.zone_id)?.quantity || 0;
  let remaining = Math.min(requested, entitlement, outstandingNeed(zone, claim.category));
  const delivered = remaining, shortfall = requested - delivered;
  const winner = plan[0]?.zone;
  const reason = winner && winner.zone_id !== zone.zone_id
    ? winner.name + ' has priority (criterion: ' + criterionWon(winner, zone, claim.category) + ')'
    : zone.name + ' receives its ranked share (criterion: ' + criterionWon(zone, plan[1]?.zone, claim.category) + ')';
  const rows = [];
  for (const resource of store.RESOURCE_ITEMS.filter(r => r.category === claim.category)) {
    const take = Math.min(remaining, freeResourceQuantity(resource));
    if (!take) continue;
    resource.quantity_available -= take;
    if (!resource.quantity_available) resource.status = resource.category === 'rescue' ? 'deployed' : 'depleted';
    remaining -= take;
    rows.push({ resource_id: resource.resource_id, quantity: take });
    if (!remaining) break;
  }
  if (!rows.length) rows.push({ resource_id: store.RESOURCE_ITEMS.find(r => r.category === claim.category)?.resource_id || null, quantity: 0 });
  const allocations = rows.map((row, i) => {
    const allocation = { ...row, allocation_id: nextId('ALC'), zone_id: zone.zone_id, category: claim.category, agency_id: claim.agency_id,
      status: shortfall > 0 ? 'partial' : 'fulfilled', shortfall: i === 0 ? shortfall : 0, claimed_quantity: i === 0 ? requested : row.quantity,
      reallocated_from: null, reallocated_to: null, timestamp: new Date().toISOString(),
      reason_text: row.quantity + ' ' + claim.category + ' delivered to ' + zone.name + '; ' + reason + '; rule: ' + OPTIMIZATION_RULE };
    store.ALLOCATIONS.push(allocation);
    audit({ actor, action_type: 'ALLOCATION_DELIVERED', zone_id: zone.zone_id, resource_id: row.resource_id, allocation_id: allocation.allocation_id, description: allocation.reason_text });
    return allocation;
  });
  claim.status = 'converted';
  if (shortfall) audit({ actor, action_type: 'ALLOCATION_SHORTFALL', zone_id: zone.zone_id, allocation_id: allocations[0].allocation_id, description: 'Requested ' + requested + '; delivered ' + delivered + '; shortfall ' + shortfall + ' ' + claim.category + '. ' + reason });
  refreshAssessments(actor);
  return { ...allocations[0], allocations, delivered_quantity: delivered, total_shortfall: shortfall };
}
export function deliverAllocation(id, quantity, actor) {
  const allocation = store.ALLOCATIONS.find(a => a.allocation_id === id && isUndelivered(a));
  if (!allocation) return null;
  const delivered = quantity ?? allocation.quantity;
  const resource = getResource(allocation.resource_id);
  if (!Number.isFinite(delivered) || delivered <= 0 || delivered > allocation.quantity || !resource || delivered > resource.quantity_available) throw Object.assign(new Error('Delivery exceeds committed or available quantity'), { status: 400 });
  if (delivered < allocation.quantity) {
    store.ALLOCATIONS.push({ ...allocation, allocation_id: nextId('ALC'), quantity: allocation.quantity - delivered, timestamp: new Date().toISOString(), reason_text: 'Remaining undelivered balance of ' + id });
  }
  resource.quantity_available -= delivered;
  if (!resource.quantity_available) resource.status = resource.category === 'rescue' ? 'deployed' : 'depleted';
  allocation.quantity = delivered;
  allocation.status = 'fulfilled';
  audit({ actor, action_type: 'ALLOCATION_DELIVERED', zone_id: allocation.zone_id, resource_id: allocation.resource_id, allocation_id: id, description: delivered + ' ' + allocation.category + ' delivered to ' + zoneName(allocation.zone_id) + '; inventory decremented once' });
  refreshAssessments(actor);
  return allocation;
}

