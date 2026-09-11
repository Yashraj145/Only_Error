// §9 — Needs assessment agent. Computes the raw resource GAP per category only
// (§2 decision): it never scores — priority/severity scoring is the separate
// agent that turns gaps into a score, tier, and override.
import { store, isUndelivered } from '../store.js';

// Every constant is named and justified (§13). Planning horizon: first 72h.
export const DAYS_OF_COVER = 3; // first-response planning horizon before resupply
export const BENCHMARKS = {
  water:   { perPersonPerDay: 15, unit: 'L' },         // WHO emergency minimum: survival + basic hygiene
  food:    { perPersonPerDay: 1,  unit: 'kit' },       // one ready-to-eat kit per person per day
  medical: { per100Persons: 2,    unit: 'kit' },      // one kit per ~50 affected people
  shelter: { per100Persons: 25,   unit: 'family-kit' },// one family kit (~4 people) per 4 people
  rescue:  { perIncident: 1,      unit: 'team' },      // one rescue team per rescue-flagged zone
};

export function benchmarkedNeed(category, population, rescueNeeded = false) {
  const b = BENCHMARKS[category];
  if (!b) return 0;
  if (b.perPersonPerDay) return Math.ceil(b.perPersonPerDay * population * DAYS_OF_COVER);
  if (b.per100Persons) return Math.ceil((b.per100Persons * population) / 100);
  if (rescueNeeded && b.perIncident) return b.perIncident;
  return 0;
}

// Supply model: undelivered allocations CONSUME inventory (the units are
// earmarked). Uncommitted supply = raw stock − all undelivered commitments;
// a zone's own committed stock is added back for that zone only.
export function uncommittedSupply(category) {
  const raw = store.RESOURCE_ITEMS
    .filter((r) => r.category === category && r.status === 'available')
    .reduce((sum, r) => sum + r.quantity_available, 0);
  const committed = store.ALLOCATIONS
    .filter((a) => a.category === category && isUndelivered(a))
    .reduce((sum, a) => sum + a.quantity, 0);
  return Math.max(0, raw - committed);
}

export function supplyFor(zone, category) {
  const committedToZone = store.ALLOCATIONS
    .filter((a) => a.zone_id === zone.zone_id && a.category === category && isUndelivered(a))
    .reduce((sum, a) => sum + a.quantity, 0);
  const delivered = store.ALLOCATIONS.filter(a => a.zone_id === zone.zone_id && a.category === category && ['fulfilled', 'partial'].includes(a.status)).reduce((s, a) => s + a.quantity, 0);
  return uncommittedSupply(category) + committedToZone + delivered;
}

// Returns and writes { benchmarked_needs, gaps } onto the zone. Rescue needs are
// only assessed when zone.rescue_needed is true (one team per incident).
export function assessNeeds(zone) {
  const categories = [...new Set([...(zone.needs || []), ...(zone.rescue_needed ? ['rescue'] : [])])];
  const needs = {};
  const gaps = {};
  for (const category of categories) {
    const need = benchmarkedNeed(category, zone.population_affected, zone.rescue_needed);
    const supply = supplyFor(zone, category);
    needs[category] = need;
    gaps[category] = Math.max(0, need - supply);
  }
  zone.benchmarked_needs = needs;
  zone.gaps = gaps;
  zone.updated_at = new Date().toISOString();
  return { needs, gaps };
}
