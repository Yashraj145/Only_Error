import test from 'node:test';
import assert from 'node:assert/strict';
import { store, seedDemoData } from '../src/store.js';
import { audit } from '../src/audit.js';
import { startSimulation, stopSimulation } from '../src/simulation.js';

test('invalid audit calls cannot append incomplete history', () => {
  seedDemoData();
  const count = store.AUDIT_LOG.length;
  assert.throws(() => audit('simulation_event', 'simulation-engine', 'event'), /Audit actor/);
  assert.equal(store.AUDIT_LOG.length, count);
});

test('simulation records action, actor, zone and associated agent history', async () => {
  seedDemoData();
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Simulation did not emit an event')), 2000);
      startSimulation('flood_escalation', 1, event => {
        if (event.type === 'simulation_event') { clearTimeout(timeout); resolve(); }
      });
    });
    const row = store.AUDIT_LOG.find(r => r.action_type === 'SIMULATION_EVENT');
    assert.ok(row);
    assert.equal(row.actor, 'simulation-engine');
    assert.ok(row.zone_id);
    assert.match(row.description, /Riverside Colony/);
    for (const action of ['REPORT_CREATED', 'NEEDS_ASSESSED', 'SCORED', 'REALLOCATION_CHECK']) {
      assert.ok(store.AUDIT_LOG.some(r => r.zone_id === row.zone_id && r.action_type === action), action);
    }
    assert.ok(store.AUDIT_LOG.every(r => r.actor && r.action_type && r.description));
  } finally { stopSimulation(); }
});
