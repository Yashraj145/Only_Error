import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { default: app } = await import('../server.js');
const { stopSimulation } = await import('../src/simulation.js');

test('simulation SSE sends named progress and completion events', { timeout: 10000 }, async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const start = await fetch(`${base}/api/simulate/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'flood_escalation', speed: 100 }),
    });
    assert.equal(start.status, 200);
    let text = '';
    while (!text.includes('"type":"simulation_complete"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const events = text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    const progress = events.filter(e => e.type === 'simulation_event');
    assert.equal(progress.length, 6);
    assert.deepEqual(progress.map(e => e.payload.event_index), [0, 1, 2, 3, 4, 5]);
    assert.ok(events.some(e => e.type === 'simulation_complete'));
    const status = await (await fetch(`${base}/api/simulate/status`)).json();
    assert.equal(status.running, false);
    assert.equal(status.events_completed, 6);
    assert.equal(status.status, 'completed');
    await fetch(`${base}/api/simulate/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'flood_escalation', speed: 1 }),
    });
    await fetch(`${base}/api/simulate/stop`, { method: 'POST' });
    const stopped = await (await fetch(`${base}/api/simulate/status`)).json();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.running, false);
  } finally {
    controller.abort();
    stopSimulation();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
