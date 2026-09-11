// §4 AUDIT_LOG / §6.10 — every agent appends exactly one row per state change.
// The no-op re-allocation case also logs (§5), so the check is provably always on.
import { store, nextId } from './store.js';

export function audit({ actor, action_type, zone_id = null, resource_id = null, allocation_id = null, description }) {
  for (const [field, value] of Object.entries({ actor, action_type, description })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`Audit ${field} must be a non-empty string`);
    }
  }
  const row = {
    log_id: nextId('LOG'),
    timestamp: new Date().toISOString(),
    actor,
    action_type,
    zone_id,
    resource_id,
    allocation_id,
    description,
  };
  store.AUDIT_LOG.push(row);
  return row;
}

export function auditTrailForZone(zoneId) {
  return store.AUDIT_LOG.filter((row) => row.zone_id === zoneId);
}
