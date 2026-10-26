// İşletme ekranı: ana ekran (özet, büyük işlem düğmeleri, bölümler) ve bölüm sayfaları.
// Ürünler, cariler, ortak kasaları ve aylık kâr canlı dinlenir; sayfadaki hareket listesi
// sadece o sayfanın hareket türleri için dinlenir.

import {
  collection, query, where, orderBy, limit, onSnapshot, getDocs,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, store, toast, avatar, today, currentTheme, applyTheme, formatDay, formatMonth } from "./ui.js";
import { t, unitLabel, lang, setLang } from "./i18n.js";
import { session, currentFirm, partners, person, sharePlan, resetFirm, myName } from "./session.js";
import { formatMoney, formatNumber } from "./money.js";
import { avgCost, sumMonths, splitBuckets, lineTotal, roundQty } from "./ledger.js";
import {
  moveRow, balanceText, emptyState, searchBox, byName, matches, segmented, newestFirst, productThumb,
  productCategories, categoryBubbles, inCategory,
} from "./views.js";
import {
  openProductSheet, openPartySheet, openMoveSheet, openMoveDetail, openShelfSheet, openCashSheet, openSharesSheet,
  openDealSheet, openGuestSheet, openGuestAddSheet, openBusinessSheet, openCategoriesSheet, openAiSheet, openOrderSheet,
} from "./forms.js";
import { openInvoiceImport } from "./importer.js";
import { openParty, refreshParty } from "./party.js";
import { productByBarcode, productLabel, recompute } from "./data.js";
import { canScan, scanBarcode } from "./scanner.js";
import { sharedAiReady } from "./ai.js";
import { REPORT_TYPES, buildReport, salesSeries, topBy } from "./report.js";

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

// Sayfanın hareket türleri için canlı liste. Çöp kutusu: silinen (iptal edilen) kayıtlar, en son silinen üstte.
function listenPageMoves() {
  stopPageMoves();
  const { types, trash } = PAGES[page] ?? {};
  if (!types && !trash) return;
  const col = collection(db, "firms", session.firm.id, "moves");
  const q = trash
    ? query(col, orderBy("voided.at", "desc"), limit(pageLimit))
    : types === "all"
      ? query(col, orderBy("at", "desc"), limit(pageLimit))
      : query(col, where("type", "in", types), orderBy("at", "desc"), limit(pageLimit));
  pageUnsub = onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    pageMoves = trash ? list : list.sort(newestFirst);
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
    $("#view").replaceChildren(...[view.head?.(), body, view.fab && fabBar(...view.fab())].filter(Boolean));
    $("#firm").classList.toggle("home", !page);
    $("#firm").classList.toggle("has-fab", Boolean(view.fab));
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

// Sayfanın üstündeki yan işlem düğmeleri (ana işlem alttaki sabit düğmededir).
function bigActions(...actions) {
  return h("div", { class: "page-actions" }, actions.filter(Boolean).map(([label, ic, onclick, cls = ""]) =>
    h("button", { type: "button", class: `big-action ${cls}`, onclick }, icon(ic), h("span", {}, label))));
}

// Sayfanın ana işlemi: ekranın altında, başparmağın yetiştiği yerde hep duran büyük düğme.
function fabBar(label, onclick) {
  return h("div", { class: "fab-bar" }, h("button", { type: "button", class: "primary block fab", onclick }, icon("plus"), h("span", {}, label)));
}

// --- Ana ekran ------------------------------------------------------------------

// Sol sütun alış tarafı (alış, ödeme, tedarikçi), sağ sütun satış tarafı (satış, tahsilat, müşteri):
// her satırda karşılıklı iki iş yan yana durur.
const TILES = [
  ["purchases", "in", "tile-purchase"], ["sales", "out", "tile-sale"],
  ["consign", "send", "tile-dark"], ["expenses", "receipt", "tile-dark"],
];
const QUICK_NEW = {
  purchases: ["new_purchase", () => openMoveSheet("purchase")],
  sales: ["new_sale", () => openMoveSheet("sale")],
  consign: ["new_consign", () => openMoveSheet("consign")],
  expenses: ["new_expense", () => openCashSheet("expense")],
};
const SECTIONS = [
  ["payments", "minusCircle"], ["collections", "plusCircle"],
  ["suppliers", "truck"], ["sellers", "store"],
  ["products", "box"], ["invoice", "fileScan"],
  ["cash", "wallet"], ["ledger", "book"],
  ["reports", "chart"], ["trash", "trash"],
  ["settings", "gear"],
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
      // Kutucuk bölümü açar; köşedeki "+" doğrudan yeni kayıt formunu (tek dokunuş).
      h("div", { class: "tiles-big" }, TILES.map(([id, ic, cls]) => h("div", { class: "tile-wrap" },
        h("button", { type: "button", class: `tile-big ${cls}`, onclick: () => openPage(id) },
          h("span", { class: "big-ic" }, icon(ic)), h("span", {}, t(`page_${id}`))),
        h("button", { type: "button", class: "tile-plus", "aria-label": t(QUICK_NEW[id][0]), title: t(QUICK_NEW[id][0]), onclick: QUICK_NEW[id][1] }, icon("plus"))))),
      low.length > 0 && h("button", { type: "button", class: "card low-banner", onclick: () => openPage("products", { filter: "low" }) },
        icon("alert"), h("span", { class: "main" },
          h("strong", {}, t("lowStockCount", { n: low.length })),
          h("small", {}, low.slice(0, 3).map(productLabel).join(", ") + (low.length > 3 ? "…" : ""))),
        icon("chevron")),
      h("div", { class: "tiles-grid" }, SECTIONS.map(([id, ic]) =>
        h("button", { type: "button", class: `tile-small tone-${id}`, onclick: () => (id === "invoice" ? openInvoiceImport() : openPage(id)) },
          h("span", { class: "tile-ic" }, icon(ic)), h("span", {}, t(`page_${id}`))))),
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

// fab: alttaki ana düğme [etiket, işlem]; actions: üstteki yan işlemler.
const movesPage = ({ types, fab, actions, empty, summary }) => ({
  types,
  fab,
  top: () => pageTop(t(`page_${page}`)),
  head: actions && (() => bigActions(...actions())),
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

// Ürünler: kategori baloncukları; "Hepsi"de kategori başlıklarıyla gruplu. Satır ya da kutucuk
// (yan yana) görünüm sağ üstten değişir ve bu cihazda hatırlanır.
let productCat = "";
let productView = store.get("productView") === "grid" ? "grid" : "list";

function viewToggle() {
  const btn = h("button", { type: "button", class: "icon-btn" });
  const paint = () => {
    const label = t(productView === "grid" ? "viewList" : "viewGrid");
    btn.replaceChildren(icon(productView === "grid" ? "rows" : "grid"));
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };
  btn.addEventListener("click", () => {
    productView = productView === "grid" ? "list" : "grid";
    store.set("productView", productView);
    paint();
    rerenderBody();
  });
  paint();
  return btn;
}

// Ürünleri seçili görünümde çizer: satırda çeşitler tek kartta, kutucukta her çeşit ayrı.
function productItems(items) {
  if (productView === "grid") return h("div", { class: "product-grid" }, items.map(productTile));
  const groups = new Map();
  for (const p of items) {
    const key = p.groupId || p.id;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return h("ul", { class: "cards" }, [...groups.values()].map((g) => (g.length === 1 && !g[0].variant ? productRow(g[0]) : groupCard(g))));
}

const productsPage = {
  fab: () => [t("newProduct"), () => openProductSheet()],
  top: () => pageTop(t("page_products"), viewToggle()),
  head: () => h("div", { class: "page-head" },
    segmented([["all", t("filterAll")], ["low", t("filterLow")]], productFilter, (v) => { productFilter = v; rerenderBody(); }, "tabs"),
    searchBox(t("searchProducts"), search.products, (v) => { search.products = v; rerenderBody(); }, canScan() ? scanProduct : null)),
  body() {
    const all = [...session.firm.products.values()];
    if (!all.length) return [emptyState("📦", t("noProducts"))];
    const q = search.products.trim();
    const base = all
      .filter((p) => matches(productLabel(p), q) || (q && p.barcode === q))
      .filter((p) => productFilter !== "low" || isLow(p))
      .sort(byName);
    const bubbles = categoryBubbles(base, productCat, (v) => { productCat = v; rerenderBody(); });
    const list = base.filter((p) => inCategory(p, productCat));
    if (!list.length) return [bubbles, emptyState(productFilter === "low" ? "✅" : "🔍", t(productFilter === "low" ? "noLowStock" : "noMatch"))];
    // Azalanlarda en üstte: hepsi için sipariş hazırla (WhatsApp) ve mal gelince alış gir.
    const order = productFilter === "low" && h("div", { class: "order-cta" },
      h("p", {}, t("orderCta", { n: list.length })),
      h("button", { type: "button", class: "ink block", onclick: () => openOrderSheet(list) }, icon("send"), t("orderPrepare")));
    // Kategori seçilmemişse ve kategori varsa: her kategori kendi başlığı altında, kategorisizler en sonda.
    const cats = productCategories(list);
    if (productCat || !cats.length) return [order, bubbles, productItems(list)];
    const loose = list.filter((p) => !p.category);
    return [order, bubbles,
      ...cats.flatMap(([c, n]) => [h("h2", { class: "sec cat-head" }, h("bdi", {}, c), h("small", {}, String(n))), productItems(list.filter((p) => p.category === c))]),
      ...(loose.length ? [h("h2", { class: "sec cat-head" }, t("noCategory"), h("small", {}, String(loose.length))), productItems(loose)] : [])];
  },
};

// Kutucuk görünümünde ürün: büyük resim, ad, fiyat ve stok rozeti.
function productTile(p) {
  return h("button", { type: "button", class: "card product-tile", onclick: () => openProductSheet(p) },
    productThumb(p, "tile"),
    h("span", { class: "pt-name" }, h("bdi", {}, productLabel(p))),
    h("span", { class: "pt-foot" }, h("strong", {}, p.price ? formatMoney(p.price) : "–"), stockBadge(p)));
}

// Ürünün etiketleri: satıcılardaki miktar ve kâr marjı.
function productChips(p) {
  const chips = [];
  if (p.consigned > 0) chips.push(h("span", { class: "chip-tag blue" }, t("atSellers", { n: formatNumber(p.consigned) })));
  const margin = marginOf(p);
  if (margin != null) chips.push(h("span", { class: `chip-tag ${margin < 0 ? "red" : "green"}` }, t("marginShort", { pct: formatNumber(margin) })));
  return chips.length ? h("span", { class: "chip-tags" }, chips) : null;
}

// Stok rozeti: yeterliyse yeşil, azaldıysa turuncu, bittiyse kırmızı.
function stockBadge(p) {
  const tone = p.stock <= 0 ? "red" : isLow(p) ? "amber" : "green";
  return h("span", { class: `stock-badge ${tone}` }, `${formatNumber(p.stock)} ${unitLabel(p.unit)}`);
}

// Alış (ortalama maliyet) ve satış fiyatı.
function pricePills(p) {
  const cost = p.stock > 0 ? avgCost(p) : p.lastCost;
  return h("span", { class: "price-pills" },
    h("span", { class: "price-pill" }, h("small", {}, t("priceBuy")), h("strong", {}, cost ? formatMoney(Math.round(cost)) : "–")),
    h("span", { class: "price-pill" }, h("small", {}, t("priceSell")), h("strong", {}, p.price ? formatMoney(p.price) : "–")));
}

function productRow(p) {
  return h("li", {},
    h("button", { type: "button", class: "card product-card", onclick: () => openProductSheet(p) },
      h("span", { class: "pc-head" },
        productThumb(p),
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        stockBadge(p)),
      productChips(p),
      pricePills(p)));
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
  fab: () => [t(kind === "seller" ? "newSeller" : "newSupplier"), () => openPartySheet(kind)],
  top: () => pageTop(t(kind === "seller" ? "page_sellers" : "page_suppliers")),
  head: () => h("div", { class: "page-head" },
    searchBox(t(kind === "seller" ? "searchSellers" : "searchSuppliers"), search[kind], (v) => { search[kind] = v; rerenderBody(); })),
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
  fab: () => [t("quick_consign"), () => openMoveSheet("consign")],
  top: () => pageTop(t("page_consign")),
  head: () => bigActions(
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
  fab: () => [t("new_expense"), () => openCashSheet("expense")],
  top: () => pageTop(t("page_expenses"),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("expenseCategories"), title: t("expenseCategories"), onclick: () => openCategoriesSheet() }, icon("tag"))),
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

// Dönemin satış, alış, gider, tahsilat ve ödeme hareketlerini bir kez okur ve raporu kurar.
async function loadReport() {
  const [from, to] = periodRange();
  const key = `${from}|${to}`;
  if (report?.key === key) return;
  report = { key, loading: true };
  try {
    const col = collection(db, "firms", session.firm.id, "moves");
    const snap = await getDocs(query(col,
      where("type", "in", REPORT_TYPES),
      where("date", ">=", from ? `${from}-01` : ""), where("date", "<=", `${to}-31`)));
    report = { key, data: buildReport(snap.docs.map((d) => d.data())) };
  } catch (err) {
    console.error(err);
    report = { key, data: buildReport([]), failed: true };
  }
  if (page === "reports") rerenderBody();
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

// Özet kutucuğu: başlık, büyük rakam, altında kısa açıklama.
const kpi = (label, value, sub, tone = "") =>
  h("div", { class: `kpi ${tone}` }, h("span", {}, label), h("strong", {}, value), sub ? h("small", {}, sub) : null);

// Satış grafiği: günlük ya da aylık sütunlar; sütuna dokununca o günün satışı ve kârı yazar.
function salesChart(series) {
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

// Pay çubuklu döküm satırı: ad, tutar ve bütün içindeki payı.
const shareRow = (name, value, whole, meta) => h("div", { class: "share-line" },
  h("div", { class: "pl-row" }, h("span", {}, h("bdi", {}, name), meta ? h("small", {}, ` · ${meta}`) : null), h("strong", {}, formatMoney(value))),
  h("span", { class: "share-track" }, h("span", { class: "share-fill", style: `width:${Math.max(2, pct(value, whole))}%` })));

let productSort = "profit";

const reportsPage = {
  top: () => pageTop(t("page_reports")),
  head: () => periodSeg(() => { report = null; rerenderBody(); }),
  body() {
    const { months, products } = session.firm;
    const [from, to] = periodRange();
    loadReport();
    const p = sumMonths(months, from, to);
    const r = report?.data;
    const loading = !r;
    const dash = "…";

    const out = [
      h("div", { class: "kpis" },
        kpi(t("rp_sales"), formatMoney(p.revenue), r ? t("rp_salesCount", { n: r.salesCount }) : dash, "green"),
        kpi(t("plProfit"), formatMoney(p.profit), p.revenue ? t("rp_grossMargin", { pct: formatNumber(pct(p.revenue - p.cogs, p.revenue)) }) : "", p.profit < 0 ? "red" : "green"),
        kpi(t("rp_purchases"), r ? formatMoney(r.purchases) : dash, null, "amber"),
        kpi(t("plExpenses"), formatMoney(p.expenses), null, "red"),
        kpi(t("rp_collections"), r ? formatMoney(r.collections) : dash, t("rp_collectionsSub"), "blue"),
        kpi(t("rp_payments"), r ? formatMoney(r.payments) : dash, t("rp_paymentsSub"), "ink")),
    ];
    if (r) out.push(salesChart(salesSeries(r.days, { from, to, today: today() })));
    out.push(profitCard(p));

    // Şu anki durum (döneme bağlı değil)
    const receivable = sum(parties("seller"), (x) => Math.max(x.balance, 0));
    const stockValue = sum([...products.values()], (x) => Math.max(x.value ?? 0, 0));
    const shelfValue = sum(parties("seller"), (x) => sum(shelfItems(x), ([, s]) => s.value ?? 0));
    out.push(h("h2", { class: "sec" }, t("rp_now")),
      h("div", { class: "card pl" },
        h("div", { class: "pl-row" }, h("span", {}, t("receivable")), h("strong", { class: "in" }, formatMoney(receivable))),
        h("div", { class: "pl-row" }, h("span", {}, t("totalPayable")), h("strong", {}, payableText())),
        h("div", { class: "pl-row" }, h("span", {}, t("rp_stockValue")), h("strong", {}, formatMoney(stockValue))),
        h("div", { class: "pl-row" }, h("span", {}, t("shelfValue")), h("strong", {}, formatMoney(shelfValue)))));

    if (loading) {
      out.push(h("p", { class: "muted center" }, dash));
      return out;
    }

    // Müşterilere göre satış
    const customers = topBy(r.customers, "sales");
    if (customers.length) {
      out.push(h("h2", { class: "sec" }, t("rp_byCustomer")),
        h("div", { class: "card breakdown" }, customers.map(([, c]) =>
          shareRow(c.name, c.sales, r.sales, `${t("rp_salesCount", { n: c.count })} · ${t("plProfit")} ${formatMoney(c.profit)}`))));
    }

    // Ürünler: en kârlı ya da en çok satan
    const prods = topBy(r.products, productSort === "qty" ? "qty" : "profit");
    out.push(h("h2", { class: "sec" }, t("rp_byProduct")));
    if (!prods.length) out.push(h("p", { class: "field-hint" }, t("noSalesInPeriod")));
    else {
      out.push(segmented([["profit", t("rp_mostProfit")], ["qty", t("rp_mostSold")]], productSort, (v) => { productSort = v; rerenderBody(); }),
        h("ul", { class: "cards report-products" }, prods.map(([, x]) => h("li", { class: "card row" },
          h("span", { class: "main" },
            h("span", { class: "title" }, h("bdi", {}, x.name)),
            h("span", { class: "meta" }, `${formatNumber(x.qty)} ${unitLabel(x.unit)} · ${formatMoney(x.revenue)}`
              + (x.revenue ? ` · ${t("marginShort", { pct: formatNumber(pct(x.profit, x.revenue)) })}` : ""))),
          h("span", { class: `end ${x.profit < 0 ? "out" : "in"}` },
            h("span", { class: "amount" }, productSort === "qty" ? `${formatNumber(x.qty)} ${unitLabel(x.unit)}` : formatMoney(x.profit)),
            h("span", { class: "after" }, productSort === "qty" ? t("rp_sold") : t("grossProfit")))))));
    }

    // Tedarikçilere göre alış
    const suppliers = topBy(r.suppliers, "total");
    if (suppliers.length) {
      out.push(h("h2", { class: "sec" }, t("rp_bySupplier")),
        h("div", { class: "card breakdown" }, suppliers.map(([, s]) => shareRow(s.name, s.total, r.purchases, t("rp_purchaseCount", { n: s.count })))));
    }

    // Giderler kategoriye göre
    if (r.categories.size) {
      out.push(h("h2", { class: "sec" }, t("expensesByCategory")),
        h("div", { class: "card breakdown" }, topBy(r.categories, "total", 20).map(([name, c]) =>
          shareRow(name || t("uncategorized"), c.total, r.expenses))));
    }

    // En çok borcu olan müşteriler
    const debtors = parties("seller").filter((x) => x.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 5);
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
  top: () => pageTop(t("page_ledger"),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("page_trash"), title: t("page_trash"), onclick: () => openPage("trash") }, icon("trash"))),
  head: () => h("div", { class: "toolbar" },
    h("select", { "aria-label": t("filter"), onchange: (e) => { ledgerFilter = e.target.value; rerenderBody(); } },
      h("option", { value: "" }, t("allTypes")),
      FILTERS.map((type) => h("option", { value: type, selected: type === ledgerFilter }, t(`type_${type}`))))),
  body: () => movesList({ filter: ledgerFilter ? (m) => m.type === ledgerFilter : null }),
};

// --- Çöp kutusu: silinen kayıtlar; dokununca ayrıntı ve "Geri yükle" -------------------------

const trashPage = {
  trash: true,
  top: () => pageTop(t("page_trash")),
  body() {
    if (!pageMoves) return [];
    const list = pageMoves.filter((m) => !m.restored);
    if (!list.length) return [emptyState("🗑️", t("trashEmpty"))];
    const out = [
      h("p", { class: "field-hint trash-hint" }, t("trashHint")),
      h("ul", { class: "cards" }, list.map((m) => moveRow(m, { onclick: () => openMoveDetail(m) }))),
    ];
    if (pageMoves.length >= pageLimit) {
      out.push(h("button", { type: "button", class: "block more", onclick: () => { pageLimit += PAGE; listenPageMoves(); } }, t("olderMoves")));
    }
    return out;
  },
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
        item("fileScan", t("aiSettings"), firm.ai?.key || sharedAiReady() ? t("aiReady") : t("aiNotSet"), () => openAiSheet()),
        item("wallet", t("page_cash"), t("cashSettingsHint"), () => openPage("cash"))),
      h("div", { class: "field" }, h("span", {}, t("theme")),
        segmented([["auto", t("theme_auto")], ["light", t("theme_light")], ["dark", t("theme_dark")]], currentTheme(), applyTheme),
        h("small", { class: "field-hint" }, t("themeHint"))),
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
    fab: () => [t("new_sale"), () => openMoveSheet("sale")],
    actions: () => [[t("page_consign"), "send", () => openPage("consign")]],
  }),
  purchases: movesPage({
    types: ["purchase"], empty: "noPurchases",
    fab: () => [t("new_purchase"), () => openMoveSheet("purchase")],
    actions: () => [[t("page_invoice"), "fileScan", () => openInvoiceImport()]],
  }),
  collections: movesPage({
    types: ["collection"], empty: "noCollections",
    fab: () => [t("new_collection"), () => openMoveSheet("collection")],
  }),
  payments: movesPage({
    types: ["payment"], empty: "noPayments",
    fab: () => [t("new_payment"), () => openMoveSheet("payment")],
  }),
  expenses: expensesPage,
  consign: consignPage,
  products: productsPage,
  sellers: partiesPage("seller"),
  suppliers: partiesPage("supplier"),
  cash: cashPage,
  reports: reportsPage,
  ledger: ledgerPage,
  trash: trashPage,
  settings: settingsPage,
};
