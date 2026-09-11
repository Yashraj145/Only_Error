import test from 'node:test';
import assert from 'node:assert/strict';
import { store, seedDemoData, nextId, getZone, resetStore } from '../src/store.js';
import { attemptClaim } from '../src/agents/claims.js';
import { convertClaimToAllocation, deliverAllocation, rankZones } from '../src/agents/allocation.js';
import { runReallocationCheck, acceptProposal, dismissProposal } from '../src/agents/reallocation.js';
import { submitReport, updateZone } from '../src/pipeline.js';

test('reset restores four scored tiers, clean activity and unique IDs', () => {
  for (let i = 0; i < 2; i++) {
    seedDemoData();
    assert.deepEqual(store.ZONES.map(z => z.tier), ['high', 'moderate', 'low', 'critical']);
    assert.ok(store.ZONES.every(z => Object.keys(z.gaps).length && z.score_breakdown));
    assert.equal(store.AUDIT_LOG.length, 0);
    assert.equal(store.CLAIMS.length, 0);
    assert.equal(store.DUPLICATE_FLAGS.length, 0);
    assert.equal(store.ALLOCATIONS.length, 1);
    assert.equal(nextId('ALC'), 'ALC002');
    submitReport({ name: 'Ward 9', location: 'West dock', population_affected: 1000, needs: ['medical'], rescue_needed: true });
  }
});
test('water-only urgency cannot divert medical; same-category partial diversion preserves balance', () => {
  seedDemoData();
  const target = getZone('Z2'); Object.assign(target, { tier: 'critical', severity_score: 90, gaps: { water: 100 } });
  assert.equal(runReallocationCheck(target), null);
  target.needs.push('medical'); target.gaps.medical = 5;
  const p = runReallocationCheck(target); assert.equal(p.quantity, 5);
  const stock = store.RESOURCE_ITEMS[0].quantity_available;
  acceptProposal(p.allocation_id, 'test');
  assert.equal(store.RESOURCE_ITEMS[0].quantity_available, stock);
  assert.equal(store.ALLOCATIONS.filter(a => a.status === 'confirmed').reduce((s,a) => s+a.quantity,0), 12);
});
test('source delivery makes an open proposal stale', () => {
  seedDemoData();
  const r = submitReport({ name: 'Ward 9', location: 'West dock', population_affected: 1000, needs: ['medical'], rescue_needed: true });
  deliverAllocation('ALC001', 12, 'test');
  assert.throws(() => acceptProposal(r.proposal.allocation_id, 'test'), /stale/);
  assert.ok(dismissProposal(r.proposal.allocation_id, 'test'));
});
test('actual allocation honors priority and conserves stock across multiple rows', () => {
  resetStore();
  store.AGENCIES.push({agency_id:'A',name:'Agency'});
  store.ZONES.push({zone_id:'H',name:'High',needs:['food'],population_affected:20,tier:'critical',severity_score:80,gaps:{food:60},benchmarked_needs:{food:60}}, {zone_id:'L',name:'Low',needs:['food'],population_affected:20,tier:'low',severity_score:10,gaps:{food:60},benchmarked_needs:{food:60}});
  store.RESOURCE_ITEMS.push({resource_id:'R1',agency_id:'A',category:'food',quantity_available:30,status:'available'}, {resource_id:'R2',agency_id:'A',category:'food',quantity_available:50,status:'available'});
  const low = attemptClaim({zone_id:'L',category:'food',agency_id:'A',quantity:60});
  const result = convertClaimToAllocation(low.claim,'test');
  assert.equal(result.delivered_quantity,20); assert.equal(result.total_shortfall,40);
  assert.equal(store.RESOURCE_ITEMS.reduce((s,r)=>s+r.quantity_available,0),60);
  const high = attemptClaim({zone_id:'H',category:'food',agency_id:'A',quantity:60});
  const delivered = convertClaimToAllocation(high.claim,'test');
  assert.equal(delivered.delivered_quantity,60); assert.equal(delivered.allocations.length,2);
  assert.equal(store.RESOURCE_ITEMS.reduce((s,r)=>s+r.quantity_available,0),0);
  assert.equal(store.ALLOCATIONS.reduce((s,a)=>s+a.quantity,0),80);
});
test('partial committed delivery keeps an undelivered balance and rejects repeat delivery', () => {
  seedDemoData(); const r = deliverAllocation('ALC001',5,'test');
  assert.equal(r.status,'fulfilled'); assert.equal(store.RESOURCE_ITEMS[0].quantity_available,7);
  assert.equal(store.ALLOCATIONS.find(a=>a.status==='confirmed').quantity,7);
  assert.equal(deliverAllocation('ALC001',5,'test'),null);
});
test('ranking resolves severity and gap ties and update raises Ward 7 score', () => {
  const zones = [{zone_id:'A',tier:'high',severity_score:40,gaps:{water:10},benchmarked_needs:{water:100}}, {zone_id:'B',tier:'high',severity_score:40,gaps:{water:50},benchmarked_needs:{water:100}}, {zone_id:'C',tier:'high',severity_score:45,gaps:{water:1},benchmarked_needs:{water:100}}];
  assert.deepEqual(rankZones(zones,'water').map(z=>z.zone_id),['C','B','A']);
  seedDemoData(); const before=getZone('Z2').severity_score; updateZone('Z2',{population_affected:4000});
  assert.ok(getZone('Z2').severity_score > before);
  assert.ok(store.AUDIT_LOG.some(l=>l.zone_id==='Z2' && l.action_type==='REALLOCATION_CHECK'));
});
