import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove, revertMove, replay, moveTotal, avgCost, stockOut, shelfKey, sumMonths, splitProfit, splitBuckets,
} from "../public/ledger.js";

const D = "2026-10-25";
const buy = (product, qty, price, extra = {}) =>
  ({ type: "purchase", party: "sup", date: D, by: "ali", lines: [{ product, qty, price }], ...extra });
const sell = (product, qty, price) => ({ type: "sale", party: "sel", date: D, by: "ali", lines: [{ product, qty, price }] });
const consign = (product, qty, price) => ({ type: "consign", party: "sel", date: D, by: "ali", lines: [{ product, qty, price }] });
const counted = (product, qty, price) => ({ type: "consignSale", party: "sel", date: D, by: "ali", lines: [{ product, qty, price }] });
const giveBack = (product, qty, price) => ({ type: "return", party: "sel", date: D, by: "ali", lines: [{ product, qty, price }] });
const money = (type, amount, extra = {}) => ({ type, party: "", date: D, by: "ali", amount, ...extra });

// Hareketleri sırayla uygular, uygulamadaki gibi. Durum replay ile aynı biçimdedir.
function run(moves) {
  const s = { products: new Map(), shelves: new Map(), balances: new Map(), cash: new Map(), capital: new Map(), months: new Map() };
  const get = { product: (id) => s.products.get(id), shelf: (party, id) => s.shelves.get(shelfKey(party, id)) };
  const add = (map, k, v) => map.set(k, (map.get(k) ?? 0) + v);
  const results = [];
  for (const m of moves) {
    const fx = (m.revert ? revertMove : applyMove)(m.revert ?? m, get);
    const move = m.revert ?? m;
    for (const [id, p] of fx.products) s.products.set(id, p);
    for (const [key, sh] of fx.shelves) s.shelves.set(key, sh.next);
    if (move.party) add(s.balances, move.party, fx.balance);
    for (const [u, d] of fx.cash) add(s.cash, u, d);
    for (const [u, d] of fx.capital) add(s.capital, u, d);
    if (fx.month) {
      const cur = s.months.get(fx.month.key) ?? { revenue: 0, cogs: 0, expenses: 0 };
      s.months.set(fx.month.key, {
        revenue: cur.revenue + fx.month.revenue, cogs: cur.cogs + fx.month.cogs, expenses: cur.expenses + fx.month.expenses,
      });
    }
    results.push(fx);
  }
  return { ...s, results };
}

// Uygulandıktan sonra maliyeti yazılmış hareket (iptal testleri için).
const recorded = (move, state) => ({ ...move, lines: applyMove(move, state).lines });

test("alış stoğu ve tedarikçi borcunu artırır", () => {
  const { products, balances } = run([buy("çay", 10, 10000)]);
  assert.deepEqual(products.get("çay"), { stock: 10, value: 100000, lastCost: 10000 });
  assert.equal(balances.get("sup"), 100000);
});

test("ağırlıklı ortalama maliyet", () => {
  const { products } = run([buy("çay", 10, 10000), buy("çay", 10, 12000)]);
  assert.equal(avgCost(products.get("çay")), 11000);
});

test("satış ortalama maliyetle düşer, maliyet satıra yazılır, aylık kâra işlenir", () => {
  const { products, balances, results, months } = run([buy("çay", 10, 10000), buy("çay", 10, 12000), sell("çay", 4, 15000)]);
  assert.deepEqual(products.get("çay"), { stock: 16, value: 176000, lastCost: 12000 });
  assert.equal(results[2].lines[0].cost, 44000);
  assert.equal(balances.get("sel"), 60000);
  assert.deepEqual(months.get("2026-10"), { revenue: 60000, cogs: 44000, expenses: 0 });
});

test("ödeme ve tahsilat bakiyeyi ve ortağın kasasını değiştirir", () => {
  const { balances, cash } = run([
    buy("çay", 10, 10000),
    { ...money("payment", 30000), party: "sup" },
    sell("çay", 2, 15000),
    { ...money("collection", 10000, { holder: "veli" }), party: "sel" },
  ]);
  assert.equal(balances.get("sup"), 70000);
  assert.equal(balances.get("sel"), 20000);
  assert.equal(cash.get("ali"), -30000);
  assert.equal(cash.get("veli"), 10000);
});

test("stoktan fazla satış: eksik kısım son alış fiyatından, stok eksiye düşer", () => {
  const { product, cost } = stockOut({ stock: 2, value: 20000, lastCost: 12000 }, 5);
  assert.equal(cost, 2 * 10000 + 3 * 12000);
  assert.deepEqual(product, { stock: -3, value: 0, lastCost: 12000 });
});

test("eksi stoğa gelen mal önce açığı kapatır", () => {
  const { products } = run([sell("çay", 3, 15000), buy("çay", 10, 10000)]);
  assert.deepEqual(products.get("çay"), { stock: 7, value: 70000, lastCost: 10000 });
});

test("kesirli miktarlar yuvarlanır", () => {
  const { products } = run([buy("peynir", 0.1, 30000), buy("peynir", 0.2, 30000)]);
  assert.equal(products.get("peynir").stock, 0.3);
  assert.equal(products.get("peynir").value, 9000);
});

test("bir satışta aynı ürün iki satırda olabilir", () => {
  const sale = { ...sell("çay", 2, 15000), lines: [{ product: "çay", qty: 2, price: 15000 }, { product: "çay", qty: 3, price: 14000 }] };
  const { products, results } = run([buy("çay", 10, 10000), sale]);
  assert.equal(products.get("çay").stock, 5);
  assert.deepEqual(results[1].lines.map((l) => l.cost), [20000, 30000]);
  assert.equal(moveTotal(sale), 72000);
});

test("dövizli alış: tedarikçi borcu dövizde, maliyet o günün kuruyla TL", () => {
  const { products, balances } = run([buy("çay", 10, 300, { currency: "USD", rate: 40 })]);
  assert.equal(balances.get("sup"), 3000); // 30 $
  assert.deepEqual(products.get("çay"), { stock: 10, value: 120000, lastCost: 12000 });
});

test("dövizli ödeme: borç dövizde düşer, kasadan TL karşılığı çıkar", () => {
  const { balances, cash } = run([
    buy("çay", 10, 300, { currency: "USD", rate: 40 }),
    { ...money("payment", 1000, { currency: "USD", rate: 42.5 }), party: "sup" },
  ]);
  assert.equal(balances.get("sup"), 2000);
  assert.equal(cash.get("ali"), -42500);
});

test("emanet: mal depodan rafa geçer, borç oluşmaz", () => {
  const { products, shelves, balances } = run([buy("çay", 10, 10000), consign("çay", 6, 15000)]);
  assert.deepEqual(products.get("çay"), { stock: 4, value: 40000, lastCost: 10000 });
  assert.deepEqual(shelves.get(shelfKey("sel", "çay")), { stock: 6, value: 60000, price: 15000 });
  assert.equal(balances.get("sel"), 0);
});

test("sayım: satılan emanet borca ve kâra yazılır, iade depoya döner", () => {
  const { products, shelves, balances, months, results } = run([
    buy("çay", 10, 10000), consign("çay", 6, 15000), counted("çay", 4, 15000), giveBack("çay", 2, 15000),
  ]);
  assert.equal(results[2].lines[0].cost, 40000);
  assert.equal(balances.get("sel"), 60000);
  assert.deepEqual(months.get("2026-10"), { revenue: 60000, cogs: 40000, expenses: 0 });
  assert.equal(shelves.get(shelfKey("sel", "çay")).stock, 0);
  assert.equal(shelves.get(shelfKey("sel", "çay")).value, 0);
  assert.deepEqual(products.get("çay"), { stock: 6, value: 60000, lastCost: 10000 });
});

test("gider kârdan ve kasadan düşer; ortak parası sermayeye işlenir; devir kasalar arasında", () => {
  const { cash, capital, months } = run([
    money("capitalIn", 500000),
    money("expense", 20000),
    money("withdraw", 100000, { holder: "veli" }),
    money("transfer", 50000, { to: "veli" }),
  ]);
  assert.equal(cash.get("ali"), 500000 - 20000 - 50000);
  assert.equal(cash.get("veli"), -100000 + 50000);
  assert.equal(capital.get("ali"), 500000);
  assert.equal(capital.get("veli"), -100000);
  assert.deepEqual(months.get("2026-10"), { revenue: 0, cogs: 0, expenses: 20000 });
});

test("iptal her hareket türünde etkiyi tam geri alır", () => {
  const base = run([buy("çay", 10, 10000), buy("çay", 10, 12000), consign("çay", 5, 15000)]);
  const get = { product: (id) => base.products.get(id), shelf: (p, id) => base.shelves.get(shelfKey(p, id)) };
  const cases = [
    sell("çay", 4, 15000), consign("çay", 3, 15000), counted("çay", 2, 15000), giveBack("çay", 2, 15000),
    buy("çay", 5, 13000, { currency: "USD", rate: 40 }),
    { ...money("collection", 1000), party: "sel" }, money("expense", 500), money("transfer", 300, { to: "veli" }),
  ];
  for (const move of cases) {
    const rec = recorded(move, get);
    const after = run([...[buy("çay", 10, 10000), buy("çay", 10, 12000), consign("çay", 5, 15000)], move, { revert: rec }]);
    // Son alış fiyatı (lastCost) sadece forma öneri olduğu için iptalde eski haline dönmez.
    assert.deepEqual({ ...after.products.get("çay"), lastCost: 0 }, { ...base.products.get("çay"), lastCost: 0 }, move.type);
    assert.deepEqual(after.shelves.get(shelfKey("sel", "çay")), base.shelves.get(shelfKey("sel", "çay")), move.type);
    assert.equal(after.balances.get("sel") ?? 0, base.balances.get("sel") ?? 0, move.type);
    assert.equal(after.balances.get("sup"), base.balances.get("sup"), move.type);
    for (const uid of ["ali", "veli"]) assert.equal(after.cash.get(uid) ?? 0, 0, `${move.type} ${uid}`);
    const m = after.months.get("2026-10") ?? { revenue: 0, cogs: 0, expenses: 0 };
    assert.deepEqual(m, { revenue: 0, cogs: 0, expenses: 0 }, move.type);
  }
});

test("açılış: eldeki stok maliyetiyle girer, bakiye eksi de olabilir", () => {
  const { products, balances } = run([
    { type: "opening", party: "", date: D, lines: [{ product: "çay", qty: 20, price: 9000 }] },
    { type: "opening", party: "sel", date: D, amount: 50000 },
    { type: "opening", party: "sup", date: D, amount: -12000 },
  ]);
  assert.deepEqual(products.get("çay"), { stock: 20, value: 180000, lastCost: 9000 });
  assert.equal(balances.get("sel"), 50000);
  assert.equal(balances.get("sup"), -12000);
});

test("yeniden hesap: iptaller atlanır, sıra zamana göredir, uygulamayla aynı sonucu verir", () => {
  const moves = [
    { ...buy("çay", 10, 10000), at: 1 },
    { ...buy("çay", 10, 12000), at: 2 },
    { ...consign("çay", 6, 15000), at: 4 },
    { ...sell("çay", 4, 15000), at: 3 },
    { ...buy("çay", 100, 1), at: 5, voided: { by: "x" } },
    { ...counted("çay", 2, 15000), at: 6 },
    { ...money("collection", 10000), party: "sel", at: 7 },
    { ...money("expense", 3000), at: 8 },
  ];
  const state = replay(moves);
  const live = run(moves.filter((m) => !m.voided).sort((a, b) => a.at - b.at));
  for (const key of ["products", "shelves"]) assert.deepEqual(state[key], live[key], key);
  const totals = (map) => new Map([...map].map(([k, m]) => [k, { revenue: m.revenue, cogs: m.cogs, expenses: m.expenses }]));
  assert.deepEqual(totals(state.months), totals(live.months));
  // Sayaçlarda sıfır kalanlar replay'de hiç oluşmaz.
  const nonZero = (map) => new Map([...map].filter(([k, v]) => k && v));
  for (const key of ["balances", "cash", "capital"]) assert.deepEqual(state[key], nonZero(live[key]), key);
  assert.equal(state.balances.get("sel"), 60000 + 30000 - 10000);
});

test("dönem kârı ve ortak payları", () => {
  const months = { "2026-09": { revenue: 1000, cogs: 600, expenses: 100 }, "2026-10": { revenue: 5000, cogs: 3000, expenses: 500 } };
  assert.equal(sumMonths(months).profit, 1800);
  assert.equal(sumMonths(months, "2026-10", "2026-10").profit, 1500);
  assert.deepEqual([...splitProfit(1000, ["a", "b", "c"], { a: 50, b: 30, c: 20 })], [["a", 500], ["b", 300], ["c", 200]]);
  // Pay girilmemişse eşit; kuruş artığı sonuncuya.
  assert.deepEqual([...splitProfit(1000, ["a", "b", "c"])], [["a", 333], ["b", 333], ["c", 334]]);
  // Zararda da bölünür.
  assert.deepEqual([...splitProfit(-100, ["a", "b"], { a: 60, b: 40 })], [["a", -60], ["b", -40]]);
});

test("ürün ortaklığı: satışın kârı satırdaki ortaklığın kovasına, gider seçilen kovaya", () => {
  const moves = [
    { ...buy("çay", 10, 10000), at: 1 },
    { ...buy("şeker", 10, 5000), at: 2 },
    { type: "sale", party: "sel", date: D, by: "ali", at: 3, lines: [
      { product: "çay", qty: 2, price: 15000, deal: "d1" },
      { product: "şeker", qty: 2, price: 6000 },
    ] },
    { ...money("expense", 1000, { deal: "d1" }), at: 4 },
    { ...money("expense", 500), at: 5 },
  ];
  const { months } = replay(moves);
  const sum = sumMonths(months);
  assert.equal(sum.profit, 30000 + 12000 - 20000 - 10000 - 1500);
  assert.deepEqual(sum.by.d1, { revenue: 30000, cogs: 20000, expenses: 1000, profit: 9000 });
  assert.deepEqual(sum.by.general, { revenue: 12000, cogs: 10000, expenses: 500, profit: 1500 });

  // d1: ali %50, kuzen (uygulamasız) %50; genel: ali %100
  const plan = (bucket) => (bucket === "d1"
    ? { ids: ["ali", "kuzen"], shares: { ali: 50, kuzen: 50 } }
    : { ids: ["ali"], shares: { ali: 100 } });
  assert.deepEqual([...splitBuckets(sum.by, plan)], [["ali", 4500 + 1500], ["kuzen", 4500]]);
});

test("ortaklıktan önceki aylar genele sayılır", () => {
  const sum = sumMonths({ "2026-01": { revenue: 1000, cogs: 600, expenses: 100 } });
  assert.deepEqual(sum.by, { general: { revenue: 1000, cogs: 600, expenses: 100, profit: 300 } });
});

test("dışarıdan ortak: koyduğu para onun sermayesine, kasaya teslim alan ortağın eline", () => {
  const { cash, capital } = run([money("capitalIn", 20000, { holder: "ali", partner: "kuzen" }), money("withdraw", 5000, { holder: "ali", partner: "kuzen" })]);
  assert.equal(cash.get("ali"), 15000);
  assert.equal(capital.get("kuzen"), 15000);
  assert.equal(capital.get("ali"), undefined);
});

const takeBack = (product, qty, price) => ({ type: "saleReturn", party: "sel", date: D, by: "ali", lines: [{ product, qty, price }] });

test("satış iadesi: mal ortalama maliyetle depoya döner, borç ve aylık satış düşer", () => {
  const { products, balances, results, months } = run([buy("çay", 10, 10000), sell("çay", 4, 15000), takeBack("çay", 1, 15000)]);
  assert.deepEqual(products.get("çay"), { stock: 7, value: 70000, lastCost: 10000 });
  assert.equal(results[2].lines[0].cost, 10000);
  assert.equal(balances.get("sel"), 45000);
  assert.deepEqual(months.get("2026-10"), { revenue: 45000, cogs: 30000, expenses: 0 });
});

test("para iadesi: müşteriye verilen para kasadan çıkar, bakiyesine eklenir", () => {
  const { balances, cash } = run([
    buy("çay", 10, 10000), sell("çay", 2, 15000),
    money("collection", 30000, { party: "sel", holder: "ali" }),
    takeBack("çay", 1, 15000),
    money("refund", 15000, { party: "sel", holder: "ali" }),
  ]);
  assert.equal(balances.get("sel"), 0);
  assert.equal(cash.get("ali"), 15000);
});

test("satış iadesi iptal edilince stok, borç ve ay eski haline döner", () => {
  const state = run([buy("çay", 10, 10000), sell("çay", 4, 15000)]);
  const get = { product: (id) => state.products.get(id) };
  const move = recorded(takeBack("çay", 2, 15000), get);
  const after = run([buy("çay", 10, 10000), sell("çay", 4, 15000), move, { revert: move }]);
  assert.deepEqual(after.products.get("çay"), state.products.get("çay"));
  assert.equal(after.balances.get("sel"), state.balances.get("sel"));
  assert.deepEqual(after.months.get("2026-10"), state.months.get("2026-10"));
  assert.deepEqual(replay([buy("çay", 10, 10000), sell("çay", 4, 15000), takeBack("çay", 2, 15000)].map((m, i) => ({ ...m, at: i }))).products.get("çay"),
    { stock: 8, value: 80000, lastCost: 10000 });
});

const counted2 = (product, qty, price = 0) => ({ type: "stockCount", party: "", date: D, by: "ali", lines: [{ product, qty, price }] });

test("stok sayımı: eksik ortalama maliyetle düşer ve maliyete yazılır, fazla geri girer", () => {
  const { products, results, months, balances } = run([buy("çay", 10, 10000), counted2("çay", -2), counted2("çay", 1)]);
  assert.deepEqual(products.get("çay"), { stock: 9, value: 90000, lastCost: 10000 });
  assert.equal(results[1].lines[0].cost, -20000);
  assert.equal(results[2].lines[0].cost, 10000);
  assert.deepEqual(months.get("2026-10"), { revenue: 0, cogs: 10000, expenses: 0 });
  assert.equal(balances.get("sup"), 100000); // sayım kimsenin bakiyesine dokunmaz
});

test("stok sayımı iptal edilince stok ve kâr eski haline döner", () => {
  const base = [buy("çay", 10, 10000), sell("çay", 3, 15000)];
  const state = run(base);
  const get = { product: (id) => state.products.get(id) };
  const loss = recorded(counted2("çay", -2), get);
  const after = run([...base, loss, { revert: loss }]);
  assert.deepEqual(after.products.get("çay"), state.products.get("çay"));
  assert.deepEqual(after.months.get("2026-10"), state.months.get("2026-10"));
});
