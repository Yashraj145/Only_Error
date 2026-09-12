import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server.js';
import http from 'node:http';
import { store } from '../src/store.js';
import { readFile } from 'node:fs/promises';

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

test('voice agent: GET /api/voice-samples returns sample catalog', async () => {
  const res = await makeRequest('/api/voice-samples');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data));
  assert.ok(res.data.length >= 3);
  const mayday = res.data.find((s) => s.filename === 'critical_mayday.wav');
  assert.ok(mayday);
  assert.ok(mayday.transcript.includes('Mayday'));
});

test('voice agent: analysis produces review draft without creating an incident', async () => {
  const before = JSON.stringify(store);
  const res = await makeRequest('/api/voice-report', 'POST', {
    sample_name: 'critical_mayday.wav',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.acoustic);
  assert.equal(res.data.acoustic.engine, 'librosa');
  assert.equal(res.data.acoustic.mfcc.length, 13);
  assert.ok(res.data.acoustic.pitch_hz > 0);
  assert.ok(res.data.acoustic.energy_rms > 0);
  assert.ok(res.data.acoustic.speech_rate > 0);
  assert.ok(res.data.acoustic.distress_score >= 70);
  assert.equal(res.data.parsed.rescue_needed, true);
  assert.equal(res.data.parsed.urgency_high, true);
  assert.equal(res.data.review_required, true);
  assert.equal(res.data.report_result, undefined);
  assert.equal(JSON.stringify(store), before);
});

test('voice upload without transcript does not invent a location or report', async () => {
  const before = JSON.stringify(store);
  const audio = await readFile(new URL('../public/samples/critical_mayday.wav', import.meta.url));
  const res = await makeRequest('/api/voice-report', 'POST', { audio_base64: audio.toString('base64') });
  assert.equal(res.status, 200);
  assert.equal(res.data.transcript, '');
  assert.equal(res.data.transcript_missing, true);
  assert.equal(res.data.parsed.name, '');
  assert.equal(res.data.parsed.location, '');
  assert.equal(JSON.stringify(store), before);
  const confirmed = await makeRequest('/api/reports', 'POST', {
    ...res.data.parsed, name: 'Reviewed voice zone', location: 'Reviewed location', request_id: 'voice-reviewed-1',
  });
  assert.equal(confirmed.status, 201);
});

test('voice agent: repeated analysis works with compiled audio cache', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await makeRequest('/api/voice-report', 'POST', { sample_name: 'critical_mayday.wav' });
    assert.equal(res.status, 200, res.data.error);
    assert.equal(res.data.acoustic.engine, 'librosa');
    assert.equal(res.data.acoustic.mfcc.length, 13);
  }
});
