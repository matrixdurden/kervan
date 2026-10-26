import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, salesSeries, topBy, inLira, groupTotals, salesVat, monthsInRange } from "../public/report.js";

const sale = (date, party, partyName, lines, extra = {}) => ({
  type: "sale", date, party, partyName, lines,
  total: lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0), ...extra,
});

const MOVES = [
  sale("2026-10-02", "ali", "Ali Market", [{ product: "cay", name: "Çay", unit: "paket", qty: 2, price: 25000, cost: 38000 }]),
  sale("2026-10-02", "veli", "Veli Bakkal", [{ product: "seker", name: "Şeker", unit: "çuval", qty: 3, price: 18000, cost: 45000 }]),
  sale("2026-10-05", "ali", "Ali Market", [
    { product: "cay", name: "Çay", unit: "paket", qty: 1, price: 25000, cost: 19000 },
    { product: "seker", name: "Şeker", unit: "çuval", qty: 1, price: 18000, cost: 15000 },
  ]),
  { type: "consignSale", date: "2026-10-05", party: "veli", partyName: "Veli Bakkal", total: 9000,
    lines: [{ product: "seker", name: "Şeker", unit: "çuval", qty: 0.5, price: 18000, cost: 7500 }] },
  // Çöp kutusundaki satış sayılmaz.
  sale("2026-10-06", "ali", "Ali Market", [{ product: "cay", name: "Çay", unit: "paket", qty: 10, price: 25000, cost: 190000 }], { voided: { by: "u", reason: "x" } }),
  { type: "purchase", date: "2026-10-01", party: "dogu", partyName: "Doğu Toptan", total: 100000 },
  { type: "purchase", date: "2026-10-03", party: "usd", partyName: "Elektronik", total: 10000, currency: "USD", rate: 40.5 },
  { type: "expense", date: "2026-10-04", total: 5000, categoryName: "Yakıt" },
  { type: "expense", date: "2026-10-04", total: 2000, categoryName: "" },
  { type: "collection", date: "2026-10-05", party: "ali", total: 30000 },
  { type: "payment", date: "2026-10-05", party: "usd", total: 2000, currency: "USD", rate: 41 },
];

test("buildReport: özet rakamlar, iptaller sayılmaz, döviz TL'ye çevrilir", () => {
  const r = buildReport(MOVES);
  assert.equal(r.salesCount, 4);
  assert.equal(r.sales, 50000 + 54000 + 43000 + 9000);
  assert.equal(r.cogs, 38000 + 45000 + 19000 + 15000 + 7500);
  assert.equal(r.purchases, 100000 + 405000);
  assert.equal(r.expenses, 7000);
  assert.equal(r.collections, 30000);
  assert.equal(r.payments, 82000);
  assert.equal(inLira({ total: 100 }), 100);
});

test("buildReport: müşteri, ürün, tedarikçi ve kategori dökümleri", () => {
  const r = buildReport(MOVES);
  assert.deepEqual(r.customers.get("ali"), { name: "Ali Market", sales: 93000, profit: 93000 - 72000, count: 2 });
  assert.deepEqual(r.customers.get("veli"), { name: "Veli Bakkal", sales: 63000, profit: 63000 - 52500, count: 2 });
  assert.deepEqual(r.products.get("seker"), { name: "Şeker", unit: "çuval", qty: 4.5, revenue: 54000 + 18000 + 9000, profit: 81000 - 67500 });
  assert.equal(r.suppliers.get("usd").total, 405000);
  assert.equal(r.categories.get("Yakıt").total, 5000);
  assert.equal(r.categories.get("").total, 2000);
  assert.deepEqual(topBy(r.customers, "sales", 1).map(([id]) => id), ["ali"]);
  assert.deepEqual(r.days.get("2026-10-02"), { sales: 104000, profit: 104000 - 83000 });
});

test("salesSeries: tek ayda günler (bu ayda bugüne kadar), uzun dönemde aylar", () => {
  const r = buildReport(MOVES);
  const month = salesSeries(r.days, { from: "2026-10", to: "2026-10", today: "2026-10-26" });
  assert.equal(month.length, 26);
  assert.equal(month[0].key, "2026-10-01");
  assert.equal(month[1].sales, 104000);
  assert.equal(month[4].sales, 52000);
  assert.equal(salesSeries(r.days, { from: "2026-09", to: "2026-09", today: "2026-10-26" }).length, 30);

  const year = salesSeries(r.days, { from: "2026-01", to: "2026-12", today: "2026-10-26" });
  assert.equal(year.length, 10); // gelecek aylar yok
  assert.equal(year.at(-1).key, "2026-10");
  assert.equal(year.at(-1).sales, 156000);
  assert.equal(year[0].unit, "month");

  const all = salesSeries(r.days, { from: "", to: "9999-99", today: "2026-10-26" });
  assert.deepEqual(all.map((x) => x.key), ["2026-10"]);
  const empty = salesSeries(new Map(), { from: "", to: "9999-99", today: "2026-10-26" });
  assert.deepEqual(empty.map((x) => x.key), ["2026-10"]);
});

test("groupTotals, salesVat, monthsInRange; hareket listesi en yeni üstte ve iptalsiz", () => {
  const r = buildReport(MOVES);
  assert.equal(r.moves.length, MOVES.length - 1);
  assert.equal(r.moves[0].date, "2026-10-05");
  const pays = groupTotals(r.moves.filter((m) => m.type === "payment"), (m) => m.party, (m) => m.partyName);
  assert.deepEqual(pays.get("usd"), { name: "", total: 82000, count: 1 });
  const vat = salesVat(MOVES, (id) => (id === "cay" ? 20 : 1));
  assert.equal(vat.gross, 50000 + 54000 + 43000 + 9000);
  assert.deepEqual(vat.byRate.map((x) => x.rate), [1, 20]);
  assert.equal(vat.net + vat.vat, vat.gross);
  const months = new Map([["2026-08", {}], ["2026-10", {}], ["2025-12", {}]]);
  assert.deepEqual(monthsInRange(months, "2026-01", "2026-12"), ["2026-10", "2026-08"]);
  assert.deepEqual(monthsInRange(months, "", "9999-99"), ["2026-10", "2026-08", "2025-12"]);
});

test("buildReport: satış iadesi satıştan, kârdan ve adetten düşer; para iadesi ayrı sayılır", () => {
  const moves = [
    sale("2026-10-02", "ali", "Ali Market", [{ product: "cay", name: "Çay", unit: "paket", qty: 2, price: 25000, cost: 38000 }]),
    { type: "saleReturn", date: "2026-10-03", party: "ali", partyName: "Ali Market", total: 25000,
      lines: [{ product: "cay", name: "Çay", unit: "paket", qty: 1, price: 25000, cost: 19000 }] },
    { type: "refund", date: "2026-10-03", party: "ali", total: 25000 },
  ];
  const r = buildReport(moves);
  assert.equal(r.sales, 25000);
  assert.equal(r.cogs, 19000);
  assert.equal(r.salesCount, 1);
  assert.equal(r.returns, 25000);
  assert.equal(r.refunds, 25000);
  assert.deepEqual(r.products.get("cay"), { name: "Çay", unit: "paket", qty: 1, revenue: 25000, profit: 6000 });
  assert.equal(r.customers.get("ali").sales, 25000);
  assert.equal(salesVat(moves, () => 20).gross, 25000);
});
