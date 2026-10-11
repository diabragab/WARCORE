// Coin packs sold through Whop checkout.
//
// Settings (environment variables on the server; payments stay off until all three are set):
//   WHOP_API_KEY         Whop dashboard > Developer > API keys (Account API key, needs payment + plan permissions)
//   WHOP_COMPANY_ID      your business id, starts with biz_
//   WHOP_WEBHOOK_SECRET  Developer > Webhooks > your webhook's signing secret (starts with ws_)
//   WHOP_SANDBOX=1       use Whop's sandbox (test payments, no real money)
// Create the webhook in Whop pointing at https://<your domain>/api/whop/webhook with the payment events enabled.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { creditCoins, json, readBody, readRaw, userByKey, userFor } from './accounts.mjs';

const env = process.env;
const W = {
  apiKey: env.WHOP_API_KEY,
  company: env.WHOP_COMPANY_ID,
  secret: env.WHOP_WEBHOOK_SECRET,
  sandbox: env.WHOP_SANDBOX === '1' || env.WHOP_SANDBOX === 'true',
};
const API = env.WHOP_API_BASE || (W.sandbox ? 'https://sandbox-api.whop.com/api/v1' : 'https://api.whop.com/api/v1');
const SITE = W.sandbox ? 'https://sandbox.whop.com' : 'https://whop.com';
const enabled = () => !!(W.apiKey && W.company && W.secret);

export const CURRENCY = 'USD';
export const PACKS = [
  { id: 'crate', name: 'Ammo Crate', coins: 1000, price: 1.99 },
  { id: 'convoy', name: 'Supply Convoy', coins: 3500, price: 4.99, note: '500 bonus coins' },
  { id: 'arsenal', name: 'War Chest', coins: 8000, price: 9.99, note: '2,000 bonus coins' },
];

async function whop(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${W.apiKey}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Whop ${method} ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function createCheckout(key, pack, returnTo) {
  const c = await whop('POST', '/checkout_configurations', {
    mode: 'payment',
    plan: { company_id: W.company, currency: CURRENCY.toLowerCase(), initial_price: pack.price, plan_type: 'one_time' },
    metadata: { warcore_user: key, warcore_pack: pack.id },
    ...(returnTo ? { redirect_url: returnTo } : {}),
  });
  if (!c.purchase_url) throw new Error(`Whop returned no purchase_url: ${JSON.stringify(c).slice(0, 300)}`);
  return c.purchase_url.startsWith('http') ? c.purchase_url : SITE + c.purchase_url;
}

/** Standard Webhooks signature: HMAC-SHA256 over "id.timestamp.body", base64, header "v1,<sig>" (space separated list). */
function signatureOk(req, raw) {
  const id = req.headers['webhook-id'];
  const ts = req.headers['webhook-timestamp'];
  const sigs = String(req.headers['webhook-signature'] || '').split(' ');
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  // Whop says to use the ws_ secret exactly as given; also accept the whsec_<base64> form other tools use.
  const keys = [Buffer.from(W.secret, 'utf8')];
  if (W.secret.startsWith('whsec_')) keys.push(Buffer.from(W.secret.slice(6), 'base64'));
  for (const k of keys) {
    const want = createHmac('sha256', k).update(`${id}.${ts}.${raw}`).digest();
    for (const s of sigs) {
      const [v, b64] = s.split(',');
      const got = v === 'v1' && b64 ? Buffer.from(b64, 'base64') : null;
      if (got && got.length === want.length && timingSafeEqual(got, want)) return true;
    }
  }
  return false;
}

const seen = new Set();

/** Looks the payment up in Whop (rather than trusting the webhook body) and credits or removes the coins. */
async function settle(paymentId, refund) {
  const p = await whop('GET', `/payments/${encodeURIComponent(paymentId)}`);
  const key = p.metadata?.warcore_user;
  const pack = PACKS.find((x) => x.id === p.metadata?.warcore_pack);
  if (!key || !pack || !userByKey(key)) return console.log(`Whop payment ${paymentId}: not a WARCORE coin pack, ignored`);
  if (refund) {
    if (Number(p.refunded_amount) > 0 || /refund/.test(String(p.status))) creditCoins(key, -pack.coins, `refund:${paymentId}`);
  } else if (p.status === 'paid' || p.status === 'succeeded' || p.substatus === 'succeeded') {
    creditCoins(key, pack.coins, paymentId);
  } else return console.log(`Whop payment ${paymentId} has status ${p.status}, not crediting yet`);
  console.log(`Whop ${refund ? 'refund' : 'payment'} ${paymentId}: ${pack.id} for ${key}`);
}

/** Handles /api/pay/* and the Whop webhook. Returns false for other paths. */
export async function handlePayments(req, res, path) {
  if (path === '/api/whop/webhook' && req.method === 'POST') {
    const raw = await readRaw(req);
    if (!enabled() || !signatureOk(req, raw)) return json(res, 401, { error: 'invalid signature' }), true;
    const msgId = String(req.headers['webhook-id']);
    if (seen.has(msgId)) return res.writeHead(200).end(), true;
    const e = JSON.parse(raw);
    const d = e.data || {};
    const paymentId = String(d.id || '').startsWith('pay_') ? d.id : d.payment?.id || d.payment_id;
    try {
      if (paymentId && e.type === 'payment.succeeded') await settle(paymentId, false);
      else if (paymentId && /refund|dispute/.test(e.type)) await settle(paymentId, true);
      seen.add(msgId);
    } catch (err) {
      console.error(err.message);
      // Unknown payment: nothing to retry. Anything else gets a non-2xx so Whop retries the delivery later.
      if (/\(404\)/.test(err.message)) return res.writeHead(200).end(), true;
      return json(res, 500, { error: 'temporary failure' }), true;
    }
    return res.writeHead(200).end(), true;
  }

  if (!path.startsWith('/api/pay/')) return false;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end(), true;

  if (path === '/api/pay/config' && req.method === 'GET') {
    return json(res, 200, { enabled: enabled(), sandbox: W.sandbox, currency: CURRENCY, packs: PACKS }), true;
  }
  if (path === '/api/pay/checkout' && req.method === 'POST') {
    if (!enabled()) return json(res, 503, { error: 'Coin purchases are not available yet.' }), true;
    const who = userFor(req);
    if (!who?.user) return json(res, 401, { error: 'Please sign in again.' }), true;
    const body = await readBody(req).catch(() => ({}));
    const pack = PACKS.find((p) => p.id === body.pack);
    if (!pack) return json(res, 400, { error: 'Unknown coin pack.' }), true;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const returnTo = host && !/^(127\.|localhost)/.test(host) ? `https://${host}/play/` : undefined;
    try {
      return json(res, 200, { url: await createCheckout(who.key, pack, returnTo) }), true;
    } catch (e) {
      console.error(e.message);
      return json(res, 502, { error: "The payment page couldn't be opened. Try again in a moment." }), true;
    }
  }
  return json(res, 404, { error: 'Not found.' }), true;
}
