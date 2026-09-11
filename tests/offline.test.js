import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueReport, readQueue, flushQueue } from '../public/reportQueue.js';
test('offline queue persists failures, keeps order and retains concurrent additions', async () => {
  const data = new Map(); const storage = { getItem:k=>data.get(k), setItem:(k,v)=>data.set(k,v) };
  enqueueReport(storage,{request_id:'a',name:'A'}); enqueueReport(storage,{request_id:'a',name:'A'});
  await assert.rejects(flushQueue(storage, async()=>{throw new Error('offline');}),/offline/);
  assert.equal(readQueue(storage).length,1);
  const sent=[];
  await flushQueue(storage, async r=>{sent.push(r.request_id);if(r.request_id==='a') enqueueReport(storage,{request_id:'b',name:'B'});});
  assert.deepEqual(sent,['a','b']); assert.equal(readQueue(storage).length,0);
});
