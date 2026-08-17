// api/webhook.js
// Vercel Serverless function — webhook tester
export default async function handler(req, res) {
  const now = new Date().toISOString();

  // Optional shared-secret check (set VERCEL_WEBHOOK_TOKEN in Vercel project env)
  const expectedToken = process.env.VERCEL_WEBHOOK_TOKEN || null;
  const gotToken = req.headers['x-webhook-token'] || req.headers['x-hook-token'] || req.headers['x-source-token'];

  if (expectedToken && String(gotToken || '') !== String(expectedToken)) {
    console.warn(`[${now}] Webhook rejected — bad token`, { gotToken: !!gotToken });
    return res.status(401).json({ ok: false, reason: 'invalid token' });
  }

  // Build a compact record to log/return (avoid logging huge binary)
  const record = {
    received_at: now,
    method: req.method,
    path: req.url,
    headers: req.headers,
    query: req.query,
    // body: Vercel (and Next) will parse JSON body automatically when content-type is application/json
    // We return a summarized body (and also log full body server-side)
    body_sample: (() => {
      try {
        if (!req.body) return null;
        if (typeof req.body === 'string') {
          // attempt JSON parse for convenience
          try { return JSON.parse(req.body); } catch { return req.body.slice(0, 4000); }
        }
        // object-like
        const keys = Object.keys(req.body || {});
        if (keys.length > 25) {
          // too many keys — return first few
          const small = {};
          for (const k of keys.slice(0, 25)) small[k] = req.body[k];
          small.__truncated = true;
          return small;
        }
        return req.body;
      } catch (e) {
        return { error: 'could not introspect body' };
      }
    })()
  };

  // Log the full body and metadata to Vercel function logs (these appear in the Vercel dashboard)
  console.log('[webhook-tester] received payload:', JSON.stringify(record, null, 2));

  // Respond with the record so an HTTP client sees what we parsed
  return res.status(200).json({
    ok: true,
    received_at: now,
    summary: record
  });
}