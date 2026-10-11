// Coin packs sold through Xsolla Pay Station.
//
// Settings (environment variables on the server; payments stay off until all four are set):
//   XSOLLA_MERCHANT_ID, XSOLLA_PROJECT_ID, XSOLLA_API_KEY   from Publisher Account > Company settings / Project settings
//   XSOLLA_WEBHOOK_SECRET                                  Project settings > Webhooks > Secret key
//   XSOLLA_SANDBOX=1                                       test payments (no real money)
// In Publisher Account set the webhook URL to https://<your domain>/api/xsolla/webhook.
// Uses Pay Station "simple checkout" (an amount instead of catalog items); ask your Xsolla manager to enable it.
import { createHash, timingSafeEqual } from 'node:crypto';
import { creditCoins, json, readBody, readRaw, userByKey, userFor } from './accounts.mjs';

const env = process.env;
const X = {
  merchant: env.XSOLLA_MERCHANT_ID,
  project: Number(env.XSOLLA_PROJECT_ID),
  apiKey: env.XSOLLA_API_KEY,
  secret: env.XSOLLA_WEBHOOK_SECRET,
  sandbox: env.XSOLLA_SANDBOX === '1' || env.XSOLLA_SANDBOX === 'true',
};
const enabled = () => !!(X.merchant && X.project && X.apiKey && X.secret);

export const CURRENCY = 'USD';
export const PACKS = [
  { id: 'crate', name: 'Ammo Crate', coins: 1000, price: 1.99 },
  { id: 'convoy', name: 'Supply Convoy', coins: 3500, price: 4.99, note: '500 bonus coins' },
  { id: 'arsenal', name: 'War Chest', coins: 8000, price: 9.99, note: '2,000 bonus coins' },
];

async function createCheckout(user, key, pack) {
  const auth = Buffer.from(`${X.merchant}:${X.apiKey}`).toString('base64');
  const res = await fetch(`https://api.xsolla.com/merchant/v2/merchants/${X.merchant}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      user: { id: { value: key }, name: { value: user.name } },
      settings: { project_id: X.project, currency: CURRENCY, language: 'en', ...(X.sandbox ? { mode: 'sandbox' } : {}) },
      purchase: { checkout: { amount: pack.price, currency: CURRENCY }, description: { value: `${pack.coins.toLocaleString('en-US')} WARCORE coins` } },
      custom_parameters: { pack: pack.id },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(`Xsolla token request failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return `https://${X.sandbox ? 'sandbox-' : ''}secure.xsolla.com/paystation4/?token=${encodeURIComponent(data.token)}`;
}

function signatureOk(req, raw) {
  const m = /^Signature ([a-f0-9]{40})$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const want = createHash('sha1').update(raw + X.secret).digest();
  return timingSafeEqual(Buffer.from(m[1].toLowerCase(), 'hex'), want);
}

/** Handles /api/pay/* and the Xsolla webhook. Returns false for other paths. */
export async function handlePayments(req, res, path) {
  if (path === '/api/xsolla/webhook' && req.method === 'POST') {
    const raw = await readRaw(req);
    if (!enabled() || !signatureOk(req, raw)) return json(res, 400, { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }), true;
    const n = JSON.parse(raw);
    const userKey = n.user?.id;
    if (n.notification_type === 'user_validation') {
      return userByKey(userKey) ? (res.writeHead(204).end(), true) : (json(res, 400, { error: { code: 'INVALID_USER', message: 'Invalid user' } }), true);
    }
    if (n.notification_type === 'payment' || n.notification_type === 'refund') {
      const pack = PACKS.find((p) => p.id === n.custom_parameters?.pack);
      const tx = String(n.transaction?.id ?? '');
      if (!pack || !tx) return json(res, 400, { error: { code: 'INVALID_PARAMETER', message: 'Unknown purchase' } }), true;
      const refund = n.notification_type === 'refund';
      if (!creditCoins(userKey, refund ? -pack.coins : pack.coins, refund ? `refund:${tx}` : tx)) {
        return json(res, 400, { error: { code: 'INVALID_USER', message: 'Invalid user' } }), true;
      }
      console.log(`Xsolla ${n.notification_type}: ${tx} ${pack.id} for ${userKey}`);
    }
    return res.writeHead(204).end(), true;
  }

  if (!path.startsWith('/api/pay/')) return false;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end(), true;

  if (path === '/api/pay/config' && req.method === 'GET') {
    return json(res, 200, { enabled: enabled(), sandbox: X.sandbox, currency: CURRENCY, packs: PACKS }), true;
  }
  if (path === '/api/pay/checkout' && req.method === 'POST') {
    if (!enabled()) return json(res, 503, { error: 'Coin purchases are not available yet.' }), true;
    const who = userFor(req);
    if (!who?.user) return json(res, 401, { error: 'Please sign in again.' }), true;
    const body = await readBody(req).catch(() => ({}));
    const pack = PACKS.find((p) => p.id === body.pack);
    if (!pack) return json(res, 400, { error: 'Unknown coin pack.' }), true;
    try {
      return json(res, 200, { url: await createCheckout(who.user, who.key, pack) }), true;
    } catch (e) {
      console.error(e.message);
      return json(res, 502, { error: "The payment page couldn't be opened. Try again in a moment." }), true;
    }
  }
  return json(res, 404, { error: 'Not found.' }), true;
}
