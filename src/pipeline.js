// §6 — End-to-end pipeline. One orchestrator; every step appends its own
// AUDIT_LOG row (§6.10) and the re-allocation check runs after EVERY severity
// pass (§5). Pure functions over the in-memory store — no HTTP concerns here.
import { store, getZone, zoneName } from './store.js';
import { audit } from './audit.js';
import { findDuplicateReport } from './agents/duplicateReport.js';
import { assessNeeds } from './agents/needsAssessment.js';
import { scoreZone } from './agents/severityScoring.js';
import { runReallocationCheck } from './agents/reallocation.js';
import { recordSeveritySnapshot } from './store.js';

// Steps 2–6 of the pipeline. Shared by report-submission, duplicate-merge, and
// zone-update entry points so all three stay in lockstep.
export function runAssessmentPipeline(zone, actor) {
  // Steps 3–4: needs assessment, then severity scoring — two separate agents (§13).
  assessNeeds(zone);
  audit({ actor, action_type: 'NEEDS_ASSESSED', zone_id: zone.zone_id, description: `Resource gaps: ${JSON.stringify(zone.gaps)}` });
  const scoring = scoreZone(zone);
  recordSeveritySnapshot(zone);
  audit({
    actor,
    action_type: 'SCORED',
    zone_id: zone.zone_id,
    description: `${zone.name} scored ${scoring.severity_score} → tier ${scoring.tier}${scoring.override_applied ? ' (hard override: rescue_needed)' : ''}`,
  });

  // Step 5 (v2): re-allocation check on every severity pass — proposal or no-op.
  const proposal = runReallocationCheck(zone, actor);

  // Step 6: critical zones surface their unclaimed categories at the top of the
  // dashboard. Computed on read by the API; nothing to write here.
  return { zone, scoring, proposal };
}

// Steps 1–5: a new zone report (duplicate check first, §6.2).
export function submitReport(report, actor = 'field-reporter') {
  const flag = findDuplicateReport(report);
  if (flag) {
    return { status: 'duplicate', flag, zone_id: flag.matched_zone_id, message: `Possible duplicate of ${zoneName(flag.matched_zone_id)} — coordinator review required` };
  }
  return createZone(report, actor);
}

export function createZone(report, actor = 'field-reporter') {
  const now = new Date().toISOString();
  const zone = {
    zone_id: `Z${String(store.ZONES.length + 1).padStart(2, '0')}`,
    name: report.name,
    location: report.location,
    population_affected: report.population_affected ?? 0,
    needs: report.needs ?? [],
    rescue_needed: !!report.rescue_needed,
    urgency_high: !!report.urgency_high,
    gaps: {}, benchmarked_needs: {}, severity_score: 0, tier: 'low',
    override_applied: false, created_at: now, updated_at: now,
  };
  store.ZONES.push(zone);
  audit({ actor, action_type: 'DUPLICATE_CHECK_PASSED', zone_id: zone.zone_id, description: 'New report accepted after duplicate check or coordinator review' });
  audit({ actor, action_type: 'REPORT_CREATED', zone_id: zone.zone_id, description: `New zone report: ${zone.name} (${zone.location}) — population ${zone.population_affected}, needs [${zone.needs.join(', ')}]${zone.rescue_needed ? ', RESCUE NEEDED' : ''}` });
  const result = runAssessmentPipeline(zone, actor);
  return { status: 'new', flag: null, zone_id: zone.zone_id, ...result };
}

// Step 2 → merge path: fold an incoming report into the existing zone and re-run
// the pipeline (§6 duplicate-resolution; max population, union of needs, OR rescue).
export function mergeIntoZone(zoneId, incoming, actor = 'coordinator') {
  const zone = getZone(zoneId);
  if (!zone) return null;
  zone.population_affected = Math.max(zone.population_affected, incoming.population_affected ?? 0);
  zone.needs = [...new Set([...(zone.needs || []), ...(incoming.needs || [])])];
  zone.rescue_needed = zone.rescue_needed || !!incoming.rescue_needed;
  zone.urgency_high = zone.urgency_high || !!incoming.urgency_high;
  audit({ actor, action_type: 'ZONE_MERGED', zone_id: zoneId, description: `Duplicate report "${incoming.name}" merged into ${zone.name}` });
  return runAssessmentPipeline(zone, actor);
}

// Update path (demo trigger #2): an existing zone's situation changes → same
// pipeline, so severity and ranks move live and the re-allocation check re-runs.
export function updateZone(zoneId, patch, actor = 'field-reporter') {
  const zone = getZone(zoneId);
  if (!zone) return null;
  if (patch.population_affected != null) zone.population_affected = patch.population_affected;
  if (patch.needs) zone.needs = patch.needs;
  if (patch.rescue_needed != null) zone.rescue_needed = patch.rescue_needed;
  if (patch.urgency_high != null) zone.urgency_high = patch.urgency_high;
  audit({ actor, action_type: 'ZONE_UPDATED', zone_id: zoneId, description: `Zone ${zone.name} updated — population ${zone.population_affected}, needs [${zone.needs.join(', ')}]` });
  return runAssessmentPipeline(zone, actor);
}
