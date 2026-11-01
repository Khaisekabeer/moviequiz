// Local Supabase only answers on this machine, so clip links handed to the projector and upload
// links handed to the quiz master point here instead (see store.publicMediaUrl). That way they work
// from any device and through the Cloudflare tunnel. Only token-signed links to the clip bucket
// pass; Storage checks the token itself. Bodies and Range requests are streamed untouched.
const http = require('http');
const https = require('https');

const SIGNED_LINK = /^\/object\/(sign|upload\/sign)\/question-videos\/[^?]+\?token=/;
const PASS_HEADERS = ['range', 'content-type', 'content-length', 'x-upsert', 'cache-control', 'if-range'];

function mediaProxy(req, res) {
  if (!['GET', 'HEAD', 'PUT'].includes(req.method) || !SIGNED_LINK.test(req.url)) return res.status(404).end();
  const target = new URL(`${process.env.SUPABASE_URL}/storage/v1${req.url}`);
  const headers = {};
  for (const name of PASS_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, { method: req.method, headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', err => {
    console.error(`[media] ${err.message}`);
    if (res.headersSent) res.destroy();
    else res.status(502).end();
  });
  req.pipe(upstream);
}

module.exports = mediaProxy;
