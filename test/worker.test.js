import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { toJsonSchema, verifyIdToken, vapidAuth, notify } from "../worker/index.js";

const PROJECT = "kervan-7c9f64";
const ORIGIN = "https://kervanim.web.app";
const enc = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

// Google'ın imzaladığı jetonun yerine kendi anahtarımızla imzalanmış bir jeton.
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
);
const jwk = { ...await crypto.subtle.exportKey("jwk", publicKey), kid: "k1" };
const fetcher = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=60" } });
const NOW = 1_800_000_000;

async function token(claims = {}, kid = "k1") {
  const head = enc({ alg: "RS256", kid });
  const body = enc({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: "u1", iat: NOW - 10, exp: NOW + 3600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

test("worker: Firebase kimlik jetonu doğrulanır", async () => {
  const opts = { now: NOW, fetcher };
  assert.equal(await verifyIdToken(await token(), opts), "u1");
  assert.equal(await verifyIdToken(await token({ aud: "baska-proje" }), opts), null);
  assert.equal(await verifyIdToken(await token({ iss: "https://evil" }), opts), null);
  assert.equal(await verifyIdToken(await token({ exp: NOW - 1 }), opts), null);
  assert.equal(await verifyIdToken(await token({ sub: "" }), opts), null);
  assert.equal(await verifyIdToken(await token({}, "yok"), opts), null);
  const t = await token();
  assert.equal(await verifyIdToken(`${t.slice(0, t.lastIndexOf(".") + 1)}AAAA`, opts), null); // bozuk imza
  assert.equal(await verifyIdToken("abc", opts), null);
  assert.equal(await verifyIdToken(undefined, opts), null);
});

test("worker: şema JSON Schema'ya çevrilir, bütün alanlar zorunlu", () => {
  const s = toJsonSchema({ type: "OBJECT", properties: { a: { type: "STRING", nullable: true }, b: { type: "ARRAY", items: { type: "NUMBER" } } } });
  assert.deepEqual(s, { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: "array", items: { type: "number" } } }, required: ["a", "b"] });
});

test("worker: yabancı site ve jetonsuz istek reddedilir", async () => {
  const env = { AI: { run: async () => assert.fail("AI çağrılmamalı") } };
  const post = (origin, headers = {}) => worker.fetch(new Request("https://w.dev", {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: "{}",
  }), env);
  let res = await post("https://evil.example");
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  res = await post(ORIGIN);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "ai-setup");
  res = await worker.fetch(new Request("https://w.dev", { method: "OPTIONS", headers: { origin: ORIGIN } }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
});

test("worker: VAPID başlığı açık anahtarla doğrulanır", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
  const header = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", priv, pub, NOW);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, pub);
  const [h, b, s] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(b, "base64url"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, NOW + 12 * 3600);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${b}`));
  assert.ok(ok);
});

test("worker: sipariş bildirimi sadece yeni ve taze siparişe, bir kez gider; bırakılmış abonelik silinir", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const store = new Map([["sub:dukkan:a", JSON.stringify({ endpoint: "https://push.example/a" })], ["sub:dukkan:b", JSON.stringify({ endpoint: "https://push.example/b" })]]);
  const env = {
    VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)), VAPID_PUBLIC: "pub",
    PUSH: {
      get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); },
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
  };
  const now = Date.parse("2026-10-27T10:00:00Z");
  const pushes = [];
  const fetcher = async (url, opts) => {
    if (url.includes("/orders/")) {
      return new Response(JSON.stringify({ fields: { status: { stringValue: url.endsWith("eskiSiparis0001") ? "done" : "new" }, at: { timestampValue: "2026-10-27T09:58:00Z" } } }));
    }
    pushes.push(url);
    return new Response(null, { status: url.endsWith("/b") ? 410 : 201 });
  };
  const first = await notify({ slug: "dukkan", order: "yeniSiparis00001" }, env, fetcher, now);
  assert.deepEqual(first, { status: 200, sent: 1 });
  assert.equal(pushes.length, 2);
  assert.ok(!store.has("sub:dukkan:b"));
  assert.deepEqual(await notify({ slug: "dukkan", order: "yeniSiparis00001" }, env, fetcher, now), { status: 200, sent: 0 });
  assert.equal((await notify({ slug: "dukkan", order: "eskiSiparis0001" }, env, fetcher, now)).status, 404);
  assert.equal((await notify({ slug: "Kötü Ad", order: "yeniSiparis00001" }, env, fetcher, now)).status, 400);
});
