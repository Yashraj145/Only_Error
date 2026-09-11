/**
 * Predictive needs forecasting agent.
 * Analyzes resource burn rates and predicts depletion.
 */
import { store, CATEGORIES } from '../store.js';
import { availableQuantity } from '../store.js';

/**
 * Computes the burn rate for a given resource category.
 * @param {string} category - The resource category.
 * @param {number} [hoursWindow=24] - The time window in hours to consider.
 * @returns {Object} Burn rate details.
 */
export function computeBurnRate(category, hoursWindow = 24) {
  const now = Date.now();
  const timeLimit = now - hoursWindow * 60 * 60 * 1000;

  const relevantAllocations = store.ALLOCATIONS.filter(a => 
    a.category === category &&
    (a.status === 'confirmed' || a.status === 'fulfilled') &&
    new Date(a.timestamp).getTime() > timeLimit
  );

  const totalUnits = relevantAllocations.reduce((sum, a) => sum + (a.quantity || 0), 0);
  const rate = totalUnits / hoursWindow;

  return { category, rate, unit_per_hour: rate };
}

/**
 * Estimates when a resource category will be depleted.
 * @param {string} category - The resource category.
 * @returns {Object} Depletion estimate details.
 */
export function estimateDepletion(category) {
  const current = availableQuantity(category);
  const { rate } = computeBurnRate(category);
  
  let hours_remaining = Infinity;
  let depleted_by = null;
  let status = 'stable';

  if (rate > 0) {
    hours_remaining = current / rate;
    const depletionTime = new Date(Date.now() + hours_remaining * 60 * 60 * 1000);
    depleted_by = depletionTime.toISOString();

    if (hours_remaining < 4) {
      status = 'critical';
    } else if (hours_remaining < 12) {
      status = 'warning';
    }
  } else if (current === 0) {
    hours_remaining = 0;
    depleted_by = new Date().toISOString();
    status = 'critical';
  }

  return {
    category,
    current_stock: current,
    burn_rate: rate,
    hours_to_depletion: hours_remaining === Infinity ? null : hours_remaining,
    depleted_by,
    status
  };
}

/**
 * Generates forecasts for all resources and tracks zone severity trends.
 * @returns {Object} Comprehensive forecast report.
 */
export function generateForecasts() {
  const resource_forecasts = CATEGORIES.map(cat => estimateDepletion(cat));
  const zone_trends = getZoneTrends();
  const alerts = [];

  for (const forecast of resource_forecasts) {
    if (forecast.status === 'critical' && forecast.hours_to_depletion !== null) {
      const hours = Math.round(forecast.hours_to_depletion * 10) / 10;
      alerts.push(`⚠️ ${forecast.category.charAt(0).toUpperCase() + forecast.category.slice(1)} supplies will be depleted in ~${hours} hours at current allocation rate`);
    } else if (forecast.status === 'critical' && forecast.current_stock === 0) {
      alerts.push(`⚠️ ${forecast.category.charAt(0).toUpperCase() + forecast.category.slice(1)} supplies are currently depleted!`);
    }
  }

  return {
    resource_forecasts,
    zone_trends,
    alerts,
    generated_at: new Date().toISOString()
  };
}

/**
 * Tracks and returns trends in zone severity scores.
 * @returns {Array<Object>} List of zone trend objects.
 */
export function getZoneTrends() {
  return store.ZONES.map(zone => {
    const currentScore = zone.severity_score || 0;
    const prevScore = zone._prev_score !== undefined ? zone._prev_score : currentScore;
    
    let trend = 'stable';
    if (currentScore > prevScore) {
      trend = 'rising';
    } else if (currentScore < prevScore) {
      trend = 'falling';
    }

    // Update the previous score for the next calculation
    zone._prev_score = currentScore;

    return {
      zone_id: zone.zone_id,
      name: zone.name,
      tier: zone.tier || 'unknown',
      severity_score: currentScore,
      trend
    };
  });
}
