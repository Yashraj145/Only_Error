import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { default: app } = await import('../server.js');

test('HTTP demo: seed → report → diversion → delivery → update → duplicates → scarcity → audit', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => { const r = await fetch(base + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return {status:r.status, body:await r.json()}; };
  try {
    await call('/api/seed',{});
    const agencies = (await call('/api/agencies')).body;
    assert.equal(agencies.find(a => a.agency_id === 'AG2').name, 'State Disaster Response Force (SDRF)');
    assert.equal(agencies.find(a => a.agency_id === 'AG2').total_units_stocked, 60002);
    assert.equal(agencies[0].active_claims, 0);
    const zones=(await call('/api/zones')).body; assert.deepEqual(zones.map(z=>z.tier),['critical','high','moderate','low']);
    const report={name:'Ward 9',location:'Ward 9, West District',population_affected:1000,needs:['medical'],rescue_needed:true,request_id:'demo-report'};
    const created=(await call('/api/reports',report)).body;
    assert.equal(created.status,'new'); assert.ok(created.proposal);
    assert.equal((await call('/api/reports',report)).body.zone_id,created.zone_id);
    assert.equal((await call('/api/zones')).body.length,5);
    const id=created.proposal.allocation_id;
    assert.equal((await call(`/api/reallocations/${id}/accept`,{})).status,200);
    assert.equal((await call('/api/resource-items')).body.find(r=>r.category==='medical').quantity_available,12);
    const conflict=await call(`/zones/${created.zone_id}/claim`,{category:'medical',agency_id:'AG1',quantity:12});
    assert.equal(conflict.status,409); assert.equal(conflict.body.existing_claim_agency,'Indian Red Cross Society (IRCS)');
    assert.equal((await call(`/api/allocations/${id}/deliver`,{})).body.allocation.status,'fulfilled');
    assert.equal((await call('/api/resource-items')).body.find(r=>r.category==='medical').quantity_available,0);
    assert.equal((await call(`/api/allocations/${id}/deliver`,{})).status,404);
    const update=await call('/zones/Z2/update',{population_affected:4000}); assert.ok(update.body.severity_score>18);
    const dup=(await call('/api/reports',{name:'Ward 3',location:'Ward 3, North District',population_affected:1200,needs:['medical']})).body;
    assert.equal(dup.status,'duplicate');
    await call(`/api/duplicate-flags/${dup.flag.flag_id}/resolve`,{action:'merge'});
    const second=(await call('/api/reports',{name:'Ward 3',location:'Ward 3, North District',population_affected:20,needs:['medical']})).body;
    const kept=await call(`/api/duplicate-flags/${second.flag.flag_id}/resolve`,{action:'dismiss'});
    assert.equal(kept.body.status,'new'); assert.equal((await call('/api/zones')).body.length,6);
    await call('/zones/Z4/update',{needs:['shelter','medical']});
    await call('/zones/Z4/claim',{category:'medical',agency_id:'AG3',quantity:18});
    const scarcity=(await call('/zones/Z4/deliver',{category:'medical',agency_id:'AG3'})).body.allocation;
    assert.equal(scarcity.status,'partial'); assert.equal(scarcity.total_shortfall,18);
    const log=(await call(`/api/audit-log?zone=${created.zone_id}`)).body;
    for(const action of ['REPORT_CREATED','DUPLICATE_CHECK_PASSED','NEEDS_ASSESSED','SCORED','REALLOCATION_PROPOSED','REALLOCATION_ACCEPTED','ALLOCATION_DELIVERED']) assert.ok(log.some(l=>l.action_type===action),action);
    const restocked=await call('/api/resource-items',{resource_id:'RES1',quantity_available:10}); assert.equal(restocked.body.status,'available');
    assert.equal((await call('/zones/Z2/update',{population_affected:-1})).status,400);
    assert.equal((await call('/zones/Z2/claim',{category:'water',agency_id:'AG2',quantity:-1})).status,400);
    await call('/api/seed',{}); assert.equal((await call('/api/reallocations')).body.length,0);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
