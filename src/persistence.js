import fs from 'node:fs';
import path from 'node:path';

// A single-process local snapshot. Rename commits a complete file atomically.
export function snapshotStore(file, store, requests) {
  return {
    load() {
      if (!fs.existsSync(file)) return false;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.store || !Array.isArray(saved.requests)) throw new Error('Invalid saved workspace');
      for (const key of Object.keys(store)) {
        if (key === '_seq') {
          if (!saved.store[key] || typeof saved.store[key] !== 'object' || Array.isArray(saved.store[key])) throw new Error('Invalid saved ID counters');
        } else if (!Array.isArray(saved.store[key])) throw new Error(`Invalid saved collection: ${key}`);
      }
      for (const key of Object.keys(store)) store[key] = saved.store[key];
      requests.clear();
      for (const [id, response] of saved.requests) requests.set(id, response);
      return true;
    },
    save() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const data = JSON.stringify({ version: 1, store, requests: [...requests] });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    },
  };
}
