// Tiny HTTP router helpers: CORS, body parsing, JSON responses, SSE.

export function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  const h = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-LocalForge-Confirm',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // Chrome Private Network Access: secure pages fetching http://localhost
  if (req.headers['access-control-request-private-network'] === 'true') {
    h['Access-Control-Allow-Private-Network'] = 'true';
  }
  return h;
}

export function handlePreflight(req, res) {
  const h = corsHeaders(req);
  res.writeHead(204, h);
  res.end();
}

export function withCors(req, res) {
  const h = corsHeaders(req);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

// Simple fixed-window rate limiter
export function rateLimiter(maxPerMin) {
  const hits = new Map(); // key -> [timestamps]
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= maxPerMin) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}
