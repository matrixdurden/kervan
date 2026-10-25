import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { setLang, t } from "../public/i18n.js";

const dir = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const source = read("i18n.js");

// STRINGS içindeki dil bloklarının anahtarları.
function keys(langCode) {
  const start = source.indexOf(`  ${langCode}: {`);
  const end = source.indexOf("\n  },", start);
  return new Set([...source.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("Türkçe ve Arapça aynı metinlere sahip", () => {
  const tr = keys("tr");
  const ar = keys("ar");
  assert.deepEqual([...tr].filter((k) => !ar.has(k)), [], "Arapçada eksik");
  assert.deepEqual([...ar].filter((k) => !tr.has(k)), [], "Türkçede olmayan");
});

test("koddaki her metin anahtarı tanımlı", () => {
  const tr = keys("tr");
  const used = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    for (const m of read(file).matchAll(/\bt\("(\w+)"/g)) used.add(m[1]);
  }
  for (const m of read("index.html").matchAll(/data-i18n(?:-label|-placeholder)?="(\w+)"/g)) used.add(m[1]);
  assert.deepEqual([...used].filter((k) => !tr.has(k)), []);

  // Değişken parçalı anahtarlar (t(`type_${…}`) gibi) her tür için var mı?
  const types = ["purchase", "payment", "sale", "collection", "consign", "consignSale", "return", "expense", "capitalIn", "withdraw", "transfer", "opening"];
  for (const type of types) assert.ok(tr.has(`type_${type}`), `type_${type}`);
  for (const type of types.filter((x) => x !== "opening")) assert.ok(tr.has(`new_${type}`), `new_${type}`);
  for (const type of ["expense", "capitalIn", "withdraw", "transfer"]) {
    assert.ok(tr.has(`holder_${type}`) && tr.has(`hint_${type}`), type);
  }
  for (const type of ["collection", "payment", "expense", "capitalIn", "withdraw"]) assert.ok(tr.has(`holderOf_${type}`), type);
});

test("yer tutucular doldurulur, dil değişir", () => {
  setLang("tr");
  assert.equal(t("deleted", { name: "Çay" }), "Çay silindi");
  setLang("ar");
  assert.equal(t("deleted", { name: "Çay" }), "تم حذف Çay");
  setLang("tr");
});
