// Detaylı raporlar: Raporlar sayfasındaki resimli kutucuklar ve her birinin sayfası. Dönemin
// hareketleri report.js'te toplanır (buildReport); şu anki durum (stok, cari, kasa) canlı özetlerden gelir.

import { h, icon, formatDay, formatMonth } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { session, currentFirm, partners, person, sharePlan } from "./session.js";
import { formatMoney, formatNumber } from "./money.js";
import { sumMonths, splitBuckets, lineTotal, roundQty } from "./ledger.js";
import { moveRow, emptyState, bubbleRow, segmented, balanceText } from "./views.js";
import { openMoveDetail } from "./forms.js";
import { openParty } from "./party.js";
import { lastRate } from "./rates.js";
import { topBy, groupTotals, salesVat, monthsInRange, inLira, salesSeries } from "./report.js";

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const sec = (text) => h("h2", { class: "sec" }, text);

// Özet kutucuğu: başlık, büyük rakam, altında kısa açıklama.
export const kpi = (label, value, sub, tone = "") =>
  h("div", { class: `kpi ${tone}` }, h("span", {}, label), h("strong", {}, value), sub ? h("small", {}, sub) : null);

// Pay çubuklu döküm satırı: ad, tutar ve bütün içindeki payı.
export const shareRow = (name, value, whole, meta) => h("div", { class: "share-line" },
  h("div", { class: "pl-row" }, h("span", {}, h("bdi", {}, name), meta ? h("small", {}, ` · ${meta}`) : null), h("strong", {}, formatMoney(value))),
  h("span", { class: "share-track" }, h("span", { class: "share-fill", style: `width:${Math.max(2, pct(value, whole))}%` })));

const breakdown = (rows) => (rows.length ? h("div", { class: "card breakdown" }, rows) : null);
const plRow = (label, value, cls = "") => h("div", { class: `pl-row ${cls}` }, h("span", {}, label), h("strong", {}, value));

// Satış, maliyet, gider, kâr ve marj kartı.
export function profitCard(p) {
  return h("div", { class: "card pl" },
    plRow(t("plRevenue"), formatMoney(p.revenue)),
    plRow(t("plCogs"), `−${formatMoney(p.cogs)}`),
    plRow(t("plExpenses"), `−${formatMoney(p.expenses)}`),
    plRow(t("plProfit"), formatMoney(p.profit), `total ${p.profit < 0 ? "out" : "in"}`),
    p.revenue > 0 && plRow(t("plMargin"), `%${formatNumber(pct(p.revenue - p.cogs, p.revenue))}`, "muted"));
}

// Satış grafiği: günlük ya da aylık sütunlar; sütuna dokununca o günün satışı ve kârı yazar.
export function salesChart(series) {
  const max = Math.max(1, ...series.map((s) => s.sales));
  const label = (s) => (s.unit === "day" ? formatDay(s.key) : formatMonth(s.key));
  const caption = h("div", { class: "chart-caption", "aria-live": "polite" });
  const show = (s) => caption.replaceChildren(
    h("span", {}, label(s)), h("strong", {}, formatMoney(s.sales)),
    h("small", {}, s.sales ? `${t("plProfit")}: ${formatMoney(s.profit)}` : t("rp_noSaleThatDay")));
  let picked = null;
  const bars = series.map((s) => {
    const bar = h("button", {
      type: "button", class: "bar", "aria-label": `${label(s)}: ${formatMoney(s.sales)}`,
      onclick: () => {
        picked?.classList.remove("on");
        bar.classList.add("on");
        picked = bar;
        show(s);
      },
    }, h("span", { class: "bar-fill", style: `height:${s.sales ? Math.max(3, Math.round((s.sales / max) * 100)) : 0}%` }));
    return bar;
  });
  // Son satış olan sütun seçili başlar.
  const lastIdx = series.map((s) => s.sales > 0).lastIndexOf(true);
  if (lastIdx >= 0) bars[lastIdx].click();
  else caption.replaceChildren(h("small", {}, t("noSalesInPeriod")));
  const ends = series.length > 1 ? [series[0], series.at(-1)] : series;
  return h("div", { class: "card chart" },
    h("p", { class: "chart-title" }, t("rp_salesChart")),
    caption,
    h("div", { class: "bars", style: `--n:${series.length}` }, bars),
    h("div", { class: "chart-axis" }, ends.map((s) => h("span", {}, label(s)))));
}

// --- Kutucuklar ---------------------------------------------------------------------

export const REPORT_TILES = [
  ["all", "grid", "#4A5A62"], ["pl", "trend", "#2F6FB5"],
  ["plSummary", "pie", "#23935A"], ["cash", "wallet", "#7B4FB5"],
  ["vat", "percent", "#C8873A"], ["balances", "scale", "#4F46E5"],
  ["sales", "out", "#23935A"], ["purchases", "in", "#D4483B"],
  ["collections", "plusCircle", "#2F6FB5"], ["payments", "minusCircle", "#C2413A"],
  ["expenses", "receipt", "#B4562F"], ["returns", "undo", "#5F6B69"],
  ["topProducts", "trophy", "#B7791F"], ["position", "chart", "#3F51B5"],
];

export function reportTiles(onopen) {
  return h("div", { class: "tiles-grid report-tiles" }, REPORT_TILES.map(([id, ic, c]) =>
    h("button", { type: "button", class: "tile-small", style: `--c:${c}`, onclick: () => onopen(id) },
      h("span", { class: "tile-ic" }, icon(ic)), h("span", {}, t(`rpt_${id}`)))));
}

// --- Sayfalar -------------------------------------------------------------------------

// Hareket listesi (dokununca ayrıntı) ya da boş yazısı.
const movesList = (moves, max = 200) => (moves.length
  ? h("ul", { class: "cards" }, moves.slice(0, max).map((m) => moveRow(m, { onclick: () => openMoveDetail(m) })))
  : emptyState("📒", t("rp_noData")));

const ofType = (r, ...types) => r.moves.filter((m) => types.includes(m.type));
const partyName = (m) => m.partyName || "?";
const holderName = (m) => person(currentFirm(), m.holder).name;

// Tüm İşlemler: tür baloncuklarıyla süzülen liste.
const ALL_GROUPS = [
  ["sales", ["sale", "consignSale"]], ["purchases", ["purchase"]], ["collections", ["collection"]],
  ["payments", ["payment"]], ["expenses", ["expense"]], ["consign", ["consign", "return"]],
  ["cash", ["capitalIn", "withdraw", "transfer"]],
];
let allGroup = "";
let productSort = "qty";
let balanceKind = "seller";

const PAGES = {
  all(r, { rerender }) {
    const counts = new Map(ALL_GROUPS.map(([g, types]) => [g, r.moves.filter((m) => types.includes(m.type)).length]));
    const options = [["", t("filterAll"), r.moves.length],
      ...ALL_GROUPS.filter(([g]) => counts.get(g)).map(([g]) => [g, t(g === "cash" ? "trashCash" : `page_${g}`), counts.get(g)])];
    const types = ALL_GROUPS.find(([g]) => g === allGroup)?.[1];
    return [bubbleRow(options, allGroup, (v) => { allGroup = v; rerender(); }), movesList(types ? r.moves.filter((m) => types.includes(m.type)) : r.moves)];
  },

  pl(r, { p, from, to }) {
    const { months } = session.firm;
    return [profitCard(p), sec(t("rp_byMonth")), ...monthsInRange(months, from, to).map((key) => {
      const m = sumMonths(months, key, key);
      return h("div", { class: "card pl month-pl" },
        h("p", { class: "chart-title" }, formatMonth(key)),
        plRow(t("plRevenue"), formatMoney(m.revenue)),
        plRow(t("plCogs"), `−${formatMoney(m.cogs)}`),
        plRow(t("plExpenses"), `−${formatMoney(m.expenses)}`),
        plRow(t("plProfit"), formatMoney(m.profit), `total ${m.profit < 0 ? "out" : "in"}`));
    })];
  },

  plSummary(r, { p }) {
    const firm = currentFirm();
    const plan = sharePlan(firm);
    const buckets = Object.entries(p.by ?? {}).filter(([, b]) => b.revenue || b.cogs || b.expenses);
    const shares = splitBuckets(p.by ?? {}, plan);
    return [
      profitCard(p),
      buckets.length > 1 && sec(t("rp_buckets")),
      buckets.length > 1 && breakdown(buckets.map(([id, b]) =>
        plRow(id === "general" ? t("generalShares") : firm.deals?.[id]?.name ?? t("deletedDeal"), formatMoney(b.profit), b.profit < 0 ? "out" : "in"))),
      sec(t("rp_partnerShares")),
      breakdown(partners(firm).map((x) => plRow(x.name, formatMoney(shares.get(x.uid) ?? 0)))),
    ];
  },

  cash(r) {
    const firm = currentFirm();
    const { accounts } = session.firm;
    const inTypes = ["collection", "capitalIn"];
    const outTypes = ["payment", "expense", "withdraw"];
    const moneyIn = sum(ofType(r, ...inTypes), inLira);
    const moneyOut = sum(ofType(r, ...outTypes), inLira);
    const cashNow = sum(firm.members, (uid) => accounts.get(uid)?.cash ?? 0);
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_moneyIn"), formatMoney(moneyIn), null, "green"),
        kpi(t("rp_moneyOut"), formatMoney(moneyOut), null, "red"),
        kpi(t("rp_net"), formatMoney(moneyIn - moneyOut), null, moneyIn - moneyOut < 0 ? "red" : "green"),
        kpi(t("cashTotal"), formatMoney(cashNow), t("rp_now"), "blue")),
      sec(t("rp_cashNow")),
      breakdown(firm.members.map((uid) => plRow(person(firm, uid).name, formatMoney(accounts.get(uid)?.cash ?? 0)))),
      sec(t("rp_moneyMoves")),
      movesList(ofType(r, ...inTypes, ...outTypes, "transfer")),
    ];
  },

  vat(r) {
    const firm = currentFirm();
    const rateOf = (id) => session.firm.products.get(id)?.vat ?? firm.defaultVat ?? 20;
    const v = salesVat(r.moves, rateOf);
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_vatNet"), formatMoney(v.net), null, "blue"),
        kpi(t("rp_vatAmount"), formatMoney(v.vat), null, "amber")),
      sec(t("rp_vatByRate")),
      v.byRate.length ? h("div", { class: "card breakdown" }, v.byRate.map((x) =>
        plRow(`%${formatNumber(x.rate)} · ${t("rp_vatNet")} ${formatMoney(x.net)}`, formatMoney(x.vat)))) : emptyState("🧾", t("noSalesInPeriod")),
      plRow(t("rp_vatGross"), formatMoney(v.gross), "total-line"),
      h("p", { class: "field-hint" }, t("rp_vatHint")),
    ];
  },

  sales(r, { from, to }) {
    const sales = ofType(r, "sale", "consignSale");
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_sales"), formatMoney(r.sales), t("rp_salesCount", { n: r.salesCount }), "green"),
        kpi(t("grossProfit"), formatMoney(r.sales - r.cogs), r.sales ? t("rp_grossMargin", { pct: formatNumber(pct(r.sales - r.cogs, r.sales)) }) : "", "green"),
        kpi(t("rp_avgSale"), formatMoney(r.salesCount ? Math.round(r.sales / r.salesCount) : 0), null, "blue"),
        kpi(t("rp_itemsSold"), formatNumber(roundQty(sum([...r.products.values()], (x) => x.qty))), null, "ink")),
      salesChart(salesSeries(r.days, { from, to, today: new Date().toISOString().slice(0, 10) })),
      sec(t("rp_byCustomer")),
      breakdown(topBy(r.customers, "sales", 20).map(([, c]) =>
        shareRow(c.name, c.sales, r.sales, `${t("rp_salesCount", { n: c.count })} · ${t("plProfit")} ${formatMoney(c.profit)}`))),
      sec(t("rp_list")),
      movesList(sales),
    ];
  },

  purchases(r) {
    const purchases = ofType(r, "purchase");
    const byProduct = new Map();
    for (const m of purchases) {
      for (const l of m.lines ?? []) {
        const cur = byProduct.get(l.product) ?? { name: l.name, unit: l.unit, qty: 0, total: 0 };
        cur.qty = roundQty(cur.qty + l.qty);
        cur.total += m.currency && m.rate ? Math.round(lineTotal(l) * m.rate) : lineTotal(l);
        byProduct.set(l.product, cur);
      }
    }
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_purchases"), formatMoney(r.purchases), t("rp_purchaseCount", { n: purchases.length }), "red"),
        kpi(t("rp_suppliersCount"), formatNumber(r.suppliers.size), null, "ink")),
      sec(t("rp_bySupplier")),
      breakdown(topBy(r.suppliers, "total", 20).map(([, s]) => shareRow(s.name, s.total, r.purchases, t("rp_purchaseCount", { n: s.count })))),
      sec(t("rp_byProduct")),
      breakdown(topBy(byProduct, "total", 20).map(([, x]) => shareRow(x.name, x.total, r.purchases, `${formatNumber(x.qty)} ${unitLabel(x.unit)}`))),
      sec(t("rp_list")),
      movesList(purchases),
    ];
  },

  returns(r) {
    const returns = ofType(r, "return");
    const total = sum(returns, (m) => m.total);
    const byProduct = new Map();
    for (const m of returns) {
      for (const l of m.lines ?? []) {
        const cur = byProduct.get(l.product) ?? { name: l.name, unit: l.unit, qty: 0, total: 0 };
        cur.qty = roundQty(cur.qty + l.qty);
        cur.total += lineTotal(l);
        byProduct.set(l.product, cur);
      }
    }
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_returnsTotal"), formatMoney(total), t("rp_returnCount", { n: returns.length }), "ink"),
        kpi(t("rp_consignGiven"), formatMoney(sum(ofType(r, "consign"), (m) => m.total)), null, "blue")),
      sec(t("rp_perCustomer")),
      breakdown(topBy(groupTotals(returns, (m) => m.party, partyName, (m) => m.total), "total", 20).map(([, g]) =>
        shareRow(g.name, g.total, total, t("rp_returnCount", { n: g.count })))),
      sec(t("rp_byProduct")),
      breakdown(topBy(byProduct, "total", 20).map(([, x]) => shareRow(x.name, x.total, total, `${formatNumber(x.qty)} ${unitLabel(x.unit)}`))),
      sec(t("rp_list")),
      movesList(returns),
    ];
  },

  collections(r) {
    const list = ofType(r, "collection");
    return [
      h("div", { class: "kpis" }, kpi(t("rp_collections"), formatMoney(r.collections), t("rp_count", { n: list.length }), "green")),
      sec(t("rp_perCustomer")),
      breakdown(topBy(groupTotals(list, (m) => m.party, partyName), "total", 20).map(([, g]) => shareRow(g.name, g.total, r.collections, t("rp_count", { n: g.count })))),
      sec(t("rp_byHolderIn")),
      breakdown(topBy(groupTotals(list, (m) => m.holder, holderName), "total").map(([, g]) => shareRow(g.name, g.total, r.collections))),
      sec(t("rp_list")),
      movesList(list),
    ];
  },

  payments(r) {
    const list = ofType(r, "payment");
    return [
      h("div", { class: "kpis" }, kpi(t("rp_payments"), formatMoney(r.payments), t("rp_count", { n: list.length }), "red")),
      sec(t("rp_perSupplier")),
      breakdown(topBy(groupTotals(list, (m) => m.party, partyName), "total", 20).map(([, g]) => shareRow(g.name, g.total, r.payments, t("rp_count", { n: g.count })))),
      sec(t("rp_byHolderOut")),
      breakdown(topBy(groupTotals(list, (m) => m.holder, holderName), "total").map(([, g]) => shareRow(g.name, g.total, r.payments))),
      sec(t("rp_list")),
      movesList(list),
    ];
  },

  expenses(r) {
    const list = ofType(r, "expense");
    return [
      h("div", { class: "kpis" }, kpi(t("plExpenses"), formatMoney(r.expenses), t("rp_count", { n: list.length }), "red")),
      sec(t("expensesByCategory")),
      breakdown(topBy(r.categories, "total", 30).map(([name, c]) => shareRow(name || t("uncategorized"), c.total, r.expenses))),
      sec(t("rp_byHolderOut")),
      breakdown(topBy(groupTotals(list, (m) => m.holder, holderName), "total").map(([, g]) => shareRow(g.name, g.total, r.expenses))),
      sec(t("rp_list")),
      movesList(list),
    ];
  },

  topProducts(r, { rerender }) {
    const field = productSort === "revenue" ? "revenue" : productSort === "profit" ? "profit" : "qty";
    const list = topBy(r.products, field, 30);
    return [
      segmented([["qty", t("rp_mostSold")], ["revenue", t("rp_mostRevenue")], ["profit", t("rp_mostProfit")]], productSort,
        (v) => { productSort = v; rerender(); }),
      list.length ? h("ol", { class: "cards rank-list" }, list.map(([, x], i) => h("li", { class: "card row" },
        h("span", { class: "rank" }, String(i + 1)),
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, x.name)),
          h("span", { class: "meta" }, `${formatNumber(x.qty)} ${unitLabel(x.unit)} · ${formatMoney(x.revenue)}`
            + (x.revenue ? ` · ${t("marginShort", { pct: formatNumber(pct(x.profit, x.revenue)) })}` : ""))),
        h("span", { class: `end ${x.profit < 0 ? "out" : "in"}` },
          h("span", { class: "amount" }, field === "qty" ? `${formatNumber(x.qty)} ${unitLabel(x.unit)}` : formatMoney(x[field])),
          h("span", { class: "after" }, t(field === "qty" ? "rp_sold" : field === "revenue" ? "rp_revenue" : "grossProfit")))))) : emptyState("🏆", t("noSalesInPeriod")),
    ];
  },

  // Mali durum (şu an): varlıklar, borçlar ve net değer. Döviz borcu son kurla TL'ye çevrilir.
  position() {
    const firm = currentFirm();
    const { products, parties, accounts } = session.firm;
    const all = [...parties.values()];
    const stock = sum([...products.values()], (x) => Math.max(x.value ?? 0, 0));
    const shelf = sum(all.filter((x) => x.kind === "seller"), (x) => sum(Object.values(x.shelf ?? {}), (s) => (s.stock > 0 ? s.value ?? 0 : 0)));
    const receivable = sum(all.filter((x) => x.kind === "seller"), (x) => Math.max(x.balance, 0));
    const cash = sum(firm.members, (uid) => accounts.get(uid)?.cash ?? 0);
    const payables = new Map();
    for (const x of all.filter((y) => y.kind === "supplier" && y.balance > 0)) {
      const c = x.currency || "TRY";
      payables.set(c, (payables.get(c) ?? 0) + x.balance);
    }
    let unknown = false;
    const payableTry = sum([...payables], ([c, v]) => {
      if (c === "TRY") return v;
      const rate = lastRate(c);
      if (!rate) unknown = true;
      return rate ? Math.round(v * rate) : 0;
    });
    const assets = stock + shelf + receivable + cash;
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_assets"), formatMoney(assets), null, "green"),
        kpi(t("rp_liabilities"), formatMoney(payableTry), null, "red")),
      sec(t("rp_assets")),
      breakdown([
        plRow(t("rp_stockValue"), formatMoney(stock)),
        plRow(t("shelfValue"), formatMoney(shelf)),
        plRow(t("receivable"), formatMoney(receivable)),
        plRow(t("cashTotal"), formatMoney(cash))]),
      sec(t("rp_liabilities")),
      breakdown([...payables].map(([c, v]) => plRow(t("rp_payableIn", { c }), formatMoney(v, c)))) ?? emptyState("✅", t("rp_noDebt")),
      plRow(t("rp_netWorth"), formatMoney(assets - payableTry), `total-line ${assets - payableTry < 0 ? "out" : "in"}`),
      h("p", { class: "field-hint" }, t(unknown ? "rp_netWorthNoRate" : "rp_netWorthHint")),
    ];
  },

  // Cari bakiyeler (şu an): müşteriler ya da tedarikçiler, en büyük bakiye üstte.
  balances(r, { rerender }) {
    const list = [...session.firm.parties.values()].filter((x) => x.kind === balanceKind)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    const open = list.filter((x) => x.balance);
    const totalOf = (sign) => sum(open.filter((x) => Math.sign(x.balance) === sign && (x.currency || "TRY") === "TRY"), (x) => Math.abs(x.balance));
    return [
      segmented([["seller", t("page_sellers")], ["supplier", t("page_suppliers")]], balanceKind, (v) => { balanceKind = v; rerender(); }, "tabs"),
      h("div", { class: "kpis balance-kpis" },
        kpi(balanceText(balanceKind, 1).label, formatMoney(totalOf(1)), null, balanceKind === "seller" ? "green" : "red"),
        kpi(balanceText(balanceKind, -1).label, formatMoney(totalOf(-1)), null, balanceKind === "seller" ? "red" : "green")),
      list.length ? h("ul", { class: "cards" }, list.map((x) => {
        const b = balanceText(x.kind, x.balance, x.currency);
        return h("li", {}, h("button", { type: "button", class: "card row", onclick: () => openParty(x.id) },
          h("span", { class: "main" }, h("span", { class: "title" }, h("bdi", {}, x.name)), x.phone && h("span", { class: "meta" }, x.phone)),
          h("span", { class: `end ${b.tone}` }, h("span", { class: "amount" }, b.amount), h("span", { class: "after" }, b.label))));
      })) : emptyState("👥", t("rp_noData")),
    ];
  },
};

// Döneme bağlı olmayan (şu anki durumu gösteren) raporlar.
export const NOW_REPORTS = ["position", "balances"];

// ctx: { r: buildReport sonucu (yükleniyorsa null), p: dönemin aylık özeti, from, to, rerender }
export function reportDetail(id, ctx) {
  const page = PAGES[id];
  if (!page) return [];
  if (!ctx.r && !NOW_REPORTS.includes(id)) return [h("p", { class: "muted center" }, "…")];
  return page(ctx.r, ctx).filter(Boolean);
}

