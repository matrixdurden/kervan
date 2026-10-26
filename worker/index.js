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

    const uid = await verifyIdToken(/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]).catch(() => null);
    if (!uid) return reply(origin, 401, { error: "ai-setup" });

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
