/* Logika API pro cloudovou zálohu dat Investixu (bez závislosti na konkrétní databázi
   a ověřování - ty se dodávají zvenku, viz data.js; díky tomu jde celé testovat). */
const MAX_DATA_BYTES = 1_000_000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '');
  return match ? match[1] : null;
}

function parseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function createHandler({ store, verifyToken, allowedOrigins }) {
  const isAllowedOrigin = (origin) =>
    !!origin && allowedOrigins.some((allowed) => (allowed instanceof RegExp ? allowed.test(origin) : allowed === origin));

  return async function handler(req, res) {
    const origin = req.headers.origin;
    const originAllowed = isAllowedOrigin(origin);
    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.statusCode = originAllowed ? 204 : 403;
      return res.end();
    }
    if (!originAllowed) return send(res, 403, { error: 'origin_not_allowed' });

    const token = bearerToken(req.headers.authorization);
    if (!token) return send(res, 401, { error: 'missing_token' });

    let userId;
    try {
      userId = await verifyToken(token, origin);
    } catch {
      return send(res, 401, { error: 'invalid_token' });
    }

    try {
      if (req.method === 'GET') {
        const row = await store.load(userId);
        return send(res, 200, row ? { data: row.data, updated_at: row.updated_at } : { data: null });
      }
      if (req.method === 'PUT') {
        const body = parseBody(req.body);
        const data = body && body.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'invalid_body' });
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) return send(res, 413, { error: 'too_large' });
        const updatedAt = await store.save(userId, data);
        return send(res, 200, { ok: true, updated_at: updatedAt });
      }
      if (req.method === 'DELETE') {
        await store.remove(userId);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (e) {
      console.error('investix api error:', e && e.message);
      return send(res, 500, { error: 'server_error' });
    }
  };
}

module.exports = { createHandler };
