import test from 'node:test';
import assert from 'node:assert/strict';
import { store, seedDemoData, getZone } from '../src/store.js';
import { assessNeeds } from '../src/agents/needsAssessment.js';
import { scoreZone, populationPressure } from '../src/agents/severityScoring.js';
import { scoreMatch, MATCH_SCORE_THRESHOLD, findDuplicateReport } from '../src/agents/duplicateReport.js';
import { acceptProposal, dismissProposal, MIN_RANK_ADVANTAGE_POINTS } from '../src/agents/reallocation.js';
import { attemptClaim } from '../src/agents/claims.js';
import { convertClaimToAllocation, rankZones } from '../src/agents/allocation.js';
import { submitReport, updateZone, mergeIntoZone } from '../src/pipeline.js';
import { TIER_ORDER } from '../src/store.js';

test('needs assessment: gaps = benchmarked need minus available supply', () => {
  seedDemoData();
  const z2 = getZone('Z2'); // Ward 7: 2000 people, water
  assessNeeds(z2);
  assert.equal(z2.benchmarked_needs.water, 15 * 2000 * 3);
  assert.equal(z2.gaps.water, 30000); // 90000 needed, 60000 stocked
});

test('needs assessment: committed undelivered stock counts as supply', () => {
  seedDemoData();
  const z1 = getZone('Z1');
  assessNeeds(z1);
  // Ward 3: 1200 people → 24 medical kits needed; 12 committed undelivered → gap 12
  assert.equal(z1.benchmarked_needs.medical, 24);
  assert.equal(z1.gaps.medical, 12);
});

test('severity scoring: hard override fires on rescue_needed', () => {
  seedDemoData();
  const z4 = getZone('Z4');
  assessNeeds(z4);
  const r = scoreZone(z4);
  assert.equal(r.override_applied, true);
  assert.equal(r.tier, 'critical');
});

test('severity scoring: population doubling raises the score (demo trigger 2)', () => {
  seedDemoData();
  const z2 = getZone('Z2');
  z2.needs = ['water'];
  z2.population_affected = 3000; // 135000 needed vs 60000 stocked → real gap
  assessNeeds(z2);
  const before = scoreZone(z2).severity_score;
  z2.population_affected = 6000; // population doubles
  assessNeeds(z2);
  const after = scoreZone(z2).severity_score;
  assert.ok(after > before, `score must rise when population doubles (${before} → ${after})`);
  assert.ok(populationPressure(6000) > populationPressure(3000));
});

test('duplicate REPORT detection: flags at score >= 3, never auto-merges', () => {
  seedDemoData();
  const nearDup = { name: 'Ward 3', location: 'Ward 3, North District', needs: ['medical'], population_affected: 1100 };
  const flag = findDuplicateReport(nearDup);
  assert.ok(flag, 'close variant must be flagged');
  assert.ok(flag.score >= MATCH_SCORE_THRESHOLD);
  assert.equal(flag.status, 'open'); // human review required
  const distinct = { name: 'Harbor Point', location: 'Harbor docks, Pier 2', needs: ['shelter'], population_affected: 50 };
  assert.equal(findDuplicateReport(distinct), null); // pass-through
});

test('duplicate REPORT vs duplicate EFFORT are two separate checks', () => {
  seedDemoData();
  // report check: weighted text/location match against zones
  const m = scoreMatch({ name: 'Ward 3', location: 'Ward 3, North District', needs: ['medical'] }, getZone('Z1'));
  assert.ok(m.score >= 3);
  // effort check: pure claim/ledger lookup, no text matching
  const first = attemptClaim({ zone_id: 'Z1', category: 'food', agency_id: 'AG1' });
  assert.equal(first.accepted, true);
  const second = attemptClaim({ zone_id: 'Z1', category: 'food', agency_id: 'AG2' });
  assert.equal(second.accepted, false);
  assert.equal(second.existing_claim_agency, 'Relief Corps'); // claiming agency shown
});
