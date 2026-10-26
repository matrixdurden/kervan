import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { toJsonSchema, verifyIdToken } from "../worker/index.js";

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
