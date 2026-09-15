// Test-only: a round-robin front for several php -S workers, so the sandbox
// behaves like the multi-process PHP on cPanel (where the relay long-poll does
// not block every other request).
const http = require('http');
const backends = [8088, 8089, 8091, 8092];
let i = 0;
http.createServer((req, res) => {
  const port = backends[i++ % backends.length];
  const p = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
  req.pipe(p);
}).listen(8090, () => console.log('proxy on 8090 ->', backends.join(',')));
