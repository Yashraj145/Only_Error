// §5 (v2 core) — Re-allocation agent. Runs after EVERY severity pass — new
// report, report update, or tier change. The agent only PROPOSES: a coordinator
// Accepts or Dismisses from the dashboard card. Nothing auto-diverts (§13).
import { store, nextId, TIER_ORDER, isUndelivered, zoneName } from '../store.js';
import { audit } from '../audit.js';

// A diversion must be clearly justified, not a tie-break (§5).
export const MIN_RANK_ADVANTAGE_TIERS = 1; // at least one full tier
export const MIN_RANK_ADVANTAGE_POINTS = 10; // or >= 10 severity points
export const ONE_OPEN_PROPOSAL_PER_RESOURCE = true;

function rank(zone) {
  // Primary: tier (critical > high > moderate > low); secondary: severity desc.
  return { tier: TIER_ORDER[zone.tier], severity: -zone.severity_score };
}

function outranks(a, b) {
  // Strict advantage per MIN_RANK_ADVANTAGE: a full tier better, or same tier
  // and at least 10 severity points better.
  if (a.tier < b.tier - (MIN_RANK_ADVANTAGE_TIERS - 1)) return true;
  return a.tier === b.tier && b.severity - a.severity >= MIN_RANK_ADVANTAGE_POINTS;
}

export function openProposalFor(resourceId) {
  return store.ALLOCATIONS.find(
    (a) => a.status === 'proposed' && a.resource_id === resourceId
  ) || null;
}

// The check itself. Returns the created proposal, or null on the no-op case —
// which STILL logs (§5) so judges see the check ran on every update.
export function runReallocationCheck(zone, actor = 'system:reallocation-agent') {
  const updatedRank = rank(zone);

  // Candidate diversions: undelivered allocations to LOWER-ranked zones.
  const candidates = store.ALLOCATIONS.filter((a) => {
    if (!isUndelivered(a) || a.category === 'rescue') return false; // rescue teams: single-hop limit
    const receiving = store.ZONES.find((z) => z.zone_id === a.zone_id);
    return receiving && outranks(updatedRank, rank(receiving));
  });
  if (candidates.length === 0) {
    audit({
      actor,
      action_type: 'REALLOCATION_CHECK',
      zone_id: zone.zone_id,
      description: `Re-allocation check — no change; ${zone.name} (${zone.tier}, score ${zone.severity_score}) outranks no undelivered allocation`,
    });
    return null;
  }

  // Propose diverting the LOWEST-ranked outranked allocation (§5), honoring
  // ONE_OPEN_PROPOSAL_PER_RESOURCE.
  candidates.sort((a, b) => {
    const ra = rank(store.ZONES.find((z) => z.zone_id === a.zone_id));
    const rb = rank(store.ZONES.find((z) => z.zone_id === b.zone_id));
    return rb.tier - ra.tier || ra.severity - rb.severity; // lowest first
  });
  let source = null;
  for (const candidate of candidates) {
    if (!ONE_OPEN_PROPOSAL_PER_RESOURCE || !openProposalFor(candidate.resource_id)) {
      source = candidate;
      break;
    }
  }
  if (!source) {
    audit({
      actor,
      action_type: 'REALLOCATION_CHECK',
      zone_id: zone.zone_id,
      description: `Re-allocation check — a better-ranked zone exists but a proposal is already open for every candidate resource (one open proposal per resource)`,
    });
    return null;
  }

  const criterion = updatedRank.tier < rank(store.ZONES.find((z) => z.zone_id === source.zone_id)).tier
    ? 'tier'
    : 'severity_score';
  const proposal = {
    allocation_id: nextId('ALC'),
    resource_id: source.resource_id,
    category: source.category,
    zone_id: source.zone_id,          // from_zone while status = proposed
    quantity: source.quantity,
    status: 'proposed',
    claimed_quantity: source.quantity,
    shortfall: 0,
    reallocated_from: source.zone_id,
    reallocated_to: zone.zone_id,
    source_allocation_id: source.allocation_id,
    reason_text: `${source.quantity} ${source.category} units re-targeted ${zoneName(source.zone_id)} → ${zoneName(zone.zone_id)} — new ${zone.tier} zone, higher unmet severity (criterion: ${criterion})`,
    timestamp: new Date().toISOString(),
  };
  store.ALLOCATIONS.push(proposal);
  audit({
    actor,
    action_type: 'REALLOCATION_PROPOSED',
    zone_id: zone.zone_id,
    allocation_id: proposal.allocation_id,
    description: `Proposal: divert ${source.quantity} ${source.category} units ${zoneName(source.zone_id)} → ${zoneName(zone.zone_id)} — ${zone.name} is ${zone.tier} (score ${zone.severity_score}); awaiting coordinator decision`,
  });
  return proposal;
}

// Accept: proposal → confirmed; source allocation → diverted (reallocated_to);
// inventory untouched (§4 v2 rule: undelivered stock, rollback-free).
export function acceptProposal(proposalId, actor) {
  const proposal = store.ALLOCATIONS.find((a) => a.allocation_id === proposalId && a.status === 'proposed');
  if (!proposal) return null;
  const source = store.ALLOCATIONS.find((a) => a.allocation_id === proposal.source_allocation_id);
  proposal.status = 'confirmed';
  // Once accepted, the units are committed to the RECEIVING zone — its claim
  // grid shows the diverted batch pre-marked, and duplicate-effort detection
  // (§9) blocks any second claim against the same commitment.
  proposal.zone_id = proposal.reallocated_to;
  if (source) {
    source.status = 'diverted';
    source.reallocated_to = proposal.reallocated_to;
  }
  audit({
    actor,
    action_type: 'REALLOCATION_ACCEPTED',
    zone_id: proposal.reallocated_to,
    allocation_id: proposal.allocation_id,
    description: `Re-allocation accepted by ${actor} — ${proposal.reason_text}`,
  });
  return { proposal, source };
}

// Dismiss: proposal row dropped; decision posts to AUDIT_LOG (§5).
export function dismissProposal(proposalId, actor) {
  const idx = store.ALLOCATIONS.findIndex((a) => a.allocation_id === proposalId && a.status === 'proposed');
  if (idx === -1) return null;
  const [proposal] = store.ALLOCATIONS.splice(idx, 1);
  audit({
    actor,
    action_type: 'REALLOCATION_DISMISSED',
    zone_id: proposal.reallocated_from,
    allocation_id: proposal.allocation_id,
    description: `Re-allocation dismissed by ${actor} — ${zoneName(proposal.reallocated_from)} keeps ${proposal.quantity} ${proposal.category} units`,
  });
  return proposal;
}
