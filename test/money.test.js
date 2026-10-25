import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumber, parseMoney, parseQty, parseRate, formatMoney as format, moneyInput, qtyInput } from "../public/money.js";

// Yön yalıtım işaretleri (U+2066/U+2069) olmadan.
const formatMoney = (...args) => format(...args).replace(/[⁦⁩]/g, "");

test("tutar sağdan sola metinde yalıtılır", () => {
  assert.match(format(100), /^⁦.*⁩$/);
});

test("kur: nokta da virgül de ondalık", () => {
  assert.equal(parseRate("41,2345"), 41.2345);
  assert.equal(parseRate("41.234"), 41.234);
  assert.equal(parseRate("41"), 41);
  for (const s of ["", "0", "abc", "-3", "1.2.3"]) assert.equal(parseRate(s), null, s);
});

test("döviz biçimleme", () => {
  assert.equal(formatMoney(125050, "USD").replace(/\s/g, ""), "$1.250,50");
  assert.equal(formatMoney(99, "EUR").replace(/\s/g, ""), "€0,99");
});

test("Türkçe yazım: nokta binlik, virgül ondalık", () => {
  assert.equal(parseNumber("1.250,50"), 1250.5);
  assert.equal(parseNumber("12,5"), 12.5);
  assert.equal(parseNumber("1.250"), 1250);
  assert.equal(parseNumber("1.000.000"), 1000000);
});

test("telefon klavyesi: tek nokta ondalık", () => {
  assert.equal(parseNumber("12.5"), 12.5);
  assert.equal(parseNumber("12.50"), 12.5);
  assert.equal(parseNumber("0.500"), 0.5);
  assert.equal(parseNumber(".5"), 0.5);
});

test("İngilizce yazım da okunur", () => {
  assert.equal(parseNumber("1,250.50"), 1250.5);
});

test("para işareti ve boşluklar yok sayılır", () => {
  assert.equal(parseNumber("₺ 40"), 40);
  assert.equal(parseNumber("40 TL"), 40);
});

test("okunamayan girişler null döner", () => {
  for (const s of ["", " ", "abc", "-5", ",", "12a", null, undefined]) {
    assert.equal(parseNumber(s), null, String(s));
  }
});

test("para kuruşa, miktar 3 haneye yuvarlanır", () => {
  assert.equal(parseMoney("12,345"), 1235);
  assert.equal(parseMoney("0,1"), 10);
  assert.equal(parseMoney("1.250,50"), 125050);
  assert.equal(parseQty("1,23456"), 1.235);
});

test("biçimleme", () => {
  assert.equal(formatMoney(125050).replace(/\s/g, ""), "₺1.250,50");
  assert.equal(moneyInput(125050), "1250,50");
  assert.equal(moneyInput(4500), "45");
  assert.equal(moneyInput(4505), "45,05");
  assert.equal(moneyInput(0), "");
  assert.equal(qtyInput(2.5), "2,5");
  // Forma yazılan değer tekrar okununca aynı sonuç çıkmalı.
  for (const k of [1, 99, 100, 4505, 125050, 100000000]) assert.equal(parseMoney(moneyInput(k)), k);
});
