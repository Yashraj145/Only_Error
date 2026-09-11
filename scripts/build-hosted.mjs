import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'client'), { recursive: true });
fs.mkdirSync(path.join(dist, 'server'), { recursive: true });
fs.mkdirSync(path.join(dist, '.openai'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(dist, 'client'), { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(dist, 'server', 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'worker', 'index.js'), path.join(dist, 'server', 'index.js'));
fs.copyFileSync(path.join(root, '.openai', 'hosting.json'), path.join(dist, '.openai', 'hosting.json'));
console.log('Built Cloudflare Worker and client assets in dist/');
