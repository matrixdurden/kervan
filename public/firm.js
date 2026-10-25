// İşletme ekranı: ürünler, cariler, ortak kasaları, aylık kâr ve son hareketler canlı dinlenir;
// sekmeler (Özet, Ürünler, Cariler, Kasa, Defter) bunlardan çizilir.

import {
  collection, query, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, store, toast, avatar, avatarStack, today } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { session, currentFirm, members, partners, person, sharePlan, resetFirm } from "./session.js";
import { formatMoney, formatNumber } from "./money.js";
import { avgCost, sumMonths, splitBuckets } from "./ledger.js";
import {
  moveRow, balanceText, emptyState, searchBox, byName, matches, segmented, actionButton, newestFirst,
} from "./views.js";
import {
  openProductSheet, openPartySheet, openMoveSheet, openMoveDetail, openShelfSheet, openCashSheet, openSharesSheet,
  openDealSheet, openGuestSheet, openGuestAddSheet,
} from "./forms.js";
import { openParty, refreshParty } from "./party.js";
import { productByBarcode } from "./data.js";
import { canScan, scanBarcode } from "./scanner.js";

const TABS = [["summary", "home"], ["products", "box"], ["people", "users"], ["cash", "wallet"], ["ledger", "book"]];
const PAGE = 100;

let unsubs = [];
let unsubMoves = null;
let moves = [];
let movesLimit = PAGE;
let movesReady = false;
let tab = TABS.some(([id]) => id === store.get("tab")) ? store.get("tab") : "summary";
let peopleKind = store.get("people") === "supplier" ? "supplier" : "seller";
let period = "month";
let ledgerFilter = "";
const search = { products: "", seller: "", supplier: "" };

export const currentFirmId = () => session.firm.id;

export function openFirm(id) {
  closeFirm();
  resetFirm(id);
  const docs = (snap) => new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const failed = (err) => { console.error(err); toast(t("readFailed")); };
  const listen = (name, key) => onSnapshot(collection(db, "firms", id, name), (snap) => {
    session.firm[key] = docs(snap);
    refreshFirm();
  }, failed);
  unsubs = [listen("products", "products"), listen("parties", "parties"), listen("accounts", "accounts"), listen("months", "months")];
  movesLimit = PAGE;
  listenMoves();
  renderedTab = null;
  refreshFirm();
}

function listenMoves() {
  unsubMoves?.();
  const q = query(collection(db, "firms", session.firm.id, "moves"), orderBy("at", "desc"), limit(movesLimit));
  unsubMoves = onSnapshot(q, (snap) => {
    moves = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(newestFirst);
    movesReady = true;
    refreshFirm();
  }, (err) => { console.error(err); toast(t("readFailed")); });
}

export function closeFirm() {
  for (const unsub of unsubs) unsub();
  unsubMoves?.();
  unsubs = [];
  unsubMoves = null;
  moves = [];
  movesReady = false;
  resetFirm(null);
}

export function refreshFirm() {
  const firm = currentFirm();
  if (!firm) return;
  $("#firm-title").textContent = firm.name;
  $("#firm-menu-open").replaceChildren(avatarStack(members(firm)));
  renderTabs();
  render();
  refreshParty();
}

// Dil değişince sekmenin üst kısmı da yeniden kurulsun.
export function rebuildFirm() {
  renderedTab = null;
  refreshFirm();
}

function setTab(next, options = {}) {
  tab = next;
  store.set("tab", next);
  if (options.kind) {
    peopleKind = options.kind;
    store.set("people", options.kind);
  }
  renderedTab = null;
  render();
  renderTabs();
  scrollTo(0, 0);
}

function renderTabs() {
  $("#tabs").replaceChildren(...TABS.map(([id, ic]) => h("button", {
    type: "button", "aria-current": id === tab ? "page" : null, onclick: () => setTab(id),
  }, icon(ic), h("span", {}, t(`tab_${id}`)))));
}

// Sekmenin üst kısmı (arama kutusu gibi) sadece sekme değişince kurulur ki yazarken odak kaybolmasın;
// liste kısmı her veri değişiminde yeniden çizilir.
let renderedTab = null;
let body = null;

function render() {
  const view = VIEWS[tab];
  if (renderedTab !== tab) {
    renderedTab = tab;
    body = h("div", { class: "view-body" });
    $("#view").replaceChildren(...[view.head?.(), body].filter(Boolean));
  }
  body.replaceChildren(...view.body().filter(Boolean));
}

const rerenderBody = () => body?.replaceChildren(...VIEWS[tab].body().filter(Boolean));

const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const parties = (kind) => [...session.firm.parties.values()].filter((p) => p.kind === kind);
const shelfItems = (party) => Object.entries(party.shelf ?? {}).filter(([, s]) => s.stock > 0);

// Tedarikçi borçları para birimine göre, her biri kendi satırında: ₺12.000 / $1.500
function payableText() {
  const byCurrency = new Map();
  for (const p of parties("supplier")) {
    if (p.balance > 0) byCurrency.set(p.currency || "TRY", (byCurrency.get(p.currency || "TRY") ?? 0) + p.balance);
  }
  if (!byCurrency.size) return formatMoney(0);
  return h("span", { class: "amounts" }, [...byCurrency].map(([c, v]) => h("bdi", {}, formatMoney(v, c))));
}

// --- Özet -------------------------------------------------------------------

function summaryBody() {
  const { products, accounts, months } = session.firm;
  const month = today().slice(0, 7);
  const profit = sumMonths(months, month, month).profit;
  const receivable = sum(parties("seller"), (p) => Math.max(p.balance, 0));
  const stockValue = sum([...products.values()], (p) => Math.max(p.value, 0));
  const shelfValue = sum(parties("seller"), (p) => sum(shelfItems(p), ([, s]) => s.value));
  const cash = sum([...accounts.values()], (a) => a.cash || 0);

  const tile = (label, amount, tone, onclick) =>
    h("button", { type: "button", class: `tile ${tone}`, onclick },
      h("span", { class: "tile-label" }, label), h("strong", {}, amount));

  const out = [
    h("div", { class: "tiles" },
      tile(t("receivable"), formatMoney(receivable), "in", () => setTab("people", { kind: "seller" })),
      tile(t("payable"), payableText(), "out", () => setTab("people", { kind: "supplier" })),
      tile(t("stockValue"), formatMoney(stockValue), "", () => setTab("products")),
      tile(t("shelfValue"), formatMoney(shelfValue), "", () => setTab("people", { kind: "seller" })),
      tile(t("profitThisMonth"), formatMoney(profit), profit < 0 ? "out" : "in", () => setTab("cash")),
      tile(t("cashTotal"), formatMoney(cash), "", () => setTab("cash"))),
    h("div", { class: "quicks" },
      actionButton("sale", t("quick_sale"), () => openMoveSheet("sale")),
      actionButton("collection", t("quick_collection"), () => openMoveSheet("collection")),
      actionButton("purchase", t("quick_purchase"), () => openMoveSheet("purchase")),
      actionButton("payment", t("quick_payment"), () => openMoveSheet("payment")),
      actionButton("consign", t("quick_consign"), () => openMoveSheet("consign")),
      actionButton("consignSale", t("quick_count"), () => openShelfSheet("count")),
      actionButton("return", t("quick_return"), () => openShelfSheet("return")),
      actionButton("expense", t("quick_expense"), () => openCashSheet("expense"))),
  ];

  if (!products.size || !parties("seller").length || !parties("supplier").length) out.push(startGuide());

  if (moves.length) {
    out.push(
      h("h2", { class: "sec" }, h("span", {}, t("recentMoves")),
        h("button", { type: "button", class: "link", onclick: () => setTab("ledger") }, t("allMoves"))),
      h("ul", { class: "cards" }, moves.slice(0, 8).map((m) => moveRow(m, { onclick: () => openMoveDetail(m) }))));
  }
  return out;
}

// İlk kurulumda ne yapılacağını adım adım gösterir.
function startGuide() {
  const { products } = session.firm;
  const step = (done, text, onclick) =>
    h("li", { class: done ? "done" : "" },
      h("span", { class: "step-dot" }, done ? icon("check") : null),
      h("span", { class: "main" }, text),
      !done && h("button", { type: "button", class: "small", onclick }, t("add")));
  return h("div", { class: "card guide" },
    h("p", { class: "guide-title" }, t("guideTitle")),
    h("ol", {},
      step(products.size > 0, t("guideProducts"), () => openProductSheet()),
      step(parties("seller").length > 0, t("guideSellers"), () => openPartySheet("seller")),
      step(parties("supplier").length > 0, t("guideSuppliers"), () => openPartySheet("supplier"))),
    h("p", { class: "field-hint" }, t("guideHint")));
}

// --- Ürünler ----------------------------------------------------------------

// Barkod okutunca ürün varsa açılır, yoksa o barkodla yeni ürün formu gelir.
async function scanProduct() {
  const code = await scanBarcode();
  if (!code) return;
  const p = productByBarcode(code);
  if (p) openProductSheet(p);
  else openProductSheet(null, { barcode: code });
}

function productsHead() {
  return h("div", { class: "toolbar" },
    searchBox(t("searchProducts"), search.products, (v) => { search.products = v; rerenderBody(); }),
    canScan() && h("button", { type: "button", class: "icon-btn", "aria-label": t("scanBarcode"), title: t("scanBarcode"), onclick: scanProduct }, icon("barcode")),
    h("button", { type: "button", class: "primary small", onclick: () => openProductSheet() }, "+ ", t("product")));
}

function productsBody() {
  const all = [...session.firm.products.values()].sort(byName);
  if (!all.length) return [emptyState("📦", t("noProducts"))];
  const q = search.products.trim();
  const list = all.filter((p) => matches(p.name, q) || (q && p.barcode === q));
  if (!list.length) return [emptyState("🔍", t("noMatch"))];
  return [h("ul", { class: "cards" }, list.map(productRow))];
}

function productRow(p) {
  const unit = unitLabel(p.unit);
  const badge = p.stock < 0 ? t("negativeStock") : p.stock === 0 ? t("outOfStock") : null;
  const meta = [t("inWarehouse", { n: formatNumber(p.stock), unit })];
  if (p.consigned > 0) meta.push(t("atSellers", { n: formatNumber(p.consigned) }));
  if (p.stock > 0) meta.push(`${t("avgCostShort")} ${formatMoney(avgCost(p))}`);
  return h("li", {},
    h("button", { type: "button", class: "card row", onclick: () => openProductSheet(p) },
      productThumb(p),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, p.name)),
        h("span", { class: "meta" }, meta.join(" · "))),
      h("span", { class: "end" },
        p.price ? h("span", { class: "amount" }, formatMoney(p.price)) : null,
        badge ? h("span", { class: "badge warn" }, badge) : h("span", { class: "after" }, t("perUnit", { unit })))));
}

// Ürünün küçük fotoğrafı; yoksa adının baş harfi.
function productThumb(p) {
  return p.thumb
    ? h("img", { class: "thumb", src: p.thumb, alt: "", loading: "lazy" })
    : h("span", { class: "thumb blank", "aria-hidden": "true" }, p.name.charAt(0).toLocaleUpperCase("tr"));
}

// --- Cariler (satıcılar ve tedarikçiler) -------------------------------------------

function peopleHead() {
  return h("div", { class: "people-head" },
    segmented([["seller", t("tab_sellers")], ["supplier", t("tab_suppliers")]], peopleKind, (v) => {
      peopleKind = v;
      store.set("people", v);
      renderedTab = null;
      render();
    }),
    h("div", { class: "toolbar" },
      searchBox(t(peopleKind === "seller" ? "searchSellers" : "searchSuppliers"), search[peopleKind], (v) => {
        search[peopleKind] = v;
        rerenderBody();
      }),
      h("button", { type: "button", class: "primary small", onclick: () => openPartySheet(peopleKind) }, "+ ", t(peopleKind))));
}

function peopleBody() {
  const kind = peopleKind;
  const all = parties(kind).sort(byName);
  if (!all.length) return [emptyState(kind === "seller" ? "🏪" : "🚚", t(kind === "seller" ? "noSellers" : "noSuppliers"))];
  const q = search[kind];
  const list = all.filter((p) => matches(p.name, q) || matches(p.phone, q));
  return [
    h("p", { class: "total-line" },
      h("span", {}, t(kind === "seller" ? "totalReceivable" : "totalPayable")),
      h("strong", {}, kind === "seller" ? formatMoney(sum(all, (p) => Math.max(p.balance, 0))) : payableText())),
    list.length ? h("ul", { class: "cards" }, list.map(partyRow)) : emptyState("🔍", t("noMatch")),
  ];
}

function partyRow(p) {
  const b = balanceText(p.kind, p.balance, p.currency);
  const items = shelfItems(p);
  const meta = [p.phone || p.note, items.length ? t("onShelfCount", { n: items.length }) : null].filter(Boolean);
  return h("li", {},
    h("button", { type: "button", class: "card row", onclick: () => openParty(p.id) },
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, p.name)),
        meta.length > 0 && h("span", { class: "meta" }, h("bdi", {}, meta.join(" · ")))),
      h("span", { class: `end ${b.tone}` },
        h("span", { class: "amount" }, b.amount),
        h("span", { class: "after" }, b.label))));
}

// --- Kasa: kâr, ortaklar ve paraları ---------------------------------------------

function periodRange() {
  const now = today();
  const y = Number(now.slice(0, 4));
  const m = Number(now.slice(5, 7));
  const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}`;
  if (period === "month") return [ym(y, m), ym(y, m)];
  if (period === "lastMonth") return m === 1 ? [ym(y - 1, 12), ym(y - 1, 12)] : [ym(y, m - 1), ym(y, m - 1)];
  if (period === "year") return [ym(y, 1), ym(y, 12)];
  return ["", "9999-99"];
}

function cashHead() {
  return segmented([
    ["month", t("period_month")], ["lastMonth", t("period_lastMonth")], ["year", t("period_year")], ["all", t("period_all")],
  ], period, (v) => { period = v; rerenderBody(); });
}

function cashBody() {
  const firm = currentFirm();
  const { accounts, months, products } = session.firm;
  const [from, to] = periodRange();
  const period = sumMonths(months, from, to);
  const allTime = sumMonths(months);
  const plan = sharePlan(firm);
  const periodShare = splitBuckets(period.by, plan);
  const allShare = splitBuckets(allTime.by, plan);
  const people = partners(firm);
  const cashTotal = sum(firm.members, (uid) => accounts.get(uid)?.cash ?? 0);
  const deals = Object.entries(firm.deals ?? {});

  const row = (label, value, cls = "") => h("div", { class: `pl-row ${cls}` }, h("span", {}, label), h("strong", {}, value));
  // "Ali %50 · Kuzen %50"
  const sharesText = ({ ids, shares }) => ids.map((id) => {
    const pct = shares[id] ?? Math.round((100 / ids.length) * 10) / 10;
    return `${person(firm, id).name} %${formatNumber(pct)}`;
  }).join(" · ");
  const bucketProfit = (bucket) => period.by[bucket]?.profit ?? 0;

  const out = [
    h("div", { class: "card pl" },
      row(t("plRevenue"), formatMoney(period.revenue)),
      row(t("plCogs"), `−${formatMoney(period.cogs)}`),
      row(t("plExpenses"), `−${formatMoney(period.expenses)}`),
      row(t("plProfit"), formatMoney(period.profit), `total ${period.profit < 0 ? "out" : "in"}`)),
    h("div", { class: "quicks" },
      actionButton("expense", t("quick_expense"), () => openCashSheet("expense")),
      actionButton("capitalIn", t("quick_capitalIn"), () => openCashSheet("capitalIn")),
      actionButton("withdraw", t("quick_withdraw"), () => openCashSheet("withdraw")),
      actionButton("transfer", t("quick_transfer"), () => openCashSheet("transfer"), firm.members.length < 2)),
  ];

  // Ortaklıklar: genel paylar ve ürün ortaklıkları, her birinin bu dönemki kârıyla.
  const dealCard = (title, sub, shares, profit, onclick) =>
    h("li", {}, h("button", { type: "button", class: "card row deal", onclick },
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, title)),
        sub && h("span", { class: "meta sub" }, h("bdi", {}, sub)),
        h("span", { class: "meta" }, h("bdi", {}, shares))),
      h("span", { class: `end ${profit < 0 ? "out" : "in"}` },
        h("span", { class: "amount" }, formatMoney(profit)),
        h("span", { class: "after" }, t("plProfit")))));
  out.push(
    h("h2", { class: "sec" }, h("span", {}, t("deals")),
      h("button", { type: "button", class: "link", onclick: () => openDealSheet() }, `+ ${t("newDeal")}`)),
    h("ul", { class: "cards" },
      dealCard(t("generalShares"), deals.length ? t("generalSharesSub") : null, sharesText(plan("general")), bucketProfit("general"), () => openSharesSheet()),
      deals.map(([id, d]) => dealCard(
        d.name,
        (d.products ?? []).map((pid) => products.get(pid)?.name).filter(Boolean).join(", ") || t("noDealProducts"),
        sharesText(plan(id)), bucketProfit(id), () => openDealSheet(id)))),
    !deals.length && h("p", { class: "field-hint" }, t("dealsIntro")));

  // Ortaklar: uygulamadakiler ve uygulamasız olanlar.
  out.push(h("h2", { class: "sec" }, h("span", {}, t("partners")),
    h("button", { type: "button", class: "link", onclick: () => openGuestAddSheet() }, `+ ${t("addGuest")}`)));
  out.push(h("ul", { class: "cards" }, people.map((p) => {
    const acc = accounts.get(p.uid) ?? {};
    const equity = (acc.capital ?? 0) + (allShare.get(p.uid) ?? 0);
    return h("li", {}, h(p.guest ? "button" : "div", {
      type: p.guest ? "button" : null, class: "card partner", onclick: p.guest ? () => openGuestSheet(p.uid) : null,
    },
    h("div", { class: "partner-head" },
      avatar(p),
      h("strong", { class: "main" }, h("bdi", {}, p.name), p.uid === session.uid ? ` (${t("you")})` : ""),
      p.guest && h("span", { class: "badge" }, t("guest"))),
    h("div", { class: "facts" },
      fact(t("profitShare"), formatMoney(periodShare.get(p.uid) ?? 0)),
      p.guest ? null : fact(t("cashInHand"), formatMoney(acc.cash ?? 0)),
      fact(t("netCapital"), formatMoney(acc.capital ?? 0)),
      fact(t("equity"), formatMoney(equity)))));
  })));
  out.push(
    h("p", { class: "total-line" }, h("span", {}, t("cashTotal")), h("strong", {}, formatMoney(cashTotal))),
    h("p", { class: "field-hint" }, t("equityHint")));
  return out;
}

const fact = (label, value) => h("div", { class: "fact" }, h("span", {}, label), h("strong", {}, value));

// --- Defter -------------------------------------------------------------------

const FILTERS = ["sale", "collection", "purchase", "payment", "consign", "consignSale", "return", "expense", "capitalIn", "withdraw", "transfer", "opening"];

function ledgerHead() {
  const select = h("select", { "aria-label": t("filter"), onchange: (e) => { ledgerFilter = e.target.value; rerenderBody(); } },
    h("option", { value: "" }, t("allTypes")),
    FILTERS.map((type) => h("option", { value: type, selected: type === ledgerFilter }, t(`type_${type}`))));
  return h("div", { class: "toolbar" }, select);
}

function ledgerBody() {
  if (!moves.length) return [movesReady ? emptyState("📒", t("noMoves")) : null];
  const list = ledgerFilter ? moves.filter((m) => m.type === ledgerFilter) : moves;
  const out = [list.length
    ? h("ul", { class: "cards" }, list.map((m) => moveRow(m, { onclick: () => openMoveDetail(m) })))
    : emptyState("🔍", t("noMatch"))];
  if (moves.length >= movesLimit) {
    out.push(h("button", {
      type: "button", class: "block more", onclick: () => { movesLimit += PAGE; listenMoves(); },
    }, t("olderMoves")));
  }
  return out;
}

const VIEWS = {
  summary: { body: summaryBody },
  products: { head: productsHead, body: productsBody },
  people: { head: peopleHead, body: peopleBody },
  cash: { head: cashHead, body: cashBody },
  ledger: { head: ledgerHead, body: ledgerBody },
};
