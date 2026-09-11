export const QUEUE_KEY = 'only-error-report-queue-v1';
export function readQueue(storage) {
  return JSON.parse(storage.getItem(QUEUE_KEY) || '[]');
}
export function enqueueReport(storage, report) {
  const queue = readQueue(storage);
  if (!queue.some(r => r.request_id === report.request_id)) queue.push(report);
  storage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
export async function flushQueue(storage, send) {
  while (readQueue(storage).length) {
    const report = readQueue(storage)[0];
    await send(report);
    // Re-read so a report added while a request was in flight is retained.
    storage.setItem(QUEUE_KEY, JSON.stringify(readQueue(storage).filter(r => r.request_id !== report.request_id)));
  }
}
