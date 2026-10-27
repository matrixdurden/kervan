// İşletme ekranı: ana ekran (özet, büyük işlem düğmeleri, bölümler) ve bölüm sayfaları.
// Ürünler, cariler, ortak kasaları ve aylık kâr canlı dinlenir; sayfadaki hareket listesi
// sadece o sayfanın hareket türleri için dinlenir.

import {
  collection, query, where, orderBy, limit, onSnapshot, getDocs,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, store, toast, avatar, today, currentTheme, applyTheme, formatDay, formatMonth, millis, dateLocale } from "./ui.js";
import { t, unitLabel, lang, setLang } from "./i18n.js";
import { session, currentFirm, partners, person, sharePlan, resetFirm, myName } from "./session.js";
import { formatMoney, formatNumber, parseQty, qtyInput, base, setBaseCurrency, CURRENCIES, currencyName } from "./money.js";
import { avgCost, sumMonths, splitBuckets, lineTotal, roundQty } from "./ledger.js";
import {
  moveRow, balanceText, emptyState, searchBox, byName, matches, segmented, newestFirst, productThumb, moveMatches, receiptNumber,
  productCategories, categoryBubbles, inCategory, bubbleRow, landedCost,
} from "./views.js";
import {
  openProductSheet, openPartySheet, openMoveSheet, openMoveDetail, openShelfSheet, openCashSheet, openSharesSheet,
  openDealSheet, openGuestSheet, openGuestAddSheet, openBusinessSheet, openCategoriesSheet, openAiSheet, openOrderSheet, receiptLabels,
  openMethodsSheet, paymentMethods, methodEmoji, openFundMoveSheet, openFundAdjustSheet, sendToChat, sendPhoto, sharePhoto, receiptFirm, openReceiptSettings, openProductCategories, openSheet, closeButton, failed, openShopSheet, openShopOrderSheet,
} from "./forms.js";
import { openInvoiceImport, openSaleImport } from "./importer.js";
import { openParty, refreshParty } from "./party.js";
import { productByBarcode, barcodesOf, productLabel, recompute, restoreProduct, restoreParty, purgeTrash, recordMoves, voidMoves, saveFirmSettings } from "./data.js";
import { canScan, scanBarcode } from "./scanner.js";
import { sharedAiReady } from "./ai.js";
import { REPORT_TYPES, buildReport, salesSeries } from "./report.js";
import { kpi, pct, salesChart, profitCard, reportTiles, reportDetail, NOW_REPORTS } from "./report-pages.js";
import { receiptBlob, printReceipt, shareOnWhatsApp, canShareFiles } from "./receipt.js";
import { shopOf, shopUrl, scheduleShopSync, resetShopSync, listenOrders, orderChime, pushPermission, pushSupported, enableOrderPush } from "./shop.js";

const PAGE = 100;

let unsubs = [];
let page = null; // null: ana ekran
let pageStack = []; // alt sayfa açılınca önceki sayfa (ve kaydırma yeri) burada; geri basınca oraya dönülür
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
  const docs = (snap) => new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data({ serverTimestamps: "estimate" }) }]));
  const failed = (err) => { console.error(err); toast(t("readFailed")); };
  // Silinmiş (çöp kutusundaki) ürün ve cariler uygulamanın geri kalanına hiç girmez; ayrı tutulur.
  const listen = (name, key) => onSnapshot(collection(db, "firms", id, name), (snap) => {
    const all = docs(snap);
    session.firm[key] = new Map([...all].filter(([, x]) => !x.deleted));
    if (key in session.firm.trash) session.firm.trash[key] = new Map([...all].filter(([, x]) => x.deleted));
    refreshFirm();
    if (key === "products") scheduleShopSync(); // online mağaza vitrini
  }, failed);
  unsubs = [listen("products", "products"), listen("parties", "parties"), listen("accounts", "accounts"), listen("months", "months"), listen("funds", "funds")];
  // Ana ekrandaki "son işlemler".
  recentUnsub = onSnapshot(query(collection(db, "firms", id, "moves"), orderBy("at", "desc"), limit(6)), (snap) => {
    recent = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(newestFirst);
    if (!page) refreshFirm();
  }, failed);
  page = null;
  pageStack = [];
  rendered = null;
  refreshFirm();
}

export function closeFirm() {
  ordersUnsub?.();
  ordersUnsub = null;
  ordersSlug = null;
  resetShopSync();
  for (const unsub of unsubs) unsub();
  unsubs = [];
  recentUnsub?.();
  recentUnsub = null;
  stopPageMoves();
  page = null;
  pageStack = [];
  recent = [];
  resetFirm(null);
}

export function refreshFirm() {
  if (!currentFirm()) return;
  setBaseCurrency(currentFirm().currency);
  watchOrders();
  scheduleShopSync(); // işletmenin adı, logosu ya da para birimi değiştiyse vitrin de güncellenir
  render();
  refreshParty();
}

// Online mağazanın siparişleri: mağaza açılınca (ya da adresi değişince) dinlenmeye başlar.
let ordersUnsub = null;
let ordersSlug = null;
function watchOrders() {
  const slug = shopOf()?.slug ?? null;
  if (slug === ordersSlug) return;
  ordersUnsub?.();
  ordersSlug = slug;
  session.firm.orders = [];
  let seen = null; // ilk okumada gelenler eski sayılır
  ordersUnsub = slug ? listenOrders((list) => {
    const fresh = seen ? list.filter((o) => o.status === "new" && !seen.has(o.id)) : [];
    seen = new Set(list.map((o) => o.id));
    session.firm.orders = list;
    render();
    if (fresh.length) announceOrder(fresh[0]);
  }) : null;
}

// Yeni sipariş geldi: ses, bildirim (uygulama arka plandaysa üst perdede), ekranda haber.
function announceOrder(order) {
  orderChime();
  navigator.vibrate?.([200, 100, 200]);
  toast(t("ord_arrived", { name: order.name }));
  if (document.hidden && pushPermission() === "granted") {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(t("ord_notifyTitle"), {
      body: t("ord_arrived", { name: order.name }), tag: "kervan-order", renotify: true, icon: "/icons/icon-192.png", data: { url: "/#orders" },
    })).catch(() => {});
  }
}
// Bildirime dokununca siparişler açılır.
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "open-orders" && currentFirm()) openPage("orders"); });
if (location.hash === "#orders") {
  history.replaceState(null, "", location.pathname);
  const wait = setInterval(() => { if (currentFirm()) { clearInterval(wait); openPage("orders"); } }, 300);
  setTimeout(() => clearInterval(wait), 15000);
}
const newOrders = () => (session.firm.orders ?? []).filter((o) => o.status === "new").length;

// Dil değişince sayfanın üst kısmı da yeniden kurulsun.
export function rebuildFirm() {
  rendered = null;
  refreshFirm();
}

// --- Sayfalar arası geçiş (Android geri tuşu da çalışsın diye history kullanılır) ---

export function openPage(id, options = {}) {
  if (page) pageStack.push({ id: page, y: scrollY });
  purge = null;
  page = id;
  if (options.kind) search[options.kind] = "";
  if (options.filter) productFilter = options.filter;
  if (options.report) reportId = options.report;
  if (options.detail) { valueMode = options.detail; search.value = ""; }
  if (options.fund) fundId = options.fund;
  if (options.ledgerFilter !== undefined) ledgerFilter = options.ledgerFilter;
  history.pushState({ page: id }, "");
  listenPageMoves();
  rendered = null;
  render();
  scrollTo(0, 0);
}

// Geri: alt sayfadan (ör. bir rapor) bir önceki sayfaya (Raporlar), en sonunda ana ekrana.
export function closePage() {
  const prev = pageStack.pop();
  purge = null;
  page = prev?.id ?? null;
  if (page) listenPageMoves();
  else stopPageMoves();
  rendered = null;
  render();
  scrollTo(0, prev?.y ?? 0);
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
  const cost = landedCost(p);
  if (!p.price || !cost) return null;
  return Math.round(((p.price - cost) / p.price) * 1000) / 10;
}

// Tedarikçi borçları para birimine göre, her biri kendi satırında: ₺12.000 / $1.500
function payableText() {
  const byCurrency = new Map();
  for (const p of parties("supplier")) {
    if (p.balance > 0) byCurrency.set(p.currency || base(), (byCurrency.get(p.currency || base()) ?? 0) + p.balance);
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

// Sol sütun satış tarafı (satış, tahsilat), sağ sütun alış tarafı (alış, ödeme):
// her satırda karşılıklı iki iş yan yana durur.
// "Satış başlat" ve "Gider başlat" sayfa değil, doğrudan formu açar (köşelerinde + yok).
const TILES = [
  ["sales", "out", "tile-sale"], ["purchases", "in", "tile-purchase"],
  ["direct", "bolt", "tile-dark"], ["expenseStart", "receipt", "tile-dark"],
];
const QUICK_NEW = {
  purchases: ["new_purchase", () => openMoveSheet("purchase")],
  sales: ["new_sale", () => openMoveSheet("sale")],
};
const START = {
  direct: () => openMoveSheet("sale"), // Satışlar → Satış gir ile aynı form
  expenseStart: () => openCashSheet("expense"), // Giderler → Gider gir ile aynı form
};
// Sayfa değil, doğrudan pencere açan kutucuklar.
const TILE_ACTION = { invoice: () => openInvoiceImport(), shop: () => openShopSheet() };
// Tahsilatlar ve Ödemeler "Satış başlat / Gider başlat"ın hemen altında ferah renkli geniş kutular.
const FRESH = [["collections", "plusCircle", "fresh-in"], ["payments", "minusCircle", "fresh-out"]];
// Online mağaza satırı Tahsilatlar/Ödemeler'in hemen altında; diğer bölümler aşağıda.
const SHOP_TILES = [["orders", "bag"], ["shop", "globe"]];
const SECTIONS = [
  ["sellers", "store"], ["suppliers", "truck"],
  ["products", "box"], ["stockCount", "clipboard"],
  ["invoice", "fileScan"], ["expenses", "receipt"],
  ["consign", "send"], ["saleReturns", "undo"],
  ["cash", "wallet"], ["partners", "users"],
  ["debts", "scale"], ["ledger", "book"],
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
      // Tatlı arama kutusu: dokununca arama sayfası (ürün, müşteri, fiş no, barkod).
      h("button", { type: "button", class: "home-search", onclick: () => { globalQuery = ""; openPage("search"); } },
        icon("search"), h("span", {}, t("searchAll")), canScan() && h("span", { class: "hs-scan" }, icon("barcode"))),
      h("div", { class: "stats" },
        stat(t("receivable"), formatMoney(receivable), "in", () => openPage("sellers")),
        stat(t("cashTotal"), formatMoney(cash), "", () => openPage("cash")),
        stat(t("profitThisMonth"), formatMoney(profit), profit < 0 ? "out" : "in", () => openPage("reports"))),
      // Kutucuk bölümü açar; köşedeki "+" doğrudan yeni kayıt formunu (tek dokunuş).
      h("div", { class: "tiles-big" }, TILES.map(([id, ic, cls]) => h("div", { class: "tile-wrap" },
        h("button", { type: "button", class: `tile-big ${cls}`, onclick: () => (START[id] ? START[id]() : openPage(id)) },
          h("span", { class: "big-ic" }, icon(ic)), h("span", {}, t(`page_${id}`))),
        QUICK_NEW[id] && h("button", { type: "button", class: "tile-plus", "aria-label": t(QUICK_NEW[id][0]), title: t(QUICK_NEW[id][0]), onclick: QUICK_NEW[id][1] }, icon("plus"))))),
      h("div", { class: "tiles-fresh" }, FRESH.map(([id, ic, cls]) =>
        h("button", { type: "button", class: `tile-fresh ${cls}`, onclick: () => openPage(id) },
          h("span", { class: "fresh-ic" }, icon(ic)), h("span", {}, t(`page_${id}`))))),
      smallTiles(SHOP_TILES),
      low.length > 0 && h("button", { type: "button", class: "card low-banner", onclick: () => openPage("products", { filter: "low" }) },
        icon("alert"), h("span", { class: "main" },
          h("strong", {}, t("lowStockCount", { n: low.length })),
          h("small", {}, low.slice(0, 3).map(productLabel).join(", ") + (low.length > 3 ? "…" : ""))),
        icon("chevron")),
      products.size > 0 && homeValueCard(),
      smallTiles(SECTIONS),
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

const smallTiles = (list) => h("div", { class: "tiles-grid" }, list.map(([id, ic]) =>
  h("button", { type: "button", class: `tile-small tone-${id}`, onclick: () => (TILE_ACTION[id] ? TILE_ACTION[id]() : openPage(id)) },
    h("span", { class: "tile-ic" }, icon(ic)), h("span", {}, t(`page_${id}`)),
    id === "orders" && newOrders() > 0 && h("span", { class: "tile-badge" }, String(newOrders())))));

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
  top: () => pageTop(t("page_products"), h("div", { class: "top-actions" },
    h("button", { type: "button", class: "icon-btn", "aria-label": t("page_stockCount"), title: t("page_stockCount"), onclick: () => openPage("stockCount") }, icon("clipboard")),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("productCategories"), title: t("productCategories"), onclick: () => openProductCategories() }, icon("tag")),
    viewToggle())),
  head: () => h("div", { class: "page-head" },
    segmented([["all", t("filterAll")], ["low", t("filterLow")]], productFilter, (v) => { productFilter = v; rerenderBody(); }, "tabs"),
    searchBox(t("searchProducts"), search.products, (v) => { search.products = v; rerenderBody(); }, canScan() ? scanProduct : null)),
  body() {
    const all = [...session.firm.products.values()];
    if (!all.length) return [emptyState("📦", t("noProducts"))];
    const q = search.products.trim();
    const base = all
      .filter((p) => matches(productLabel(p), q) || barcodesOf(p).includes(q))
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

// Müşteriler, tedarikçiler ve borç defteri (kişiler): arama, toplam ve liste.
const PARTY_PAGE = {
  seller: { page: "page_sellers", search: "searchSellers", empty: "noSellers", emoji: "🏪" },
  supplier: { page: "page_suppliers", search: "searchSuppliers", empty: "noSuppliers", emoji: "🚚" },
  person: { page: "page_debts", search: "searchPeople", empty: "noPeople", emoji: "🤝" },
};
// Borç defterinde toplamlar ana para birimindeki kişilerden (dövizliler kendi satırında görünür).
const personTotals = (all) => {
  const same = all.filter((p) => (p.currency || base()) === base());
  return [sum(same, (p) => Math.max(p.balance, 0)), sum(same, (p) => Math.max(-p.balance, 0))];
};
const partiesPage = (kind) => ({
  fab: () => [t(`new_${kind}`), () => openPartySheet(kind)],
  top: () => pageTop(t(PARTY_PAGE[kind].page)),
  head: () => h("div", { class: "page-head" },
    searchBox(t(PARTY_PAGE[kind].search), search[kind] ?? "", (v) => { search[kind] = v; rerenderBody(); })),
  body() {
    const all = parties(kind).sort(byName);
    if (!all.length) return [emptyState(PARTY_PAGE[kind].emoji, t(PARTY_PAGE[kind].empty))];
    const q = search[kind] ?? "";
    const list = all.filter((p) => matches(p.name, q) || matches(p.phone, q));
    const [theyOwe, weOwe] = personTotals(all);
    // Borçlar: aramada liste; değilse iki kutu (bize borçlu / biz borçluyuz), dokununca kimler olduğu açılır.
    if (kind === "person" && !q.trim()) {
      const n = (sign) => all.filter((p) => Math.sign(p.balance) === sign).length;
      return [
        h("div", { class: "value-grid" },
          valueTile("they", t("theyOweUs"), formatMoney(theyOwe), t("sv_people", { n: n(1) }), "in", "in", "debtList"),
          valueTile("we", t("weOweThem"), formatMoney(weOwe), t("sv_people", { n: n(-1) }), "out", "out", "debtList")),
        h("button", { type: "button", class: "block", onclick: () => openPage("debtList", { detail: "all" }) }, icon("users"), t("allPeople", { n: all.length })),
      ];
    }
    return [
      kind === "person" ? null
      : h("p", { class: "total-line" },
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

// --- Stok değeri ve borçlar ----------------------------------------------------------------
// İkiye bölünür: solda satış tarafı (stoğun satış değeri, müşterilerin borcu), sağda maliyet tarafı
// (stoğun maliyet değeri, tedarikçilere borç). Her kutu kalem kalem ayrıntıyı açar (arama ve barkod).

const inStock = () => [...session.firm.products.values()].filter((p) => p.stock > 0);
const saleValueOf = (p) => Math.round(Math.max(p.stock, 0) * (p.price || 0));
const costValueOf = (p) => Math.max(p.value ?? 0, 0);
const owingCustomers = () => parties("seller").filter((p) => p.balance > 0);
const owedSuppliers = () => parties("supplier").filter((p) => p.balance > 0);

function valueTile(mode, label, value, sub, tone, ic, page = "valueDetail") {
  return h("button", { type: "button", class: `card value-tile ${tone}`, onclick: () => openPage(page, { detail: mode }) },
    h("span", { class: "vt-ic" }, icon(ic)),
    h("span", { class: "vt-label" }, label),
    h("strong", { class: "vt-value" }, value),
    h("small", { class: "vt-sub" }, sub),
    h("span", { class: "vt-more" }, t("sv_details"), icon("chevron")));
}

// Ana ekrandaki ve sayfadaki dört kutu: satış değeri | maliyet değeri, müşteri borcu | tedarikçi borcu.
function valueGrid() {
  const items = inStock();
  const saleV = sum(items, saleValueOf);
  const costV = sum(items, costValueOf);
  return [
    h("div", { class: "value-grid" },
      valueTile("sale", t("sv_saleValue"), formatMoney(saleV), t("sv_items", { n: items.length }), "in", "tag"),
      valueTile("cost", t("sv_costValue"), formatMoney(costV), t("sv_items", { n: items.length }), "blue", "box"),
      valueTile("customers", t("sv_customersDebt"), formatMoney(sum(owingCustomers(), (p) => p.balance)), t("sv_people", { n: owingCustomers().length }), "in", "store"),
      valueTile("suppliers", t("sv_suppliersDebt"), payableText(), t("sv_people", { n: owedSuppliers().length }), "out", "truck")),
    h("p", { class: "total-line" }, h("span", {}, t("sv_potential")), h("strong", { class: saleV - costV < 0 ? "out" : "in" }, formatMoney(saleV - costV))),
    h("small", { class: "field-hint" }, t("sv_hint")),
  ];
}

function homeValueCard() {
  const items = inStock();
  const cell = (label, value, tone) => h("span", { class: `hv-cell ${tone}` }, h("small", {}, label), h("strong", {}, value));
  return h("button", { type: "button", class: "card home-value", onclick: () => openPage("stockValue") },
    h("span", { class: "hv-title" }, icon("chart"), h("span", {}, t("page_stockValue")), icon("chevron")),
    h("span", { class: "hv-grid" },
      cell(t("sv_saleValue"), formatMoney(sum(items, saleValueOf)), "in"),
      cell(t("sv_costValue"), formatMoney(sum(items, costValueOf)), "blue"),
      cell(t("sv_customersDebt"), formatMoney(sum(owingCustomers(), (p) => p.balance)), "in"),
      cell(t("sv_suppliersDebt"), payableText(), "out")));
}

// Borçlar ayrıntısı: bize borçlu olanlar, borçlu olduklarımız ya da herkes.
const debtListPage = {
  fab: () => [t("new_person"), () => openPartySheet("person")],
  top: () => pageTop(t(valueMode === "they" ? "theyOweUs" : valueMode === "we" ? "weOweThem" : "page_debts")),
  head: () => h("div", { class: "page-head" }, searchBox(t("searchPeople"), search.value ?? "", (v) => { search.value = v; rerenderBody(); })),
  body() {
    const q = (search.value ?? "").trim();
    const all = parties("person").filter((p) => valueMode === "all" || Math.sign(p.balance) === (valueMode === "they" ? 1 : -1))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    const list = all.filter((p) => matches(p.name, q) || matches(p.phone, q));
    return [list.length ? h("ul", { class: "cards" }, list.map(partyRow)) : emptyState("🤝", t(all.length ? "noMatch" : "noPeople"))];
  },
};

// Online mağazanın önizlemesi uygulamanın içinde (geri basınca uygulamada kalınır).
const shopPreviewPage = {
  top: () => pageTop(t("page_shop"), h("button", {
    type: "button", class: "icon-btn", "aria-label": t("shopShare"), title: t("shopShare"),
    onclick: () => shareOnWhatsApp({ text: t("shopShareText", { name: currentFirm().name, url: shopUrl(shopOf().slug) }) }),
  }, icon("whatsapp"))),
  body: () => [shopOf()?.slug ? h("iframe", { class: "shop-frame", src: shopUrl(shopOf().slug), title: t("page_shop") }) : emptyState("🛍️", t("ord_noShop"))],
};
document.addEventListener("kervan:shop-preview", () => openPage("shopPreview"));

// --- Genel arama (ana ekranın üstünden): ürün, müşteri, tedarikçi, kişi ve fiş numarası -----------

let globalQuery = "";
const receiptHits = new Map(); // "20261026" → o günün hareketleri (eski fiş numaraları için)

async function scanSearch() {
  const code = await scanBarcode();
  if (!code) return;
  globalQuery = code;
  rendered = null;
  render();
}

// Fiş numarası yazıldıysa (20261026-AB12) o günün hareketleri okunur; numaranın kimlik kısmıyla eşleşenler.
function receiptLookup(q) {
  const m = q.replace(/\s/g, "").match(/^(\d{4})(\d{2})(\d{2})-?([a-z0-9]{0,4})$/i);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!receiptHits.has(date)) {
    receiptHits.set(date, null);
    getDocs(query(collection(db, "firms", session.firm.id, "moves"), where("date", "==", date)))
      .then((snap) => {
        receiptHits.set(date, snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
        if (page === "search") rerenderBody();
      }, (err) => { console.error(err); receiptHits.delete(date); });
  }
  const list = receiptHits.get(date);
  return list && list.filter((x) => x.id.slice(0, m[4].length).toUpperCase() === m[4].toUpperCase());
}

const searchPage = {
  types: "all",
  top: () => pageTop(t("page_search")),
  head() {
    const box = searchBox(t("searchAll"), globalQuery, (v) => { globalQuery = v; rerenderBody(); }, canScan() ? scanSearch : null);
    setTimeout(() => box.querySelector("input")?.focus(), 60);
    return h("div", { class: "page-head" }, box);
  },
  body() {
    const q = globalQuery.trim();
    if (!q) return [h("p", { class: "field-hint search-hint" }, t("searchHint"))];
    const prods = [...session.firm.products.values()]
      .filter((p) => matches(productLabel(p), q) || matches(p.category, q) || barcodesOf(p).includes(q)).sort(byName).slice(0, 30);
    const people = [...session.firm.parties.values()].filter((p) => matches(p.name, q) || matches(p.phone, q)).sort(byName).slice(0, 30);
    const byReceipt = receiptLookup(q);
    const recentMoves = (pageMoves ?? []).filter((m) => moveMatches(m, q));
    const moves = [...new Map([...(byReceipt ?? []), ...recentMoves].map((m) => [m.id, m])).values()].slice(0, 30);
    const section = (title, items, row) => items.length ? [h("h2", { class: "sec" }, title), h("ul", { class: "cards" }, items.map(row))] : [];
    const out = [
      ...section(t("page_products"), prods, (p) => valueProductRow(p, "sale")),
      ...section(t("search_people"), people, partyRow),
      ...section(t("page_ledger"), moves, (m) => moveRow(m, { onclick: () => openMoveDetail(m) })),
    ];
    if (byReceipt === null) out.push(h("p", { class: "muted center" }, t("searchingReceipt")));
    return out.length ? out : [emptyState("🔍", t("noMatch"))];
  },
};

const stockValuePage = {
  top: () => pageTop(t("page_stockValue")),
  body: () => valueGrid(),
};

// Ayrıntı: ürünler (satış ya da maliyet değeriyle, en büyük üstte) ya da borçlu müşteriler / tedarikçiler.
let valueMode = "sale";
async function scanValue() {
  const code = await scanBarcode();
  if (!code) return;
  search.value = code;
  rendered = null; // arama kutusu okunan barkodla yeniden kurulsun
  render();
}

function valueProductRow(p, mode) {
  const unitPrice = mode === "sale" ? p.price || 0 : Math.round(avgCost(p));
  const total = mode === "sale" ? saleValueOf(p) : costValueOf(p);
  return h("li", {}, h("button", { type: "button", class: "card row", onclick: () => openProductSheet(p) },
    productThumb(p, "sm"),
    h("span", { class: "main" },
      h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
      h("span", { class: "meta" }, `${formatNumber(p.stock)} ${unitLabel(p.unit)} × ${formatMoney(unitPrice)}${p.barcode ? ` · ${p.barcode}` : ""}`)),
    h("span", { class: "end" }, h("span", { class: "amount" }, formatMoney(total)))));
}

const valueDetailPage = {
  top: () => pageTop(t(`sv_${valueMode}Title`)),
  head: () => h("div", { class: "page-head" },
    searchBox(t(["sale", "cost"].includes(valueMode) ? "searchProducts" : "searchSellers"), search.value ?? "",
      (v) => { search.value = v; rerenderBody(); },
      ["sale", "cost"].includes(valueMode) && canScan() ? scanValue : null)),
  body() {
    const q = (search.value ?? "").trim();
    if (valueMode === "sale" || valueMode === "cost") {
      const valueOf = valueMode === "sale" ? saleValueOf : costValueOf;
      const all = inStock();
      const list = all.filter((p) => matches(productLabel(p), q) || matches(p.category, q) || barcodesOf(p).includes(q))
        .sort((a, b) => valueOf(b) - valueOf(a));
      return [
        h("p", { class: "total-line" }, h("span", {}, t("sv_total", { n: list.length })), h("strong", {}, formatMoney(sum(list, valueOf)))),
        list.length ? h("ul", { class: "cards" }, list.map((p) => valueProductRow(p, valueMode))) : emptyState("🔍", t(all.length ? "noMatch" : "sv_noStock")),
      ];
    }
    const all = (valueMode === "customers" ? owingCustomers() : owedSuppliers()).sort((a, b) => b.balance - a.balance);
    const list = all.filter((p) => matches(p.name, q) || matches(p.phone, q));
    return [
      h("p", { class: "total-line" }, h("span", {}, t("sv_total", { n: list.length })),
        h("strong", {}, valueMode === "customers" ? formatMoney(sum(list, (p) => p.balance)) : payableText())),
      list.length ? h("ul", { class: "cards" }, list.map(partyRow)) : emptyState("✅", t(all.length ? "noMatch" : "sv_noDebt")),
    ];
  },
};

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


const plain = (s) => s.replace(/[⁦⁩]/g, "");

// Özet fişini resim olarak WhatsApp'tan gönderir; telefon yoksa kişi WhatsApp'ta seçilir.

// --- Kasalar (nakit, kart, banka…) -------------------------------------------------------------

const FUND_TYPES = ["collection", "payment", "expense", "refund", "capitalIn", "withdraw", "debtOut", "debtIn", "fundMove", "fundAdjust"];
let fundId = "cash";
const fundBalance = (id) => session.firm.funds.get(id)?.balance ?? 0;

// Kayıtlı kasalar ve listede olmayıp bakiyesi kalanlar ("Diğer").
function allFunds() {
  const list = paymentMethods(currentFirm());
  const known = new Set(list.map((m) => m.id));
  const rest = [...session.firm.funds.keys()].filter((id) => !known.has(id) && fundBalance(id)).map((id) => ({ id, name: t("fundOther") }));
  return [...list, ...rest];
}

// Kasa sayfasının en üstü: her kasa simgeli kare kutuda, bakiyesiyle; dokununca kasanın hareketleri.
function fundsSection() {
  const firm = currentFirm();
  const funds = allFunds();
  const total = sum(funds, (m) => fundBalance(m.id));
  const cashTotal = sum(firm.members, (uid) => session.firm.accounts.get(uid)?.cash ?? 0);
  return [
    h("h2", { class: "sec" }, h("span", {}, t("funds")),
      h("button", { type: "button", class: "link", onclick: () => openMethodsSheet() }, t("edit"))),
    h("div", { class: "fund-grid" }, funds.map((m) => h("button", {
      type: "button", class: `card fund-tile${fundBalance(m.id) < 0 ? " neg" : ""}`, onclick: () => openPage("fund", { fund: m.id }),
    }, h("span", { class: "ft-emoji", "aria-hidden": "true" }, methodEmoji(m)),
    h("span", { class: "ft-name" }, h("bdi", {}, m.name)),
    h("strong", { class: "ft-bal" }, formatMoney(fundBalance(m.id)))))),
    h("p", { class: "total-line" }, h("span", {}, t("fundsTotal")), h("strong", {}, formatMoney(total))),
    // Eski kayıtlar kasalara henüz dağıtılmadıysa: defterden yeniden hesapla.
    total !== cashTotal && h("div", { class: "card fund-notice" },
      h("span", {}, t("fundsMismatch")),
      h("button", {
        type: "button", class: "small primary",
        onclick: () => recompute().then(() => toast(t("fundsRecomputed")), (err) => { console.error(err); toast(t("genericError")); }),
      }, icon("refresh"), t("fundsRecompute"))),
    bigActions([t("type_fundMove"), "swap", () => openFundMoveSheet()]),
  ];
}

const fundPage = {
  types: "all",
  top: () => pageTop(allFunds().find((m) => m.id === fundId)?.name ?? t("fundOther")),
  head() {
    const m = allFunds().find((x) => x.id === fundId) ?? { id: fundId, name: t("fundOther") };
    return bigActions(
      [t("fundAdjust"), "pencil", () => openFundAdjustSheet(m, fundBalance(fundId))],
      [t("type_fundMove"), "swap", () => openFundMoveSheet(m)]);
  },
  body: () => [
    h("p", { class: "total-line" }, h("span", {}, t("fundBalance")), h("strong", {}, formatMoney(fundBalance(fundId)))),
    ...movesList({
      filter: (m) => FUND_TYPES.includes(m.type) && ((m.method || "cash") === fundId || m.toMethod === fundId),
      emptyText: t("fundNoMoves"),
    }),
  ],
};

// Kasa: paranın nerede durduğu (nakit, kart, banka…); para koy / çek, kasalar arası aktar.
const cashPage = {
  top: () => pageTop(t("page_cash")),
  head: () => bigActions(
    [t("quick_capitalIn"), "plusCircle", () => openCashSheet("capitalIn")],
    [t("quick_withdraw"), "minusCircle", () => openCashSheet("withdraw")]),
  body: () => fundsSection(),
};

// Ortaklar: dönemin kârı, ortaklıklar ve her ortağın payı, elindeki para, koyduğu − çektiği.
const partnersPage = {
  top: () => pageTop(t("page_partners")),
  head: () => h("div", { class: "page-head" },
    currentFirm().members.length > 1 && bigActions([t("quick_transfer"), "swap", () => openCashSheet("transfer")]),
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
        // Ortağa özet fişi: dönemin kâr payı, payı, elindeki para, sermayesi ve toplam hakkı.
        const general = plan("general");
        const pctOf = general.shares[x.uid] ?? (general.ids.includes(x.uid) ? Math.round((100 / general.ids.length) * 10) / 10 : 0);
        const summary = () => ({
          kind: "summary", title: t("partnerSummaryTitle"), subtitle: x.name, date: today(), time: new Date().toTimeString().slice(0, 5),
          firm: receiptFirm(firm),
          rows: [
            [t("periodLabel"), t(`period_${period}`)],
            [t("generalShareOf"), `%${formatNumber(pctOf)}`],
            [t("profitShare"), plain(formatMoney(periodShare.get(x.uid) ?? 0))],
            ...(x.guest ? [] : [[t("cashInHand"), plain(formatMoney(acc.cash ?? 0))]]),
            [t("netCapital"), plain(formatMoney(acc.capital ?? 0))],
          ],
          total: [t("equity"), plain(formatMoney(equity))],
          note: t("equityHint"),
        });
        return h("li", { class: "partner-item" }, h(x.guest ? "button" : "div", {
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
          fact(t("equity"), formatMoney(equity)))),
        h("div", { class: "statement-actions" },
          // Yeşil: özet fotoğrafı doğrudan ortağın sohbetine (kopyala + aç); yanındaki: paylaşım ekranı.
          h("button", {
            type: "button", class: "whatsapp",
            onclick: () => sendPhoto(receiptBlob(summary(), receiptLabels()), firm.guests?.[x.uid]?.phone || null, `ortak-${x.name}.png`),
          }, icon("whatsapp"), t("sendPartnerSummary")),
          h("button", { type: "button", class: "small", "aria-label": t("sharePhoto"), title: t("sharePhoto"),
            onclick: () => sharePhoto(receiptBlob(summary(), receiptLabels()), `ortak-${x.name}.png`) }, icon("send")),
          h("button", { type: "button", class: "small", "aria-label": t("print"), title: t("print"), onclick: () => printReceipt(summary(), receiptLabels()) },
            icon("printer"))));
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
  if (page === "reports" || page === "report") rerenderBody();
}

const reportsPage = {
  top: () => pageTop(t("page_reports")),
  head: () => periodSeg(() => { report = null; rerenderBody(); }),
  body() {
    const { months } = session.firm;
    const [from, to] = periodRange();
    loadReport();
    const p = sumMonths(months, from, to);
    const r = report?.data;
    const dash = "…";
    return [
      h("div", { class: "kpis" },
        kpi(t("rp_sales"), formatMoney(p.revenue), r ? t("rp_salesCount", { n: r.salesCount }) : dash, "green"),
        kpi(t("plProfit"), formatMoney(p.profit), p.revenue ? t("rp_grossMargin", { pct: formatNumber(pct(p.revenue - p.cogs, p.revenue)) }) : "", p.profit < 0 ? "red" : "green"),
        kpi(t("rp_purchases"), r ? formatMoney(r.purchases) : dash, null, "amber"),
        kpi(t("plExpenses"), formatMoney(p.expenses), null, "red"),
        kpi(t("rp_collections"), r ? formatMoney(r.collections) : dash, t("rp_collectionsSub"), "blue"),
        kpi(t("rp_payments"), r ? formatMoney(r.payments) : dash, t("rp_paymentsSub"), "ink")),
      r && salesChart(salesSeries(r.days, { from, to, today: today() })),
      h("h2", { class: "sec" }, t("rp_detailed")),
      reportTiles((id) => openPage("report", { report: id })),
    ];
  },
};

// Detaylı rapor sayfası (Raporlar'daki kutucuktan açılır); dönem seçimi Raporlar'la ortak.
// Şu anki durumu gösteren raporlarda (mali durum, cari bakiyeler) dönem seçimi yoktur.
let reportId = "sales";
const reportPage = {
  top: () => pageTop(t(`rpt_${reportId}`)),
  head: () => (NOW_REPORTS.includes(reportId) ? null : periodSeg(() => { report = null; rerenderBody(); })),
  body() {
    const [from, to] = periodRange();
    if (!NOW_REPORTS.includes(reportId)) loadReport();
    return reportDetail(reportId, { r: report?.data, p: sumMonths(session.firm.months, from, to), from, to, rerender: rerenderBody });
  },
};

// --- Stok sayımı ------------------------------------------------------------------------------
// Depodaki mal sayılır: her ürünün kartında sayılan / kayıttaki adet, − / + ve durum (sayılmadı, tam,
// eksik, fazla). Barkod okuttukça o ürün bir artar. Sayım bu telefonda saklanır, yarıda bırakılabilir.
// "Sayımı uygula" farkları tek bir stok sayımı kaydıyla stoğa işler; sayılmayan ürünlere dokunulmaz.

const countKey = () => `count.${session.firm.id}`;
let counts = {}; // ürünId → sayılan
let countFilter = "all"; // all | todo | diff
let countCat = "";

function loadCounts() {
  try {
    counts = JSON.parse(store.get(countKey()) || "{}") ?? {};
  } catch {
    counts = {};
  }
}
const saveCounts = () => store.set(countKey(), Object.keys(counts).length ? JSON.stringify(counts) : null);

function setCount(id, n) {
  if (n == null || Number.isNaN(n)) delete counts[id];
  else counts[id] = Math.max(0, roundQty(n));
  saveCounts();
  rerenderBody();
}

const countDiff = (p) => (counts[p.id] == null ? null : roundQty(counts[p.id] - p.stock));
const countStatus = (p) => {
  const d = countDiff(p);
  return d == null ? "todo" : d === 0 ? "ok" : d < 0 ? "short" : "over";
};

// Barkod okutma: okunan ürün bir artar ve kamera hemen yeniden açılır; vazgeçince durur.
async function scanCount() {
  for (;;) {
    const code = await scanBarcode();
    if (!code) return;
    const p = productByBarcode(code);
    if (!p) {
      toast(t("barcodeUnknown", { code }));
      continue;
    }
    setCount(p.id, (counts[p.id] ?? 0) + 1);
    navigator.vibrate?.(30);
    toast(t("cnt_scanned", { name: productLabel(p), n: formatNumber(counts[p.id]) }));
  }
}

function countCard(p) {
  const c = counts[p.id];
  const d = countDiff(p);
  const st = countStatus(p);
  const label = st === "todo" ? t("cnt_todo") : st === "ok" ? t("cnt_ok")
    : st === "short" ? t("cnt_short", { n: formatNumber(-d) }) : t("cnt_over", { n: formatNumber(d) });
  const input = h("input", {
    class: "count-input", inputmode: "decimal", autocomplete: "off", dir: "ltr", placeholder: "–",
    value: c == null ? "" : c === 0 ? "0" : qtyInput(c), "aria-label": t("cnt_counted"),
    onfocus: (e) => e.target.select(),
    onchange: (e) => setCount(p.id, e.target.value.trim() === "" ? null : parseQty(e.target.value)),
  });
  return h("li", { class: `card count-card ${st}` },
    h("div", { class: "count-top" },
      productThumb(p, "sm"),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        h("span", { class: "count-chips" },
          p.barcode && h("span", { class: "count-chip", dir: "ltr" }, p.barcode),
          h("span", { class: "count-chip status" }, label)))),
    h("div", { class: "count-step" },
      h("button", { type: "button", "aria-label": t("stepLess"), onclick: () => setCount(p.id, (c ?? 0) - 1) }, icon("minus")),
      h("span", { class: "count-nums" }, input, h("small", {}, `/ ${formatNumber(p.stock)} ${unitLabel(p.unit)}`)),
      h("button", { type: "button", "aria-label": t("stepMore"), onclick: () => setCount(p.id, (c ?? 0) + 1) }, icon("plus"))));
}

// Sayımı uygula: farklar ve değerleri gösterilir; onaylanınca tek kayıt olarak işlenir.
function openCountApply() {
  const diffs = [...session.firm.products.values()].filter((p) => countDiff(p)).sort(byName);
  const countedN = Object.keys(counts).filter((id) => session.firm.products.has(id)).length;
  if (!countedN) return toast(t("cnt_nothing"));
  if (!diffs.length) {
    const before = counts;
    counts = {};
    saveCounts();
    rerenderBody();
    return toast(t("cnt_noDiff"), async () => { counts = before; saveCounts(); rerenderBody(); });
  }
  const value = (p) => Math.round(Math.abs(countDiff(p)) * avgCost(p));
  const shortV = sum(diffs.filter((p) => countDiff(p) < 0), value);
  const overV = sum(diffs.filter((p) => countDiff(p) > 0), value);
  return openSheet(t("cnt_applyTitle"), [
    h("ul", { class: "line-list" }, diffs.map((p) => h("li", {},
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        h("span", { class: "meta" }, t("cnt_line", { stock: formatNumber(p.stock), count: formatNumber(counts[p.id]), unit: unitLabel(p.unit) }))),
      h("strong", { class: countDiff(p) < 0 ? "out" : "in" }, `${countDiff(p) > 0 ? "+" : "−"}${formatNumber(Math.abs(countDiff(p)))}`)))),
    h("div", { class: "facts" },
      fact(t("cnt_shortValue"), formatMoney(shortV)),
      fact(t("cnt_overValue"), formatMoney(overV))),
    h("small", { class: "field-hint" }, t("cnt_applyHint")),
  ], [h("button", { class: "primary block" }, icon("check"), t("cnt_applyNow")), closeButton()], () => {
    const lines = diffs.map((p) => ({ product: p.id, qty: countDiff(p), price: Math.round(avgCost(p)) }));
    const { moves, done } = recordMoves([{ type: "stockCount", party: "", date: today(), note: "", lines }]);
    done.catch(failed);
    const before = counts;
    counts = {};
    saveCounts();
    $("#sheet").close();
    rerenderBody();
    toast(t("cnt_applied", { n: lines.length }), () => voidMoves(moves, t("undoReason")).then(() => {
      counts = before;
      saveCounts();
      rerenderBody();
      toast(t("undone"));
    }, failed));
    return undefined;
  });
}

function resetCount() {
  const before = counts;
  counts = {};
  saveCounts();
  rerenderBody();
  toast(t("cnt_resetDone"), async () => { counts = before; saveCounts(); rerenderBody(); });
}

const stockCountPage = {
  top: () => {
    loadCounts();
    return pageTop(t("page_stockCount"));
  },
  head: () => h("div", { class: "page-head" },
    searchBox(t("searchProducts"), search.count ?? "", (v) => { search.count = v; rerenderBody(); }, canScan() ? scanCount : null),
    segmented([["all", t("filterAll")], ["todo", t("cnt_filterTodo")], ["diff", t("cnt_filterDiff")]], countFilter,
      (v) => { countFilter = v; rerenderBody(); }, "tabs")),
  body() {
    const all = [...session.firm.products.values()].sort(byName);
    if (!all.length) return [emptyState("📦", t("noProducts"))];
    const q = (search.count ?? "").trim();
    const base = all.filter((p) => matches(productLabel(p), q) || barcodesOf(p).includes(q));
    const list = base.filter((p) => inCategory(p, countCat))
      .filter((p) => countFilter === "all" || (countFilter === "todo" ? countStatus(p) === "todo" : !["todo", "ok"].includes(countStatus(p))));
    const countedN = all.filter((p) => counts[p.id] != null).length;
    $("#firm").classList.add("has-fab");
    return [
      h("p", { class: "field-hint trash-hint" }, t("cnt_hint")),
      categoryBubbles(base, countCat, (v) => { countCat = v; rerenderBody(); }),
      list.length ? h("ul", { class: "cards count-list" }, list.map(countCard)) : emptyState("✅", t(countFilter === "all" ? "noMatch" : "cnt_noneHere")),
      h("div", { class: "fab-bar count-bar" },
        h("div", { class: "count-progress" }, h("small", {}, t("cnt_progress")), h("strong", {}, `${countedN} / ${all.length}`)),
        h("button", { type: "button", class: "primary block", disabled: !countedN, onclick: openCountApply }, icon("check"), t("cnt_apply")),
        h("button", { type: "button", class: "icon-btn", "aria-label": t("cnt_reset"), title: t("cnt_reset"), disabled: !countedN, onclick: resetCount }, icon("refresh"))),
    ];
  },
};

// --- Siparişler (online mağaza) ------------------------------------------------------------

let ordersFilter = "new";
const ORDER_STATUS = { new: "ord_statusNew", done: "ord_statusDone", rejected: "ord_statusRejected" };

function orderRow(o) {
  const at = millis(o.at);
  const when = at ? new Intl.DateTimeFormat(dateLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at) : "";
  const n = o.lines.reduce((s, l) => s + l.qty, 0);
  return h("li", {}, h("button", { type: "button", class: `card row order-row ${o.status}`, onclick: () => openShopOrderSheet(o) },
    h("span", { class: "move-icon" }, icon(o.via === "whatsapp" ? "whatsapp" : "bag")),
    h("span", { class: "main" },
      h("span", { class: "title" }, h("bdi", {}, o.name)),
      h("span", { class: "meta" }, [o.code, when, t("productCount", { n: formatNumber(n) })].filter(Boolean).join(" · "))),
    h("span", { class: "end" },
      o.total ? h("span", { class: "amount" }, formatMoney(o.total, o.currency || base())) : null,
      h("span", { class: `badge ${o.status === "new" ? "warn" : ""}` }, t(ORDER_STATUS[o.status] ?? "ord_statusNew")))));
}

const ordersPage = {
  top: () => pageTop(t("page_orders"), h("button", { type: "button", class: "icon-btn", "aria-label": t("page_shop"), title: t("page_shop"), onclick: () => openShopSheet() }, icon("gear"))),
  head: () => segmented([["new", t("ord_filterNew")], ["done", t("ord_filterDone")], ["all", t("filterAll")]], ordersFilter,
    (v) => { ordersFilter = v; rerenderBody(); }, "tabs"),
  body() {
    if (!shopOf()?.slug) {
      return [emptyState("🛍️", t("ord_noShop"), h("button", { type: "button", class: "primary", onclick: () => openShopSheet() }, icon("globe"), t("ord_openShop")))];
    }
    const list = (session.firm.orders ?? []).filter((o) => ordersFilter === "all" || (ordersFilter === "new" ? o.status === "new" : o.status !== "new"));
    // Kapalıyken de bildirim için bir kez izin + kayıt.
    const notifyCard = pushSupported() && pushPermission() !== "granted" && h("div", { class: "card fund-notice" },
      h("span", {}, t("ord_notifyAsk")),
      h("button", {
        type: "button", class: "small primary",
        onclick: () => enableOrderPush().then(() => { toast(t("ord_notifyOn")); rerenderBody(); },
          (err) => { console.error(err); toast(t(err?.code === "denied" ? "ord_notifyDenied" : "genericError")); }),
      }, icon("bell"), t("ord_notifyEnable")));
    if (!list.length) return [notifyCard, emptyState("📭", t(ordersFilter === "new" ? "ord_noneNew" : "ord_none"))];
    return [notifyCard, h("ul", { class: "cards" }, list.map(orderRow))];
  },
};

// --- Hareketler (defter) ---------------------------------------------------------------------

const FILTERS = ["sale", "collection", "saleReturn", "refund", "purchase", "payment", "consign", "consignSale", "return", "expense", "capitalIn", "withdraw", "transfer", "opening", "stockCount", "costFix", "debtOut", "debtIn", "fundMove", "fundAdjust", "purchaseReturn", "supplierRefund"];

const ledgerPage = {
  types: "all",
  top: () => pageTop(t("page_ledger"),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("page_trash"), title: t("page_trash"), onclick: () => openPage("trash") }, icon("trash"))),
  head: () => h("div", { class: "page-head" },
    searchBox(t("searchMoves"), search.ledger ?? "", (v) => { search.ledger = v; rerenderBody(); }),
    h("div", { class: "toolbar" },
      h("select", { "aria-label": t("filter"), onchange: (e) => { ledgerFilter = e.target.value; rerenderBody(); } },
        h("option", { value: "" }, t("allTypes")),
        FILTERS.map((type) => h("option", { value: type, selected: type === ledgerFilter }, t(`type_${type}`)))))),
  body: () => movesList({ filter: (m) => (!ledgerFilter || m.type === ledgerFilter) && moveMatches(m, search.ledger ?? "") }),
};

// --- Çöp kutusu: silinen kayıtlar; dokununca ayrıntı ve "Geri yükle" -------------------------

// Çöp kutusu bölümleri: ürünler, müşteriler, tedarikçiler ve hareket türleri. Sadece içinde bir şey
// olanların baloncuğu görünür.
const TRASH_GROUPS = [
  ["products", ["costFix"]], ["sellers"], ["suppliers"],
  ["sales", ["sale", "consignSale"]], ["purchases", ["purchase"]], ["collections", ["collection"]],
  ["saleReturns", ["saleReturn", "refund", "purchaseReturn", "supplierRefund"]], ["payments", ["payment"]], ["expenses", ["expense"]], ["consign", ["consign", "return"]],
  ["stockCount", ["stockCount"]], ["debts", ["debtOut", "debtIn"]], ["cash", ["capitalIn", "withdraw", "transfer", "opening", "fundMove", "fundAdjust"]],
];
let trashCat = "";

// Çöpteki ürün ya da cari: kim, ne zaman sildi; yanında "Geri yükle".
// Temizleme modunda kayıt seçimi: yuvarlak işaret (seçiliyse ✓).
const pickMark = (on) => h("span", { class: `pick-check${on ? " on" : ""}`, "aria-hidden": "true" }, on ? icon("check") : null);

// pick: temizleme modunda { on, toggle } — dokununca seçilir, "Geri yükle" görünmez.
function trashRecord(x, kind, pick) {
  const firm = currentFirm();
  const at = millis(x.deleted?.at);
  const when = at ? new Intl.DateTimeFormat(dateLocale(), { day: "numeric", month: "short" }).format(at) : "";
  const what = kind === "product" ? t("trashProduct") : t(x.kind);
  const restore = async () => {
    try {
      await (kind === "product" ? restoreProduct(x.id) : restoreParty(x.id));
      toast(t("restored"));
    } catch (err) {
      console.error(err);
      toast(t("saveFailed"));
    }
  };
  const parts = [
    kind === "product" ? productThumb(x) : partyAvatar(x),
    h("span", { class: "main" },
      h("span", { class: "title" }, h("bdi", {}, kind === "product" ? productLabel(x) : x.name)),
      h("span", { class: "meta" }, [what, t("trashedBy", { name: person(firm, x.deleted?.by).name }), when].filter(Boolean).join(" · ")))];
  if (pick) {
    return h("li", {}, h("button", {
      type: "button", class: `card row trash-record${pick.on ? " picked" : ""}`, "aria-pressed": String(pick.on), onclick: pick.toggle,
    }, pickMark(pick.on), ...parts));
  }
  return h("li", {}, h("div", { class: "card row trash-record" }, ...parts,
    h("button", { type: "button", class: "small primary", onclick: restore }, icon("undo"), t("restore"))));
}

// Çöp kutusunu temizleme: "Temizle" seçim modunu açar; kayıtlar tek tek ya da "Hepsini seç" ile seçilip
// kalıcı silinir. Kalıcı silme ilk dokunuşta "Emin misin?" olur, ikinci dokunuşta siler (açılır soru yok).
let purge = null; // seçim modunda: seçilenlerin anahtarları ("m:id", "p:id", "c:id")
let purgeArmed = null; // "Emin misin?" bekleme zamanlayıcısı

function setPurge(on) {
  purge = on ? new Set() : null;
  clearTimeout(purgeArmed);
  purgeArmed = null;
  rendered = null; // başlıktaki düğme de değişir
  render();
}

async function runPurge(keys) {
  const ids = (prefix) => keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(2));
  setPurge(false);
  try {
    await purgeTrash({ moves: ids("m:"), products: ids("p:"), parties: ids("c:") });
    toast(t("purged", { n: keys.length }));
  } catch (err) {
    console.error(err);
    toast(t("saveFailed"));
  }
}

const trashPage = {
  trash: true,
  top: () => pageTop(t("page_trash"), h("button", { type: "button", class: `small${purge ? "" : " danger"}`, onclick: () => setPurge(!purge) },
    purge ? t("cancel") : [icon("trash"), t("trashClean")])),
  body() {
    if (!pageMoves) return [];
    const { products, parties } = session.firm.trash;
    const groupOf = (m) => TRASH_GROUPS.find(([, types]) => types?.includes(m.type))?.[0] ?? "cash";
    // Seçim modunda dokunmak seçer; değilse ayrıntıyı açar (ürün/kişide "Geri yükle").
    const pick = (key) => purge && {
      on: purge.has(key),
      toggle: () => { if (!purge.delete(key)) purge.add(key); rerenderBody(); },
    };
    const moveItem = (m) => {
      const key = `m:${m.id}`;
      const p = pick(key);
      const li = moveRow(m, { onclick: p ? p.toggle : () => openMoveDetail(m) });
      if (p) {
        li.firstChild.classList.toggle("picked", p.on);
        li.firstChild.setAttribute("aria-pressed", String(p.on));
        li.firstChild.prepend(pickMark(p.on));
      }
      return li;
    };
    const items = [
      ...[...products.values()].map((p) => ({ key: `p:${p.id}`, group: "products", at: millis(p.deleted?.at), el: () => trashRecord(p, "product", pick(`p:${p.id}`)) })),
      ...[...parties.values()].map((p) => ({ key: `c:${p.id}`, group: { seller: "sellers", supplier: "suppliers", person: "debts" }[p.kind], at: millis(p.deleted?.at), el: () => trashRecord(p, "party", pick(`c:${p.id}`)) })),
      ...pageMoves.filter((m) => !m.restored).map((m) => ({ key: `m:${m.id}`, group: groupOf(m), at: millis(m.voided?.at), el: () => moveItem(m) })),
    ].sort((a, b) => b.at - a.at);
    $("#firm").classList.toggle("has-fab", Boolean(purge && items.length));
    if (!items.length) return [emptyState("🗑️", t("trashEmpty"))];

    const counts = new Map();
    for (const it of items) counts.set(it.group, (counts.get(it.group) ?? 0) + 1);
    if (trashCat && !counts.has(trashCat)) trashCat = "";
    const options = [["", t("filterAll"), items.length],
      ...TRASH_GROUPS.filter(([g]) => counts.has(g)).map(([g]) => [g, t(g === "cash" ? "trashCash" : `page_${g}`), counts.get(g)])];
    const shown = items.filter((it) => !trashCat || it.group === trashCat);
    // Seçilmiş ama artık görünmeyen (başka bölümde ya da silinmiş) kayıtlar sayılmaz.
    const chosen = purge ? shown.map((it) => it.key).filter((k) => purge.has(k)) : [];
    const allOn = purge && chosen.length === shown.length;
    const out = [
      bubbleRow(options, trashCat, (v) => { trashCat = v; rerenderBody(); }, t("page_trash")),
      h("p", { class: "field-hint trash-hint" }, t(purge ? "purgeHint" : "trashHint")),
      h("ul", { class: "cards" }, shown.map((it) => it.el())),
      purge && h("div", { class: "fab-bar purge-bar" },
        h("button", {
          type: "button", class: "block",
          onclick: () => { for (const it of shown) (allOn ? purge.delete(it.key) : purge.add(it.key)); rerenderBody(); },
        }, icon(allOn ? "x" : "listCheck"), t(allOn ? "selectNone" : "selectAll")),
        h("button", {
          type: "button", class: `block danger-fill${purgeArmed ? " armed" : ""}`, disabled: !chosen.length,
          onclick: () => {
            if (purgeArmed) return runPurge(chosen);
            purgeArmed = setTimeout(() => { purgeArmed = null; rerenderBody(); }, 4000);
            return rerenderBody();
          },
        }, icon("trash"), purgeArmed ? t("purgeConfirm") : t("purgeSelected", { n: chosen.length }))),
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
        item("wallet", t("paymentMethods"), paymentMethods(firm).map((m) => m.name).join(", "), () => openMethodsSheet()),
        item("fileScan", t("aiSettings"), firm.ai?.key || sharedAiReady() ? t("aiReady") : t("aiNotSet"), () => openAiSheet()),
        item("wallet", t("page_cash"), t("cashSettingsHint"), () => openPage("cash")),
        item("globe", t("page_shop"), shopOf()?.on ? shopOf().slug : t("shopOffHint"), () => openShopSheet()),
        item("receipt", t("receiptSettings"), t("receiptSettingsHint"), () => openReceiptSettings())),
      h("div", { class: "field" }, h("span", {}, t("theme")),
        segmented([["auto", t("theme_auto")], ["light", t("theme_light")], ["dark", t("theme_dark")]], currentTheme(), applyTheme),
        h("small", { class: "field-hint" }, t("themeHint"))),
      // Ana para birimi: bütün tutarlar bu paradadır (değişince tutarlar çevrilmez, sadece işaret değişir).
      h("label", { class: "field" }, h("span", {}, t("baseCurrency")),
        h("select", {
          onchange: (e) => saveFirmSettings({ currency: e.target.value }).then(() => toast(t("saved")), () => toast(t("saveFailed"))),
        }, CURRENCIES.map((c) => h("option", { value: c, selected: c === base() }, currencyName(c, lang)))),
        h("small", { class: "field-hint" }, t("baseCurrencyHint"))),
      h("div", { class: "field" }, h("span", {}, t("waApp")),
        segmented([["", t("waApp_auto")], ["w", "WhatsApp"], ["b", "WhatsApp Business"]], store.get("waApp") ?? "", (v) => store.set("waApp", v || null)),
        h("small", { class: "field-hint" }, t("waAppHint"))),
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
    actions: () => [
      [t("new_saleReturn"), "undo", () => openMoveSheet("saleReturn")],
      [t("page_saleInvoice"), "fileScan", () => openSaleImport()],
      [t("page_consign"), "send", () => openPage("consign")]],
  }),
  // İadeler: satış sayfasının aynısı; müşterinin geri getirdiği mal ve geri verilen para.
  // İadeler: müşteriden iade al (satış iadesi) ve tedarikçiye iade ver.
  saleReturns: movesPage({
    types: ["saleReturn", "refund", "purchaseReturn", "supplierRefund"], empty: "noSaleReturns",
    fab: () => [t("returnsTake"), () => openMoveSheet("saleReturn")],
    actions: () => [
      [t("returnsTake"), "undo", () => openMoveSheet("saleReturn")],
      [t("returnsGive"), "out", () => openMoveSheet("purchaseReturn")]],
    summary: () => monthTotal(["saleReturn"]),
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
  stockCount: stockCountPage,
  sellers: partiesPage("seller"),
  suppliers: partiesPage("supplier"),
  debts: partiesPage("person"),
  orders: ordersPage,
  stockValue: stockValuePage,
  search: searchPage,
  shopPreview: shopPreviewPage,
  debtList: debtListPage,
  valueDetail: valueDetailPage,
  cash: cashPage,
  partners: partnersPage,
  fund: fundPage,
  reports: reportsPage,
  report: reportPage,
  ledger: ledgerPage,
  trash: trashPage,
  settings: settingsPage,
};
