/**
 * War Room simulation engine.
 * Auto-generates escalating disaster scenarios.
 */
import { store } from './store.js';
import { submitReport, updateZone } from './pipeline.js';
import { audit } from './audit.js';

export const SCENARIOS = {
  flood_escalation: {
    name: 'Flood Escalation',
    description: 'Rising water levels across multiple districts',
    events: [
      { delay_seconds: 0, type: 'report', data: { name: 'Riverside Colony', location: 'Riverside Colony, South Bank', population_affected: 450, needs: ['water', 'food'], rescue_needed: false, urgency_high: false } },
      { delay_seconds: 10, type: 'report', data: { name: 'Market Area', location: 'Central Market, Downtown', population_affected: 300, needs: ['shelter', 'food'], rescue_needed: false, urgency_high: false } },
      { delay_seconds: 20, type: 'update', zone_index: 0, data: { population_affected: 800, needs: ['water', 'food', 'medical'], urgency_high: true } },
      { delay_seconds: 30, type: 'report', data: { name: 'Bridge Settlement', location: 'Old Bridge, West Side', population_affected: 600, needs: ['rescue', 'medical'], rescue_needed: true, urgency_high: true } },
      { delay_seconds: 45, type: 'update', zone_index: 1, data: { population_affected: 700, rescue_needed: true, needs: ['shelter', 'food', 'rescue'] } },
      { delay_seconds: 55, type: 'report', data: { name: 'School Campus', location: 'Government School, North District', population_affected: 1500, needs: ['water', 'food', 'shelter', 'medical'], rescue_needed: false, urgency_high: true } },
    ]
  },
  earthquake_aftershock: {
    name: 'Earthquake + Aftershocks',
    description: 'Initial quake followed by aftershock escalations',
    events: [
      { delay_seconds: 0, type: 'report', data: { name: 'Downtown Core', location: 'Downtown Core, Central City', population_affected: 2000, needs: ['rescue', 'medical'], rescue_needed: true, urgency_high: true } },
      { delay_seconds: 8, type: 'report', data: { name: 'Industrial Zone', location: 'Industrial Zone, East Quarter', population_affected: 500, needs: ['medical', 'water'], rescue_needed: false, urgency_high: false } },
      { delay_seconds: 18, type: 'report', data: { name: 'Residential Block A', location: 'Block A, West Residential', population_affected: 1200, needs: ['shelter', 'food', 'water'], rescue_needed: false, urgency_high: true } },
      { delay_seconds: 28, type: 'update', zone_index: 0, data: { population_affected: 3500, needs: ['rescue', 'medical', 'water', 'food'] } },
      { delay_seconds: 38, type: 'report', data: { name: 'Hospital Road', location: 'Hospital Road, Medical District', population_affected: 800, needs: ['medical', 'water'], rescue_needed: true, urgency_high: true } },
      { delay_seconds: 50, type: 'update', zone_index: 2, data: { population_affected: 2000, rescue_needed: true } },
    ]
  },
  cyclone_landfall: {
    name: 'Cyclone Landfall',
    description: 'Approaching cyclone with phased impact zones',
    events: [
      { delay_seconds: 0, type: 'report', data: { name: 'Coastal Village', location: 'Coastal Village, Shoreline District', population_affected: 600, needs: ['shelter', 'water'], rescue_needed: false, urgency_high: true } },
      { delay_seconds: 12, type: 'report', data: { name: 'Fishing Harbor', location: 'Fishing Harbor, Port Area', population_affected: 400, needs: ['rescue', 'shelter'], rescue_needed: true, urgency_high: true } },
      { delay_seconds: 22, type: 'update', zone_index: 0, data: { population_affected: 1200, rescue_needed: true, needs: ['shelter', 'water', 'rescue', 'food'] } },
      { delay_seconds: 35, type: 'report', data: { name: 'Inland Town', location: 'Inland Town, Central County', population_affected: 900, needs: ['shelter', 'food', 'water'], rescue_needed: false, urgency_high: false } },
      { delay_seconds: 45, type: 'report', data: { name: 'Power Station Area', location: 'Power Station, Industrial Belt', population_affected: 350, needs: ['medical', 'water'], rescue_needed: false, urgency_high: true } },
      { delay_seconds: 55, type: 'update', zone_index: 1, data: { population_affected: 900, needs: ['rescue', 'shelter', 'medical', 'food'] } },
    ]
  }
};

let simulationState = {
  status: 'idle',
  running: false,
  scenario: null,
  speed: 1,
  currentEventIndex: 0,
  createdZoneIds: [],
  timers: [],
  startedAt: null,
};

/**
 * Starts a simulation scenario.
 * @param {string} scenarioKey - Key of the scenario to run.
 * @param {number} [speed=1] - Playback speed multiplier.
 * @param {Function} [broadcastFn=null] - Optional callback for event broadcasting.
 */
export function startSimulation(scenarioKey, speed = 1, broadcastFn = null) {
  stopSimulation();

  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    throw new Error(`Scenario ${scenarioKey} not found`);
  }

  simulationState = {
    status: 'running',
    running: true,
    scenario: scenario,
    speed: speed,
    currentEventIndex: 0,
    createdZoneIds: [],
    timers: [],
    startedAt: new Date().toISOString(),
  };

  const totalEvents = scenario.events.length;

  scenario.events.forEach((event, index) => {
    const timerDelay = (event.delay_seconds * 1000) / speed;
    
    const timer = setTimeout(async () => {
      simulationState.currentEventIndex = index + 1;
      let zone_name = '';
      let zone_id = null;

      try {
        if (event.type === 'report') {
          const result = await submitReport(event.data, 'simulation-engine');
          const zoneId = result.zone_id || result.id;
          zone_id = zoneId || null;
          simulationState.createdZoneIds.push(zoneId);
          zone_name = event.data.name;
        } else if (event.type === 'update') {
          const zoneId = simulationState.createdZoneIds[event.zone_index];
          zone_id = zoneId || null;
          if (zoneId) {
            await updateZone(zoneId, event.data, 'simulation-engine');
          }
          zone_name = `Zone ${zoneId}`;
        }

        audit({
          actor: 'simulation-engine',
          action_type: 'SIMULATION_EVENT',
          zone_id,
          description: `Executed ${event.type} event for ${zone_name}`,
        });

        if (broadcastFn) {
          broadcastFn({
            type: 'simulation_event',
            event_index: index,
            total_events: totalEvents,
            event_type: event.type,
            zone_name: zone_name
          });
        }
      } catch (error) {
        simulationState.status = 'failed';
        console.error('Simulation event error:', error);
      }

      // Check if this was the last event
      if (index === totalEvents - 1) {
        simulationState.running = false;
        if (simulationState.status !== 'failed') simulationState.status = 'completed';
        if (broadcastFn) {
          broadcastFn({ type: 'simulation_complete' });
        }
      }
    }, timerDelay);

    simulationState.timers.push(timer);
  });
}

/**
 * Stops the currently running simulation.
 */
export function stopSimulation() {
  if (simulationState.running) simulationState.status = 'stopped';
  if (simulationState.timers) {
    simulationState.timers.forEach(timer => clearTimeout(timer));
  }
  
  simulationState.running = false;
  simulationState.timers = [];
}

/**
 * Updates the speed of the running simulation. (Note: Only applies to future startSimulation calls in this basic implementation, or we can just update state).
 * @param {number} speed - The new playback speed.
 */
export function setSpeed(speed) {
  simulationState.speed = speed;
}

/**
 * Retrieves the current status of the simulation.
 * @returns {Object} Simulation status details.
 */
export function getSimulationStatus() {
  return {
    status: simulationState.status,
    running: simulationState.running,
    scenario_name: simulationState.scenario ? simulationState.scenario.name : null,
    speed: simulationState.speed,
    events_completed: simulationState.currentEventIndex,
    total_events: simulationState.scenario ? simulationState.scenario.events.length : 0,
    started_at: simulationState.startedAt
  };
}
