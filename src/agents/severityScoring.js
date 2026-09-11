// §9 — Priority/severity scoring agent. The single implementation contract
// (§2): turns gaps into a weighted score, a tier, and — when rescue_needed — a
// hard override. Kept strictly separate from needs assessment, matching the two
// boxes in the architecture diagram.
import { TIER_ORDER } from '../store.js';

// Weights are absolute (sum to 1 over the four scoreable categories). Rescue is
// never weight-scored — it fires the hard override instead (§2).
export const CATEGORY_WEIGHTS = { medical: 0.30, water: 0.30, food: 0.20, shelter: 0.20 };
export const URGENCY_MULTIPLIER = 1.2;        // reporter flagged the situation urgent
export const TIER_THRESHOLDS = { critical: 60, high: 40, moderate: 15 }; // below moderate => low
export const OVERRIDDEN_MIN_SCORE = 60;       // keeps score and tier coherent when the override fires

// Same coverage deficit hurts more people when the affected population is
// larger. Neutral (1.0x) at 500 affected, linear to a 3x cap — named, not
// magic (§13). This is what makes "population doubles" move the score.
export function populationPressure(population) {
  return Math.min(3, 0.75 + population / 2000);
}

// The tier→number mapping lives in store.js (TIER_ORDER) — ranking (§5) and
// scoring share one source of truth for tier precedence.
export function tierOf(score) {
  if (score >= TIER_THRESHOLDS.critical) return 'critical';
  if (score >= TIER_THRESHOLDS.high) return 'high';
  if (score >= TIER_THRESHOLDS.moderate) return 'moderate';
  return 'low';
}

// severity_score = 100 x Σ (weight_c x gap_ratio_c) x population_pressure x urgency_mult
// where gap_ratio_c = gap_c / benchmarked_need_c (capped at 1).
export function scoreZone(zone) {
  const pressure = populationPressure(zone.population_affected);
  const urgencyMult = zone.urgency_high ? URGENCY_MULTIPLIER : 1.0;
  const perCategory = [];
  let weightedSum = 0;
  for (const [category, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    const need = zone.benchmarked_needs?.[category] || 0;
    if (need <= 0) continue; // zone did not report a need in this category
    const gap = zone.gaps?.[category] ?? 0;
    const ratio = Math.min(1, gap / need);
    weightedSum += weight * ratio;
    perCategory.push({ category, weight, need, gap, gap_ratio: Number(ratio.toFixed(3)), contribution: Number((weight * ratio * 100).toFixed(1)) });
  }
  let severity_score = Math.min(100, Math.round(weightedSum * 100 * pressure * urgencyMult));

  let override_applied = false;
  let tier;
  if (zone.rescue_needed) {
    // Hard override (§2): people trapped outranks every weighted calculation.
    override_applied = true;
    tier = 'critical';
    severity_score = Math.max(severity_score, OVERRIDDEN_MIN_SCORE);
  } else {
    tier = tierOf(severity_score);
  }

  const result = {
    severity_score,
    tier,
    override_applied,
    breakdown: {
      per_category: perCategory,
      population_pressure: Number(pressure.toFixed(2)),
      urgency_multiplier: urgencyMult,
      thresholds: TIER_THRESHOLDS,
      tier_rank: TIER_ORDER[tier],
    },
  };
  zone.severity_score = severity_score;
  zone.tier = tier;
  zone.override_applied = override_applied;
  zone.score_breakdown = result.breakdown; // served by GET /zones/:id/score-breakdown
  zone.updated_at = new Date().toISOString();
  return result;
}
