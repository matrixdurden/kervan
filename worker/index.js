// İki iş: (1) anahtarsız fatura okuma, (2) online mağaza sipariş bildirimi (Web Push, aşağıda).
//
// Anahtarsız fatura okuma: uygulama faturanın görselini (ya da PDF'in metnini) buraya yollar,
// Worker onu Cloudflare Workers AI'daki görsel okuyabilen bir modele sorar. Kullanıcı anahtar
// girmez; isteği sadece kervan'a Google ile girmiş biri atabilir (Firebase kimlik jetonu).
// Workers AI'ın ücretsiz planı günlük bir sınıra (10.000 neuron) gelince durur, para çıkmaz.
// Talimat ve şema uygulamadakiyle aynıdır (public/invoice.js).

import { PROMPT, SCHEMA } from "../public/invoice.js";

const PROJECT = "kervan-7c9f64";
const ORIGINS = ["https://kervanim.web.app", "https://kervan-7c9f64.web.app", "https://kervan-7c9f64.firebaseapp.com"];
// İlki hata verirse (model kalkmış, geçici sorun) sıradakine geçilir.
const MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct"];
const MAX_BODY = 8 * 1024 * 1024;
const MAX_TEXT = 60000;
const JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Gemini şemasından (STRING, nullable…) standart JSON Schema'ya. Bütün alanlar zorunlu yapılır
// (okunamayan null gelir); yoksa model fatura no ve tarih gibi alanları sessizce atlıyor.
export function toJsonSchema(s) {
  const type = s.type.toLowerCase();
  const out = { type: s.nullable ? [type, "null"] : type };
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = Object.keys(s.properties);
  }
  if (s.items) out.items = toJsonSchema(s.items);
  return out;
}

const RESPONSE_FORMAT = { type: "json_schema", json_schema: toJsonSchema(SCHEMA) };

// ---- Firebase kimlik jetonu (RS256) ----

let keys = { at: 0, ttl: 0, list: [] };

async function googleKeys(fetcher) {
  if (Date.now() - keys.at < keys.ttl) return keys.list;
  const res = await fetcher(JWKS);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  keys = { at: Date.now(), ttl: maxAge * 1000, list: (await res.json()).keys ?? [] };
  return keys.list;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json64 = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Geçerliyse kullanıcının uid'si, değilse null.
export async function verifyIdToken(token, { project = PROJECT, now = Date.now() / 1000, fetcher = fetch } = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = json64(parts[0]); claims = json64(parts[1]); } catch { return null; }
  if (header.alg !== "RS256") return null;
  const jwk = (await googleKeys(fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed)) return null;
  const ok = claims.aud === project && claims.iss === `https://securetoken.google.com/${project}`
    && typeof claims.sub === "string" && claims.sub.length > 0
    && claims.exp > now && claims.iat <= now + 300;
  return ok ? claims.sub : null;
}

// ---- Sipariş bildirimi (Web Push) ----
// Dükkânın telefonu /push/subscribe ile kaydolur: sadece o mağazanın işletmesinin ortağı (Firestore,
// kişinin kendi jetonuyla okunabiliyorsa ortaktır). Müşteri sipariş gönderince vitrin /push/notify'ı
// çağırır; sipariş Firestore'dan doğrulanır (var, yeni, birkaç dakikalık) ve kayıtlı telefonlara
// içeriksiz bildirim gider (telefon "Yeni sipariş" yazar). Kayıtlar KV'de (PUSH), gizli anahtar
// VAPID_PRIVATE_JWK sırrında, açık anahtar VAPID_PUBLIC değişkeninde.

const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const enc64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const text64 = (obj) => enc64(new TextEncoder().encode(JSON.stringify(obj)));

async function sha256(s) {
  return enc64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

// VAPID başlığı (ES256 imzalı kısa JWT): push sunucusu isteğin bu uygulamadan geldiğini anlar.
export async function vapidAuth(endpoint, privateJwk, publicKey, now = Date.now() / 1000) {
  const head = text64({ typ: "JWT", alg: "ES256" });
  const body = text64({ aud: new URL(endpoint).origin, exp: Math.floor(now) + 12 * 3600, sub: "https://kervanim.web.app" });
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${enc64(sig)}, k=${publicKey}`;
}

// Sipariş bildirim için uygun mu: var, durumu yeni, son 15 dakikada oluşmuş.
export function freshOrder(doc, now = Date.now()) {
  const f = doc?.fields;
  if (!f || f.status?.stringValue !== "new") return false;
  const at = Date.parse(f.at?.timestampValue ?? "");
  return Number.isFinite(at) && now - at < 15 * 60 * 1000 && at - now < 60 * 1000;
}

async function subscribe(request, env, origin, idToken, fetcher = fetch) {
  const body = await request.json().catch(() => null);
  const slug = String(body?.slug ?? "");
  const endpoint = String(body?.subscription?.endpoint ?? "");
  if (!SLUG.test(slug) || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) return reply(origin, 400, { error: "bad" });
  const shop = await (await fetcher(`${FIRESTORE}/shops/${slug}`)).json().catch(() => null);
  const firm = shop?.fields?.firm?.stringValue;
  if (!firm) return reply(origin, 404, { error: "shop" });
  const member = await fetcher(`${FIRESTORE}/firms/${firm}`, { headers: { authorization: `Bearer ${idToken}` } });
  if (!member.ok) return reply(origin, 403, { error: "member" });
  await env.PUSH.put(`sub:${slug}:${await sha256(endpoint)}`, JSON.stringify({ endpoint }), { expirationTtl: 90 * 24 * 3600 });
  return reply(origin, 200, { ok: true });
}

export async function notify(body, env, fetcher = fetch, now = Date.now()) {
  const slug = String(body?.slug ?? "");
  const order = String(body?.order ?? "");
  if (!SLUG.test(slug) || !/^[A-Za-z0-9]{10,40}$/.test(order)) return { status: 400, sent: 0 };
  const doc = await (await fetcher(`${FIRESTORE}/shops/${slug}/orders/${order}`)).json().catch(() => null);
  if (!freshOrder(doc, now)) return { status: 404, sent: 0 };
  if (await env.PUSH.get(`sent:${order}`)) return { status: 200, sent: 0 };
  await env.PUSH.put(`sent:${order}`, "1", { expirationTtl: 3600 });
  const privateJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  let sent = 0;
  const { keys: subs } = await env.PUSH.list({ prefix: `sub:${slug}:` });
  for (const { name } of subs) {
    const sub = JSON.parse(await env.PUSH.get(name) ?? "null");
    if (!sub?.endpoint) continue;
    const res = await fetcher(sub.endpoint, {
      method: "POST",
      headers: { authorization: await vapidAuth(sub.endpoint, privateJwk, env.VAPID_PUBLIC, now / 1000), ttl: "86400", urgency: "high", "content-length": "0" },
    }).catch(() => null);
    if (res?.status === 404 || res?.status === 410) await env.PUSH.delete(name); // telefon aboneliği bırakmış
    else if (res?.ok) sent++;
  }
  return { status: 200, sent };
}

// ---- İstek ----

const cors = (origin) => (ORIGINS.includes(origin) ? {
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
  vary: "origin",
} : {});

const reply = (origin, status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...cors(origin) },
});

// Workers AI hatasından uygulamanın hata kodu.
function errorCode(err) {
  const s = String(err?.message ?? err);
  if (/3036|daily free allocation|neurons|quota|429|rate limit/i.test(s)) return "ai-quota";
  return "ai-failed";
}

function messages(body) {
  if (typeof body.text === "string") {
    return [{ role: "user", content: `${PROMPT}\n\nThe invoice text (extracted from a PDF):\n\n${body.text.slice(0, MAX_TEXT)}` }];
  }
  return [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: body.image } }] }];
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply(origin, 405, { error: "ai-failed" });
    if (!ORIGINS.includes(origin)) return reply(origin, 403, { error: "ai-setup" });
    const path = new URL(request.url).pathname;

    // Vitrinden: sipariş geldi (girişsiz; sipariş Firestore'dan doğrulanır).
    if (path === "/push/notify") {
      const body = await request.json().catch(() => null);
      const out = await notify(body, env);
      return reply(origin, out.status, { sent: out.sent });
    }

    const idToken = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const uid = await verifyIdToken(idToken).catch(() => null);
    if (!uid) return reply(origin, 401, { error: "ai-setup" });
    if (path === "/push/subscribe") return subscribe(request, env, origin, idToken);

    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return reply(origin, 413, { error: "ai-too-big" });
    const body = await request.json().catch(() => null);
    const valid = body && (typeof body.text === "string" ? body.text.trim().length > 0 : /^data:image\/(jpeg|png|webp);base64,/.test(body.image ?? ""));
    if (!valid) return reply(origin, 400, { error: "ai-unsupported" });

    let last;
    for (const model of MODELS) {
      try {
        const out = await env.AI.run(model, { messages: messages(body), response_format: RESPONSE_FORMAT, temperature: 0, max_tokens: 4096 });
        const text = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? null);
        return reply(origin, 200, { text, model });
      } catch (err) {
        last = err;
        console.error(model, String(err?.message ?? err));
        if (errorCode(err) === "ai-quota") break; // kota hepsi için ortak
      }
    }
    const code = errorCode(last);
    return reply(origin, code === "ai-quota" ? 429 : 502, { error: code });
  },
};
