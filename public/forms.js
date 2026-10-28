// Formlar: ürün, cari, alış/satış/emanet, sayım/iade, kasa işlemleri, ortaklık payları
// ve hareket ayrıntısı. Hepsi aynı <dialog id="sheet"> içinde açılır.
// Kolaylık için her alan akla gelen değerle dolu gelir: tarih bugün, fiyat ürünün fiyatı,
// kur son kullanılan, parayı alan/veren ortak kişinin kendisi.

import { $, h, icon, iconButton, toast, today, formatDay, millis, avatar, dateLocale } from "./ui.js";
import { t, UNITS, unitLabel, lang } from "./i18n.js";
import { session, currentFirm, person, partners, generalShares } from "./session.js";
import {
  parseMoney, parseQty, parseRate, formatMoney, formatNumber, formatRate, moneyInput, qtyInput,
  CURRENCIES, currencySymbol, currencyName, base,
} from "./money.js";
import { PARTY_KIND, hasLines, lineTotal, avgCost, roundQty } from "./ledger.js";
import {
  recordMoves, voidMoves, replaceMove, restoreMove, saveProduct, saveParty, deleteProduct, deleteParty, restoreProduct, restoreParty, saveShares,
  setCategories, saveDeal, deleteDeal, putDeal, saveGuest, deleteGuest, putGuest, dealOf, productByBarcode, barcodesOf, productLabel, saveFirmSettings, shareReceipt, setShopHidden,
} from "./data.js";
import {
  byName, matches, searchBox, balanceText, productThumb, productCategories, categoryBubbles, inCategory, NO_CATEGORY,
  unitCostOf, landedCost, receiptNumber, segmented,
} from "./views.js";
import {
  RECEIPT_LABEL_KEYS, MONEY_KINDS, receiptBlob, receiptPdf, printReceipt, shareOnWhatsApp, canShareFiles, waPhone, canCopyImage, copyImageAndOpenChat,
} from "./receipt.js";
import { shopOf, shopUrl, productUrl, slugify, saveShop, syncShop, setOrderStatus, deleteOrder, pushSupported, pushPermission, enableOrderPush } from "./shop.js";
import { pickGeminiModel } from "./invoice.js";
import { sharedAiReady } from "./ai.js";
import { lastRate, rememberRate, fetchRate } from "./rates.js";
import { pickImage, preparePhoto, prepareSquare, prepareCover, loadFullPhoto } from "./photos.js";
import { canScan, scanBarcode } from "./scanner.js";
import { canPickContact, pickContact } from "./contacts.js";

const sheet = $("#sheet");

// Form telefonda tam ekran bir sayfa gibi açılır: üstte geri oku ve başlık, ortada alanlar,
// altta hep görünen ana düğme. Ana düğme (primary) ve "foot" sınıflı parçalar alta gider,
// diğer düğmeler alanların sonuna. Kapat düğmesinin yerini üstteki geri oku alır.
// onsubmit hata metni döndürürse form açık kalır ve metin ana düğmenin hemen üstünde görünür.
// dialog: hangi pencerede açılacağı; formun üstünde başka bir form (satıştan yeni ürün) için #subsheet.
function open(title, fields, buttons, onsubmit, dialog = sheet) {
  const error = h("p", { class: "error", role: "alert" });
  const list = buttons.filter((b) => b && !b.hasAttribute?.("data-close"));
  const foot = list.filter((b) => b.classList?.contains("primary") || b.classList?.contains("foot"));
  const rest = list.filter((b) => !foot.includes(b));
  const body = h("div", { class: "sheet-body" }, fields.filter(Boolean), rest, foot.length ? null : error);
  const form = h("form", {
    class: "menu", novalidate: true,
    onsubmit: (e) => {
      e.preventDefault();
      error.textContent = "";
      try {
        const message = onsubmit?.();
        if (typeof message === "string") error.textContent = message;
      } catch (err) {
        console.error(err);
        error.textContent = t("genericError");
      }
    },
  },
  h("header", { class: "sheet-top" },
    h("button", { type: "button", class: "icon back", "aria-label": t("close"), onclick: () => dialog.close() }, icon("back")),
    h("h3", {}, title)),
  body,
  foot.length > 0 && h("div", { class: "sheet-foot" }, error, foot));
  dialog.replaceChildren(form);
  if (!dialog.open) dialog.showModal(); // bir formdan diğerine geçerken pencere zaten açık
  body.scrollTop = 0;
}

const subsheet = $("#subsheet");

// Formun altındaki özet + ana düğme (toplam, sayılan…): solda özet, sağda düğme.
const footBar = (summary, button) => h("div", { class: "foot foot-bar" }, summary, button);

const failed = (err) => {
  console.error(err);
  toast(t("saveFailed"));
};

// Kayıt yerel önbelleğe hemen düşer; internet yoksa sunucuya sonra gider.
function saved(promise, message) {
  sheet.close();
  toast(message);
  promise.catch(failed);
}

// Ortaklık / uygulamasız ortak silindi (çöp kutusu yok): bildirimdeki "Geri al" eskisini geri yazar.
function removed(promise, message, undo) {
  sheet.close();
  promise.catch(failed);
  toast(message, () => undo().then(() => toast(t("restored")), failed));
}

// Ürün / cari silindi: çöp kutusuna taşındı; bildirimdeki "Geri al" geri yükler.
function trashed(promise, undo) {
  sheet.close();
  promise.catch(failed);
  toast(t("movedToTrash"), () => undo().then(() => toast(t("restored")), failed));
}

// Hareket kaydı: bildirimdeki "Geri al" kaydı iptal eder (defterde iz kalır).
// Satışta, ödemede ve tahsilatta bildirim yerine fiş / makbuz gönderme penceresi açılır.
// options: recordMoves'a (aynı kayıtta açılacak yeni cari gibi).
function record(inputs, message = t("savedMove"), options = {}) {
  // Kişinin kayıttan önceki bakiyesi: canlı liste yeni bakiyeyi biraz sonra getirir.
  const before = session.firm.parties.get(inputs[0]?.party)?.balance ?? 0;
  const { moves, done } = recordMoves(inputs, options);
  done.catch(failed);
  if (moves.some((m) => RECEIPT_TYPES.includes(m.type))) return saleDone(moves, before);
  if (moves.length === 1 && MONEY_KINDS.includes(moves[0].type) && moves[0].party) return moneyDone(moves[0], before);
  sheet.close();
  toast(message, () => voidMoves(moves, t("undoReason")).then(() => toast(t("undone")), failed));
  return undefined;
}

const field = (label, control, hint) =>
  h("label", { class: "field" }, h("span", {}, label), control, hint && h("small", { class: "field-hint" }, hint));
const textInput = (attrs = {}) => h("input", { autocomplete: "off", dir: "auto", ...attrs });
const numberInput = (attrs = {}) => h("input", { inputmode: "decimal", autocomplete: "off", dir: "ltr", ...attrs });
const select = (options, value, attrs = {}) =>
  h("select", attrs, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
const fact = (label, value) => h("div", { class: "fact" }, h("span", {}, label), h("strong", {}, value));
// Not alanı gizli başlar; "Not ekle"ye dokununca açılır (çoğu kayıtta not gerekmez).
function noteField(input) {
  const wrap = field(t("note"), input);
  wrap.hidden = !input.value;
  const toggle = h("button", {
    type: "button", class: "pill-btn", hidden: Boolean(input.value),
    onclick: () => { toggle.hidden = true; wrap.hidden = false; input.focus(); },
  }, icon("pencil"), t("addNote"));
  return h("div", { class: "note-field" }, toggle, wrap);
}
const saveButton = (label = t("save")) => h("button", { class: "primary block" }, label);
const closeButton = () => h("button", { type: "button", class: "block ghost", "data-close": true, onclick: () => sheet.close() }, t("close"));
const dateInput = (value) => h("input", { type: "date", value: value || today(), required: true });
const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);

// Ortak seçimi. Tek ortak varsa gösterilmez (hep kendisi).
function partnerField(label, value = session.uid, exclude) {
  const firm = currentFirm();
  const uids = firm.members.filter((uid) => uid !== exclude);
  const el = select(uids.map((uid) => [uid, uid === session.uid ? `${person(firm, uid).name} (${t("you")})` : person(firm, uid).name]), value);
  return { el, field: firm.members.length > 1 ? field(label, el) : null };
}

// Gerekli kayıt yoksa (ürün, kişi, emanet) önce onu yapmaya yönlendirir.
function missing(title, text, action, onclick) {
  open(title, [h("p", { class: "muted center" }, text)], [
    h("button", { type: "button", class: "primary block", onclick }, action), closeButton(),
  ]);
}


// --- Ürün -------------------------------------------------------------------

// Fotoğraf alanı: dokununca kamera/galeri açılır. Sonuç: undefined (değişmedi), null (kaldırıldı)
// ya da { thumb, full } (yeni). loadFull verilirse büyük hal sonradan yüklenir.
function photoField(current, { loadFull, round = false, label = t("addPhoto"), prepare = preparePhoto } = {}) {
  let result;
  const img = h("img", { alt: "" });
  const empty = h("span", { class: "photo-empty" }, icon("camera"), h("span", {}, label));
  const box = h("button", { type: "button", class: `photo${round ? " round" : ""}`, "aria-label": label }, img, empty);
  const remove = h("button", { type: "button", class: "link", hidden: true }, t("removePhoto"));
  const show = (src) => {
    img.src = src || "";
    img.hidden = !src;
    empty.hidden = Boolean(src);
    remove.hidden = !src;
  };
  show(current);
  if (current && loadFull) loadFull().then((full) => { if (full && result === undefined) img.src = full; });

  box.addEventListener("click", async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      result = await prepare(file);
      show(result.full);
    } catch (err) {
      console.error(err);
      toast(t("photoFailed"));
    }
  });
  remove.addEventListener("click", () => {
    result = null;
    show("");
  });
  return { el: h("div", { class: `photo-field${round ? " small" : ""}` }, box, remove), value: () => result };
}

// Kategori alanı: var olan kategoriler baloncuk; dokununca seçilir, seçiliye dokununca kalkar.
// "+ Yeni kategori" bir yazı kutusu açar. Hiç kategori yoksa yazı kutusu doğrudan görünür.
function categoryField(current) {
  const cats = productCategories([...session.firm.products.values()]).map(([c]) => c);
  let value = current;
  const input = textInput({ maxlength: 40, placeholder: t("newCategoryPlaceholder") });
  input.hidden = cats.length > 0;
  const wrap = h("div", { class: "bubbles wrap" });
  const render = () => wrap.replaceChildren(
    ...cats.map((c) => h("button", {
      type: "button", class: "bubble", "aria-pressed": String(input.hidden && c === value),
      onclick: () => {
        value = value === c && input.hidden ? "" : c;
        input.hidden = true;
        input.value = "";
        render();
      },
    }, h("bdi", {}, c))),
    h("button", {
      type: "button", class: "bubble add", "aria-pressed": String(!input.hidden),
      onclick: () => { input.hidden = false; input.focus(); render(); },
    }, "+ ", t("newCategory")));
  if (cats.length) render();
  return {
    el: h("div", { class: "field" }, h("span", {}, t("category")), cats.length ? wrap : null, input,
      h("small", { class: "field-hint" }, t("categoryHint"))),
    value: () => (input.hidden ? value : input.value.trim()),
  };
}

// Kategoriler (Ürünler sayfasından): var olanlar ürün sayılarıyla; birine ya da "Yeni kategori"ye
// dokununca adı ve içindeki ürünler seçilir.
export function openProductCategories() {
  const products = [...session.firm.products.values()];
  const cats = productCategories(products);
  open(t("productCategories"), [
    h("ul", { class: "cards" },
      cats.map(([c, n]) => h("li", {}, h("button", { type: "button", class: "card row", onclick: () => openCategoryEditor(c) },
        categoryPhoto(c) ? h("img", { class: "cat-photo", src: categoryPhoto(c), alt: "" }) : h("span", { class: "cat-photo empty" }, icon("camera")),
        h("span", { class: "main" }, h("span", { class: "title" }, h("bdi", {}, c)), h("span", { class: "meta" }, t("productCount", { n }))),
        icon("chevron"))))),
    !cats.length && h("p", { class: "field-hint" }, t("noCategoriesYet")),
  ], [
    h("button", { type: "button", class: "primary block", onclick: () => openCategoryEditor("") }, icon("plus"), t("newCategory")),
    closeButton(),
  ]);
}

// Kategori fotoğrafı (online mağazada kategori kutucuğunda görünür): işletme ayarlarında, kategori adına göre.
const categoryPhoto = (name) => currentFirm().categoryPhotos?.[name] ?? "";

// Bir kategori: fotoğrafı, adı ve içindeki ürünler (işaretli olanlar). Kaydedince işaretlenenler bu kategoriye
// geçer, işareti kaldırılanlar kategorisiz kalır; ad değişirse hepsi (ve fotoğrafı) yeni adı alır. Hiç ürün
// kalmazsa kategori silinmiş olur.
function openCategoryEditor(current) {
  const products = [...session.firm.products.values()].sort(byName);
  const photo = photoField(categoryPhoto(current), { prepare: prepareSquare, label: t("categoryPhoto") });
  const name = textInput({ maxlength: 40, value: current, placeholder: t("newCategoryPlaceholder") });
  const picked = new Set(products.filter((p) => current && p.category === current).map((p) => p.id));
  let query = "";
  const count = h("small", { class: "field-hint" });
  const list = h("ul", { class: "cards pick-list" });
  const render = () => {
    count.textContent = t("productsChosen", { n: picked.size });
    list.replaceChildren(...products.filter((p) => matches(productLabel(p), query)).map((p) => {
      const on = picked.has(p.id);
      return h("li", {}, h("button", {
        type: "button", class: `card row check-row${on ? " picked" : ""}`, "aria-pressed": String(on),
        onclick: () => { if (!picked.delete(p.id)) picked.add(p.id); render(); },
      },
      h("span", { class: `pick-check${on ? " on" : ""}`, "aria-hidden": "true" }, on ? icon("check") : null),
      productThumb(p, "sm"),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        p.category && p.category !== current && h("span", { class: "meta" }, h("bdi", {}, p.category)))));
    }));
  };
  render();
  open(current || t("newCategory"), [
    photo.el,
    h("small", { class: "field-hint center" }, t("categoryPhotoHint")),
    field(t("categoryName"), name),
    h("p", { class: "label" }, t("categoryProducts")),
    searchBox(t("searchProducts"), "", (v) => { query = v; render(); }),
    list,
    count,
  ], [saveButton(), h("button", { type: "button", class: "block ghost", onclick: openProductCategories }, t("back"))], () => {
    const n = name.value.trim();
    if (!n) return t("enterCategoryName");
    if (!picked.size && !current) return t("pickSomeProducts");
    const changes = {};
    for (const p of products) {
      const next = picked.has(p.id) ? n : p.category === current && current ? "" : p.category ?? "";
      if (next !== (p.category ?? "")) changes[p.id] = next;
    }
    // Fotoğraf: yeni seçildiyse o, kaldırıldıysa yok, değişmediyse eskisi (ad değiştiyse yeni adla).
    const photos = { ...(currentFirm().categoryPhotos ?? {}) };
    const before = JSON.stringify(photos);
    const pic = photo.value();
    const keep = categoryPhoto(current);
    if (current) delete photos[current];
    if (pic) photos[n] = pic.thumb;
    else if (pic === undefined && keep) photos[n] = keep;
    else delete photos[n];
    const photoChanged = JSON.stringify(photos) !== before;
    if (!Object.keys(changes).length && !photoChanged) return sheet.close();
    saved(Promise.all([
      Object.keys(changes).length ? setCategories(changes) : null,
      photoChanged ? saveFirmSettings({ categoryPhotos: photos }) : null,
    ]), t("saved"));
    return undefined;
  });
}

// Barkod alanı: yazılabilir ya da kamerayla okutulur.
function barcodeField(value) {
  const input = h("input", { inputmode: "numeric", autocomplete: "off", dir: "ltr", maxlength: 64, value, placeholder: t("barcodePlaceholder") });
  const scan = canScan() && h("button", {
    type: "button", class: "icon scan", "aria-label": t("scanBarcode"), title: t("scanBarcode"),
    onclick: async () => {
      const code = await scanBarcode();
      if (code) input.value = code;
    },
  }, icon("barcode"));
  return { input, el: field(t("barcode"), h("div", { class: "with-button" }, input, scan)) };
}

// Satış fiyatına göre kâr marjı: (satış − maliyet) / satış.
const marginPct = (price, cost) => (price > 0 && cost > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null);
const isLow = (p) => p.minStock > 0 && p.stock <= p.minStock;

// preset: yeni ürün formunu doldurmak için (barkod okutulduğunda ya da çeşit eklerken).
// inside(id): satış/alış formunun üstünde açılır; kaydedilince yeni ürünün kimliğiyle çağrılır.
export function openProductSheet(product, preset = {}, { inside } = {}) {
  const firm = currentFirm();
  const base = product ?? preset;
  const photo = photoField(product?.thumb, { loadFull: product ? () => loadFullPhoto(product.id) : null });
  const name = textInput({ maxlength: 80, value: base.name, placeholder: t("productNamePlaceholder") });
  const variant = textInput({ maxlength: 40, value: product?.variant ?? "", placeholder: t("variantPlaceholder") });
  const unit = select(UNITS.map((u) => [u, unitLabel(u)]), base.unit ?? UNITS[0]);
  const price = numberInput({ value: moneyInput(base.price), placeholder: "0,00" });
  // Maliyet satış fiyatının solunda ve düzenlenebilir. Kayıtlı üründe şu anki birim maliyet gelir;
  // değiştirilirse kaydedince maliyet düzeltme kaydı girer (depodaki malın değeri de güncellenir).
  const costNow = product ? Math.round(unitCostOf(product)) : base.cost ?? 0;
  const costIn = numberInput({ value: moneyInput(costNow), placeholder: "0,00" });
  // Birim başına yakıt gideri ve istenen kadar başka masraf: sadece kârı doğru göstermek için.
  const fuel = numberInput({ value: moneyInput(base.fuel ?? 0), placeholder: "0,00" });
  const extraList = h("div", { class: "cat-list" });
  const extras = [];
  const addExtra = (x) => {
    const nameIn = textInput({ maxlength: 40, value: x?.name ?? "", placeholder: t("extraCostName") });
    const amountIn = numberInput({ value: moneyInput(x?.amount ?? 0), placeholder: "0,00", class: "extra-amount" });
    const row = { nameIn, amountIn };
    const el = h("div", { class: "cat-row" }, nameIn, amountIn, iconButton("x", t("remove"), () => {
      extras.splice(extras.indexOf(row), 1);
      el.remove();
      showMargin();
    }));
    amountIn.addEventListener("input", () => showMargin());
    extras.push(row);
    extraList.append(el);
    return nameIn;
  };
  const vat = numberInput({ value: String(base.vat ?? firm.defaultVat ?? 20).replace(".", ","), placeholder: "20" });
  const minStock = numberInput({ value: base.minStock ? qtyInput(base.minStock) : "", placeholder: t("minStockPlaceholder") });
  const barcode = barcodeField(product?.barcode ?? preset.barcode ?? "");
  // Aynı ürünün başka barkodları (farklı ambalaj, eski etiket…): her biri okutulabilir.
  const extraCodes = h("div", { class: "cat-list" });
  const codes = [];
  const addCode = (value = "") => {
    const input = h("input", { inputmode: "numeric", autocomplete: "off", dir: "ltr", maxlength: 64, value, placeholder: t("barcodeExtra") });
    const row = { input };
    const el = h("div", { class: "cat-row" }, input,
      canScan() && iconButton("barcode", t("scanBarcode"), async () => { const c = await scanBarcode(); if (c) input.value = c; }),
      iconButton("x", t("remove"), () => { codes.splice(codes.indexOf(row), 1); el.remove(); }));
    codes.push(row);
    extraCodes.append(el);
    return input;
  };
  for (const c of product?.barcodes ?? []) addCode(c);
  const category = categoryField(base.category ?? "");
  // Online mağaza açıksa: bu ürün vitrinde görünsün mü (fiyatı olan ürünler görünür).
  const shopShow = h("input", { type: "checkbox", checked: !base.shopHide });

  // Stok, birim ve fiyatın hemen altında: yeni üründe "Elinde şu an var mı?", kayıtlı üründe depo durumu.
  let qty;
  let stockBlock;

  // Kâr marjı canlı: satış fiyatı ile toplam maliyetten (alış + yakıt + diğer masraflar).
  const extraSum = () => (parseMoney(fuel.value) ?? 0) + sum(extras, (x) => parseMoney(x.amountIn.value) ?? 0);
  const cost = () => (parseMoney(costIn.value) ?? 0) + extraSum();
  const margin = h("small", { class: "field-hint margin" });
  const showMargin = () => {
    const p = parseMoney(price.value);
    const c = cost();
    const m = marginPct(p, c);
    const extra = extraSum();
    const parts = [m == null ? t("marginNeedsCost")
      : t("marginLine", { pct: formatNumber(m), amount: formatMoney(p - Math.round(c)), cost: formatMoney(Math.round(c)) })];
    if (extra) parts.push(t("landedLine", { cost: formatMoney(parseMoney(costIn.value) ?? 0), extra: formatMoney(extra) }));
    margin.textContent = parts.join(" · ");
    margin.classList.toggle("bad", m != null && m < 0);
  };
  for (const el of [price, costIn, fuel]) el.addEventListener("input", showMargin);
  for (const x of base.extras ?? []) addExtra(x);
  if (product) {
    stockBlock = [h("div", { class: "facts" },
      fact(t("inStock"), `${formatNumber(product.stock)} ${unitLabel(product.unit)}`),
      fact(t("atSellersLabel"), `${formatNumber(product.consigned ?? 0)} ${unitLabel(product.unit)}`),
      fact(t("avgCost"), formatMoney(avgCost(product))),
      fact(t("stockValue"), formatMoney(product.value)))];
  } else {
    qty = numberInput({ placeholder: "0" });
    stockBlock = [field(t("openingStock"), qty, t("openingStockHint"))];
  }
  showMargin();

  const fields = [
    photo.el,
    field(t("productName"), name),
    category.el,
    field(t("variant"), variant, t("variantHint")),
    h("div", { class: "row2" }, field(t("costPrice"), costIn), field(t("salePrice"), price)),
    margin,
    product && product.stock > 0 && h("small", { class: "field-hint" }, t("costFixHint")),
    h("div", { class: "row2" }, field(t("vatRate"), vat), field(t("fuelCost"), fuel)),
    extraList,
    h("button", { type: "button", class: "small add-line", onclick: () => addExtra().focus() }, "+ ", t("addExtraCost")),
    h("small", { class: "field-hint" }, t("extraCostsHint")),
    ...stockBlock,
    h("div", { class: "row2" }, field(t("unit"), unit), field(t("minStock"), minStock)),
    h("small", { class: "field-hint" }, t("minStockHint")),
    barcode.el,
    extraCodes,
    h("button", { type: "button", class: "small add-line", onclick: () => addCode().focus() }, "+ ", t("addBarcode")),
    shopOf()?.on && h("label", { class: "check" }, shopShow, h("span", {}, t("shopShowProduct"))),
  ];

  // Ortaklık: bu ürünün kârı genel paylarla mı, bir ürün ortaklığıyla mı bölünür?
  const deals = Object.entries(firm.deals ?? {});
  const currentDeal = product ? dealOf(product.id) : "";
  let deal;
  deal = select([["", t("generalShares")], ...deals.map(([id, d]) => [id, d.name])], currentDeal);
  fields.push(field(t("productDeal"), deal, t(deals.length ? "productDealHint" : "noDealsHint")));

  if (product) {
    // Çeşitler: aynı gruptaki diğer ürünler ve yeni çeşit ekleme.
    const groupId = product.groupId || product.id;
    const siblings = [...session.firm.products.values()].filter((p) => p.id !== product.id && (p.groupId || p.id) === groupId).sort(byName);
    fields.push(
      h("p", { class: "label" }, t("variants")),
      h("div", { class: "chips" },
        siblings.map((p) => h("button", { type: "button", class: "chip", onclick: () => openProductSheet(p) },
          h("bdi", {}, p.variant || p.name), h("small", {}, ` · ${formatNumber(p.stock)}`))),
        h("button", {
          type: "button", class: "chip add",
          onclick: () => openProductSheet(null, {
            name: product.name, category: product.category ?? "", unit: product.unit, price: product.price, vat: product.vat, minStock: product.minStock, groupId,
          }),
        }, "+ ", t("addVariant"))),
      h("small", { class: "field-hint" }, t("variantsHint")));
  }

  const buttons = [saveButton()];
  if (product) {
    // Stok tedarikçiden alışla artar: ürünle dolu alış formu açılır.
    buttons.push(h("button", {
      type: "button", class: "block",
      onclick: () => openMoveSheet("purchase", { lines: [{ product: product.id, qty: suggestedOrder(product) }] }),
    }, icon("in"), t("addStock")));
    const hasStock = Boolean(product.stock || product.value || product.consigned);
    buttons.push(h("button", {
      type: "button", class: "block danger", disabled: hasStock,
      onclick: () => trashed(deleteProduct(product.id), () => restoreProduct(product.id)),
    }, t("delete")));
    if (hasStock) buttons.push(h("small", { class: "field-hint center" }, t("cantDeleteProduct")));
  }
  buttons.push(closeButton());

  const title = product ? t("editProduct") : preset.groupId ? t("addVariant") : t("newProduct");
  open(title, fields, inside ? [saveButton(t("saveAndAdd"))] : buttons, () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    const p = price.value.trim() ? parseMoney(price.value) : 0;
    if (p == null) return t("badNumber");
    const v = vat.value.trim() ? parseQty(vat.value) : 0;
    if (v == null || v < 0 || v > 100) return t("badVat");
    const min = minStock.value.trim() ? parseQty(minStock.value) : 0;
    if (min == null) return t("badNumber");
    const code = barcode.input.value.trim();
    const more = [...new Set(codes.map((x) => x.input.value.trim()).filter((x) => x && x !== code))].slice(0, 20);
    for (const each of [code, ...more].filter(Boolean)) {
      const twin = productByBarcode(each);
      if (twin && twin.id !== product?.id) return t("barcodeTaken", { name: productLabel(twin) });
    }
    const c = costIn.value.trim() ? parseMoney(costIn.value) : 0;
    const f = fuel.value.trim() ? parseMoney(fuel.value) : 0;
    if (c == null || f == null) return t("badNumber");
    const extraCosts = [];
    for (const x of extras) {
      const a = x.amountIn.value.trim() ? parseMoney(x.amountIn.value) : 0;
      if (a == null) return t("badNumber");
      if (a || x.nameIn.value.trim()) extraCosts.push({ name: x.nameIn.value.trim() || t("extraCost"), amount: a });
    }
    let opening;
    // Yeni üründe miktar varsa açılış kaydı; sadece maliyet yazıldıysa ürünün son alış maliyeti olur
    // (marj ve alışta önerilen fiyat için).
    let lastCost;
    if (!product && qty.value.trim()) {
      const q = parseQty(qty.value);
      if (!q) return t("badOpening");
      opening = { qty: q, cost: c };
    } else if (!product && c) {
      lastCost = c;
    }
    const data = {
      name: n, variant: variant.value.trim(), category: category.value(), unit: unit.value, price: p, barcode: code, barcodes: more, vat: v, minStock: min,
      groupId: product?.groupId ?? preset.groupId ?? "", fuel: f, extras: extraCosts.slice(0, 10),
      shopHide: !shopShow.checked,
    };
    // Kayıtlı ürünün maliyeti elle değiştirildiyse maliyet düzeltme kaydı (depodaki değer de güncellenir).
    if (product && c !== costNow) {
      recordMoves([{ type: "costFix", party: "", date: today(), note: "", lines: [{ product: product.id, qty: Math.max(product.stock, 0), price: c }] }])
        .done.catch(failed);
    }
    const nextDeal = deal && deal.value !== currentDeal ? deal.value : undefined;
    const done = saveProduct(product?.id, data, { opening, lastCost, photo: photo.value(), deal: nextDeal });
    if (inside) {
      done.catch(failed);
      subsheet.close();
      inside(done.id);
      return undefined;
    }
    saved(done, t("saved"));
    return undefined;
  }, inside ? subsheet : sheet);
  if (!product && !preset.name) name.focus();
}

// --- Satıcı / tedarikçi -------------------------------------------------------

export function openPartySheet(kind, party) {
  const name = textInput({ maxlength: 80, value: party?.name, placeholder: t(`namePlaceholder_${kind}`) });
  const phone = h("input", { type: "tel", maxlength: 24, value: party?.phone, dir: "ltr", autocomplete: "off", placeholder: "0555 555 55 55" });
  const note = textInput({ maxlength: 200, value: party?.note, placeholder: t("partyNotePlaceholder") });
  const photo = photoField(party?.thumb, { round: true, label: t("addLogo") });
  // Fatura bilgileri: fatura belgesinde müşteri/tedarikçi bloğuna yazılır (isteğe bağlı, kapalı gelir).
  const taxNo = h("input", { inputmode: "numeric", maxlength: 20, value: party?.taxNo ?? "", dir: "ltr", autocomplete: "off" });
  const taxOffice = textInput({ maxlength: 60, value: party?.taxOffice ?? "" });
  const address = textInput({ maxlength: 300, value: party?.address ?? "" });
  const taxInfo = h("details", { class: "more", open: Boolean(party?.taxNo || party?.address) },
    h("summary", {}, t("invoiceDetails")),
    h("div", { class: "row2" }, field(t("taxNo"), taxNo), field(t("taxOffice"), taxOffice)),
    field(t("address"), address));
  const fields = [photo.el, field(t("name"), name), field(t("phone"), phone), field(t("note"), note), taxInfo];

  // Telefon rehberinden seçme (Android Chrome); ad ve numarayı doldurur.
  if (canPickContact()) {
    fields.splice(1, 0, h("button", {
      type: "button", class: "block contact-pick",
      onclick: async () => {
        try {
          const contact = await pickContact();
          if (!contact) return;
          if (contact.name) name.value = contact.name.slice(0, 80);
          if (contact.phone) phone.value = contact.phone.slice(0, 24);
        } catch (err) {
          console.error(err);
          toast(t("contactFailed"));
        }
      },
    }, icon("contact"), t("pickContact")));
  }

  // Tedarikçiyle ve borç defterindeki kişiyle hangi parayla çalışıldığı: borç o parada tutulur.
  let currency = null;
  if (kind === "supplier" || kind === "person") {
    const locked = Boolean(party?.balance);
    currency = select(CURRENCIES.map((c) => [c, currencyName(c, lang)]), party?.currency ?? base(), { disabled: locked });
    fields.push(field(t("currency"), currency, locked ? t("currencyLocked") : t("currencyHint")));
  }

  let amount;
  let direction;
  if (!party) {
    amount = numberInput({ placeholder: "0,00" });
    // Bakiye işareti: satıcıda + bize borçlu, tedarikçide + biz borçluyuz.
    const options = kind !== "supplier"
      ? [["1", t("theyOweUs")], ["-1", t("weOweThem")]]
      : [["1", t("weOweThem")], ["-1", t("theyOweUs")]];
    direction = select(options, "1");
    fields.push(
      h("p", { class: "label" }, t("openingBalance")),
      h("div", { class: "row2" }, field(t("amount"), amount), field(t("direction"), direction)),
      h("small", { class: "field-hint" }, t("openingBalanceHint")));
  }

  const buttons = [saveButton()];
  if (party) {
    const busy = Boolean(party.balance) || Object.values(party.shelf ?? {}).some((s) => s.stock);
    buttons.push(h("button", {
      type: "button", class: "block danger", disabled: busy,
      onclick: () => trashed(deleteParty(party.id), () => restoreParty(party.id)),
    }, t("delete")));
    if (busy) buttons.push(h("small", { class: "field-hint center" }, t("cantDeleteParty")));
  }
  buttons.push(closeButton());

  const title = party ? t("editParty") : t(`new_${kind}`);
  open(title, fields, buttons, () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    let opening = 0;
    if (!party && amount.value.trim()) {
      const a = parseMoney(amount.value);
      if (a == null) return t("badNumber");
      opening = a * Number(direction.value);
    }
    const data = {
      kind, name: n, phone: phone.value.trim(), note: note.value.trim(),
      taxNo: taxNo.value.trim(), taxOffice: taxOffice.value.trim(), address: address.value.trim(),
    };
    if (currency) data.currency = currency.value;
    const pic = photo.value();
    saved(saveParty(party?.id, data, opening, pic === null ? null : pic && { thumb: pic.thumb }), t("saved"));
    return undefined;
  });
  // Rehberden seçilebiliyorsa klavye hemen açılmasın.
  if (!party && !canPickContact()) name.focus();
}

// --- Kur alanı (dövizli tedarikçide) ------------------------------------------------

function rateField(onchange) {
  const input = numberInput({ placeholder: "0,0000", oninput: () => { input.dataset.touched = "1"; onchange(); } });
  const label = h("span", {});
  const wrap = h("label", { class: "field" }, label, input, h("small", { class: "field-hint" }, t("rateHint")));
  let currency = base();
  return {
    el: wrap,
    get currency() { return currency; },
    set(next) {
      currency = next;
      wrap.hidden = next === base();
      if (next === base()) {
        onchange();
        return;
      }
      label.textContent = t("rateLabel", { c: currencySymbol(next), b: currencySymbol(base()) });
      if (!input.dataset.touched) {
        input.value = lastRate(next) ? formatRate(lastRate(next)) : "";
        fetchRate(next).then((rate) => {
          if (rate && !input.dataset.touched && currency === next) {
            input.value = formatRate(rate);
            onchange();
          }
        });
      }
      onchange();
    },
    value: () => (currency === base() ? 1 : parseRate(input.value)),
    // Düzenlemede kayıttaki kur (günün kuru önerilmez).
    prefill(rate) {
      input.value = formatRate(rate);
      input.dataset.touched = "1";
      onchange();
    },
  };
}

// --- Alış / satış / emanet (ürün satırlı) ve ödeme / tahsilat ----------------------------

// Formun içindeki ürün seçici: arama (barkod düğmeli), kategori baloncukları ve resimli kutucuklar.
// Kutucuğa dokununca ürün sepete girer; sepetteki ürünün kutucuğunda − adet + çıkar (azaltmak da
// buradan). İlk kutucuk "+ Yeni ürün": formdan çıkmadan ürün açılır ve sepete eklenir.
// products: güncel ürün listesini veren fonksiyon (yeni açılan ürün de görünsün).
function productBrowser({ products, count, price, currency, onstep, onnew, onscan }) {
  let query = "";
  let cat = "";
  const grid = h("div", { class: "pick-grid" });
  const bubbles = h("div", {});
  const render = () => {
    const q = query.trim();
    const all = products();
    bubbles.replaceChildren(...[categoryBubbles(all, cat, (v) => { cat = v; render(); })].filter(Boolean));
    const shown = all.filter((p) => inCategory(p, cat) && (matches(productLabel(p), q) || barcodesOf(p).includes(q)));
    const add = onnew && h("button", { type: "button", class: "pick-tile new", onclick: () => onnew({ name: q, category: cat && cat !== NO_CATEGORY ? cat : "" }) },
      h("span", { class: "pt-plus", "aria-hidden": "true" }, icon("plus")), h("span", { class: "pt-name" }, t("newProduct")));
    grid.replaceChildren(...[add].filter(Boolean), ...shown.map((p) => {
      const n = count(p);
      return h("div", { class: `pick-tile${n ? " picked" : ""}` },
        h("button", { type: "button", class: "pt-main", onclick: () => { onstep(p, 1); navigator.vibrate?.(15); } },
          productThumb(p, "tile"),
          h("span", { class: "pt-name" }, h("bdi", {}, productLabel(p))),
          h("span", { class: "pt-price" }, price(p) ? formatMoney(price(p), currency()) : "–"),
          h("span", { class: `pt-stock${p.stock <= 0 ? " bad" : ""}` }, `${formatNumber(p.stock)} ${unitLabel(p.unit)}`)),
        n ? h("div", { class: "pt-step" },
          h("button", { type: "button", "aria-label": t("stepLess"), onclick: () => onstep(p, -1) }, icon("minus")),
          h("strong", {}, formatNumber(n)),
          h("button", { type: "button", "aria-label": t("stepMore"), onclick: () => onstep(p, 1) }, icon("plus")))
          : h("div", { class: "pt-step add" },
            h("button", { type: "button", "aria-label": t("stepMore"), onclick: () => onstep(p, 1) }, icon("plus"))));
    }));
    if (!shown.length) grid.append(h("p", { class: "lines-empty wide" }, t(q && onnew ? "noMatchNew" : q ? "noMatch" : "noProducts")));
  };
  const el = h("div", { class: "browser" },
    searchBox(t("searchProducts"), "", (v) => { query = v; render(); }, onscan),
    bubbles,
    grid);
  render();
  return { el, refresh: render };
}

// Yeni açılan ürün yerel önbelleğe hemen yazılır; canlı liste onu kısa süre içinde getirir.
async function productWhenReady(id) {
  for (let i = 0; i < 60 && !session.firm.products.has(id); i++) await new Promise((r) => setTimeout(r, 50));
  return session.firm.products.get(id);
}

// Adet kutusu ve iki yanında − / + düğmeleri. onstep(d) adedi d kadar değiştirir.
function stepper(input, onstep) {
  return h("div", { class: "stepper" },
    h("button", { type: "button", class: "step", "aria-label": t("stepLess"), onclick: () => onstep(-1) }, icon("minus")),
    input,
    h("button", { type: "button", class: "step", "aria-label": t("stepMore"), onclick: () => onstep(1) }, icon("plus")));
}

// Formda bir ürün kartı: ürün, adet (− / +), birim fiyat ve satır tutarı.
// init: { qty, price } düzenlenen kayıttan; yoksa adet 1, fiyat önerilen.
function lineRow(ctx, p, onchange, onremove, init) {
  const qty = numberInput({ value: init ? qtyInput(init.qty) : "1", "aria-label": t("qty"), oninput: onchange });
  const price = numberInput({
    value: moneyInput(init ? init.price : ctx.suggestPrice(p)), placeholder: "0,00", "aria-label": t("unitPrice"),
    oninput: () => { price.dataset.touched = "1"; onchange(); },
  });
  if (init) price.dataset.touched = "1";
  const total = h("strong", { class: "line-total" });
  const hint = h("small", { class: "field-hint" });

  // Satışta fiyat liste fiyatından farklıysa: müşteriye özel fiyat notu; "Liste fiyatına dön" ve
  // "Liste fiyatı da bu olsun" (kaydedince ürünün fiyatı herkes için güncellenir).
  let asList = false;
  const tools = h("div", { class: "price-tools" });
  const showTools = () => {
    if (!ctx.priceMemory) return;
    const pr = parseMoney(price.value);
    const list = p.price || 0;
    if (pr == null || !list || pr === list) {
      asList = false;
      tools.replaceChildren();
      return;
    }
    const remembered = ctx.specialFor(p) === pr && !price.dataset.touched;
    const note = remembered ? "specialPriceNote" : ctx.remembers() ? "priceDiffNote" : "listPriceNote";
    tools.replaceChildren(
      h("small", { class: "special-note" }, icon("tag"), t(note, { list: formatMoney(list) })),
      h("div", { class: "price-actions" },
        h("button", {
          type: "button", class: "pill-btn",
          onclick: () => { price.value = moneyInput(list); price.dataset.touched = "1"; onchange(); },
        }, icon("undo"), t("useListPrice")),
        h("button", {
          type: "button", class: `pill-btn${asList ? " on" : ""}`, "aria-pressed": String(asList),
          onclick: () => { asList = !asList; showTools(); },
        }, asList ? icon("check") : icon("pencil"), t(asList ? "listWillUpdate" : "makeListPrice", { price: formatMoney(pr) }))));
  };
  const add = (d) => {
    qty.value = qtyInput(Math.max(0, roundQty((parseQty(qty.value) ?? 0) + d)));
    onchange();
  };

  // Altta stok ve (satışta) bu fiyatla kâr marjı.
  const showHint = () => {
    const parts = [t("inStockShort", { n: formatNumber(p.stock), unit: unitLabel(p.unit) })];
    if (ctx.margin) {
      const m = marginPct(parseMoney(price.value), landedCost(p));
      if (m != null) parts.push(t("marginShort", { pct: formatNumber(m) }));
    }
    hint.textContent = parts.join(" · ");
    // Çıkışta depodakinden fazlası istenirse de kırmızı.
    const over = ctx.outgoing && (parseQty(qty.value) ?? 0) > p.stock;
    hint.classList.toggle("bad", isLow(p) || p.stock <= 0 || over);
  };

  const row = {
    el: h("div", { class: "line" },
      h("div", { class: "line-top" },
        productThumb(p, "sm"),
        h("span", { class: "line-name" }, h("bdi", {}, productLabel(p))),
        h("button", { type: "button", class: "icon remove", "aria-label": t("remove"), title: t("remove"), onclick: () => onremove(row) }, icon("trash"))),
      h("div", { class: "line-nums" },
        h("div", { class: "mini" }, h("span", {}, t("qty"), ` (${unitLabel(p.unit)})`), stepper(qty, add)),
        h("label", { class: "mini" }, h("span", {}, t("unitPrice"), ctx.symbol()), price)),
      tools,
      h("div", { class: "line-foot" }, hint, total)),
    total() {
      const q = parseQty(qty.value);
      const pr = parseMoney(price.value);
      return q && pr != null ? lineTotal({ qty: q, price: pr }) : 0;
    },
    refresh() {
      total.textContent = formatMoney(row.total(), ctx.currency());
      showHint();
      showTools();
    },
    // Müşteri değişince elle değiştirilmemiş fiyat o müşterinin fiyatına geçer.
    reprice() {
      if (price.dataset.touched) return;
      price.value = moneyInput(ctx.suggestPrice(p));
    },
    asList: () => asList,
    // Hatalıysa hata metni, doğruysa { product, qty, price }.
    read() {
      const q = parseQty(qty.value);
      if (!q) return t("badQtyFor", { name: productLabel(p) });
      const pr = price.value.trim() ? parseMoney(price.value) : null;
      if (pr == null) return t("enterPriceFor", { name: productLabel(p) });
      return { product: p.id, qty: q, price: pr };
    },
    product: p,
    qty: () => parseQty(qty.value) ?? 0,
    add,
  };
  row.refresh();
  return row;
}

const PAID_NOW = { sale: "collection", purchase: "payment", saleReturn: "refund", purchaseReturn: "supplierRefund" };
const WALK_IN = "__walkin"; // satış formundaki "Peşin müşteri (direkt satış)" seçeneği

// edit: düzenlenen kayıt; form onun bilgileriyle dolu açılır, kaydedince eskisi çöp kutusuna gider.
// lines: hazır satırlar [{ product, qty }] (siparişten ya da "Stok ekle"den alış); fiyat önerilen gelir.
// Yeni satışta müşteri listesinin başında "Peşin müşteri (direkt satış)": seçilirse satış "Peşin müşteri"
// carisine yazılır (yoksa aynı kayıtta açılır) ve tutarın tamamı tahsil edilir; kimseye borç kalmaz.
export function openMoveSheet(type, { party: fixedParty, edit, lines: presetLines } = {}) {
  const kind = PARTY_KIND[type];
  const title = edit ? t("editMoveTitle", { type: t(`type_${type}`) }) : t(`new_${type}`);
  const parties = [...session.firm.parties.values()].filter((p) => p.kind === kind).sort(byName);
  const walkInOption = (type === "sale" || type === "saleReturn") && !edit;
  const walkIn = parties.find((p) => p.walkIn);
  if (!parties.length && !walkInOption) {
    return missing(title, t(`need_${kind}`), `+ ${t(`new_${kind}`)}`, () => openPartySheet(kind));
  }

  // Satış ve emanette ürün yoksa önce ürün eklenir (alışta yeni ürün formun içinden açılır).
  if (hasLines(type) && type !== "purchase" && !session.firm.products.size) {
    return missing(title, t("needProduct"), `+ ${t("newProduct")}`, () => openProductSheet());
  }

  const listed = walkInOption ? parties.filter((p) => !p.walkIn) : parties;
  const partySelect = select([
    ["", t("choose")],
    ...(walkInOption ? [[WALK_IN, t(type === "sale" ? "walkInOption" : "walkInReturnOption")]] : []),
    ...listed.map((p) => [p.id, p.name]),
  ], walkInOption && fixedParty && fixedParty === walkIn?.id ? WALK_IN : edit?.party ?? fixedParty ?? "");
  const isWalkIn = () => partySelect.value === WALK_IN;
  const walkHint = h("small", { class: "field-hint", hidden: true }, t(type === "sale" ? "directHint" : "directReturnHint"));
  const date = dateInput(edit?.date);
  const note = textInput({ maxlength: 200, placeholder: t("notePlaceholder"), value: edit?.note ?? "" });
  const total = h("strong", {});
  const totalTry = h("small", { class: "field-hint" });
  const party = () => session.firm.parties.get(partySelect.value);
  const currency = () => (kind === "supplier" || kind === "person" ? party()?.currency || base() : base());
  const rate = rateField(() => refresh());
  const fields = [h("div", { class: "row2" }, field(t(kind), partySelect), field(t("date"), date)), walkHint, rate.el];

  let rows = [];
  let amount;
  let paidNow;
  let holder;
  // İndirim / ikram (sadece satışta): tutar ya da yüzde.
  let discountIn = null;
  let discountMode = "amount";
  const symbolEls = [];
  const symbol = () => {
    const el = h("span", { class: "cur" });
    symbolEls.push(el);
    return el;
  };

  // İndirim tutarı: yazılan tutar ya da toplamın yüzdesi.
  function discountOf(gross) {
    if (!discountIn?.value.trim()) return 0;
    if (discountMode === "pct") {
      const pct = parseQty(discountIn.value);
      return pct > 0 ? Math.round((gross * Math.min(pct, 100)) / 100) : 0;
    }
    return Math.max(parseMoney(discountIn.value) ?? 0, 0);
  }

  let browser = null;
  const refresh = () => {
    for (const el of symbolEls) el.textContent = currency() === base() ? "" : ` (${currencySymbol(currency())})`;
    for (const r of rows) r.refresh();
    browser?.refresh();
    const value = hasLines(type) ? sum(rows, (r) => r.total()) - discountOf(sum(rows, (r) => r.total())) : parseMoney(amount.value) ?? 0;
    total.textContent = formatMoney(value, currency());
    const r = rate.value();
    totalTry.textContent = currency() !== base() && r ? t("inLira", { amount: formatMoney(Math.round(value * r)) }) : "";
  };

  if (hasLines(type)) {
    const list = h("div", { class: "lines" });
    const empty = h("p", { class: "lines-empty" }, t("noLinesYet"));
    const ctx = {
      currency,
      symbol,
      margin: type === "sale" || type === "consign",
      outgoing: type === "sale" || type === "consign" || type === "purchaseReturn",
      // Satışta ve iadede o müşteriye özel fiyat (yoksa ürünün satış fiyatı), emanette o satıcıya son
      // verilen fiyat, alışta son alış fiyatı.
      suggestPrice(p) {
        if (type === "sale" || type === "saleReturn") return ctx.specialFor(p) ?? p.price;
        if (type === "consign") return party()?.shelf?.[p.id]?.price || p.price;
        const r = rate.value();
        return currency() === base() ? p.lastCost : r ? Math.round(p.lastCost / r) : 0;
      },
      // Müşteriye özel fiyat hafızası (sadece yeni satışta; peşin müşteride hatırlanmaz).
      priceMemory: type === "sale" && !edit,
      remembers: () => Boolean(party() && !party().walkIn && !isWalkIn()),
      specialFor: (p) => (isWalkIn() ? undefined : party()?.prices?.[p.id]),
    };
    // Müşteri değişince elle değiştirilmemiş fiyatlar o müşterinin fiyatlarına geçer.
    partySelect.addEventListener("change", () => {
      for (const r of rows) r.reprice();
      refresh();
    });
    const showEmpty = () => { empty.hidden = rows.length > 0; };
    // Ürün forma eklenir; zaten varsa adedi 1 artar. init: düzenlemede kayıtlı adet ve fiyat.
    const removeRow = (r) => {
      rows = rows.filter((x) => x !== r);
      r.el.remove();
      showEmpty();
      refresh();
    };
    const addProduct = (p, init) => {
      const existing = !init && rows.find((r) => r.product.id === p.id);
      if (existing) {
        existing.add(1);
        return;
      }
      const row = lineRow(ctx, p, refresh, removeRow, init);
      rows.push(row);
      list.append(row.el);
      showEmpty();
      refresh();
    };
    // Kutucuktaki − / +: adet sıfıra inerse ürün sepetten çıkar.
    const stepProduct = (p, d) => {
      const row = rows.find((r) => r.product.id === p.id);
      if (!row) return d > 0 && addProduct(p);
      if (row.qty() + d <= 0) return removeRow(row);
      return row.add(d);
    };
    // Formdan çıkmadan yeni ürün: ürün formu üstte açılır, kaydedilince ürün sepete girer.
    const newProduct = (preset) => openProductSheet(null, preset, {
      inside: async (id) => {
        const p = await productWhenReady(id);
        if (p) addProduct(p);
      },
    });
    // Düzenlemede kayıtlı satırlar (ürün sonradan silindiyse kayıttaki adıyla).
    for (const l of edit?.lines ?? []) {
      const p = session.firm.products.get(l.product)
        ?? { id: l.product, name: l.name, variant: "", unit: l.unit, stock: 0, price: 0, lastCost: 0, value: 0 };
      addProduct(p, { qty: l.qty, price: l.price });
    }
    for (const l of presetLines ?? []) {
      const p = session.firm.products.get(l.product);
      if (p) addProduct(p, { qty: l.qty, price: l.price ?? ctx.suggestPrice(p) });
    }
    // Barkod okutunca ürün forma gelir; aynı ürün tekrar okutulursa adedi artar.
    const scanLine = async () => {
      const code = await scanBarcode();
      if (!code) return;
      const p = productByBarcode(code);
      if (!p) return toast(t("barcodeUnknown", { code }));
      return addProduct(p);
    };
    // Ürünler formun içinde hemen görünür: dokunulan ürün sepete eklenir.
    browser = productBrowser({
      products: () => [...session.firm.products.values()].sort(byName),
      count: (p) => rows.find((r) => r.product.id === p.id)?.qty() ?? 0,
      price: (p) => ctx.suggestPrice(p),
      currency,
      onstep: stepProduct,
      onnew: type === "purchase" ? newProduct : null, // yeni ürün sadece alışta: satılacak mal önce alınır
      onscan: canScan() ? scanLine : null,
    });
    fields.push(browser.el, h("p", { class: "label cart-label" }, icon("listCheck"), t("cart")), empty, list);
    if (type === "consign") fields.push(h("small", { class: "field-hint" }, t("consignHint")));
    if (type === "sale") {
      discountIn = numberInput({ placeholder: "0", value: edit?.discount ? moneyInput(edit.discount) : "", oninput: () => refresh() });
      const mode = segmented([["amount", currencySymbol(base())], ["pct", "%"]], discountMode, (v) => { discountMode = v; refresh(); });
      fields.push(h("div", { class: "field" }, h("span", {}, t("discount")),
        h("div", { class: "with-button discount" }, discountIn, mode),
        h("small", { class: "field-hint" }, t("discountHint"))));
    }
    if (PAID_NOW[type] && !edit) {
      paidNow = numberInput({ placeholder: "0,00" });
      const paidWrap = h("label", { class: "field" },
        h("span", {}, t({ sale: "paidNowSale", saleReturn: "refundNow", purchaseReturn: "refundReceived" }[type] ?? "paidNowPurchase"), symbol()), paidNow,
        h("small", { class: "field-hint" }, t({ saleReturn: "refundNowHint", purchaseReturn: "refundReceivedHint" }[type] ?? "paidNowHint")));
      fields.push(paidWrap);
      // Peşin müşteride tamamı zaten tahsil edilir: "Peşin alınan" gizlenir.
      partySelect.addEventListener("change", () => {
        paidWrap.hidden = isWalkIn();
        walkHint.hidden = !isWalkIn();
      });
    }
  } else {
    amount = numberInput({ placeholder: "0,00", oninput: refresh, value: edit ? moneyInput(edit.amount) : "" });
    const balanceHint = h("small", { class: "field-hint" });
    const showBalance = () => {
      const p = party();
      balanceHint.textContent = p ? t("currentBalance", { amount: formatMoney(Math.abs(p.balance), p.currency) }) : "";
    };
    partySelect.addEventListener("change", showBalance);
    showBalance();
    fields.push(h("label", { class: "field" }, h("span", {}, t("amount"), symbol()), amount, balanceHint));
  }
  if (type !== "consign") {
    holder = partnerField(t(["sale", "collection", "debtIn", "purchaseReturn", "supplierRefund"].includes(type) ? "holderIn" : "holderOut"), edit?.holder);
    fields.push(holder.field);
  }
  // Kasa: paranın girdiği / çıktığı yer (satışta ve alışta peşin ödenen kısım için).
  let fund = null;
  if (["collection", "payment", "refund", "debtOut", "debtIn", "sale", "purchase", "saleReturn", "purchaseReturn", "supplierRefund"].includes(type)) {
    fund = fundField(t(["collection", "debtIn", "sale", "purchaseReturn", "supplierRefund"].includes(type) ? "fundIn" : "fundOut"), fundOf(edit));
    fields.push(fund.el);
  }
  fields.push(noteField(note));

  partySelect.addEventListener("change", () => rate.set(currency()));
  rate.set(currency());
  if (edit?.rate) rate.prefill(edit.rate);

  // Satışta fiyat hafızası: liste fiyatından farklı satılan ürün o müşteriye özel fiyat olur, liste
  // fiyatıyla satılırsa özel fiyatı silinir. "Liste fiyatı da bu olsun" seçilen ürünün fiyatı herkes
  // için güncellenir (o zaman özel fiyat gerekmez). customer null: peşin satış, sadece liste fiyatları.
  const priceOptions = (customer) => {
    const set = {};
    const clear = [];
    const listPrices = {};
    for (const r of rows) {
      const line = r.read();
      if (typeof line === "string") continue;
      const list = r.product.price ?? 0;
      if (r.asList() && line.price !== list) listPrices[line.product] = line.price;
      const special = !r.asList() && line.price !== list ? line.price : null;
      const had = customer?.prices?.[line.product];
      if (special != null && special !== had) set[line.product] = special;
      if (special == null && had != null) clear.push(line.product);
    }
    return { listPrices, ...(customer && { prices: { party: customer.id, set, clear } }) };
  };

  // Direkt satış: satış + tamamının tahsilatı; "Peşin müşteri" yoksa aynı kayıtta açılır.
  // Peşin müşteriden iade: iade + parasının tamamı geri verilir.
  const saveDirect = () => {
    if (!date.value) return t("chooseDate");
    const lines = [];
    for (const r of rows) {
      const line = r.read();
      if (typeof line === "string") return line;
      lines.push(line);
    }
    if (!lines.length) return t("addAtLeastOne");
    const partyId = walkIn?.id ?? WALK_IN;
    const base = { party: partyId, date: date.value, holder: holder?.el.value };
    setFund(base, fund?.value());
    const gross = sum(lines, (l) => lineTotal(l));
    const discount = discountOf(gross);
    if (discount > gross) return t("discountTooBig");
    const amount = gross - discount;
    record([
      { ...base, type, note: note.value.trim(), lines, ...(discount && { discount }) },
      { ...base, type: PAID_NOW[type], note: t(type === "sale" ? "directNote" : "directRefundNote"), amount },
    ], undefined, {
      listPrices: type === "sale" ? priceOptions(null).listPrices : {},
      ...(!walkIn && { newParty: { tempId: partyId, data: { kind: "seller", name: t("walkInCustomer"), walkIn: true } } }),
    });
    return undefined;
  };

  const summary = h("div", { class: "foot-sum" }, h("span", {}, t("total")), total, totalTry);
  open(title, fields, [footBar(summary, saveButton(type === "sale" && !edit ? t("completeSale") : undefined))], () => {
    if (isWalkIn()) return saveDirect();
    const p = party();
    if (!p) return t(`choose_${kind}`);
    if (!date.value) return t("chooseDate");
    const input = { type, party: p.id, date: date.value, note: note.value.trim(), holder: holder?.el.value };
    setFund(input, fund?.value());
    const cur = currency();
    if (cur !== base()) {
      const r = rate.value();
      if (!r) return t("enterRate");
      input.currency = cur;
      input.rate = r;
      rememberRate(cur, r);
    }
    const extra = [];

    if (hasLines(type)) {
      const lines = [];
      for (const r of rows) {
        const line = r.read();
        if (typeof line === "string") return line;
        if (line) lines.push(line);
      }
      if (!lines.length) return t("addAtLeastOne");
      input.lines = lines;
      if (type === "sale") {
        const gross = sum(lines, (l) => lineTotal(l));
        const discount = discountOf(gross);
        if (discount > gross) return t("discountTooBig");
        if (discount) input.discount = discount;
      }
      if (paidNow?.value.trim()) {
        const paid = parseMoney(paidNow.value);
        if (!paid) return t("badNumber");
        extra.push({ ...input, lines: undefined, type: PAID_NOW[type], note: t(type === "saleReturn" || type === "purchaseReturn" ? "refundNote" : "paidNowNote"), amount: paid });
      }
    } else {
      const a = parseMoney(amount.value);
      if (!a) return t("enterAmount");
      input.amount = a;
    }
    const clean = ({ lines, ...rest }) => (lines ? { ...rest, lines } : rest);
    if (edit) return saveEdit(edit, clean(input));
    record([input, ...extra].map(clean), undefined, type === "sale" ? priceOptions(p) : {});
    return undefined;
  });
}

// Önerilen sipariş adedi: stoğu "azalınca uyar" sınırının iki katına tamamlar (sınır yoksa 1).
export const suggestedOrder = (p) => Math.max(1, roundQty((p.minStock > 0 ? p.minStock * 2 : 1) - Math.max(p.stock, 0)));

// Sipariş: verilen (azalan) ürünler önerilen adetlerle gelir, adetler − / + ile ayarlanır.
// Liste tedarikçiye WhatsApp'tan gönderilir; mal gelince aynı listeyle alış girilir (stok artar).
export function openOrderSheet(list) {
  const firm = currentFirm();
  const suppliers = [...session.firm.parties.values()].filter((p) => p.kind === "supplier").sort(byName);
  const supplier = select([["", t("orderAnySupplier")], ...suppliers.map((p) => [p.id, p.name])], suppliers.length === 1 ? suppliers[0].id : "");
  const items = list.map((p) => {
    const input = numberInput({ value: qtyInput(suggestedOrder(p)), "aria-label": t("orderQty") });
    const add = (d) => { input.value = qtyInput(Math.max(0, roundQty((parseQty(input.value) ?? 0) + d))); };
    const el = h("div", { class: "line" },
      h("div", { class: "line-top" },
        productThumb(p, "sm"),
        h("span", { class: "line-name" }, h("bdi", {}, productLabel(p)),
          h("small", { class: "line-sub" }, t("orderMeta", { n: formatNumber(p.stock), unit: unitLabel(p.unit), min: formatNumber(p.minStock ?? 0) })))),
      h("div", { class: "mini" }, h("span", {}, t("orderQty"), ` (${unitLabel(p.unit)})`), stepper(input, add)));
    return { p, el, qty: () => parseQty(input.value) ?? 0 };
  });
  const chosen = () => items.filter((it) => it.qty() > 0);

  // Sipariş listesi fotoğraf olarak (paylaşım ekranında WhatsApp ve kişi seçilir); dosya paylaşamayan
  // cihazda ya da "Yazı olarak" denince doğrudan tedarikçinin sohbetine yazı.
  const send = async (asText = false) => {
    const lines = chosen();
    if (!lines.length) return toast(t("noOrderLines"));
    const party = session.firm.parties.get(supplier.value);
    const text = [t("orderGreeting"), ...lines.map((it) => `• ${productLabel(it.p)}: ${formatNumber(it.qty())} ${unitLabel(it.p.unit)}`), `— ${firm.name}`].join("\n");
    if (asText || (!canShareFiles() && !canCopyImage())) return shareOnWhatsApp({ text, phone: party?.phone ?? null });
    const doc = {
      kind: "summary", title: t("orderTitle"), subtitle: party?.name ?? "", date: today(), time: new Date().toTimeString().slice(0, 5),
      firm: receiptFirm(firm),
      rows: lines.map((it) => [productLabel(it.p), `${formatNumber(it.qty())} ${unitLabel(it.p.unit)}`]),
      total: [t("orderItemsTotal"), t("orderItemsCount", { n: lines.length })],
      note: "",
    };
    return sendPhoto(receiptBlob(doc, receiptLabels()), party?.phone ?? null, `siparis-${today()}.png`);
  };
  const received = () => {
    const lines = chosen();
    if (!lines.length) return toast(t("noOrderLines"));
    return openMoveSheet("purchase", { party: supplier.value || undefined, lines: lines.map((it) => ({ product: it.p.id, qty: it.qty() })) });
  };

  open(t("orderTitle"), [
    h("small", { class: "field-hint" }, t("orderHint")),
    suppliers.length > 0 && field(t("supplier"), supplier),
    items.length ? h("div", { class: "lines" }, items.map((it) => it.el)) : h("p", { class: "lines-empty" }, t("noLowStock")),
    items.length > 0 && h("button", { type: "button", class: "block whatsapp", onclick: () => send() }, icon("whatsapp"), t("orderSend")),
    items.length > 0 && h("button", { type: "button", class: "block", onclick: () => send(true) }, icon("send"), t("sendAsText")),
  ], [items.length > 0 && h("button", { type: "button", class: "primary block", onclick: received }, icon("in"), t("orderReceived"))]);
}

// Düzenlenen kayıt: eskisi "düzenlendi" diye çöp kutusuna, yenisi deftere (tek seferde).
function saveEdit(old, input) {
  const { done } = replaceMove(old, input, t("editedReason"));
  done.catch(failed);
  sheet.close();
  toast(t("moveEdited"));
  return undefined;
}

// --- Sayım ve iade (satıcının rafındaki emanet mal) -----------------------------------

export function openShelfSheet(mode, fixedParty) {
  const count = mode === "count";
  const title = t(count ? "new_consignSale" : "new_return");
  const sellers = [...session.firm.parties.values()]
    .filter((p) => p.kind === "seller" && Object.values(p.shelf ?? {}).some((s) => s.stock > 0))
    .sort(byName);
  if (!sellers.length) {
    return missing(title, t("needShelf"), t("quick_consign"), () => openMoveSheet("consign"));
  }

  const partySelect = select([["", t("choose")], ...sellers.map((p) => [p.id, p.name])],
    sellers.some((p) => p.id === fixedParty) ? fixedParty : sellers.length === 1 ? sellers[0].id : "");
  const date = dateInput();
  const list = h("div", { class: "lines" });
  const total = h("strong", {});
  const progress = h("small", { class: "foot-progress" });
  let items = [];

  const refresh = () => {
    for (const it of items) it.refresh();
    total.textContent = formatMoney(sum(items, (it) => it.total()));
    const done = items.filter((it) => it.touched()).length;
    progress.textContent = items.length ? t(count ? "countedOf" : "returnedOf", { n: done, all: items.length }) : "";
  };

  const build = () => {
    const party = session.firm.parties.get(partySelect.value);
    items = Object.entries(party?.shelf ?? {})
      .filter(([, s]) => s.stock > 0)
      .map(([id, s]) => shelfItem(id, s, count, refresh));
    list.replaceChildren(...(items.length ? items.map((it) => it.el) : [h("p", { class: "lines-empty" }, t("chooseSeller"))]));
    scan.hidden = !items.length || !canScan();
    refresh();
  };

  // Barkod okutunca o ürün bir artar (sayımda kalan, iadede iade edilen).
  const scan = h("button", {
    type: "button", class: "scan-btn block", onclick: async () => {
      const code = await scanBarcode();
      if (!code) return;
      const p = productByBarcode(code);
      const item = p && items.find((it) => it.id === p.id);
      if (!item) return toast(p ? t("notOnShelf", { name: productLabel(p) }) : t("barcodeUnknown", { code }));
      item.add(1);
      item.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
  }, icon("barcode"), t(count ? "scanToCount" : "scanToReturn"));
  partySelect.addEventListener("change", build);

  const fields = [
    h("div", { class: "row2" }, field(t("seller"), partySelect), field(t("date"), date)),
    h("small", { class: "field-hint" }, t(count ? "countHint" : "returnHint")),
    scan,
    list,
  ];
  let paidNow;
  let holder;
  if (count) {
    paidNow = numberInput({ placeholder: "0,00" });
    holder = partnerField(t("holderIn"));
    fields.push(field(t("paidNowSale"), paidNow, t("paidNowHint")), holder.field);
  }
  build();

  const summary = h("div", { class: "foot-sum" }, h("span", {}, t(count ? "soldTotal" : "returnTotal")), total, progress);
  open(title, fields, [footBar(summary, saveButton(t(count ? "saveCount" : "saveReturn")))], () => {
    const party = partySelect.value;
    if (!party) return t("chooseSeller");
    const lines = [];
    for (const it of items) {
      const line = it.read();
      if (typeof line === "string") return line;
      if (line) lines.push(line);
    }
    if (!lines.length) return t(count ? "nothingSold" : "nothingReturned");
    const inputs = [{ type: count ? "consignSale" : "return", party, date: date.value, note: "", lines }];
    if (paidNow?.value.trim()) {
      const paid = parseMoney(paidNow.value);
      if (!paid) return t("badNumber");
      inputs.push({ type: "collection", party, date: date.value, note: t("paidNowNote"), amount: paid, holder: holder?.el.value });
    }
    record(inputs);
    return undefined;
  });
}

// Raftaki bir ürün kartı. Sayımda rafta kalan sayılır (− / + ya da barkod), satılan hesaplanır;
// iadede iade edilen miktar. Kartın rengi ve etiketi durumu söyler: sayılmadı (gri),
// hepsi rafta (yeşil), satılmış (mavi), hatalı (kırmızı).
function shelfItem(id, shelf, count, onchange) {
  const p = session.firm.products.get(id);
  const unit = unitLabel(p?.unit);
  const input = numberInput({ placeholder: count ? "–" : "0", "aria-label": count ? t("remaining") : t("returnQty"), oninput: onchange });
  const price = numberInput({ value: moneyInput(shelf.price), "aria-label": t("unitPrice"), oninput: onchange });
  const chip = h("span", { class: "chip-state" });
  const result = h("span", { class: "shelf-result" });
  // Sayımda satılan = raftaki − kalan; iadede yazılan miktar.
  const qty = () => {
    const v = parseQty(input.value);
    if (v == null) return null;
    return count ? roundQty(shelf.stock - v) : v;
  };
  // Sayılmamış üründe − sıfırdan başlar ("hiç kalmamış").
  const add = (d) => {
    const v = parseQty(input.value);
    input.value = qtyInput(Math.max(0, roundQty(v == null ? Math.max(d, 0) : v + d)));
    onchange();
  };
  const el = h("div", { class: "line shelf-card" },
    h("div", { class: "line-top" },
      p ? productThumb(p, "sm") : null,
      h("span", { class: "line-name" }, h("bdi", {}, productLabel(p) || "?")),
      chip),
    h("div", { class: "shelf-nums" },
      h("div", { class: "mini" }, h("span", {}, count ? t("remaining") : t("returnQty")),
        h("div", { class: "count-row" }, stepper(input, add), h("span", { class: "of" }, `/ ${formatNumber(shelf.stock)} ${unit}`))),
      count
        ? h("label", { class: "mini" }, h("span", {}, t("unitPrice")), price)
        : h("button", { type: "button", class: "small all", onclick: () => { input.value = qtyInput(shelf.stock); onchange(); } }, t("returnAll"))),
    result);
  const item = {
    id,
    el,
    add,
    touched: () => Boolean(input.value.trim()) && (count || (parseQty(input.value) ?? 0) > 0),
    total() {
      const q = qty();
      const pr = count ? parseMoney(price.value) : shelf.price;
      return q > 0 && pr != null ? lineTotal({ qty: q, price: pr }) : 0;
    },
    refresh() {
      const q = qty();
      const bad = q != null && (q < 0 || q > shelf.stock);
      let state = "pending";
      let label = count ? t("notCounted") : "";
      if (bad) [state, label] = ["bad", t(count ? "tooMany" : "tooManyReturn")];
      else if (count && q === 0) [state, label] = ["full", t("allOnShelf")];
      else if (q > 0) [state, label] = ["done", count ? t("soldCount", { n: formatNumber(q) }) : t("returnCount", { n: formatNumber(q) })];
      el.dataset.state = state;
      chip.textContent = label;
      chip.hidden = !label;
      result.textContent = count && q > 0 && !bad ? t("soldLine", { n: formatNumber(q), unit, amount: formatMoney(item.total()) }) : "";
    },
    read() {
      if (!input.value.trim()) return null;
      const q = qty();
      if (q == null || q < 0 || q > shelf.stock) return t(count ? "badRemaining" : "badReturn", { name: productLabel(p) || "?" });
      if (q === 0) return null;
      const pr = count ? parseMoney(price.value) : shelf.price;
      if (pr == null) return t("enterPriceFor", { name: productLabel(p) || "?" });
      return { product: id, qty: q, price: pr };
    },
  };
  return item;
}

// --- Kasa işlemleri: gider, para koyma/çekme, devir ------------------------------------

// edit: düzenlenen kayıt; form onun bilgileriyle dolu açılır.
export function openCashSheet(type, { edit } = {}) {
  const firm = currentFirm();
  if (type === "transfer" && firm.members.length < 2) return;
  const amount = numberInput({ placeholder: "0,00", value: edit ? moneyInput(edit.amount) : "" });
  const date = dateInput(edit?.date);
  const note = textInput({ maxlength: 200, placeholder: t(type === "expense" ? "expensePlaceholder" : "notePlaceholder"), value: edit?.note ?? "" });
  const fields = [h("div", { class: "row2" }, field(t("amount"), amount), field(t("date"), date))];
  const capitalMove = type === "capitalIn" || type === "withdraw";

  // Para koyma/çekmede önce kimin parası olduğu seçilir (uygulamasız ortak da olabilir);
  // uygulamasız ortağın parasını eline alan/veren uygulamadaki ortak ayrıca seçilir.
  let owner;
  const holder = partnerField(t(capitalMove ? `handler_${type}` : `holder_${type}`), edit?.holder);
  if (capitalMove) {
    const all = partners(firm);
    owner = select(all.map((p) => [p.uid, p.uid === session.uid ? `${p.name} (${t("you")})` : p.name]), edit?.partner ?? edit?.holder ?? session.uid);
    const handlerWrap = h("div", {}, holder.field ?? null);
    const sync = () => { handlerWrap.hidden = !firm.guests?.[owner.value]; };
    owner.addEventListener("change", sync);
    sync();
    fields.push(all.length > 1 ? field(t(`holder_${type}`), owner) : null, handlerWrap);
  }

  let to;
  if (type === "transfer") {
    // Parayı alan, verenden başka biri; veren değişince liste güncellenir.
    to = h("select", {});
    const fillTo = () => {
      const others = firm.members.filter((u) => u !== holder.el.value);
      const want = to.value || edit?.to;
      const keep = others.includes(want) ? want : others[0];
      to.replaceChildren(...others.map((uid) => h("option", { value: uid, selected: uid === keep }, person(firm, uid).name)));
    };
    holder.el.addEventListener("change", fillTo);
    fillTo();
    fields.push(field(t("holder_transfer"), holder.el), field(t("transferTo"), to));
  } else if (!capitalMove) {
    fields.push(holder.field);
  }

  // Gider kategorisi (kira, yakıt, vergi…): resimli kutucuklara dokunarak seçilir, en üstte;
  // liste Ayarlar'dan değiştirilir. Altta bir baloncuk ne kaydedileceğini düz cümleyle söyler.
  let category = null;
  let bubble = null;
  // Kasa: gider ve para çekmede paranın çıktığı, para koymada girdiği yer.
  const fund = type === "transfer" ? null
    : fundField(t(type === "capitalIn" ? "fundIn" : "fundOut"), fundOf(edit), () => say());
  const say = () => {
    if (!bubble) return;
    const a = parseMoney(amount.value);
    bubble.textContent = !category ? t("expenseAskWhat")
      : !a ? t("expenseAskAmount", { cat: category.name })
        : t("expenseBubble", { who: person(firm, holder.el.value).name, cat: category.name, amount: formatMoney(a), method: fund?.value()?.name ?? "" });
    bubble.classList.toggle("ready", Boolean(category && a));
  };
  if (type === "expense") {
    // Düzenlemede kayıttaki kategori ve ödeme şekli seçili gelir (listeden silindiyse kayıttaki adıyla).
    if (edit?.category) {
      category = expenseCategories(firm).find((c) => c.id === edit.category) ?? { id: edit.category, name: edit.categoryName ?? "" };
    }
    // Kategori ve ödeme şekli listeleri formun içinden düzenlenebilir (form kaybolmaz).
    const grid = h("div", { class: "cat-tiles" });
    const renderCats = (cats = expenseCategories(currentFirm())) => grid.replaceChildren(
      ...cats.map((c) => h("button", {
        type: "button", class: "cat-tile", "aria-pressed": String(c.id === category?.id),
        onclick: () => {
          category = c;
          renderCats(cats);
          if (!note.value.trim()) note.placeholder = c.name;
          say();
          if (!amount.value.trim()) amount.focus();
        },
      }, h("span", { class: "cat-emoji", "aria-hidden": "true" }, categoryEmoji(c)), h("bdi", {}, c.name))),
      h("button", { type: "button", class: "cat-tile add", onclick: () => openCategoriesSheet(renderCats) },
        h("span", { class: "cat-emoji", "aria-hidden": "true" }, icon("pencil")), t("edit")));
    renderCats();
    fields.unshift(h("p", { class: "label" }, t("expenseWhat")), grid);
    bubble = h("p", { class: "say-bubble", "aria-live": "polite" });
    amount.addEventListener("input", say);
    holder.el.addEventListener("change", say);
  }

  // "Hangi kasa?" tutar ve tarihin hemen altında.
  if (fund) fields.splice(fields.findIndex((f) => f?.classList?.contains("row2")) + 1, 0, fund.el);

  // Gider bir ürün ortaklığına ait olabilir; o zaman o ortaklığın kârından düşer.
  let deal;
  const deals = Object.entries(firm.deals ?? {});
  if (type === "expense") {
    deal = select([["", t("generalShares")], ...deals.map(([id, d]) => [id, d.name])], edit?.deal ?? "");
    fields.push(field(t("expenseDeal"), deal, deals.length ? null : t("noDealsHint")));
  }
  fields.push(field(t(type === "expense" ? "expenseNote" : "note"), note), h("small", { class: "field-hint" }, t(`hint_${type}`)), bubble);
  say();

  const title = edit ? t("editMoveTitle", { type: t(`type_${type}`) }) : t(`new_${type}`);
  open(title, fields, [saveButton(), closeButton()], () => {
    const a = parseMoney(amount.value);
    if (!a) return t("enterAmount");
    if (type === "expense" && !category) return t("chooseCategory");
    const input = { type, party: "", date: date.value, note: note.value.trim(), amount: a, holder: holder.el.value };
    if (category) {
      input.category = category.id;
      input.categoryName = category.name;
    }
    setFund(input, fund?.value());
    if (capitalMove) {
      input.partner = owner.value;
      // Uygulamadaki ortak kendi parasını kendisi koyar/çeker.
      if (!firm.guests?.[owner.value]) input.holder = owner.value;
    }
    if (deal?.value) input.deal = deal.value;
    if (to) {
      if (!to.value || to.value === holder.el.value) return t("chooseOtherPartner");
      input.to = to.value;
    }
    if (edit) return saveEdit(edit, input);
    record([input]);
    return undefined;
  });
  if (!edit && type !== "expense") amount.focus(); // giderde önce kategori seçilir
}

// Gider kategorisinin resmi: kullanıcının seçtiği (emoji); seçilmemişse hazır kategoriler kimliğinden,
// eklenenler adından tahmin edilir.
const CATEGORY_EMOJI = {
  rent: "🏠", fuel: "⛽", shipping: "🚚", tax: "🧾", salary: "👷", utilities: "💡", food: "🍽️", other: "📦",
};
const EMOJI_WORDS = [
  [/kira|إيجار/i, "🏠"], [/yakıt|benzin|mazot|motorin|وقود/i, "⛽"], [/nakliye|kargo|taşıma|شحن|نقل/i, "🚚"],
  [/vergi|ضريب/i, "🧾"], [/maaş|ücret|راتب/i, "👷"], [/elektrik|su\b|internet|doğalgaz|fatura|كهرباء|إنترنت/i, "💡"],
  [/yemek|çay|kahve|طعام/i, "🍽️"], [/telefon|hat|هاتف/i, "📱"], [/temizlik|تنظيف/i, "🧹"],
  [/tamir|bakım|صيانة/i, "🔧"], [/reklam|إعلان/i, "📣"], [/banka|komisyon|بنك/i, "🏦"], [/kırtasiye|قرطاس/i, "✏️"],
  [/araç|araba|oto|سيارة/i, "🚗"], [/sigorta|تأمين/i, "🛡️"], [/ambalaj|poşet|koli|تغليف/i, "🛍️"],
  [/taksit|kredi|borç|قسط/i, "💳"], [/market|bakkal|alışveriş|سوق|بقالة/i, "🛒"], [/pazar|manav|meyve|sebze|خضار/i, "🧺"],
  [/su\b|damacana|ماء/i, "💧"], [/ekmek|fırın|خبز/i, "🍞"], [/ilaç|eczane|sağlık|hastane|دواء/i, "💊"],
  [/okul|eğitim|kurs|مدرسة/i, "🎓"], [/giyim|kıyafet|ملابس/i, "👕"], [/hediye|هدية/i, "🎁"], [/otopark|park/i, "🅿️"],
  [/taksi|yol|ulaşım|otobüs|مواصلات/i, "🚕"], [/otel|konaklama|فندق/i, "🏨"], [/bilgisayar|yazılım|حاسوب/i, "🖥️"],
];
// Seçilebilen resimler (kategori ve kasa düzenlemede), bölüm bölüm. Bunlarda olmayan her emoji
// ızgaranın altındaki kutuya telefonun emoji klavyesinden yazılabilir.
const EMOJI_SETS = [
  ["emo_common", "🏠⛽🚚🧾👷💡🍽️📦💳🛒🧺📱🧹🔧📣🏦✏️🚗🛡️🛍️☕🍞🥩🍎💧🔥💊🎓👕🧰🪑🖥️🖨️📄🎁🅿️🚕✈️🏨🎉💼📮🔒💰📊🌐📞🏪"],
  ["emo_food", "🍞🥖🥐🧀🥚🥛🍳🥩🍗🍖🐟🍤🍚🍝🍕🍔🌭🥙🌯🥗🍲🍜🍣🍰🎂🍪🍫🍬🍭🍯☕🍵🧃🥤🧋🍺🍷🧊🍎🍏🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶️🫑🌽🥕🧄🧅🥔🍠🫘🥜🌰"],
  ["emo_home", "🛒🧺🛍️🎁🏠🏡🏢🏬🏪🏭🏗️🛋️🛏️🪑🚪🪟🧹🧽🧴🧼🧻🪣🧯🔥💡🔌🔋🧰🔧🔨🪛⚙️🪚🧱🪜🚿🛁🚽🧸👕👖👗👔👟👞👜🎒⌚💍💄🪒"],
  ["emo_travel", "🚗🚕🚙🚌🚎🚐🚚🚛🚜🏍️🛵🚲🛴⛽🚏🛣️🅿️🚦🚧🚢⛴️✈️🚆🚇🚉📦📮✉️📬"],
  ["emo_money", "💰💵💴💶💷💳🏦🧾📊📈📉💼📁📂📋📌📎🖊️✏️📝📄📃📑🗂️🗃️🖥️💻⌨️🖨️📱☎️📞📠📡🌐🔒🔑🏷️⚖️🧮"],
  ["emo_people", "💊💉🩺🏥🦷👓👷🎓📚✂️💈👶🐶🐱🐄🐑🐔🌱🌾🌳💐🤝👨‍👩‍👧"],
  ["emo_other", "🎉🎈🎊🎮🎬🎵📺📷⚽🎨🧩🕌⛪🎪🏖️⛺🌙⭐☀️🌧️❄️✅❌❗❓💯🔴🟢🔵🟡🟣⚫⚪"],
];
// Metni harflere (emoji bütün olarak) ayırır.
const graphemes = (s) => (globalThis.Intl?.Segmenter
  ? [...new Intl.Segmenter("tr", { granularity: "grapheme" }).segment(s)].map((x) => x.segment)
  : [...s]);

// Resim seçici: bölüm baloncukları, ızgara ve klavyeden emoji kutusu. onpick(emoji) seçilince çağrılır.
function emojiPicker(onpick) {
  let set = 0;
  const grid = h("div", { class: "emoji-cells" });
  const tabs = h("div", { class: "bubbles emoji-tabs" });
  const paint = () => {
    tabs.replaceChildren(...EMOJI_SETS.map(([label], i) => h("button", {
      type: "button", class: "bubble", "aria-pressed": String(i === set), onclick: () => { set = i; paint(); },
    }, t(label))));
    grid.replaceChildren(...graphemes(EMOJI_SETS[set][1]).map((e) => h("button", { type: "button", "aria-label": e, onclick: () => onpick(e) }, e)));
  };
  paint();
  const typed = textInput({ maxlength: 16, placeholder: t("emo_typePlaceholder"), "aria-label": t("emo_type") });
  typed.addEventListener("input", () => {
    const first = graphemes(typed.value.trim()).find((g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g));
    if (first) { typed.value = ""; onpick(first); }
  });
  return h("div", { class: "emoji-grid", hidden: true }, tabs, grid,
    h("label", { class: "emoji-type" }, h("span", {}, t("emo_type")), typed));
}
function categoryEmoji(c) {
  return c.emoji || CATEGORY_EMOJI[c.id] || EMOJI_WORDS.find(([re]) => re.test(c.name))?.[1] || "🏷️";
}

// --- Ortaklık payları ---------------------------------------------------------------

// Ortakların yüzde satırları. Boş bırakılan ortak bu bölüşüme girmez.
// "+ Dışarıdan ortak" uygulamayı kullanmayan birini adıyla ekler.
function shareRows(firm, shares, defaults = {}) {
  const list = h("div", { class: "share-list" });
  const total = h("strong", {});
  const rows = [];
  const refresh = () => {
    const s = roundQty(sum(rows, (r) => r.value() || 0));
    total.textContent = `%${formatNumber(s)}`;
    total.classList.toggle("bad", s !== 100);
  };
  const addRow = (p) => {
    const value = shares[p.uid] ?? defaults[p.uid];
    const input = numberInput({ value: value ? String(value).replace(".", ",") : "", placeholder: "—", oninput: refresh });
    rows.push({ uid: p.uid, value: () => (input.value.trim() ? parseQty(input.value) ?? NaN : 0) });
    list.append(h("label", { class: "share-row" },
      avatar(p),
      h("span", { class: "main" }, h("bdi", {}, p.name), p.guest && h("small", { class: "guest-tag" }, t("guest"))),
      h("span", { class: "pct" }, "%", input)));
  };
  for (const p of partners(firm)) addRow(p);

  const guestName = textInput({ maxlength: 40, placeholder: t("guestNamePlaceholder") });
  const guestForm = h("div", { class: "guest-add", hidden: true }, guestName,
    h("button", {
      type: "button", class: "small primary",
      onclick: () => {
        const name = guestName.value.trim();
        if (!name) return;
        const { id, color, done } = saveGuest(null, name);
        done.catch(failed);
        addRow({ uid: id, name, color, guest: true });
        guestName.value = "";
        guestForm.hidden = true;
        refresh();
      },
    }, t("add")));
  const addGuest = h("button", {
    type: "button", class: "small add-line", onclick: () => { guestForm.hidden = false; guestName.focus(); },
  }, "+ ", t("addGuest"));
  refresh();
  return {
    el: [list, addGuest, guestForm, h("div", { class: "total" }, h("span", {}, t("total")), total)],
    // Hata metni ya da { ortakId: yüzde } (boş/0 olanlar atılır).
    read() {
      const values = rows.map((r) => [r.uid, r.value()]);
      if (values.some(([, v]) => Number.isNaN(v) || v < 0)) return t("badNumber");
      if (roundQty(sum(values, ([, v]) => v)) !== 100) return t("sharesMust100");
      return Object.fromEntries(values.filter(([, v]) => v > 0));
    },
  };
}

// Genel paylar: ürün ortaklığına girmeyen ürünlerin ve genel giderlerin kârı böyle bölünür.
export function openSharesSheet() {
  const firm = currentFirm();
  // Pay girilmemişse ekranda eşit paylar önerilir.
  const { ids } = generalShares(firm);
  const equal = Object.fromEntries(ids.map((id) => [id, Math.round((100 / ids.length) * 10) / 10]));
  const rows = shareRows(firm, firm.shares ?? {}, Object.keys(firm.shares ?? {}).length ? {} : equal);
  open(t("generalShares"), [h("small", { class: "field-hint" }, t("sharesHint")), ...rows.el], [saveButton(), closeButton()], () => {
    const result = rows.read();
    if (typeof result === "string") return result;
    saved(saveShares(result), t("saved"));
    return undefined;
  });
}

// Ürün ortaklığı: hangi ürünlerin kârı, kimler arasında, hangi yüzdelerle bölünür.
export function openDealSheet(dealId) {
  const firm = currentFirm();
  const deal = dealId ? firm.deals?.[dealId] : null;
  const name = textInput({ maxlength: 60, value: deal?.name, placeholder: t("dealNamePlaceholder") });
  const chosen = new Set(deal?.products ?? []);

  // Ürün seçimi: dokununca seçilir; başka ortaklıktaki ürün seçilirse oradan buraya taşınır.
  const otherDeal = (pid) => Object.entries(firm.deals ?? {}).find(([id, d]) => id !== dealId && d.products?.includes(pid))?.[1];
  const products = [...session.firm.products.values()].sort(byName);
  const productList = h("div", { class: "chips" }, products.map((p) => {
    const other = otherDeal(p.id);
    const chip = h("button", {
      type: "button", class: "chip", "aria-pressed": String(chosen.has(p.id)),
      onclick: () => {
        if (chosen.has(p.id)) chosen.delete(p.id);
        else chosen.add(p.id);
        chip.setAttribute("aria-pressed", String(chosen.has(p.id)));
      },
    }, h("bdi", {}, productLabel(p)), other && h("small", {}, ` · ${other.name}`));
    return chip;
  }));

  // Ürün çoksa arama: eşleşmeyenler gizlenir, seçili olanlar hep görünür.
  const filter = products.length > 12 && searchBox(t("searchProducts"), "", (q) => {
    productList.querySelectorAll(".chip").forEach((chip, i) => {
      chip.hidden = !chosen.has(products[i].id) && !matches(products[i].name, q);
    });
  });

  const rows = shareRows(firm, deal?.shares ?? {});
  const fields = [
    field(t("dealName"), name),
    h("p", { class: "label" }, t("dealProducts")),
    filter,
    products.length ? productList : h("p", { class: "muted" }, t("needProduct")),
    h("p", { class: "label" }, t("dealPartners")),
    ...rows.el,
    h("small", { class: "field-hint" }, t("dealHint")),
  ];
  const buttons = [saveButton()];
  if (deal) {
    buttons.push(h("button", {
      type: "button", class: "block danger",
      onclick: () => removed(deleteDeal(dealId), t("deleted", { name: deal.name }), () => putDeal(dealId, deal)),
    }, t("delete")));
  }
  buttons.push(closeButton());

  open(deal ? deal.name : t("newDeal"), fields, buttons, () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    if (!chosen.size) return t("chooseDealProducts");
    const shares = rows.read();
    if (typeof shares === "string") return shares;
    saved(saveDeal(dealId, { name: n, products: [...chosen], shares }), t("saved"));
    return undefined;
  });
  if (!deal) name.focus();
}

// Uygulamayı kullanmayan ortak ekleme (sadece adı).
// Uygulamasız ortağın kişi bilgisi: carilerden (müşteri/tedarikçi) ya da telefon rehberinden seçilir,
// istenirse elle yazılır. Telefon, ortağa özet fişini WhatsApp'tan göndermek için.
function guestFields(guest = {}) {
  const name = textInput({ maxlength: 40, value: guest.name ?? "", placeholder: t("guestNamePlaceholder") });
  const phone = textInput({ maxlength: 24, value: guest.phone ?? "", type: "tel", inputmode: "tel", dir: "ltr", placeholder: "0555 555 55 55" });
  let party = guest.party ?? "";
  const parties = [...session.firm.parties.values()].filter((p) => !p.walkIn).sort(byName);
  const fromParties = parties.length > 0 && select(
    [["", t("pickFromParties")], ...parties.map((p) => [p.id, `${p.name} · ${t(p.kind)}`])], party,
    {
      onchange: (e) => {
        const p = session.firm.parties.get(e.target.value);
        party = p?.id ?? "";
        if (p) {
          name.value = p.name.slice(0, 40);
          phone.value = p.phone ?? "";
        }
      },
    });
  const fromContacts = canPickContact() && h("button", {
    type: "button", class: "block contact-pick",
    onclick: async () => {
      try {
        const c = await pickContact();
        if (!c) return;
        if (c.name) name.value = c.name.slice(0, 40);
        if (c.phone) phone.value = c.phone;
        party = "";
        if (fromParties) fromParties.value = "";
      } catch (err) {
        console.error(err);
      }
    },
  }, icon("contact"), t("pickContact"));
  return {
    fields: [
      fromParties && field(t("pickFromPartiesLabel"), fromParties),
      fromContacts,
      field(t("name"), name),
      field(t("phone"), phone, t("guestPhoneHint")),
      h("small", { class: "field-hint" }, t("guestHint")),
    ],
    name,
    value: () => ({ name: name.value.trim(), phone: phone.value.trim(), party }),
  };
}

export function openGuestAddSheet() {
  const g = guestFields();
  open(t("addGuest"), g.fields, [saveButton(), closeButton()], () => {
    const v = g.value();
    if (!v.name) return t("enterName");
    saved(saveGuest(null, v).done, t("saved"));
    return undefined;
  });
}

// Uygulamasız ortağın adını değiştirme / silme.
export function openGuestSheet(guestId) {
  const firm = currentFirm();
  const guest = firm.guests?.[guestId];
  if (!guest) return;
  const g = guestFields(guest);
  const inDeal = Object.values(firm.deals ?? {}).some((d) => d.shares?.[guestId]) || firm.shares?.[guestId];
  const acc = session.firm.accounts.get(guestId);
  const busy = Boolean(inDeal || acc?.capital);
  open(t("guestPartner"), g.fields, [
    saveButton(),
    h("button", {
      type: "button", class: "block danger", disabled: busy,
      onclick: () => removed(deleteGuest(guestId), t("deleted", { name: guest.name }), () => putGuest(guestId, guest)),
    }, t("delete")),
    busy && h("small", { class: "field-hint center" }, t("cantDeleteGuest")),
    closeButton(),
  ], () => {
    const v = g.value();
    if (!v.name) return t("enterName");
    saved(saveGuest(guestId, v).done, t("saved"));
    return undefined;
  });
}

// --- Fiş ve fatura bilgisi (WhatsApp, yazdırma) ------------------------------------------

const RECEIPT_TYPES = ["sale", "consignSale", "saleReturn"];

// Fiş ayarları (Ayarlar → Fiş ayarları): başlık, alt yazı, ek satır, kâğıt; logo/telefon/adres/bakiye.
const receiptSettings = () => currentFirm()?.receipt ?? {};

export function receiptLabels() {
  const rs = receiptSettings();
  const labels = Object.fromEntries(RECEIPT_LABEL_KEYS.map((k) => [k, k === "dir" ? (lang === "ar" ? "rtl" : "ltr") : t(`rc_${k}`)]));
  if (rs.title) labels.receiptTitle = rs.title;
  if (rs.thanks != null) labels.thanks = rs.thanks;
  return { ...labels, footer: rs.extra ?? "", paper: rs.paper ?? "80" };
}

// Fişin üstündeki işletme bilgisi: ayarlarda kapatılan logo, telefon ve adres yazılmaz.
export function receiptFirm(firm = currentFirm()) {
  const rs = firm.receipt ?? {};
  return {
    name: firm.name, logo: rs.showLogo === false ? "" : firm.logo ?? "", ...firm.info,
    ...(rs.showPhone === false && { phone: "" }), ...(rs.showAddress === false && { address: "" }),
  };
}

// Fiş ayarları.
export function openReceiptSettings() {
  const rs = receiptSettings();
  const check = (on) => h("input", { type: "checkbox", checked: on });
  const title = textInput({ maxlength: 40, value: rs.title ?? "", placeholder: t("rc_receiptTitle") });
  const thanksIn = textInput({ maxlength: 80, value: rs.thanks ?? t("rc_thanks") });
  const extra = textInput({ maxlength: 160, value: rs.extra ?? "", placeholder: t("rsExtraPlaceholder") });
  const logo = check(rs.showLogo !== false);
  const phone = check(rs.showPhone !== false);
  const address = check(rs.showAddress !== false);
  const balance = check(rs.showBalance !== false);
  let paper = rs.paper ?? "80";
  open(t("receiptSettings"), [
    h("p", { class: "muted" }, t("rsIntro")),
    field(t("rsTitle"), title, t("rsTitleHint")),
    field(t("rsThanks"), thanksIn, t("rsThanksHint")),
    field(t("rsExtra"), extra, t("rsExtraHint")),
    h("label", { class: "check" }, logo, h("span", {}, t("rsLogo"))),
    h("label", { class: "check" }, phone, h("span", {}, t("rsPhone"))),
    h("label", { class: "check" }, address, h("span", {}, t("rsAddress"))),
    h("label", { class: "check" }, balance, h("span", {}, t("rsBalance"))),
    h("div", { class: "field" }, h("span", {}, t("rsPaper")),
      segmented([["58", "58 mm"], ["80", "80 mm"]], paper, (v) => { paper = v; }),
      h("small", { class: "field-hint" }, t("rsPaperHint"))),
  ], [saveButton(), closeButton()], () => {
    saved(saveFirmSettings({
      receipt: {
        title: title.value.trim(), thanks: thanksIn.value.trim(), extra: extra.value.trim(),
        showLogo: logo.checked, showPhone: phone.checked, showAddress: address.checked, showBalance: balance.checked, paper,
      },
    }), t("saved"));
    return undefined;
  });
}

// Fiş numarası: tarih + kayıt kimliğinin başı ("20261026-AB12").
export { receiptNumber };

// Hareketten fiş/fatura belgesi. paid ve balanceAfter sadece satış anında bilinir.
// Ödeme ve tahsilatta makbuz: tek tutar, kur ve kalan borç (bakiye kişinin para biriminde).
export function receiptDoc(move, kind, { paid = 0, balanceAfter: after = null } = {}) {
  const balanceAfter = receiptSettings().showBalance === false ? null : after;
  const firm = currentFirm();
  const party = session.firm.parties.get(move.party);
  const at = millis(move.at);
  if (MONEY_KINDS.includes(kind)) {
    return {
      kind,
      number: receiptNumber(move),
      date: move.date,
      time: at ? new Date(at).toTimeString().slice(0, 5) : "",
      currency: move.currency ?? base(), base: base(),
      rate: move.rate ?? null,
      firm: receiptFirm(firm),
      party: party ? { name: party.name, phone: party.phone ?? "" } : null,
      amount: move.total,
      balanceAfter,
      note: move.note ?? "",
    };
  }
  return {
    kind,
    number: receiptNumber(move),
    date: move.date,
    time: at ? new Date(at).toTimeString().slice(0, 5) : "",
    currency: move.currency ?? base(), base: base(),
    firm: receiptFirm(firm),
    party: party ? {
      name: party.name, title: party.name, taxOffice: party.taxOffice ?? "", taxNo: party.taxNo ?? "",
      address: party.address ?? "", phone: party.phone ?? "",
    } : null,
    lines: [
      ...move.lines.map((l) => ({
        name: l.name, qty: l.qty, unit: unitLabel(l.unit), price: l.price,
        vatRate: session.firm.products.get(l.product)?.vat ?? firm.defaultVat ?? 20,
      })),
      // İndirim / ikram eksi bir satır olarak: toplam ve KDV net tutardan çıkar.
      ...(move.discount ? [{ name: t("rc_discount"), qty: 1, unit: "", price: -move.discount, vatRate: firm.defaultVat ?? 20 }] : []),
    ],
    // İade fişi: başlığı "İade Fişi", ödenen yerine "Geri verilen".
    ...(move.type === "saleReturn" && { title: t("rc_returnTitle"), paidLabel: t("rc_refunded") }),
    paid,
    balanceAfter,
    note: move.note ?? "",
  };
}

const plainMoney = (v, c) => formatMoney(v, c).replace(/[⁦⁩]/g, "");
const dayText = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d.split("-").reverse().join(".") : d || "");

// Doğrudan kişinin WhatsApp sohbetine giden kısa yazı (*kalın* WhatsApp biçimi): başlık, kişi, tutar,
// kalan borç ve fişin bağlantısı. Tarayıcı belli bir sohbete dosya ekleyemez; bu yüzden fiş internette
// tahmin edilemez kodlu bir sayfaya konur, müşteri bağlantıya dokununca resim olarak görür ve PDF indirir.
// Satış/iade fişi, ödeme/tahsilat/para iadesi makbuzu, hesap ekstresi ve özet fişi (ortak) için.
export function receiptMessage(doc, link) {
  const cur = doc.currency || "TRY";
  const m = (v, c = cur) => plainMoney(v, c);
  const balance = (v) => (v == null ? null : `${v >= 0 ? t("rc_balanceOwed") : t("rc_balanceCredit")}: *${m(Math.abs(v))}*`);
  const when = [dayText(doc.date), doc.time].filter(Boolean).join(" ");
  const out = [`*${doc.firm.name}*`];
  if (doc.kind === "statement") {
    out.push(`${t("rc_statementTitle")} · ${doc.party?.name ?? ""}`, when, "", `${doc.balanceLabel}: *${m(Math.abs(doc.balance))}*`);
  } else if (doc.kind === "summary") {
    out.push(`${doc.title} · ${doc.subtitle ?? ""}`, when);
    if (doc.total) out.push("", `${doc.total[0]}: *${doc.total[1]}*`);
  } else if (MONEY_KINDS.includes(doc.kind)) {
    out.push(`${t(`rc_${doc.kind}Title`)} · ${t("rc_number")} ${doc.number}`, when);
    if (doc.party?.name) out.push(`${t(doc.kind === "collection" ? "rc_receivedFrom" : "rc_paidTo")}: ${doc.party.name}`);
    out.push("", `${t("rc_amount")}: *${m(doc.amount)}*`, balance(doc.balanceAfter));
  } else {
    out.push(`${doc.title || t("rc_receiptTitle")} · ${t("rc_number")} ${doc.number}`, when);
    if (doc.party?.name) out.push(`${t("rc_customer")}: ${doc.party.name}`);
    out.push("", `${t("rc_total")}: *${m(doc.lines.reduce((s, l) => s + lineTotal(l), 0))}*`);
    if (doc.paid) out.push(`${doc.paidLabel || t("rc_paid")}: ${m(doc.paid)}`);
    out.push(balance(doc.balanceAfter));
  }
  if (link) out.push("", `${t("rc_viewLink")}:`, link);
  out.push("", t("rc_thanks"));
  return out.filter((x) => x != null).join("\n");
}

// Fişi bağlantılı sayfaya koyar ve yazıyı doğrudan kişinin WhatsApp sohbetinde açar
// (telefon yoksa WhatsApp'ta kişi seçilir). Aynı belge ikinci kez gönderilirse aynı bağlantı kullanılır.
const sharedLinks = new WeakMap();
export function sendToChat(doc, phone) {
  let link = sharedLinks.get(doc);
  if (!link) {
    link = `${location.origin}/r/${shareReceipt(doc, receiptLabels(), lang)}`;
    sharedLinks.set(doc, link);
  }
  return shareOnWhatsApp({ text: receiptMessage(doc, link), phone: phone || null });
}

// Fiş fotoğrafını kişiye gönderir: telefonda paylaşım ekranı açılır, fotoğraf eklenmiş gelir (WhatsApp,
// kişi seçilir, gönder'e basılır). Tarayıcı belli bir sohbete dosya ekleyemez, WhatsApp da kendiliğinden
// göndermez. Dosya paylaşamayan cihazda (bilgisayar) fotoğraf kopyalanıp sohbet açılır, olmazsa indirilir.
// Fotoğrafın altına yazı eklenmez: her şey fotoğrafta var. blob: Promise<Blob>.
export async function sendPhoto(blob, phone, filename = "fis.png") {
  if (!canShareFiles() && directPhoto(phone) && await copyImageAndOpenChat(blob, phone)) return;
  const result = await shareOnWhatsApp({ blob: await blob, filename, phone: phone || null });
  if (result === "link") toast(t("receiptDownloaded"));
}
// İkinci yol: fotoğraf kopyalanır, kişinin sohbeti doğrudan açılır, mesaj kutusuna yapıştırılır.
export async function pastePhoto(blob, phone, filename = "fis.png") {
  if (directPhoto(phone) && await copyImageAndOpenChat(blob, phone)) return;
  sendPhoto(blob, phone, filename);
}
export const photoHint = () => t(canShareFiles() ? "photoShareHint" : "photoPickHint");
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const directPhoto = (phone) => Boolean(phone && waPhone(phone) && canCopyImage());

// Ana düğme: fiş fotoğraf olarak WhatsApp'a (paylaşım ekranı). Altında: sohbete yapıştır (telefon kayıtlıysa),
// yazı + bağlantı (kişinin sohbeti doğrudan açılır), (varsa) fatura bilgisi ve yazdır.
function chatButtons({ doc, phone, label, blob, filename, invoice, print }) {
  return [
    h("button", { type: "button", class: "block whatsapp", onclick: () => sendPhoto(blob(), phone, filename) }, icon("whatsapp"), label),
    h("small", { class: "field-hint center" }, photoHint()),
    h("div", { class: "row-buttons" },
      directPhoto(phone) && h("button", { type: "button", class: "block", onclick: () => pastePhoto(blob(), phone, filename) }, icon("clipboard"), t("pasteToChat")),
      h("button", { type: "button", class: "block", onclick: () => sendToChat(doc(), phone) }, icon("whatsapp"), t("sendAsText")),
      invoice && h("button", { type: "button", class: "block", onclick: invoice }, icon("receipt"), t("sendInvoice")),
      h("button", { type: "button", class: "block", onclick: print }, icon("printer"), t("print"))),
  ];
}

// Belge düğmeleri: resimler pencere açılırken hazırlanır ki paylaş dokunuşu kaybolmasın (Safari).
function receiptButtons(move, extra) {
  const party = session.firm.parties.get(move.party);
  const labels = receiptLabels();
  if (MONEY_KINDS.includes(move.type)) {
    // Makbuz: WhatsApp ve yazdır (fatura bilgisi yok; ürün satırı olmayan bir para hareketi).
    const doc = receiptDoc(move, move.type, extra);
    const ready = receiptBlob(doc, labels);
    ready.catch((err) => console.error(err));
    return chatButtons({
      doc: () => doc, phone: party?.phone, label: t("sendMoneyReceipt"),
      blob: () => ready, filename: `makbuz-${doc.number}.png`, print: () => printReceipt(doc, labels),
    });
  }
  // İadede fatura bilgisi yok; sadece iade fişi.
  const isReturn = move.type === "saleReturn";
  const docs = isReturn ? { receipt: receiptDoc(move, "receipt", extra) }
    : { receipt: receiptDoc(move, "receipt", extra), invoice: receiptDoc(move, "invoice", extra) };
  // Resimler pencere açılırken hazırlanır ki dokunuş anında hazır olsun.
  const blobs = {};
  for (const kind of Object.keys(docs)) {
    blobs[kind] = receiptBlob(docs[kind], labels);
    blobs[kind].catch((err) => console.error(err));
  }
  return [
    ...chatButtons({
      doc: () => docs.receipt, phone: party?.phone, label: t("sendReceipt"),
      blob: () => blobs.receipt, filename: `fis-${docs.receipt.number}.png`,
      invoice: isReturn ? null : () => sendPhoto(blobs.invoice, party?.phone, `fatura-${docs.invoice.number}.png`),
      print: () => printReceipt(docs.receipt, labels),
    }),
    !isReturn && h("small", { class: "field-hint center" }, t("invoiceNote")),
  ];
}

// Satış (ya da iade) kaydedilince: özet + fiş gönderme + geri alma.
// İadede borç azalır, geri verilen para borcu yeniden artırır.
function saleDone(moves, before) {
  const sale = moves.find((m) => RECEIPT_TYPES.includes(m.type));
  const isReturn = sale.type === "saleReturn";
  const paid = moves.filter((m) => m.type === "collection" || m.type === "refund").reduce((s, m) => s + m.amount, 0);
  // Peşin müşteride (direkt satış) bakiye yazılmaz; para zaten alındı.
  const party = session.firm.parties.get(sale.party);
  const account = party && !party.walkIn && sale.partyName !== t("walkInCustomer");
  const after = isReturn ? before - sale.total + paid : before + sale.total - paid;
  const extra = { paid, balanceAfter: account ? after : null };
  open(t(isReturn ? "returnSaved" : "saleSaved"), [
    h("div", { class: "done-summary" },
      h("span", { class: "done-check" }, icon("check")),
      h("strong", {}, formatMoney(sale.total)),
      sale.partyName && h("span", { class: "muted" }, h("bdi", {}, sale.partyName)),
      account && h("small", { class: "muted" }, `${balanceText("seller", after).label}: ${balanceText("seller", after).amount}`)),
    ...receiptButtons(sale, extra),
  ], [
    h("button", {
      type: "button", class: "block ghost danger",
      onclick: () => { sheet.close(); voidMoves(moves, t("undoReason")).then(() => toast(t("undone")), failed); },
    }, t("undo")),
    h("button", { type: "button", class: "block primary", onclick: () => sheet.close() }, t("done")),
  ]);
}

// Ödeme / tahsilat kaydedilince: özet (tutar, kişi, kalan borç) + makbuz gönderme + geri alma.
function moneyDone(move, before) {
  const party = session.firm.parties.get(move.party);
  // Ödeme tedarikçiye borcu, tahsilat satıcının borcunu azaltır; para iadesi müşterinin bakiyesini artırır.
  const after = move.type === "refund" ? before + move.total : before - move.total;
  const b = balanceText(party.kind, after, party.currency);
  open(t(`${move.type}Saved`), [
    h("div", { class: "done-summary" },
      h("span", { class: "done-check" }, icon("check")),
      h("strong", {}, formatMoney(move.total, move.currency)),
      h("span", { class: "muted" }, h("bdi", {}, party.name)),
      h("small", { class: "muted" }, `${b.label}: ${b.amount}`)),
    ...receiptButtons(move, { balanceAfter: after }),
  ], [
    h("button", {
      type: "button", class: "block ghost danger",
      onclick: () => { sheet.close(); voidMoves([move], t("undoReason")).then(() => toast(t("undone")), failed); },
    }, t("undo")),
    h("button", { type: "button", class: "block primary", onclick: () => sheet.close() }, t("done")),
  ]);
}

// --- Online mağaza ---------------------------------------------------------------------------

// Mağaza ayarları: aç/kapat, adres, siparişlerin geleceği WhatsApp, fiyat ve tükenen ürün gösterimi.
export function openShopSheet() {
  const firm = currentFirm();
  const cur = shopOf(firm) ?? {};
  const check = (on) => h("input", { type: "checkbox", checked: on });
  const on = check(cur.on ?? true);
  const slug = textInput({ maxlength: 40, value: cur.slug ?? slugify(firm.name), dir: "ltr", placeholder: "dukkanim" });
  const preview = h("small", { class: "field-hint", dir: "ltr" });
  const paint = () => { preview.textContent = shopUrl(slugify(slug.value) || "…"); };
  slug.addEventListener("input", paint);
  paint();
  const phone = h("input", { type: "tel", maxlength: 24, dir: "ltr", autocomplete: "off", value: cur.phone ?? firm.info?.phone ?? "", placeholder: "0555 555 55 55" });
  const showPrices = check(cur.showPrices !== false);
  const hideSoldOut = check(Boolean(cur.hideSoldOut));
  const cover = photoField(cur.cover, { prepare: prepareCover, label: t("shopCover") });
  const live = cur.slug && cur.on;
  const fields = [
    live ? shopLinkCard(cur) : h("p", { class: "muted" }, t("shopIntro")),
    live && h("button", { type: "button", class: "block", onclick: openShopProducts }, icon("box"), t("shopProducts")),
    h("p", { class: "label" }, t("shopCover")),
    cover.el,
    h("small", { class: "field-hint center" }, t("shopCoverHint")),
    h("label", { class: "check" }, on, h("span", {}, t("shopOn"))),
    h("label", { class: "field" }, h("span", {}, t("shopAddress")), slug, preview),
    field(t("shopPhone"), phone, t("shopPhoneHint")),
    h("label", { class: "check" }, showPrices, h("span", {}, t("shopShowPrices"))),
    h("label", { class: "check" }, hideSoldOut, h("span", {}, t("shopHideSoldOut"))),
    h("small", { class: "field-hint" }, t("shopPrivacy")),
  ];
  const buttons = [saveButton()];
  if (live) {
    const url = shopUrl(cur.slug);
    buttons.push(
      h("button", { type: "button", class: "block", onclick: () => { sheet.close(); document.dispatchEvent(new Event("kervan:shop-preview")); } }, icon("globe"), t("shopOpen")),
      h("button", {
        type: "button", class: "block",
        onclick: () => syncShop().then(() => toast(t("shopSynced")), failed),
      }, icon("refresh"), t("shopSyncNow")),
      pushSupported() && h("button", {
        type: "button", class: "block",
        onclick: () => enableOrderPush().then(() => toast(t("ord_notifyOn")),
          (err) => { console.error(err); toast(t(err?.code === "denied" ? "ord_notifyDenied" : "genericError")); }),
      }, icon("bell"), t(pushPermission() === "granted" ? "ord_notifyRenew" : "ord_notifyEnable")));
  }
  buttons.push(closeButton());
  open(t("page_shop"), fields, buttons, () => {
    const s = slugify(slug.value);
    if (s.length < 3) return t("shopBadAddress");
    if (on.checked && phone.value.trim() && !waPhone(phone.value)) return t("shopBadPhone");
    const pic = cover.value();
    const settings = {
      slug: s, on: on.checked, phone: phone.value.trim(), showPrices: showPrices.checked, hideSoldOut: hideSoldOut.checked,
      cover: pic ? pic.full : pic === null ? "" : cur.cover ?? "",
    };
    saveShop(settings).then(() => toast(t(settings.on ? "shopSaved" : "shopClosed")),
      (err) => { console.error(err); toast(t(err?.code === "taken" ? "shopTaken" : "saveFailed")); });
    sheet.close();
    return undefined;
  });
}

// Mağazada görünen ürünler: fiyatı olan, gizlenmemiş (ve "tükenenleri gizle" açıksa stoğu olan).
const inShop = (p, shop) => !p.shopHide && p.price > 0 && !(shop.hideSoldOut && !(p.stock > 0));

// Mağaza açıkken ayarların üstünde: adres, kopyala / WhatsApp / paylaş / QR kod ve kısa özet.
function shopLinkCard(shop) {
  const firm = currentFirm();
  const url = shopUrl(shop.slug);
  const products = [...session.firm.products.values()].filter((p) => !p.deleted);
  const shown = products.filter((p) => inShop(p, shop));
  const cats = new Set(shown.map((p) => p.category).filter(Boolean));
  return h("div", { class: "card shop-link" },
    h("a", { class: "shop-url", href: url, target: "_blank", rel: "noopener", dir: "ltr" }, url.replace(/^https?:\/\//, "")),
    h("div", { class: "row-buttons" },
      h("button", { type: "button", class: "block", onclick: () => copyText(url) }, icon("clipboard"), t("copy")),
      h("button", { type: "button", class: "block", onclick: () => shareOnWhatsApp({ text: t("shopShareText", { name: firm.name, url }) }) }, icon("whatsapp"), "WhatsApp"),
      h("button", { type: "button", class: "block", onclick: () => shareLink(firm.name, url) }, icon("send"), t("sharePhotoShort")),
      h("button", { type: "button", class: "block", onclick: () => openShopQr(url, firm.name) }, icon("grid"), t("qrCode"))),
    h("div", { class: "shop-stats" },
      h("span", {}, h("strong", {}, String(shown.length)), t("shopStatProducts")),
      h("span", {}, h("strong", {}, String(cats.size)), t("shopStatCategories")),
      h("span", {}, h("strong", {}, String(products.length - shown.length)), t("shopStatHidden"))));
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("linkCopiedOk"));
  } catch {
    toast(text);
  }
}
async function shareLink(title, url) {
  if (!navigator.share) return copyText(url);
  try {
    await navigator.share({ title, url });
  } catch (e) {
    if (e?.name !== "AbortError") copyText(url);
  }
  return undefined;
}

// QR kod: kütüphane (qrcode-generator) ilk kullanımda yüklenir; mağaza adı ve adresiyle birlikte resim olur
// (yazdırılıp tezgâha konabilir, paylaşılabilir).
const QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
let qrLib = null;
function loadQr() {
  qrLib ??= new Promise((resolve, reject) => {
    const s = h("script", { src: QR_LIB });
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => { qrLib = null; reject(new Error("qr")); };
    document.head.append(s);
  });
  return qrLib;
}
async function qrCanvas(url, title) {
  const qrcode = await loadQr();
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.max(4, Math.floor(600 / (n + 8)));
  const side = (n + 8) * cell;
  const canvas = h("canvas", { width: side, height: side + 130, class: "qr-canvas" });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
  ctx.textAlign = "center";
  ctx.font = "800 34px Nunito, sans-serif";
  ctx.fillText(title, side / 2, side + 40, side - 40);
  ctx.fillStyle = "#555";
  ctx.font = "600 22px Nunito, sans-serif";
  ctx.fillText(url.replace(/^https?:\/\//, ""), side / 2, side + 84, side - 40);
  return canvas;
}
async function openShopQr(url, title) {
  let canvas;
  try {
    canvas = await qrCanvas(url, title);
  } catch (err) {
    console.error(err);
    return toast(t("qrFailed"));
  }
  const blob = () => new Promise((r) => canvas.toBlob(r, "image/png"));
  open(t("qrCode"), [
    canvas,
    h("small", { class: "field-hint center" }, t("qrHint")),
  ], [
    h("button", { type: "button", class: "block primary", onclick: async () => shareOnWhatsApp({ blob: await blob(), filename: "magaza-qr.png" }) }, icon("send"), t("sharePhotoShort")),
    h("button", { type: "button", class: "block", onclick: async () => downloadFile(new File([await blob()], "magaza-qr.png", { type: "image/png" })) }, icon("receipt"), t("download")),
    h("button", { type: "button", class: "block ghost", onclick: openShopSheet }, t("back")),
  ]);
  return undefined;
}

// Mağazadaki ürünler: her ürün tek dokunuşla vitrinde gösterilir/gizlenir; ürünün bağlantısı kopyalanır ya da
// paylaşılır (açılınca vitrinde o ürün açılır). Fiyatı olmayan ürün vitrine çıkamaz.
function openShopProducts() {
  const shop = shopOf();
  const all = [...session.firm.products.values()].filter((p) => !p.deleted).sort(byName);
  let query = "";
  const list = h("ul", { class: "cards" });
  const count = h("small", { class: "field-hint" });
  const render = () => {
    count.textContent = t("shopShownCount", { n: all.filter((p) => inShop(p, shop)).length, total: all.length });
    list.replaceChildren(...all.filter((p) => matches(productLabel(p), query)).map((p) => {
      const toggle = h("input", {
        type: "checkbox", class: "si-toggle", checked: !p.shopHide, disabled: !(p.price > 0), "aria-label": t("shopShowProduct"),
        onchange: () => { p.shopHide = !toggle.checked; setShopHidden(p.id, p.shopHide).catch(failed); render(); },
      });
      const url = productUrl(shop.slug, p.id);
      return h("li", { class: `card shop-item${inShop(p, shop) ? "" : " off"}` },
        h("div", { class: "si-top" },
          productThumb(p, "sm"),
          h("span", { class: "main" },
            h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
            h("span", { class: "meta" }, p.price > 0 ? formatMoney(p.price) : t("shopNoPrice"),
              p.category ? ` · ${p.category}` : "", !(p.stock > 0) ? ` · ${t("outOfStock")}` : "")),
          toggle),
        p.price > 0 && !p.shopHide && h("div", { class: "si-links" },
          h("button", { type: "button", class: "link", onclick: () => copyText(url) }, t("copyLink")),
          h("button", { type: "button", class: "link", onclick: () => shareLink(productLabel(p), url) }, t("sharePhotoShort"))));
    }));
  };
  render();
  open(t("shopProducts"), [
    searchBox(t("searchProducts"), "", (v) => { query = v; render(); }),
    count,
    list,
  ], [h("button", { type: "button", class: "block ghost", onclick: openShopSheet }, t("back"))]);
}

async function partyWhenReady(id) {
  for (let i = 0; i < 60 && !session.firm.parties.has(id); i++) await new Promise((r) => setTimeout(r, 50));
  return session.firm.parties.get(id);
}

// Siparişi satışa çevirir: müşteri telefonundan (yoksa adından) bulunur, yoksa yeni müşteri açılır;
// satış formu siparişin ürünleri ve fiyatlarıyla dolu açılır. Fiyatı gizli siparişte liste fiyatı gelir.
async function orderToSale(order) {
  const sellers = [...session.firm.parties.values()].filter((p) => p.kind === "seller" && !p.walkIn);
  const key = waPhone(order.phone);
  const lower = (s) => (s || "").toLocaleLowerCase("tr").trim();
  const found = (key && sellers.find((p) => waPhone(p.phone) === key)) || sellers.find((p) => lower(p.name) === lower(order.name));
  let id = found?.id;
  if (!id) {
    const done = saveParty(null, { kind: "seller", name: order.name.slice(0, 80), phone: order.phone ?? "", note: t("ord_partyNote") });
    done.catch(failed);
    id = done.id;
    await partyWhenReady(id);
  }
  setOrderStatus(order.id, "done").catch(failed);
  openMoveSheet("sale", { party: id, lines: order.lines.map((l) => ({ product: l.id, qty: l.qty, ...(l.price > 0 && { price: l.price }) })) });
}

// Siparişin ayrıntısı: ürünler, müşteri, not; satışa çevir, müşteriye yaz, fişi, reddet, sil.
export function openShopOrderSheet(order) {
  const shop = shopOf();
  const cur = order.currency || base();
  const missing = order.lines.filter((l) => !session.firm.products.has(l.id)).length;
  const fields = [
    h("div", { class: "facts" },
      fact(t("ord_customer"), order.name),
      order.phone && fact(t("phone"), order.phone),
      fact(t("ord_code"), order.code),
      fact(t("ord_via"), t(order.via === "whatsapp" ? "ord_viaWa" : "ord_viaDirect"))),
    h("ul", { class: "line-list" }, order.lines.map((l) => h("li", {},
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, l.name)),
        h("span", { class: "meta" }, `${formatNumber(l.qty)} ${l.unit || ""}${l.price ? ` × ${formatMoney(l.price, cur)}` : ""}`)),
      l.price ? h("strong", {}, formatMoney(Math.round(l.qty * l.price), cur)) : null))),
    order.total ? h("div", { class: "facts" }, fact(t("total"), formatMoney(order.total, cur))) : null,
    order.note && h("p", { class: "note" }, h("bdi", {}, order.note)),
    missing && h("small", { class: "field-hint" }, t("ord_missing", { n: missing })),
  ];
  // Siparişin fişi uygulamanın içinde hazırlanır (bağlantı açılıp uygulamadan çıkılmaz).
  const doc = {
    kind: "receipt", title: t("rc_orderTitle"), number: order.code, date: (order.at?.toDate?.() ?? new Date()).toISOString().slice(0, 10),
    time: (order.at?.toDate?.() ?? new Date()).toTimeString().slice(0, 5), currency: cur, base: base(),
    firm: { name: currentFirm().name, logo: currentFirm().logo ?? "", ...currentFirm().info },
    party: { name: [order.name, order.phone].filter(Boolean).join(" · ") },
    lines: order.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit ?? "", price: l.price, vatRate: 0 })),
    paid: 0, balanceAfter: null, note: order.note ?? "",
  };
  const ready = receiptBlob(doc, receiptLabels());
  ready.catch((err) => console.error(err));
  const sharePdf = async () => {
    const pdf = new File([await receiptPdf(doc, receiptLabels())], `siparis-${order.code}.pdf`, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [pdf] })) navigator.share({ files: [pdf] }).catch(() => {});
    else downloadFile(pdf);
  };
  open(t("ord_title", { code: order.code }), fields, [
    order.status !== "done" && h("button", { type: "button", class: "primary block", onclick: () => orderToSale(order) }, icon("out"), t("ord_toSale")),
    order.phone && waPhone(order.phone) && h("button", {
      type: "button", class: "block",
      onclick: () => shareOnWhatsApp({ phone: order.phone, text: t("ord_reply", { name: order.name, code: order.code, firm: currentFirm().name }) }),
    }, icon("whatsapp"), t("ord_writeCustomer")),
    h("button", { type: "button", class: "block whatsapp", onclick: () => sendPhoto(ready, order.phone, `siparis-${order.code}.png`) }, icon("whatsapp"), t("ord_sendReceipt")),
    h("div", { class: "row-buttons" },
      directPhoto(order.phone) && h("button", { type: "button", class: "block", onclick: () => pastePhoto(ready, order.phone, `siparis-${order.code}.png`) }, icon("clipboard"), t("pasteToChat")),
      h("button", { type: "button", class: "block", onclick: sharePdf }, icon("receipt"), "PDF"),
      h("button", { type: "button", class: "block", onclick: () => printReceipt(doc, receiptLabels()) }, icon("printer"), t("print"))),
    h("div", { class: "move-actions" },
      order.status === "new"
        ? h("button", { type: "button", class: "block", onclick: () => { sheet.close(); setOrderStatus(order.id, "rejected").then(() => toast(t("ord_rejected")), failed); } }, icon("x"), t("ord_reject"))
        : h("button", { type: "button", class: "block", onclick: () => { sheet.close(); setOrderStatus(order.id, "new").catch(failed); } }, icon("undo"), t("ord_reopen")),
      h("button", { type: "button", class: "block danger", onclick: () => { sheet.close(); deleteOrder(order.id).then(() => toast(t("ord_deleted")), failed); } }, icon("trash"), t("delete"))),
    closeButton(),
  ]);
}

// --- Ayarlar: işletme, gider kategorileri, yapay zekâ --------------------------------------

const DEFAULT_CATEGORIES = ["rent", "fuel", "shipping", "tax", "salary", "utilities", "food", "other"];

// İşletmenin gider kategorileri; hiç düzenlenmemişse hazır liste.
export function expenseCategories(firm) {
  return firm.expenseCategories?.length
    ? firm.expenseCategories
    : DEFAULT_CATEGORIES.map((id) => ({ id, name: t(`cat_${id}`) }));
}

export function openBusinessSheet() {
  const firm = currentFirm();
  const info = firm.info ?? {};
  const logo = photoField(firm.logo, { round: true, label: t("addLogo") });
  const name = textInput({ maxlength: 40, value: firm.name });
  const input = (key, attrs = {}) => textInput({ maxlength: 120, value: info[key] ?? "", ...attrs });
  const title = input("title", { placeholder: t("firmTitlePlaceholder") });
  const taxOffice = input("taxOffice");
  const taxNo = input("taxNo", { inputmode: "numeric", dir: "ltr", maxlength: 20 });
  const address = input("address", { maxlength: 300 });
  const phone = h("input", { type: "tel", maxlength: 24, value: info.phone ?? "", dir: "ltr", autocomplete: "off" });
  const vat = numberInput({ value: String(firm.defaultVat ?? 20), placeholder: "20" });
  open(t("businessInfo"), [
    logo.el,
    field(t("firmName"), name),
    field(t("firmTitle"), title, t("firmTitleHint")),
    h("div", { class: "row2" }, field(t("taxOffice"), taxOffice), field(t("taxNo"), taxNo)),
    field(t("address"), address),
    h("div", { class: "row2" }, field(t("phone"), phone), field(t("defaultVat"), vat)),
    h("small", { class: "field-hint" }, t("businessHint")),
  ], [saveButton(), closeButton()], () => {
    const n = name.value.trim();
    if (!n) return t("enterFirmName");
    const v = parseQty(vat.value);
    if (v == null || v < 0 || v > 100) return t("badVat");
    const fields = {
      name: n,
      defaultVat: v,
      info: {
        title: title.value.trim(), taxOffice: taxOffice.value.trim(), taxNo: taxNo.value.trim(),
        address: address.value.trim(), phone: phone.value.trim(),
      },
    };
    const pic = logo.value();
    if (pic) fields.logo = pic.thumb;
    if (pic === null) fields.logo = "";
    saved(saveFirmSettings(fields), t("saved"));
    return undefined;
  });
}

// Ad listesi düzenleyici (gider kategorileri, ödeme şekilleri): her satır bir ad; kimlikler korunur
// ki eski kayıtlar bozulmasın. save(liste) en az bir ad varsa çağrılır. inside(liste) verilirse
// gider formunun üstünde açılır ve kaydedince form kaybolmadan yeni listeyle güncellenir.
// emoji: verilirse (gider kategorileri) her satırın başında resim düğmesi olur; dokununca resim seçilir.
// Seçilmeyen satırın resmi adından tahmin edilir (yazdıkça değişir).
function openNameListSheet({ title, hint, items, placeholder, addLabel, needOne, prefix, save, inside, emoji }) {
  const list = h("div", { class: "cat-list" });
  const rows = [];
  let openPicker = null;
  const addRow = (item) => {
    const input = textInput({ maxlength: 40, value: item?.name ?? "", placeholder });
    const row = { id: item?.id ?? `${prefix}${crypto.randomUUID().slice(0, 8)}`, input, emoji: item?.emoji ?? "" };
    let pickBtn = null;
    let picker = null;
    if (emoji) {
      const paint = () => { pickBtn.textContent = emoji({ id: row.id, name: input.value, emoji: row.emoji }); };
      picker = emojiPicker((e) => { row.emoji = e; paint(); picker.hidden = true; openPicker = null; });
      pickBtn = h("button", {
        type: "button", class: "emoji-pick", "aria-label": t("pickPicture"), title: t("pickPicture"),
        onclick: () => {
          if (openPicker && openPicker !== picker) openPicker.hidden = true;
          picker.hidden = !picker.hidden;
          openPicker = picker.hidden ? null : picker;
        },
      });
      input.addEventListener("input", () => { if (!row.emoji) paint(); });
      paint();
    }
    const el = h("div", { class: "cat-row" }, pickBtn, input, iconButton("x", t("remove"), () => {
      rows.splice(rows.indexOf(row), 1);
      el.remove();
      picker?.remove();
    }));
    rows.push(row);
    list.append(el);
    if (picker) list.append(picker);
    return input;
  };
  for (const item of items) addRow(item);
  open(title, [
    h("small", { class: "field-hint" }, hint),
    list,
    h("button", { type: "button", class: "small add-line", onclick: () => addRow().focus() }, "+ ", addLabel),
  ], [saveButton(), closeButton()], () => {
    const names = rows.map((r) => ({ id: r.id, name: r.input.value.trim(), ...(r.emoji && { emoji: r.emoji }) })).filter((c) => c.name);
    if (!names.length) return needOne;
    save(names).catch(failed);
    if (inside) {
      subsheet.close();
      inside(names);
    } else {
      sheet.close();
    }
    toast(t("saved"));
    return undefined;
  }, inside ? subsheet : sheet);
}

export function openCategoriesSheet(inside) {
  openNameListSheet({
    title: t("expenseCategories"), hint: t("categoriesHint"), items: expenseCategories(currentFirm()),
    placeholder: t("categoryPlaceholder"), addLabel: t("addCategory"), needOne: t("addAtLeastOneCategory"), prefix: "c",
    save: (expenseCategories) => saveFirmSettings({ expenseCategories }), inside, emoji: categoryEmoji,
  });
}

// Ödeme şekilleri (giderde "Nasıl ödendi?"): düzenlenmemişse nakit, kart, banka.
const DEFAULT_METHODS = ["cash", "card", "bank"];
export function paymentMethods(firm) {
  return firm.paymentMethods?.length ? firm.paymentMethods : DEFAULT_METHODS.map((id) => ({ id, name: t(`pm_${id}`) }));
}

// Kasa resmi: seçilen emoji; yoksa hazır kasalar kimliğinden, eklenenler adından.
const FUND_EMOJI = { cash: "💵", card: "💳", bank: "🏦" };
export function methodEmoji(m) {
  return m.emoji || FUND_EMOJI[m.id]
    || (/kart|card|بطاق/i.test(m.name) ? "💳" : /banka|havale|eft|bank|بنك/i.test(m.name) ? "🏦" : /nakit|cash|نقد/i.test(m.name) ? "💵" : "💰");
}

// "Hangi kasa?": paranın girdiği / çıktığı kasa (nakit, kart, banka…). Simgeli kare düğmeler;
// "Düzenle" kasa listesini formun üstünde açar. current: düzenlemede kayıttaki kasa.
function fundField(label, current, onchange) {
  let chosen = current?.id ? current : null;
  const box = h("div", { class: "fund-pick" });
  const render = (list = paymentMethods(currentFirm())) => {
    if (!chosen || (!list.some((m) => m.id === chosen.id) && chosen.id !== current?.id)) chosen = list[0];
    box.replaceChildren(
      ...list.map((m) => h("button", {
        type: "button", class: "fund-btn", "aria-pressed": String(m.id === chosen?.id),
        onclick: () => { chosen = m; render(list); onchange?.(m); },
      }, h("span", { class: "fund-emoji", "aria-hidden": "true" }, methodEmoji(m)), h("bdi", {}, m.name))),
      h("button", { type: "button", class: "fund-btn add", onclick: () => openMethodsSheet(render) },
        h("span", { class: "fund-emoji", "aria-hidden": "true" }, icon("pencil")), t("edit")));
  };
  render();
  return { el: h("div", { class: "field" }, h("span", {}, label), box), value: () => chosen };
}
const setFund = (input, f) => {
  if (!f) return;
  input.method = f.id;
  input.methodName = f.name;
};
const fundOf = (move) => (move?.method ? { id: move.method, name: move.methodName ?? "" } : null);

// Kasalar arası aktarma (ör. nakiti bankaya yatırmak).
export function openFundMoveSheet(from) {
  const amount = numberInput({ placeholder: "0,00" });
  const date = dateInput();
  const note = textInput({ maxlength: 200, placeholder: t("notePlaceholder") });
  const src = fundField(t("fundFrom"), from ?? null);
  const list = paymentMethods(currentFirm());
  const dst = fundField(t("fundTo"), list.find((m) => m.id !== (from?.id ?? list[0]?.id)) ?? null);
  open(t("type_fundMove"), [
    h("div", { class: "row2" }, field(t("amount"), amount), field(t("date"), date)),
    src.el, dst.el, noteField(note), h("small", { class: "field-hint" }, t("fundMoveHint")),
  ], [saveButton(), closeButton()], () => {
    const a = parseMoney(amount.value);
    if (!a) return t("enterAmount");
    const f = src.value();
    const to = dst.value();
    if (!f || !to || f.id === to.id) return t("fundSame");
    record([{ type: "fundMove", party: "", date: date.value, note: note.value.trim(), amount: a, method: f.id, methodName: f.name, toMethod: to.id, toMethodName: to.name }]);
    return undefined;
  });
}

// Kasa bakiyesini düzeltme (ya da açılış): gerçekte ne kadar olduğu yazılır, fark kasaya işlenir.
export function openFundAdjustSheet(fund, current) {
  const actual = numberInput({ value: moneyInput(current), placeholder: "0,00" });
  open(t("fundAdjustTitle", { name: fund.name }), [
    field(t("fundAdjustLabel"), actual, t("fundAdjustHint")),
  ], [saveButton(), closeButton()], () => {
    const v = parseMoney(actual.value);
    if (v == null) return t("badNumber");
    const delta = v - current;
    if (!delta) return sheet.close();
    record([{ type: "fundAdjust", party: "", date: today(), note: t("fundAdjustNote"), amount: delta, method: fund.id, methodName: fund.name }]);
    return undefined;
  });
}

export function openMethodsSheet(inside) {
  openNameListSheet({
    title: t("paymentMethods"), hint: t("methodsHint"), items: paymentMethods(currentFirm()),
    placeholder: t("methodPlaceholder"), addLabel: t("addMethod"), needOne: t("addAtLeastOneMethod"), prefix: "m",
    save: (methods) => saveFirmSettings({ paymentMethods: methods }), inside, emoji: methodEmoji,
  });
}

export function openAiSheet() {
  const firm = currentFirm();
  const key = h("input", { type: "password", autocomplete: "off", dir: "ltr", value: firm.ai?.key ?? "", placeholder: "AIza…" });
  const status = h("small", { class: "field-hint" });
  open(t("aiSettings"), [
    // Ortak (anahtarsız) yol açıksa anahtar sadece isteğe bağlıdır.
    sharedAiReady() && h("p", { class: "card ai-ready" }, t("aiSharedReady")),
    h("p", { class: "muted" }, t(sharedAiReady() ? "aiOwnKeyOptional" : "aiIntro")),
    h("ol", { class: "how" }, h("li", {}, t("aiStep1")), h("li", {}, t("aiStep2")), h("li", {}, t("aiStep3"))),
    h("a", { class: "block-link", href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, t("aiGetKey")),
    field(t("aiKey"), key),
    status,
    h("small", { class: "field-hint" }, t("aiPrivacy")),
    h("small", { class: "field-hint" }, t("aiXmlNote")),
  ], [
    saveButton(),
    h("button", {
      type: "button", class: "block",
      onclick: async () => {
        status.textContent = "…";
        try {
          const model = await pickGeminiModel(key.value.trim());
          status.textContent = t("aiWorks", { model });
        } catch (err) {
          status.textContent = t(`err_${(err.code ?? "ai-failed").replace(/-/g, "_")}`);
        }
      },
    }, t("aiTest")),
    closeButton(),
  ], () => {
    saved(saveFirmSettings({ ai: { key: key.value.trim() } }), t("saved"));
    return undefined;
  });
}

// --- Hareket ayrıntısı ve iptal -------------------------------------------------

// balanceAfter: ekstreden açılınca o hareketten sonraki bakiye (makbuzda kalan borç olarak yazılır).
export function openMoveDetail(move, { balanceAfter = null } = {}) {
  const firm = currentFirm();
  const at = millis(move.at);
  const time = at ? new Intl.DateTimeFormat(dateLocale(), { dateStyle: "medium", timeStyle: "short" }).format(at) : "";
  const cur = move.currency;
  const facts = [
    move.partyName && fact(t(PARTY_KIND[move.type] ?? "party"), move.partyName),
    fact(t("date"), formatDay(move.date)),
    move.partner && fact(t("moneyOwner"), person(firm, move.partner).name),
    move.holder && move.type !== "transfer"
      && fact(t(move.partner ? `handler_${move.type}` : `holderOf_${move.type}`), person(firm, move.holder).name),
    move.type === "expense" && fact(t("expenseDeal"), firm.deals?.[move.deal]?.name ?? t("generalShares")),
    move.type === "transfer" && fact(t("transferFromTo"), `${person(firm, move.holder).name} → ${person(firm, move.to).name}`),
    move.id && ["sale", "consignSale", "saleReturn", "collection", "payment", "refund", "debtOut", "debtIn", "purchaseReturn", "supplierRefund"].includes(move.type)
      && fact(t("receiptNo"), receiptNumber(move)),
    !move.lines && move.type !== "expense" && move.methodName
      && fact(t("fundLabel"), move.toMethodName ? `${move.methodName} → ${move.toMethodName}` : move.methodName),
    cur && fact(t("rate"), `1 ${cur} = ${currencySymbol(base())}${formatRate(move.rate)}`),
    fact(t("enteredBy"), `${person(firm, move.by).name}${time ? ` · ${time}` : ""}`),
  ];
  const fields = [h("div", { class: "facts" }, facts.filter(Boolean))];

  if (move.lines) {
    fields.push(h("ul", { class: "line-list" }, move.lines.map((l) =>
      h("li", {},
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, l.name)),
          h("span", { class: "meta" }, `${formatNumber(l.qty)} ${unitLabel(l.unit)} × ${formatMoney(l.price, cur)}`
            + (l.deal ? ` · ${firm.deals?.[l.deal]?.name ?? t("deletedDeal")}` : ""))),
        h("strong", {}, formatMoney(lineTotal(l), cur))))));
  }
  const totals = [fact(t("total"), formatMoney(move.total, cur))];
  if (cur) totals.push(fact(t("inBaseShort", { c: currencySymbol(base()) }), formatMoney(Math.round(move.total * move.rate))));
  if (move.type === "sale" || move.type === "consignSale") {
    const cost = sum(move.lines, (l) => l.cost ?? 0);
    const margin = marginPct(move.total, cost);
    totals.push(fact(t("cost"), formatMoney(cost)), fact(t("grossProfit"), formatMoney(move.total - cost)));
    if (margin != null) totals.push(fact(t("margin"), `%${formatNumber(margin)}`));
  }
  fields.push(h("div", { class: "facts" }, totals));
  if (move.type === "expense") {
    fields.unshift(h("div", { class: "facts" },
      fact(t("expenseCategory"), move.categoryName || t("uncategorized")),
      move.methodName ? fact(t("paidWith"), move.methodName) : null));
  }
  if (move.invoiceNo) fields.push(fact(t("invoiceNo"), move.invoiceNo));
  if (move.note) fields.push(h("p", { class: "note" }, h("bdi", {}, move.note)));

  const title = t(`type_${move.type}`);
  // Çöp kutusundaki kayıt: kim, neden sildi; geri yüklenebilir (bir kez).
  if (move.voided) {
    const who = person(firm, move.voided.by).name;
    const why = move.voided.reason;
    fields.push(h("p", { class: "voided-note" }, why === t("trashedReason") ? t("trashedBy", { name: who })
      : why === t("editedReason") ? t("editedBy", { name: who }) : t("voidedBy", { name: who, reason: why })));
    if (move.restored) {
      fields.push(h("p", { class: "field-hint center" }, t("restoredBy", { name: person(firm, move.restored.by).name })));
      return open(title, fields, [closeButton()]);
    }
    return open(title, fields, [
      h("button", { type: "button", class: "primary block", onclick: () => restore(move) }, icon("undo"), t("restore")),
    ]);
  }
  if (RECEIPT_TYPES.includes(move.type)) fields.push(...receiptButtons(move));
  // Satıştan iade: aynı müşteri ve aynı ürünler, satıldığı fiyatla; adetler − / + ile azaltılır.
  if (move.type === "sale") {
    fields.push(h("button", {
      type: "button", class: "block",
      onclick: () => openMoveSheet("saleReturn", { party: move.party, lines: move.lines.map((l) => ({ product: l.product, qty: l.qty, price: l.price })) }),
    }, icon("undo"), t("returnFromSale")));
  }
  else if (MONEY_KINDS.includes(move.type) && move.party) fields.push(...receiptButtons(move, { balanceAfter }));
  // Düzenle ve sil: silinen kayıt çöp kutusuna gider, oradan geri yüklenebilir.
  const editable = EDITABLE.includes(move.type);
  fields.push(
    h("div", { class: `move-actions${editable ? "" : " one"}` },
      editable && h("button", { type: "button", class: "block", onclick: () => editMove(move) }, icon("pencil"), t("edit")),
      h("button", { type: "button", class: "block danger", onclick: () => trashMove(move) }, icon("trash"), t("moveToTrash"))),
    !editable && h("small", { class: "field-hint center" }, t(move.type === "opening" ? "cantEditOpening" : "cantEditShelf")));
  open(title, fields, [closeButton()]);
}

// Düzenlenebilen kayıtlar: formu olanlar. Sayım/iade raftaki o anki duruma bağlı olduğu için
// silinip yeniden girilir; açılış kaydı ürün/kişi formundan gelir.
const EDITABLE = ["sale", "saleReturn", "purchase", "purchaseReturn", "supplierRefund", "consign", "payment", "collection", "refund", "debtOut", "debtIn", "expense", "capitalIn", "withdraw", "transfer"];

function editMove(move) {
  if (["expense", "capitalIn", "withdraw", "transfer"].includes(move.type)) openCashSheet(move.type, { edit: move });
  else openMoveSheet(move.type, { edit: move });
}

function trashMove(move) {
  sheet.close();
  voidMoves([move], t("trashedReason")).catch(failed);
  toast(t("movedToTrash"), () => restoreMove(move).done.then(() => toast(t("restored")), failed));
}

function restore(move) {
  restoreMove(move).done.catch(failed);
  sheet.close();
  toast(t("restored"));
}

// Başka form modülleri (faturadan alış) için ortak parçalar.
export {
  open as openSheet, field, textInput, numberInput, select, saveButton, closeButton, failed, rateField, marginPct,
};
