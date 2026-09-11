// §9 — Duplicate-REPORT detector. Deliberately distinct from duplicate-EFFORT
// detection (§2): this one matches incoming reports against open zones with a
// weighted score and flags for HUMAN review — the agent flags, a coordinator
// merges or dismisses, nothing auto-merges (audit-log report refinement).
import { store, nextId } from '../store.js';
import { audit } from '../audit.js';

export const MATCH_SCORE_THRESHOLD = 3; // flags at >= 3 (audit-log report contract)
export const TIME_WINDOW_MINUTES = 60;  // reports >1h apart are separate events

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Plain weighted similarity, not semantic/NLP — deliberate 24h scope decision (§14).
export function similarity(a, b) {
  const s = normalize(a);
  const t = normalize(b);
  if (!s || !t) return 0;
  const dist = levenshtein(s, t);
  return 1 - dist / Math.max(s.length, t.length);
}

function levenshtein(s, t) {
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
  }
  return dp[s.length][t.length];
}

export function scoreMatch(incoming, zone) {
  const components = { location: 0, name: 0, category: 0, recency: 0 };
  // Location: exact normalized match weighs 2; a merely-similar location
  // (≥0.85 — templated "Ward X, <dir> District" strings look alike) weighs
  // only 1, so look-alike districts never flag on structure alone.
  const locSim = similarity(incoming.location, zone.location);
  if (normalize(incoming.location) === normalize(zone.location)) components.location = 2;
  else if (locSim >= 0.85) components.location = 1;
  if (similarity(incoming.name, zone.name) >= 0.9) components.name = 1; // 0.9: "Ward 9" ≠ "Ward 3"
  if ((incoming.needs || []).some((c) => (zone.needs || []).includes(c))) components.category = 1;
  const ageMin = (Date.now() - new Date(zone.updated_at).getTime()) / 60000;
  if (ageMin <= TIME_WINDOW_MINUTES) components.recency = 1;
  return { score: components.location + components.name + components.category + components.recency, components };
}

// Returns a stored open flag when the best-matching zone crosses the threshold,
// otherwise null (pass-through — the pipeline proceeds). Runs on EVERY report
// submission (§9).
export function findDuplicateReport(incoming) {
  let best = null;
  for (const zone of store.ZONES) {
    const match = scoreMatch(incoming, zone);
    if (!best || match.score > best.match.score) best = { zone, match };
  }
  if (!best || best.match.score < MATCH_SCORE_THRESHOLD) return null;
  const flag = {
    flag_id: nextId('FLG'),
    incoming,
    matched_zone_id: best.zone.zone_id,
    score: best.match.score,
    components: best.match.components,
    status: 'open', // coordinator merges or dismisses — never auto-merged
    created_at: new Date().toISOString(),
  };
  store.DUPLICATE_FLAGS.push(flag);
  audit({
    actor: 'system:duplicate-report-detector',
    action_type: 'DUPLICATE_FLAGGED',
    zone_id: best.zone.zone_id,
    description: `Possible duplicate report "${incoming.name}" vs ${best.zone.name} — match score ${best.match.score} >= ${MATCH_SCORE_THRESHOLD}; awaiting coordinator merge/dismiss`,
  });
  return flag;
}

// Coordinator decision: merge folds the incoming report into the existing zone
// (max population, union of needs, rescue flag OR-ed) and re-runs the pipeline;
// dismiss treats the report as genuinely new. Both post their own AUDIT_LOG row.
export function resolveFlag(flagId, action) {
  const flag = store.DUPLICATE_FLAGS.find((f) => f.flag_id === flagId && f.status === 'open');
  if (!flag) return null;
  flag.status = action === 'merge' ? 'merged' : 'dismissed';
  audit({
    actor: 'system:duplicate-report-detector',
    action_type: 'DUPLICATE_RESOLVED',
    zone_id: flag.matched_zone_id,
    description: `Duplicate flag ${flag.flag_id} ${flag.status} by coordinator — "${flag.incoming.name}" ${flag.status === 'merged' ? `merged into ${flag.matched_zone_id}` : 'treated as a new zone'}`,
  });
  return flag;
}
