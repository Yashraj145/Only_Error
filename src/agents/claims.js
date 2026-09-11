// §9 — Duplicate-EFFORT / claim check. Deliberately a LOOKUP against CLAIMS and
// ALLOCATIONS — not text matching (§2). Two agencies independently committing to
// the same zone+category is blocked here, with the claiming agency named.
import { store, nextId, isUndelivered, getResource, getZone, CATEGORIES } from '../store.js';
import { audit } from '../audit.js';

export const CLAIM_TTL_MINUTES = 30; // simplified: visible countdown, not a real timer (§14)

export function existingCommitment(zoneId, category) {
  const claim = store.CLAIMS.find(
    (c) => c.zone_id === zoneId && c.category === category && c.status === 'pending'
  );
  if (claim) return { kind: 'claim', row: claim };
  const allocation = store.ALLOCATIONS.find(
    (a) => a.zone_id === zoneId && a.category === category && isUndelivered(a)
  );
  if (allocation) return { kind: 'allocation', row: allocation };
  return null;
}

// Returns { accepted, existing_claim_agency?, claim? }. Runs on EVERY claim
// action (§9). Accepted claims are `pending` until delivery converts them.
export function attemptClaim({ zone_id, category, agency_id, quantity }) {
  if (!getZone(zone_id) || !CATEGORIES.includes(category) || !store.AGENCIES.some(a => a.agency_id === agency_id)) throw Object.assign(new Error('Valid zone, category and agency required'), { status: 400 });
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) throw Object.assign(new Error('Quantity must be positive'), { status: 400 });
  const existing = existingCommitment(zone_id, category);
  const agency = store.AGENCIES.find((a) => a.agency_id === agency_id);
  if (existing) {
    const holderId = existing.row.agency_id || getResource(existing.row.resource_id)?.agency_id;
    const holder = store.AGENCIES.find((a) => a.agency_id === holderId);
    audit({
      actor: `agency:${agency_id}`,
      action_type: 'CLAIM_REJECTED',
      zone_id,
      description: `Claim rejected — ${category} for ${zone_id} already claimed by ${holder?.name || holderId} (duplicate-effort detection: claim/ledger lookup)`,
    });
    return { accepted: false, existing_claim_agency: holder?.name || holderId, claim: null };
  }
  const claim = {
    claim_id: nextId('CLM'),
    zone_id,
    category,
    agency_id,
    quantity: quantity ?? null,
    status: 'pending',
    timestamp: new Date().toISOString(),
  };
  store.CLAIMS.push(claim);
  audit({
    actor: `agency:${agency_id}`,
    action_type: 'CLAIM_RECORDED',
    zone_id,
    description: `${agency?.name || agency_id} claimed ${category} for ${zone_id}${quantity ? ` (${quantity} units)` : ''} — ledger lookup found no prior commitment`,
  });
  return { accepted: true, existing_claim_agency: null, claim };
}
