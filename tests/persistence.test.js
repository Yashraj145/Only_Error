import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotStore } from '../src/persistence.js';
import { store, seedDemoData, resetStore } from '../src/store.js';
import { submitReport } from '../src/pipeline.js';

test('snapshot restores incidents, history, counters and retry responses', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sanjeevani-state-'));
  const file = path.join(directory, 'workspace.json');
  const requests = new Map();
  const persistence = snapshotStore(file, store, requests);
  try {
    assert.equal(persistence.load(), false);
    seedDemoData();
    const report = submitReport({ name: 'Saved camp', location: 'Saved camp road', population_affected: 700, needs: ['water'], rescue_needed: true }, 'coordinator');
    requests.set('retry-id', { zone_id: report.zone_id });
    persistence.save();
    const expected = JSON.stringify(store);
    resetStore(); requests.clear();
    assert.equal(persistence.load(), true);
    assert.equal(JSON.stringify(store), expected);
    assert.equal(requests.get('retry-id').zone_id, report.zone_id);
    seedDemoData(); requests.clear(); persistence.save();
    resetStore(); persistence.load();
    assert.equal(store.ZONES.length, 4);
    assert.equal(store.AUDIT_LOG.length, 0);
    assert.equal(requests.size, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('corrupt snapshot fails visibly without reseeding or overwriting it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sanjeevani-corrupt-'));
  const file = path.join(directory, 'workspace.json');
  try {
    fs.writeFileSync(file, '{broken');
    const before = JSON.stringify(store);
    assert.throws(() => snapshotStore(file, store, new Map()).load());
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.equal(JSON.stringify(store), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
