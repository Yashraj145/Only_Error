import test from 'node:test';
import assert from 'node:assert/strict';
import { store, seedDemoData, getZone, TIER_ORDER } from '../src/store.js';
import { runReallocationCheck, acceptProposal } from '../src/agents/reallocation.js';
import { attemptClaim } from '../src/agents/claims.js';
import { convertClaimToAllocation, deliverAllocation, rankZones, OPTIMIZATION_RULE } from '../src/agents/allocation.js';
import { submitReport, updateZone, mergeIntoZone } from '../src/pipeline.js';

test('re-allocation: new critical zone outranks the undelivered Ward 3 allocation (demo step 2)', () => {
  seedDemoData();
  const r = submitReport({ name: 'Ward 9', location: 'Ward 9, West District', population_affected: 1000, needs: ['medical'], rescue_needed: true });
  assert.equal(r.status, 'new');
  assert.equal(r.zone.tier, 'critical');
  assert.ok(r.proposal, 'a diversion proposal must be created');
  assert.equal(r.proposal.reallocated_from, 'Z1'); // Ward 3 (high) is outranked
  assert.equal(r.proposal.reallocated_to, r.zone_id);
  assert.equal(r.proposal.quantity, 12);
  assert.match(r.proposal.reason_text, /criterion:/); // §13: which criterion won
});

test('re-allocation: accept diverts source allocation (§5)', () => {
  seedDemoData();
  const r = submitReport({ name: 'Ward 9', location: 'Ward 9, West District', population_affected: 1000, needs: ['medical'], rescue_needed: true });
  const accepted = acceptProposal(r.proposal.allocation_id, 'coordinator:AG1');
  assert.equal(accepted.proposal.status, 'confirmed');
  assert.equal(accepted.source.status, 'diverted');
  assert.equal(accepted.source.reallocated_to, r.zone_id);
  // inventory untouched on diversion — rollback-free (§4 v2 rule)
  assert.equal(store.RESOURCE_ITEMS.find((x) => x.resource_id === 'RES1').quantity_available, 12);
});

test('re-allocation check: no-op case still logs (§5, demo step 4)', () => {
  seedDemoData();
  const logBefore = store.AUDIT_LOG.length;
  updateZone('Z2', { population_affected: 900 }); // still moderate — no rank change
  const check = store.AUDIT_LOG.slice(logBefore).find((l) => l.action_type === 'REALLOCATION_CHECK');
  assert.ok(check, 'no-op re-allocation check must post an AUDIT_LOG row');
  assert.match(check.description, /no change/);
});

test('one rule two uses: rankZones orders tier → severity → gap ratio', () => {
  seedDemoData();
  const ranked = rankZones(store.ZONES, 'food');
  const tiers = ranked.map((z) => TIER_ORDER[z.tier]);
  assert.deepEqual([...tiers].sort((a, b) => a - b), tiers); // tier-monotonic
  assert.match(OPTIMIZATION_RULE, /greedy fill with partials/);
});

test('allocation under scarcity: partial + shortfall logged honestly (demo step 6)', () => {
  seedDemoData();
  store.RESOURCE_ITEMS.find((r) => r.resource_id === 'RES1').quantity_available = 0;
  const claim = attemptClaim({ zone_id: 'Z4', category: 'medical', agency_id: 'AG3', quantity: 5 });
  assert.equal(claim.accepted, true);
  const allocation = convertClaimToAllocation(claim.claim, 'system:allocation-agent');
  assert.equal(allocation.status, 'partial');
  assert.ok(store.AUDIT_LOG.some((l) => l.action_type === 'ALLOCATION_SHORTFALL'));
});

test('inventory decrements only at delivery confirmation (§6.9)', () => {
  seedDemoData();
  const res2 = store.RESOURCE_ITEMS.find((r) => r.resource_id === 'RES2');
  const before = res2.quantity_available;
  const claim = attemptClaim({ zone_id: 'Z2', category: 'water', agency_id: 'AG2', quantity: 5000 });
  assert.equal(res2.quantity_available, before, 'claim alone must NOT decrement');
  convertClaimToAllocation(claim.claim, 'system:allocation-agent');
  assert.equal(res2.quantity_available, before - 5000, 'delivery confirmation decrements');
});

test('merge path: duplicate merge folds report and re-runs pipeline (§12 step 5)', () => {
  seedDemoData();
  const before = getZone('Z2').population_affected;
  const result = mergeIntoZone('Z2', { name: 'Ward 7 east side', population_affected: before * 2, needs: ['food'], rescue_needed: false });
  assert.ok(result);
  assert.equal(getZone('Z2').population_affected, before * 2); // max wins
  assert.deepEqual([...getZone('Z2').needs].sort(), ['food', 'water']); // union
});

// §13 — one zone traceable report → duplicate check → gap → severity →
// diversion → delivery → audit row, end to end. After the diversion is
// accepted, a NEW claim is rejected (duplicate-effort detection) and delivery
// happens directly on the diverted allocation (§5).
test('§13 audit trace: Ward 9 end-to-end', () => {
  seedDemoData();
  const r = submitReport({ name: 'Ward 9', location: 'Ward 9, West District', population_affected: 1000, needs: ['medical'], rescue_needed: true });
  assert.equal(r.status, 'new');
  acceptProposal(r.proposal.allocation_id, 'coordinator:AG1');
  // duplicate-effort detection: Ward 9's medical is already committed
  const secondClaim = attemptClaim({ zone_id: r.zone_id, category: 'medical', agency_id: 'AG1', quantity: 12 });
  assert.equal(secondClaim.accepted, false);
  // delivery of the diverted batch itself
  const delivery = deliverAllocation(r.proposal.allocation_id, 12, 'system:allocation-agent');
  assert.equal(delivery.status, 'fulfilled');
  assert.equal(delivery.quantity, 12);
  assert.equal(store.RESOURCE_ITEMS.find((x) => x.resource_id === 'RES1').quantity_available, 0); // §12 step 3
  const trail = store.AUDIT_LOG.filter((l) => l.zone_id === r.zone_id);
  const types = trail.map((l) => l.action_type);
  for (const expected of ['REPORT_CREATED', 'SCORED', 'REALLOCATION_PROPOSED', 'REALLOCATION_ACCEPTED', 'ALLOCATION_DELIVERED']) {
    assert.ok(types.includes(expected), `audit trail must contain ${expected}: got ${types.join(',')}`);
  }
});

test('runReallocationCheck is invoked with a zone and returns null on no-op', () => {
  seedDemoData();
  const z3 = getZone('Z3'); // low tier, outranks nobody
  assert.equal(runReallocationCheck(z3), null);
});
