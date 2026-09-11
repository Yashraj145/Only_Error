import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server.js';
import http from 'node:http';

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

test('voice agent: POST /api/voice-report ingests critical radio dispatch via Librosa', async () => {
  const res = await makeRequest('/api/voice-report', 'POST', {
    sample_name: 'critical_mayday.wav',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.acoustic);
  assert.equal(res.data.acoustic.mfcc.length, 13);
  assert.ok(res.data.acoustic.pitch_hz > 0);
  assert.ok(res.data.acoustic.energy_rms > 0);
  assert.ok(res.data.acoustic.speech_rate > 0);
  assert.ok(res.data.acoustic.distress_score >= 70);
  assert.equal(res.data.parsed.rescue_needed, true);
  assert.equal(res.data.parsed.urgency_high, true);
  assert.ok(res.data.report_result);
});
