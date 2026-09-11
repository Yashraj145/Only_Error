/**
 * Auto-generated situation report (SITREP) agent.
 */
import { store, CATEGORIES, zoneName } from '../store.js';
import { availableQuantity } from '../store.js';
import { generateForecasts } from './forecasting.js';

/**
 * Generates a comprehensive Situation Report.
 * @returns {Object} The structured SITREP object.
 */
export function generateSitrep() {
  const now = new Date();
  const timestamp = now.toISOString();
  
  // Format time for title (e.g. 14:30)
  const formattedTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const title = `SITREP — ${formattedTime}`;

  const forecasts = generateForecasts();
  const zones = store.ZONES;
  
  let total_zones = zones.length;
  let critical_zones = 0;
  let high_zones = 0;
  let total_population_affected = 0;
  
  const zone_status = forecasts.zone_trends.map(zt => {
    const zone = zones.find(z => z.zone_id === zt.zone_id) || {};
    
    if (zt.tier === 'critical') critical_zones++;
    else if (zt.tier === 'high') high_zones++;
    
    total_population_affected += (zone.population_affected || 0);

    // Compute top gaps from zone.gaps
    const topGaps = zone.gaps ? Object.entries(zone.gaps).filter(([, g]) => g > 0).map(([c]) => c) : [];

    return {
      ...zt,
      top_gaps: topGaps,
    };
  });

  const resources_allocated = store.ALLOCATIONS.filter(a => a.status === 'confirmed' || a.status === 'fulfilled').reduce((s, a) => s + a.quantity, 0);
  const open_proposals = store.ALLOCATIONS.filter(a => a.status === 'proposed').length;
  const pending_flags = store.DUPLICATE_FLAGS.filter(f => f.status === 'open').length;

  const resource_status = forecasts.resource_forecasts.map(rf => ({
    category: rf.category,
    available: rf.current_stock,
    burn_rate: rf.burn_rate,
    hours_to_depletion: rf.hours_to_depletion,
    status: rf.status
  }));

  const recent_actions = [...store.AUDIT_LOG].slice(-10).reverse();

  const recommendations = [];
  
  // Resource depletion recommendations
  resource_status.forEach(rs => {
    if (rs.status === 'critical' && rs.hours_to_depletion !== null && rs.hours_to_depletion < 4) {
      recommendations.push(`URGENT: Resupply ${rs.category} immediately`);
    } else if (rs.status === 'critical' && rs.available === 0) {
      recommendations.push(`URGENT: Resupply ${rs.category} immediately`);
    }
  });

  // Zone specific recommendations
  zone_status.forEach(zs => {
    if (zs.tier === 'critical' || zs.severity_score >= 80) {
      if (zs.top_gaps && zs.top_gaps.length > 0) {
        zs.top_gaps.forEach(gap => {
          recommendations.push(`Deploy ${gap} to ${zs.name} — currently unclaimed`);
        });
      }
    }
  });

  // Proposal recommendations
  store.ALLOCATIONS.filter(a => a.status === 'proposed').forEach(p => {
    if (p.category) {
      recommendations.push(`Review pending re-allocation proposal for ${p.category}`);
    }
  });

  // Rescue teams logic (basic check)
  const availableRescueTeams = availableQuantity('rescue');
  const zonesNeedingRescue = zone_status.filter(zs => zs.top_gaps && zs.top_gaps.includes('rescue')).length;
  if (zonesNeedingRescue > availableRescueTeams) {
    recommendations.push('Additional rescue teams needed');
  }

  // Generate narrative
  let narrative = `SITREP ${formattedTime} — ${total_zones} active zones, ${critical_zones} critical. `;
  
  const escalatingZones = zone_status.filter(zs => zs.trend === 'rising');
  if (escalatingZones.length > 0) {
    narrative += `${escalatingZones[0].name} escalated to critical after recent reports. `;
  }

  const depletedResources = resource_status.filter(rs => rs.available === 0 || (rs.hours_to_depletion !== null && rs.hours_to_depletion < 1));
  if (depletedResources.length > 0) {
    const deps = depletedResources.map(r => r.category).join(', ');
    narrative += `${deps.charAt(0).toUpperCase() + deps.slice(1)} inventory depleted. `;
  }

  if (recommendations.length > 0) {
    narrative += `RECOMMENDATION: ${recommendations[0]}`;
  } else {
    narrative += 'RECOMMENDATION: Continue monitoring situation.';
  }

  return {
    timestamp,
    title,
    summary: {
      total_zones,
      critical_zones,
      high_zones,
      total_population_affected,
      resources_allocated,
      open_proposals,
      pending_flags,
    },
    zone_status,
    resource_status,
    recent_actions,
    recommendations,
    narrative
  };
}
