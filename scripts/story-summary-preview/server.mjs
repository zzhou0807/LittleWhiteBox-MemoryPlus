import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const allowedRoots = ['modules/story-summary/', 'scripts/story-summary-preview/'];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
    try {
        const requested = new URL(request.url, 'http://127.0.0.1').pathname;
        const relative = decodeURIComponent(requested === '/' ? '/scripts/story-summary-preview/index.html' : requested).slice(1);
        const absolute = path.resolve(root, relative);
        const checked = path.relative(root, absolute).replaceAll('\\', '/');
        if (!allowedRoots.some(prefix => checked.startsWith(prefix)) || checked.split('/').some(part => part.startsWith('.')) || !Object.hasOwn(types, path.extname(absolute))) {
            response.writeHead(403).end();
            return;
        }
        const body = await readFile(absolute);
        response.writeHead(200, { 'Content-Type': `${types[path.extname(absolute)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(body);
    } catch {
        response.writeHead(404).end();
    }
});
server.listen(18761, '127.0.0.1', () => console.log('Local fixture: http://127.0.0.1:18761/'));
