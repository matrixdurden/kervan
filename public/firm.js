// İşletme ekranı: ana ekran (özet, büyük işlem düğmeleri, bölümler) ve bölüm sayfaları.
// Ürünler, cariler, ortak kasaları ve aylık kâr canlı dinlenir; sayfadaki hareket listesi
// sadece o sayfanın hareket türleri için dinlenir.

import {
  collection, query, where, orderBy, limit, onSnapshot, getDocs,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, store, toast, avatar, today } from "./ui.js";
import { t, unitLabel, lang, setLang } from "./i18n.js";
import { session, currentFirm, partners, person, sharePlan, resetFirm, myName } from "./session.js";
import { formatMoney, formatNumber } from "./money.js";
import { avgCost, sumMonths, splitBuckets, lineTotal, roundQty } from "./ledger.js";
import {
  moveRow, balanceText, emptyState, searchBox, byName, matches, segmented, newestFirst,
} from "./views.js";
import {
  openProductSheet, openPartySheet, openMoveSheet, openMoveDetail, openShelfSheet, openCashSheet, openSharesSheet,
  openDealSheet, openGuestSheet, openGuestAddSheet, openBusinessSheet, openCategoriesSheet, openAiSheet,
} from "./forms.js";
import { openInvoiceImport } from "./importer.js";
import { openParty, refreshParty } from "./party.js";
import { productByBarcode, productLabel, recompute } from "./data.js";
import { canScan, scanBarcode } from "./scanner.js";

const PAGE = 100;

let unsubs = [];
let page = null; // null: ana ekran
let pageUnsub = null;
let pageMoves = null;
let pageLimit = PAGE;
let recent = [];
let recentUnsub = null;
let period = "month";
let ledgerFilter = "";
let productFilter = "all";
let report = null; // { key, sales, expenses } dönem raporu için okunan hareketler
const search = { products: "", seller: "", supplier: "" };

export const currentFirmId = () => session.firm.id;
export const currentPage = () => page;

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
  // Ana ekrandaki "son işlemler".
  recentUnsub = onSnapshot(query(collection(db, "firms", id, "moves"), orderBy("at", "desc"), limit(6)), (snap) => {
    recent = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(newestFirst);
    if (!page) refreshFirm();
  }, failed);
  page = null;
  rendered = null;
  refreshFirm();
}

export function closeFirm() {
  for (const unsub of unsubs) unsub();
  unsubs = [];
  recentUnsub?.();
  recentUnsub = null;
  stopPageMoves();
  page = null;
  recent = [];
  resetFirm(null);
}

export function refreshFirm() {
  if (!currentFirm()) return;
  render();
  refreshParty();
}

// Dil değişince sayfanın üst kısmı da yeniden kurulsun.
export function rebuildFirm() {
  rendered = null;
  refreshFirm();
}

// --- Sayfalar arası geçiş (Android geri tuşu da çalışsın diye history kullanılır) ---

export function openPage(id, options = {}) {
  page = id;
  if (options.kind) search[options.kind] = "";
  if (options.filter) productFilter = options.filter;
  if (options.ledgerFilter !== undefined) ledgerFilter = options.ledgerFilter;
  history.pushState({ page: id }, "");
  listenPageMoves();
  rendered = null;
  render();
  scrollTo(0, 0);
}

export function closePage() {
  page = null;
  stopPageMoves();
  rendered = null;
  render();
  scrollTo(0, 0);
}

const back = () => history.back();

function stopPageMoves() {
  pageUnsub?.();
  pageUnsub = null;
  pageMoves = null;
  pageLimit = PAGE;
}

// Sayfanın hareket türleri için canlı liste.
function listenPageMoves() {
  stopPageMoves();
  const types = PAGES[page]?.types;
  if (!types) return;
  const col = collection(db, "firms", session.firm.id, "moves");
  const q = types === "all"
    ? query(col, orderBy("at", "desc"), limit(pageLimit))
    : query(col, where("type", "in", types), orderBy("at", "desc"), limit(pageLimit));
  pageUnsub = onSnapshot(q, (snap) => {
    pageMoves = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(newestFirst);
    refreshFirm();
  }, (err) => { console.error(err); toast(t("readFailed")); });
}

// --- Çizim -----------------------------------------------------------------------
// Sayfanın üst kısmı (başlık, arama kutusu) sadece sayfa değişince kurulur ki yazarken odak kaybolmasın;
// içerik her veri değişiminde yeniden çizilir.

let rendered = null;
let body = null;

function render() {
  const key = page ?? "home";
  const view = page ? PAGES[page] : HOME;
  if (rendered !== key) {
    rendered = key;
    body = h("div", { class: "view-body" });
    $("#firm-top").replaceChildren(...view.top().filter(Boolean));
    $("#view").replaceChildren(...[view.head?.(), body].filter(Boolean));
    $("#firm").classList.toggle("home", !page);
  } else if (!page) {
    $("#firm-top").replaceChildren(...view.top().filter(Boolean)); // zil sayısı değişebilir
  }
  body.replaceChildren(...view.body().filter(Boolean));
}

const rerenderBody = () => body?.replaceChildren(...(page ? PAGES[page] : HOME).body().filter(Boolean));

const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const parties = (kind) => [...session.firm.parties.values()].filter((p) => p.kind === kind);
const shelfItems = (party) => Object.entries(party.shelf ?? {}).filter(([, s]) => s.stock > 0);
const fact = (label, value) => h("div", { class: "fact" }, h("span", {}, label), h("strong", {}, value));

export const isLow = (p) => p.minStock > 0 && p.stock <= p.minStock;
const lowProducts = () => [...session.firm.products.values()].filter(isLow).sort(byName);

// Satış fiyatına göre kâr marjı (%): (satış − maliyet) / satış.
export function marginOf(p) {
  const cost = p.stock > 0 ? avgCost(p) : p.lastCost;
  if (!p.price || !cost) return null;
  return Math.round(((p.price - cost) / p.price) * 1000) / 10;
}

// Tedarikçi borçları para birimine göre, her biri kendi satırında: ₺12.000 / $1.500
function payableText() {
  const byCurrency = new Map();
  for (const p of parties("supplier")) {
    if (p.balance > 0) byCurrency.set(p.currency || "TRY", (byCurrency.get(p.currency || "TRY") ?? 0) + p.balance);
  }
  if (!byCurrency.size) return formatMoney(0);
  return h("span", { class: "amounts" }, [...byCurrency].map(([c, v]) => h("bdi", {}, formatMoney(v, c))));
}

// İşletme logosu ya da adının baş harfi.
export function firmMark(firm, size = "") {
  return firm.logo
    ? h("img", { class: `firm-mark ${size}`, src: firm.logo, alt: "" })
    : h("span", { class: `firm-mark ${size}`, "aria-hidden": "true" }, firm.name.charAt(0).toLocaleUpperCase("tr"));
}

// Sayfa başlığı: geri, başlık, (varsa) sağda bir düğme.
function pageTop(title, extra) {
  return [
    h("button", { type: "button", class: "icon back", "aria-label": t("back"), onclick: back }, icon("back")),
    h("h1", {}, title),
    extra ?? null,
  ].filter(Boolean);
}

// Sayfanın en üstündeki büyük işlem düğmeleri.
function bigActions(...actions) {
  return h("div", { class: "page-actions" }, actions.filter(Boolean).map(([label, ic, onclick, cls = ""]) =>
    h("button", { type: "button", class: `big-action ${cls}`, onclick }, icon(ic), h("span", {}, label))));
}

// --- Ana ekran ------------------------------------------------------------------

const TILES = [
  ["sales", "out", "tile-sale"], ["purchases", "in", "tile-purchase"],
  ["collections", "coin", "tile-collection"], ["expenses", "receipt", "tile-expense"],
];
const SECTIONS = [
  ["products", "box"], ["sellers", "store"], ["suppliers", "truck"], ["consign", "send"],
  ["payments", "coin"], ["cash", "wallet"], ["reports", "chart"], ["ledger", "book"],
  ["invoice", "fileScan"], ["settings", "gear"],
];

const HOME = {
  top() {
    const firm = currentFirm();
    const low = lowProducts().length;
    return [
      session.firms.size > 1 && h("button", { type: "button", class: "icon back", "aria-label": t("back"), onclick: back }, icon("back")),
      firmMark(firm),
      h("div", { class: "home-title" }, h("h1", {}, h("bdi", {}, firm.name)), h("small", {}, `${t("hello")}, ${myName()}`)),
      h("button", {
        type: "button", class: "icon-btn bell", "aria-label": t("lowStockTitle"),
        onclick: () => openPage("products", { filter: "low" }),
      }, icon("bell"), low ? h("span", { class: "dot" }, String(low)) : null),
      h("button", { type: "button", class: "icon-btn", "aria-label": t("page_settings"), onclick: () => openPage("settings") }, icon("gear")),
    ];
  },
  body() {
    const { products, accounts, months } = session.firm;
    const firm = currentFirm();
    const month = today().slice(0, 7);
    const profit = sumMonths(months, month, month).profit;
    const receivable = sum(parties("seller"), (p) => Math.max(p.balance, 0));
    const cash = sum(firm.members, (uid) => accounts.get(uid)?.cash ?? 0);
    const low = lowProducts();

    const stat = (label, value, tone, onclick) => h("button", { type: "button", class: `stat ${tone}`, onclick },
      h("span", {}, label), h("strong", {}, value));
    const out = [
      h("div", { class: "stats" },
        stat(t("receivable"), formatMoney(receivable), "in", () => openPage("sellers")),
        stat(t("cashTotal"), formatMoney(cash), "", () => openPage("cash")),
        stat(t("profitThisMonth"), formatMoney(profit), profit < 0 ? "out" : "in", () => openPage("reports"))),
      h("div", { class: "tiles-big" }, TILES.map(([id, ic, cls]) =>
        h("button", { type: "button", class: `tile-big ${cls}`, onclick: () => openPage(id) }, icon(ic), h("span", {}, t(`page_${id}`))))),
      low.length > 0 && h("button", { type: "button", class: "card low-banner", onclick: () => openPage("products", { filter: "low" }) },
        icon("alert"), h("span", { class: "main" },
          h("strong", {}, t("lowStockCount", { n: low.length })),
          h("small", {}, low.slice(0, 3).map(productLabel).join(", ") + (low.length > 3 ? "…" : ""))),
        icon("chevron")),
      h("div", { class: "tiles-grid" }, SECTIONS.map(([id, ic]) =>
        h("button", { type: "button", class: "tile-small", onclick: () => (id === "invoice" ? openInvoiceImport() : openPage(id)) },
          icon(ic), h("span", {}, t(`page_${id}`))))),
    ];
    if (!products.size || !parties("seller").length || !parties("supplier").length) out.push(startGuide());
    if (recent.length) {
      out.push(
        h("h2", { class: "sec" }, h("span", {}, t("recentMoves")),
          h("button", { type: "button", class: "link", onclick: () => openPage("ledger") }, t("allMoves"))),
        h("ul", { class: "cards" }, recent.slice(0, 5).map((m) => moveRow(m, { onclick: () => openMoveDetail(m) }))));
    }
    return out;
  },
};

// İlk kurulumda ne yapılacağını adım adım gösterir.
function startGuide() {
  const { products } = session.firm;
  const firm = currentFirm();
  const step = (done, text, onclick) =>
    h("li", { class: done ? "done" : "" },
      h("span", { class: "step-dot" }, done ? icon("check") : null),
      h("span", { class: "main" }, text),
      !done && h("button", { type: "button", class: "small", onclick }, t("add")));
  return h("div", { class: "card guide" },
    h("p", { class: "guide-title" }, t("guideTitle")),
    h("ol", {},
      step(Boolean(firm.logo || firm.info?.title), t("guideBusiness"), () => openBusinessSheet()),
      step(products.size > 0, t("guideProducts"), () => openProductSheet()),
      step(parties("seller").length > 0, t("guideSellers"), () => openPartySheet("seller")),
      step(parties("supplier").length > 0, t("guideSuppliers"), () => openPartySheet("supplier"))),
    h("p", { class: "field-hint" }, t("guideHint")));
}

// --- Hareket listesi sayfaları (Satışlar, Alışlar, Tahsilatlar, Ödemeler, Giderler, Emanet, Defter) ---

function movesList({ emptyText = t("noMoves"), filter } = {}) {
  if (!pageMoves) return [];
  const list = filter ? pageMoves.filter(filter) : pageMoves;
  const out = [list.length
    ? h("ul", { class: "cards" }, list.map((m) => moveRow(m, { onclick: () => openMoveDetail(m) })))
    : emptyState("📒", emptyText)];
  if (pageMoves.length >= pageLimit) {
    out.push(h("button", { type: "button", class: "block more", onclick: () => { pageLimit += PAGE; listenPageMoves(); } }, t("olderMoves")));
  }
  return out;
}

// Bu ayın toplamı (listedeki iptal edilmemiş hareketlerden).
function monthTotal(types) {
  const month = today().slice(0, 7);
  const total = sum((pageMoves ?? []).filter((m) => types.includes(m.type) && !m.voided && m.date.startsWith(month)), (m) => m.total);
  return h("p", { class: "total-line" }, h("span", {}, t("thisMonthTotal")), h("strong", {}, formatMoney(total)));
}

const movesPage = ({ types, actions, empty, summary }) => ({
  types,
  top: () => pageTop(t(`page_${page}`)),
  head: () => bigActions(...actions()),
  body: () => [summary?.() ?? monthTotal(types), ...movesList({ emptyText: t(empty) })],
});

// --- Ürünler --------------------------------------------------------------------------

async function scanProduct() {
  const code = await scanBarcode();
  if (!code) return;
  const p = productByBarcode(code);
  if (p) openProductSheet(p);
  else openProductSheet(null, { barcode: code });
}

// Ürünün küçük fotoğrafı; yoksa adının baş harfi.
export function productThumb(p, size = "") {
  return p.thumb
    ? h("img", { class: `thumb ${size}`, src: p.thumb, alt: "", loading: "lazy" })
    : h("span", { class: `thumb blank ${size}`, "aria-hidden": "true" }, p.name.charAt(0).toLocaleUpperCase("tr"));
}

const productsPage = {
  top: () => pageTop(t("page_products")),
  head: () => h("div", { class: "page-head" },
    bigActions([t("newProduct"), "plus", () => openProductSheet(), "primary"]),
    h("div", { class: "toolbar" },
      searchBox(t("searchProducts"), search.products, (v) => { search.products = v; rerenderBody(); }),
      canScan() && h("button", { type: "button", class: "icon-btn", "aria-label": t("scanBarcode"), title: t("scanBarcode"), onclick: scanProduct }, icon("barcode"))),
    segmented([["all", t("filterAll")], ["low", t("filterLow")]], productFilter, (v) => { productFilter = v; rerenderBody(); })),
  body() {
    const all = [...session.firm.products.values()];
    if (!all.length) return [emptyState("📦", t("noProducts"))];
    const q = search.products.trim();
    const list = all
      .filter((p) => matches(productLabel(p), q) || (q && p.barcode === q))
      .filter((p) => productFilter !== "low" || isLow(p));
    if (!list.length) return [emptyState(productFilter === "low" ? "✅" : "🔍", t(productFilter === "low" ? "noLowStock" : "noMatch"))];
    // Çeşitler (renk, beden…) aynı grupta tek kartta gösterilir.
    const groups = new Map();
    for (const p of list.sort(byName)) {
      const key = p.groupId || p.id;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [h("ul", { class: "cards" }, [...groups.values()].map((items) => (items.length === 1 && !items[0].variant ? productRow(items[0]) : groupCard(items))))];
  },
};

function productMeta(p) {
  const unit = unitLabel(p.unit);
  const meta = [t("inWarehouse", { n: formatNumber(p.stock), unit })];
  if (p.consigned > 0) meta.push(t("atSellers", { n: formatNumber(p.consigned) }));
  const margin = marginOf(p);
  if (margin != null) meta.push(t("marginShort", { pct: formatNumber(margin) }));
  return meta.join(" · ");
}

function stockBadge(p) {
  if (p.stock < 0) return h("span", { class: "badge warn" }, t("negativeStock"));
  if (p.stock === 0) return h("span", { class: "badge warn" }, t("outOfStock"));
  if (isLow(p)) return h("span", { class: "badge warn" }, t("lowStock"));
  return null;
}

function productRow(p) {
  return h("li", {},
    h("button", { type: "button", class: "card row", onclick: () => openProductSheet(p) },
      productThumb(p),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        h("span", { class: "meta" }, productMeta(p))),
      h("span", { class: "end" },
        p.price ? h("span", { class: "amount" }, formatMoney(p.price)) : null,
        stockBadge(p) ?? h("span", { class: "after" }, t("perUnit", { unit: unitLabel(p.unit) })))));
}

// Çeşitli ürün: üstte ortak ad ve toplam stok, altında her çeşit kendi satırında.
function groupCard(items) {
  const first = items.find((p) => p.thumb) ?? items[0];
  const total = roundQty(sum(items, (p) => p.stock));
  return h("li", { class: "card group" },
    h("div", { class: "group-head" },
      productThumb(first),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, items[0].name)),
        h("span", { class: "meta" }, t("variantCount", { n: items.length, stock: formatNumber(total), unit: unitLabel(items[0].unit) })))),
    h("div", { class: "variants" }, items.map((p) => h("button", { type: "button", class: "variant", onclick: () => openProductSheet(p) },
      h("bdi", { class: "v-name" }, p.variant || t("variantDefault")),
      h("span", { class: "v-stock" }, `${formatNumber(p.stock)} ${unitLabel(p.unit)}`),
      p.price ? h("span", { class: "v-price" }, formatMoney(p.price)) : null,
      stockBadge(p)))));
}

// --- Satıcılar ve tedarikçiler -----------------------------------------------------------

export function partyAvatar(p) {
  return p.thumb
    ? h("img", { class: "thumb round", src: p.thumb, alt: "", loading: "lazy" })
    : h("span", { class: "thumb blank round", "aria-hidden": "true" }, p.name.charAt(0).toLocaleUpperCase("tr"));
}

const partiesPage = (kind) => ({
  top: () => pageTop(t(kind === "seller" ? "page_sellers" : "page_suppliers")),
  head: () => h("div", { class: "page-head" },
    bigActions([t(kind === "seller" ? "newSeller" : "newSupplier"), "plus", () => openPartySheet(kind), "primary"]),
    h("div", { class: "toolbar" },
      searchBox(t(kind === "seller" ? "searchSellers" : "searchSuppliers"), search[kind], (v) => { search[kind] = v; rerenderBody(); }))),
  body() {
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
  },
});

function partyRow(p) {
  const b = balanceText(p.kind, p.balance, p.currency);
  const items = shelfItems(p);
  const meta = [p.phone || p.note, items.length ? t("onShelfCount", { n: items.length }) : null].filter(Boolean);
  return h("li", {},
    h("button", { type: "button", class: "card row", onclick: () => openParty(p.id) },
      partyAvatar(p),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, p.name)),
        meta.length > 0 && h("span", { class: "meta" }, h("bdi", {}, meta.join(" · ")))),
      h("span", { class: `end ${b.tone}` },
        h("span", { class: "amount" }, b.amount),
        h("span", { class: "after" }, b.label))));
}

// --- Emanet: satıcılardaki mal ------------------------------------------------------------

const consignPage = {
  types: ["consign", "consignSale", "return"],
  top: () => pageTop(t("page_consign")),
  head: () => bigActions(
    [t("quick_consign"), "send", () => openMoveSheet("consign"), "primary"],
    [t("quick_count"), "clipboard", () => openShelfSheet("count")],
    [t("quick_return"), "undo", () => openShelfSheet("return")]),
  body() {
    const sellers = parties("seller").filter((p) => shelfItems(p).length).sort(byName);
    const out = [h("p", { class: "field-hint" }, t("consignIntro"))];
    if (sellers.length) {
      out.push(h("h2", { class: "sec" }, t("sellersWithShelf")), h("ul", { class: "cards" }, sellers.map((p) => {
        const items = shelfItems(p);
        const value = sum(items, ([, s]) => Math.round(s.stock * s.price));
        return h("li", {}, h("button", { type: "button", class: "card row", onclick: () => openParty(p.id) },
          partyAvatar(p),
          h("span", { class: "main" },
            h("span", { class: "title" }, h("bdi", {}, p.name)),
            h("span", { class: "meta" }, t("onShelfCount", { n: items.length }))),
          h("span", { class: "end" }, h("span", { class: "amount" }, formatMoney(value)))));
      })));
    }
    out.push(h("h2", { class: "sec" }, t("recentMoves")), ...movesList({ emptyText: t("noConsignMoves") }));
    return out;
  },
};

// --- Giderler --------------------------------------------------------------------------

const expensesPage = {
  types: ["expense"],
  top: () => pageTop(t("page_expenses")),
  head: () => bigActions([t("new_expense"), "plus", () => openCashSheet("expense"), "primary"],
    [t("expenseCategories"), "tag", () => openCategoriesSheet()]),
  body() {
    // Bu ayın giderleri kategoriye göre.
    const month = today().slice(0, 7);
    const byCat = new Map();
    for (const m of (pageMoves ?? []).filter((x) => !x.voided && x.date.startsWith(month))) {
      const key = m.categoryName || t("uncategorized");
      byCat.set(key, (byCat.get(key) ?? 0) + m.total);
    }
    const out = [monthTotal(["expense"])];
    if (byCat.size) {
      out.push(h("div", { class: "card breakdown" }, [...byCat].sort((a, b) => b[1] - a[1]).map(([name, v]) =>
        h("div", { class: "pl-row" }, h("span", {}, h("bdi", {}, name)), h("strong", {}, formatMoney(v))))));
    }
    return [...out, ...movesList({ emptyText: t("noExpenses") })];
  },
};

// --- Kasa: kâr, ortaklıklar, ortaklar ve paraları ---------------------------------------------

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

const periodSeg = (onchange) => segmented([
  ["month", t("period_month")], ["lastMonth", t("period_lastMonth")], ["year", t("period_year")], ["all", t("period_all")],
], period, (v) => { period = v; onchange(); });

function profitCard(p) {
  const row = (label, value, cls = "") => h("div", { class: `pl-row ${cls}` }, h("span", {}, label), h("strong", {}, value));
  return h("div", { class: "card pl" },
    row(t("plRevenue"), formatMoney(p.revenue)),
    row(t("plCogs"), `−${formatMoney(p.cogs)}`),
    row(t("plExpenses"), `−${formatMoney(p.expenses)}`),
    row(t("plProfit"), formatMoney(p.profit), `total ${p.profit < 0 ? "out" : "in"}`),
    p.revenue > 0 && row(t("plMargin"), `%${formatNumber(Math.round(((p.revenue - p.cogs) / p.revenue) * 1000) / 10)}`, "muted"));
}

const cashPage = {
  top: () => pageTop(t("page_cash")),
  head: () => h("div", { class: "page-head" },
    bigActions(
      [t("quick_capitalIn"), "plusCircle", () => openCashSheet("capitalIn")],
      [t("quick_withdraw"), "minusCircle", () => openCashSheet("withdraw")],
      currentFirm().members.length > 1 && [t("quick_transfer"), "swap", () => openCashSheet("transfer")]),
    periodSeg(rerenderBody)),
  body() {
    const firm = currentFirm();
    const { accounts, months, products } = session.firm;
    const [from, to] = periodRange();
    const p = sumMonths(months, from, to);
    const allTime = sumMonths(months);
    const plan = sharePlan(firm);
    const periodShare = splitBuckets(p.by, plan);
    const allShare = splitBuckets(allTime.by, plan);
    const deals = Object.entries(firm.deals ?? {});
    // "Ali %50 · Kuzen %50"
    const sharesText = ({ ids, shares }) => ids.map((id) => {
      const pct = shares[id] ?? Math.round((100 / ids.length) * 10) / 10;
      return `${person(firm, id).name} %${formatNumber(pct)}`;
    }).join(" · ");
    const bucketProfit = (bucket) => p.by[bucket]?.profit ?? 0;
    const dealCard = (title, sub, shares, profit, onclick) =>
      h("li", {}, h("button", { type: "button", class: "card row deal", onclick },
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, title)),
          sub && h("span", { class: "meta sub" }, h("bdi", {}, sub)),
          h("span", { class: "meta" }, h("bdi", {}, shares))),
        h("span", { class: `end ${profit < 0 ? "out" : "in"}` },
          h("span", { class: "amount" }, formatMoney(profit)),
          h("span", { class: "after" }, t("plProfit")))));

    return [
      profitCard(p),
      h("h2", { class: "sec" }, h("span", {}, t("deals")),
        h("button", { type: "button", class: "link", onclick: () => openDealSheet() }, `+ ${t("newDeal")}`)),
      h("ul", { class: "cards" },
        dealCard(t("generalShares"), deals.length ? t("generalSharesSub") : null, sharesText(plan("general")), bucketProfit("general"), () => openSharesSheet()),
        deals.map(([id, d]) => dealCard(
          d.name,
          (d.products ?? []).map((pid) => productLabel(products.get(pid))).filter(Boolean).join(", ") || t("noDealProducts"),
          sharesText(plan(id)), bucketProfit(id), () => openDealSheet(id)))),
      !deals.length && h("p", { class: "field-hint" }, t("dealsIntro")),
      h("h2", { class: "sec" }, h("span", {}, t("partners")),
        h("button", { type: "button", class: "link", onclick: () => openGuestAddSheet() }, `+ ${t("addGuest")}`)),
      h("ul", { class: "cards" }, partners(firm).map((x) => {
        const acc = accounts.get(x.uid) ?? {};
        const equity = (acc.capital ?? 0) + (allShare.get(x.uid) ?? 0);
        return h("li", {}, h(x.guest ? "button" : "div", {
          type: x.guest ? "button" : null, class: "card partner", onclick: x.guest ? () => openGuestSheet(x.uid) : null,
        },
        h("div", { class: "partner-head" },
          avatar(x),
          h("strong", { class: "main" }, h("bdi", {}, x.name), x.uid === session.uid ? ` (${t("you")})` : ""),
          x.guest && h("span", { class: "badge" }, t("guest"))),
        h("div", { class: "facts" },
          fact(t("profitShare"), formatMoney(periodShare.get(x.uid) ?? 0)),
          x.guest ? null : fact(t("cashInHand"), formatMoney(acc.cash ?? 0)),
          fact(t("netCapital"), formatMoney(acc.capital ?? 0)),
          fact(t("equity"), formatMoney(equity)))));
      })),
      h("p", { class: "total-line" }, h("span", {}, t("cashTotal")),
        h("strong", {}, formatMoney(sum(firm.members, (uid) => accounts.get(uid)?.cash ?? 0)))),
      h("p", { class: "field-hint" }, t("equityHint")),
    ];
  },
};

// --- Raporlar -------------------------------------------------------------------------

// Dönemin satış ve gider hareketlerini bir kez okur (ürün ve kategori dökümü için).
async function loadReport() {
  const [from, to] = periodRange();
  const key = `${from}|${to}`;
  if (report?.key === key) return;
  report = { key, loading: true };
  try {
    const col = collection(db, "firms", session.firm.id, "moves");
    const snap = await getDocs(query(col,
      where("type", "in", ["sale", "consignSale", "expense"]),
      where("date", ">=", from ? `${from}-01` : ""), where("date", "<=", `${to}-31`)));
    const moves = snap.docs.map((d) => d.data()).filter((m) => !m.voided);
    report = { key, moves };
  } catch (err) {
    console.error(err);
    report = { key, moves: [], failed: true };
  }
  if (page === "reports") rerenderBody();
}

const reportsPage = {
  top: () => pageTop(t("page_reports")),
  head: () => periodSeg(() => { report = null; rerenderBody(); }),
  body() {
    const { months } = session.firm;
    const [from, to] = periodRange();
    loadReport();
    const out = [profitCard(sumMonths(months, from, to))];

    // En çok kâr getiren ürünler
    const byProduct = new Map();
    const byCat = new Map();
    for (const m of report?.moves ?? []) {
      if (m.type === "expense") {
        const k = m.categoryName || t("uncategorized");
        byCat.set(k, (byCat.get(k) ?? 0) + m.total);
        continue;
      }
      for (const l of m.lines ?? []) {
        const cur = byProduct.get(l.product) ?? { name: l.name, unit: l.unit, qty: 0, revenue: 0, profit: 0 };
        cur.qty = roundQty(cur.qty + l.qty);
        cur.revenue += lineTotal(l);
        cur.profit += lineTotal(l) - (l.cost ?? 0);
        byProduct.set(l.product, cur);
      }
    }
    const top = [...byProduct.values()].sort((a, b) => b.profit - a.profit).slice(0, 10);
    out.push(h("h2", { class: "sec" }, t("topProducts")));
    if (report?.loading) out.push(h("p", { class: "muted center" }, "…"));
    else if (!top.length) out.push(h("p", { class: "field-hint" }, t("noSalesInPeriod")));
    else {
      out.push(h("ul", { class: "cards" }, top.map((x) => h("li", { class: "card row" },
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, x.name)),
          h("span", { class: "meta" }, `${formatNumber(x.qty)} ${unitLabel(x.unit)} · ${formatMoney(x.revenue)}`
            + (x.revenue ? ` · ${t("marginShort", { pct: formatNumber(Math.round((x.profit / x.revenue) * 1000) / 10) })}` : ""))),
        h("span", { class: `end ${x.profit < 0 ? "out" : "in"}` },
          h("span", { class: "amount" }, formatMoney(x.profit)), h("span", { class: "after" }, t("grossProfit")))))));
    }

    if (byCat.size) {
      out.push(h("h2", { class: "sec" }, t("expensesByCategory")),
        h("div", { class: "card breakdown" }, [...byCat].sort((a, b) => b[1] - a[1]).map(([name, v]) =>
          h("div", { class: "pl-row" }, h("span", {}, h("bdi", {}, name)), h("strong", {}, formatMoney(v))))));
    }

    // En çok borcu olan satıcılar
    const debtors = parties("seller").filter((p) => p.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 5);
    if (debtors.length) out.push(h("h2", { class: "sec" }, t("topDebtors")), h("ul", { class: "cards" }, debtors.map(partyRow)));

    const low = lowProducts();
    if (low.length) out.push(h("h2", { class: "sec" }, t("lowStockTitle")), h("ul", { class: "cards" }, low.map(productRow)));
    return out;
  },
};

// --- Hareketler (defter) ---------------------------------------------------------------------

const FILTERS = ["sale", "collection", "purchase", "payment", "consign", "consignSale", "return", "expense", "capitalIn", "withdraw", "transfer", "opening"];

const ledgerPage = {
  types: "all",
  top: () => pageTop(t("page_ledger")),
  head: () => h("div", { class: "toolbar" },
    h("select", { "aria-label": t("filter"), onchange: (e) => { ledgerFilter = e.target.value; rerenderBody(); } },
      h("option", { value: "" }, t("allTypes")),
      FILTERS.map((type) => h("option", { value: type, selected: type === ledgerFilter }, t(`type_${type}`))))),
  body: () => movesList({ filter: ledgerFilter ? (m) => m.type === ledgerFilter : null }),
};

// --- Ayarlar ----------------------------------------------------------------------------

const settingsPage = {
  top: () => pageTop(t("page_settings")),
  body() {
    const firm = currentFirm();
    const item = (ic, title, sub, onclick, cls = "") => h("li", {},
      h("button", { type: "button", class: `card row setting ${cls}`, onclick },
        h("span", { class: "setting-icon" }, icon(ic)),
        h("span", { class: "main" }, h("span", { class: "title" }, title), sub && h("span", { class: "meta" }, h("bdi", {}, sub))),
        icon("chevron")));
    const cats = firm.expenseCategories;
    return [
      h("ul", { class: "cards" },
        h("li", {}, h("button", { type: "button", class: "card row setting business", onclick: () => openBusinessSheet() },
          firmMark(firm, "lg"),
          h("span", { class: "main" },
            h("span", { class: "title" }, h("bdi", {}, firm.name)),
            h("span", { class: "meta" }, firm.info?.title || t("businessInfoHint"))),
          icon("chevron"))),
        item("users", t("partnersAndInvite"), t("partnersAndInviteHint"), () => document.dispatchEvent(new Event("kervan:firm-menu"))),
        item("tag", t("expenseCategories"), cats?.length ? cats.map((c) => c.name).join(", ") : t("defaultCategoriesHint"), () => openCategoriesSheet()),
        item("fileScan", t("aiSettings"), firm.ai?.key ? t("aiReady") : t("aiNotSet"), () => openAiSheet()),
        item("wallet", t("page_cash"), t("cashSettingsHint"), () => openPage("cash"))),
      h("div", { class: "field" }, h("span", {}, t("language")),
        segmented([["tr", "Türkçe"], ["ar", "العربية"]], lang, (v) => {
          setLang(v);
          document.dispatchEvent(new Event("kervan:lang"));
          rebuildFirm();
        })),
      h("ul", { class: "cards" },
        item("refresh", t("recompute"), t("recomputeHintShort"), async () => {
          try {
            const n = await recompute();
            toast(n ? t("recomputed", { n }) : t("recomputeClean"));
          } catch (err) {
            console.error(err);
            toast(t("genericError"));
          }
        }),
        item("contact", t("account"), session.user?.email ?? "", () => document.dispatchEvent(new Event("kervan:account"))),
        item("home", t("switchFirm"), t("switchFirmHint"), () => document.dispatchEvent(new Event("kervan:firms")))),
    ];
  },
};

const PAGES = {
  sales: movesPage({
    types: ["sale", "consignSale"], empty: "noSales",
    actions: () => [[t("new_sale"), "plus", () => openMoveSheet("sale"), "primary"], [t("page_consign"), "send", () => openPage("consign")]],
  }),
  purchases: movesPage({
    types: ["purchase"], empty: "noPurchases",
    actions: () => [[t("new_purchase"), "plus", () => openMoveSheet("purchase"), "primary"], [t("page_invoice"), "fileScan", () => openInvoiceImport()]],
  }),
  collections: movesPage({
    types: ["collection"], empty: "noCollections",
    actions: () => [[t("new_collection"), "plus", () => openMoveSheet("collection"), "primary"]],
  }),
  payments: movesPage({
    types: ["payment"], empty: "noPayments",
    actions: () => [[t("new_payment"), "plus", () => openMoveSheet("payment"), "primary"]],
  }),
  expenses: expensesPage,
  consign: consignPage,
  products: productsPage,
  sellers: partiesPage("seller"),
  suppliers: partiesPage("supplier"),
  cash: cashPage,
  reports: reportsPage,
  ledger: ledgerPage,
  settings: settingsPage,
};
