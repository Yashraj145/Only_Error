import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoData } from '../src/store.js';
import { submitReport } from '../src/pipeline.js';
import { generateForecasts, getZoneTrends } from '../src/agents/forecasting.js';
import { generateSitrep } from '../src/agents/sitrep.js';
import { parseNaturalReport } from '../src/agents/nlpParser.js';
import { SCENARIOS, getSimulationStatus } from '../src/simulation.js';

test('NLP parser extracts structured fields from conversational text', () => {
  const text = 'Severe flooding in Sector 5, about 200 families stranded on roofs, urgently need food, clean water, and boats for rescue!';
  const result = parseNaturalReport(text);
  
  assert.ok(result.parsed);
  assert.equal(result.parsed.location, 'Sector 5');
  assert.equal(result.parsed.population_affected, 800); // 200 families * 4
  assert.ok(result.parsed.needs.includes('food'));
  assert.ok(result.parsed.needs.includes('water'));
  assert.ok(result.parsed.needs.includes('rescue'));
  assert.equal(result.parsed.rescue_needed, true);
  assert.equal(result.parsed.urgency_high, true);
  assert.ok(result.confidence > 0.7);
});

test('NLP parser handles minimal emergency messages gracefully', () => {
  const text = 'Ward 12 earthquake casualties, send medical help!';
  const result = parseNaturalReport(text);
  
  assert.ok(result.parsed);
  assert.equal(result.parsed.name, 'Ward 12');
  assert.ok(result.parsed.needs.includes('medical'));
});

test('Forecasting agent computes depletion ETA and alerts for scarce resources', () => {
  seedDemoData();
  const forecasts = generateForecasts();
  
  assert.ok(forecasts.resource_forecasts.length >= 5);
  const medForecast = forecasts.resource_forecasts.find(r => r.category === 'medical');
  assert.ok(medForecast);
  assert.equal(medForecast.current_stock, 12);
  
  const trends = getZoneTrends();
  assert.ok(trends.length >= 4);
  assert.ok(trends.every(t => ['rising', 'stable', 'falling'].includes(t.trend)));
});

test('SITREP agent generates structured executive summary and actionable recommendations', () => {
  seedDemoData();
  submitReport({
    name: 'Ward 9',
    location: 'Ward 9, West District',
    population_affected: 1200,
    needs: ['medical', 'rescue'],
    rescue_needed: true,
    urgency_high: true,
  }, 'field-test');

  const sitrep = generateSitrep();
  
  assert.ok(sitrep.title.startsWith('SITREP —'));
  assert.ok(sitrep.summary.total_zones >= 5);
  assert.ok(sitrep.summary.critical_zones >= 1);
  assert.ok(sitrep.narrative.includes('SITREP'));
  assert.ok(Array.isArray(sitrep.recommendations));
  assert.ok(sitrep.recommendations.length > 0);
  assert.ok(sitrep.zone_status.length >= 5);
  assert.ok(sitrep.resource_status.length >= 5);
});

test('Simulation engine exposes realistic disaster scenarios and status', () => {
  assert.ok(SCENARIOS.flood_escalation);
  assert.ok(SCENARIOS.earthquake_aftershock);
  assert.ok(SCENARIOS.cyclone_landfall);
  assert.ok(SCENARIOS.flood_escalation.events.length >= 5);
  
  const status = getSimulationStatus();
  assert.equal(typeof status.running, 'boolean');
});
