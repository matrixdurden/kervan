// Formlar: ürün, cari, alış/satış/emanet, sayım/iade, kasa işlemleri, ortaklık payları
// ve hareket ayrıntısı. Hepsi aynı <dialog id="sheet"> içinde açılır.
// Kolaylık için her alan akla gelen değerle dolu gelir: tarih bugün, fiyat ürünün fiyatı,
// kur son kullanılan, parayı alan/veren ortak kişinin kendisi.

import { $, h, icon, iconButton, toast, today, formatDay, millis, avatar, dateLocale } from "./ui.js";
import { t, UNITS, unitLabel } from "./i18n.js";
import { session, currentFirm, person, partners, generalShares } from "./session.js";
import {
  parseMoney, parseQty, parseRate, formatMoney, formatNumber, formatRate, moneyInput, qtyInput,
  CURRENCIES, currencySymbol,
} from "./money.js";
import { PARTY_KIND, hasLines, lineTotal, avgCost, roundQty } from "./ledger.js";
import {
  recordMoves, voidMoves, saveProduct, saveParty, deleteProduct, deleteParty, saveShares,
  saveDeal, deleteDeal, saveGuest, deleteGuest, dealOf, productByBarcode,
} from "./data.js";
import { byName, matches, searchBox } from "./views.js";
import { lastRate, rememberRate, fetchRate } from "./rates.js";
import { pickImage, preparePhoto, loadFullPhoto } from "./photos.js";
import { canScan, scanBarcode } from "./scanner.js";
import { canPickContact, pickContact } from "./contacts.js";

const sheet = $("#sheet");

// onsubmit hata metni döndürürse form açık kalır ve metin gösterilir.
function open(title, fields, buttons, onsubmit) {
  const error = h("p", { class: "error", role: "alert" });
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
  }, h("h3", {}, title), fields.filter(Boolean), error, buttons.filter(Boolean));
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal(); // bir formdan diğerine geçerken pencere zaten açık
  sheet.scrollTop = 0;
}

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

// Hareket kaydı: bildirimdeki "Geri al" kaydı iptal eder (defterde iz kalır).
function record(inputs, message = t("savedMove")) {
  const { moves, done } = recordMoves(inputs);
  sheet.close();
  toast(message, () => voidMoves(moves, t("undoReason")).then(() => toast(t("undone")), failed));
  done.catch(failed);
}

const field = (label, control, hint) =>
  h("label", { class: "field" }, h("span", {}, label), control, hint && h("small", { class: "field-hint" }, hint));
const textInput = (attrs = {}) => h("input", { autocomplete: "off", dir: "auto", ...attrs });
const numberInput = (attrs = {}) => h("input", { inputmode: "decimal", autocomplete: "off", dir: "ltr", ...attrs });
const select = (options, value, attrs = {}) =>
  h("select", attrs, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
const fact = (label, value) => h("div", { class: "fact" }, h("span", {}, label), h("strong", {}, value));
const saveButton = (label = t("save")) => h("button", { class: "primary block" }, label);
const closeButton = () => h("button", { type: "button", class: "block ghost", onclick: () => sheet.close() }, t("close"));
const dateInput = () => h("input", { type: "date", value: today(), required: true });
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

const CURRENCY_NAMES = { TRY: "currency_TRY", USD: "currency_USD", EUR: "currency_EUR" };

// --- Ürün -------------------------------------------------------------------

// Fotoğraf alanı: dokununca kamera/galeri açılır. Sonuç: undefined (değişmedi), null (kaldırıldı)
// ya da { thumb, full } (yeni).
function photoField(product) {
  let result;
  const img = h("img", { alt: "" });
  const empty = h("span", { class: "photo-empty" }, icon("camera"), h("span", {}, t("addPhoto")));
  const box = h("button", { type: "button", class: "photo", "aria-label": t("addPhoto") }, img, empty);
  const remove = h("button", { type: "button", class: "link", hidden: true }, t("removePhoto"));
  const show = (src) => {
    img.src = src || "";
    img.hidden = !src;
    empty.hidden = Boolean(src);
    remove.hidden = !src;
  };
  show(product?.thumb);
  // Büyük hali sonradan gelir.
  if (product?.thumb) loadFullPhoto(product.id).then((full) => { if (full && result === undefined) img.src = full; });

  box.addEventListener("click", async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      result = await preparePhoto(file);
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
  return { el: h("div", { class: "photo-field" }, box, remove), value: () => result };
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

export function openProductSheet(product, preset = {}) {
  const firm = currentFirm();
  const photo = photoField(product);
  const name = textInput({ maxlength: 80, value: product?.name ?? preset.name, placeholder: t("productNamePlaceholder") });
  const unit = select(UNITS.map((u) => [u, unitLabel(u)]), product?.unit ?? UNITS[0]);
  const price = numberInput({ value: moneyInput(product?.price), placeholder: "0,00" });
  const barcode = barcodeField(product?.barcode ?? preset.barcode ?? "");
  const fields = [
    photo.el,
    field(t("productName"), name),
    h("div", { class: "row2" }, field(t("unit"), unit), field(t("salePrice"), price)),
    barcode.el,
  ];

  // Ortaklık: bu ürünün kârı genel paylarla mı, bir ürün ortaklığıyla mı bölünür?
  const deals = Object.entries(firm.deals ?? {});
  const currentDeal = product ? dealOf(product.id) : "";
  let deal;
  if (deals.length) {
    deal = select([["", t("generalShares")], ...deals.map(([id, d]) => [id, d.name])], currentDeal);
    fields.push(field(t("productDeal"), deal, t("productDealHint")));
  }

  let qty;
  let cost;
  if (product) {
    fields.push(h("div", { class: "facts" },
      fact(t("inStock"), `${formatNumber(product.stock)} ${unitLabel(product.unit)}`),
      fact(t("atSellersLabel"), `${formatNumber(product.consigned ?? 0)} ${unitLabel(product.unit)}`),
      fact(t("avgCost"), formatMoney(avgCost(product))),
      fact(t("stockValue"), formatMoney(product.value))));
  } else {
    qty = numberInput({ placeholder: "0" });
    cost = numberInput({ placeholder: "0,00" });
    fields.push(
      h("p", { class: "label" }, t("openingStock")),
      h("div", { class: "row2" }, field(t("qtyOnHand"), qty), field(t("unitCost"), cost)),
      h("small", { class: "field-hint" }, t("openingStockHint")));
  }

  const buttons = [saveButton()];
  if (product) {
    const hasStock = Boolean(product.stock || product.value || product.consigned);
    buttons.push(h("button", {
      type: "button", class: "block danger", disabled: hasStock,
      onclick: () => {
        if (!confirm(t("confirmDelete", { name: product.name }))) return;
        saved(deleteProduct(product.id), t("deleted", { name: product.name }));
      },
    }, t("delete")));
    if (hasStock) buttons.push(h("small", { class: "field-hint center" }, t("cantDeleteProduct")));
  }
  buttons.push(closeButton());

  open(product ? t("editProduct") : t("newProduct"), fields, buttons, () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    const p = price.value.trim() ? parseMoney(price.value) : 0;
    if (p == null) return t("badNumber");
    const code = barcode.input.value.trim();
    const twin = code && productByBarcode(code);
    if (twin && twin.id !== product?.id) return t("barcodeTaken", { name: twin.name });
    let opening;
    if (!product && (qty.value.trim() || cost.value.trim())) {
      const q = parseQty(qty.value);
      const c = cost.value.trim() ? parseMoney(cost.value) : 0;
      if (!q || c == null) return t("badOpening");
      opening = { qty: q, cost: c };
    }
    const nextDeal = deal && deal.value !== currentDeal ? deal.value : undefined;
    saved(saveProduct(product?.id, { name: n, unit: unit.value, price: p, barcode: code }, { opening, photo: photo.value(), deal: nextDeal }), t("saved"));
    return undefined;
  });
  if (!product && !preset.name) name.focus();
}

// --- Satıcı / tedarikçi -------------------------------------------------------

export function openPartySheet(kind, party) {
  const name = textInput({ maxlength: 80, value: party?.name, placeholder: t(kind === "seller" ? "sellerNamePlaceholder" : "supplierNamePlaceholder") });
  const phone = h("input", { type: "tel", maxlength: 24, value: party?.phone, dir: "ltr", autocomplete: "off", placeholder: "0555 555 55 55" });
  const note = textInput({ maxlength: 200, value: party?.note, placeholder: t("partyNotePlaceholder") });
  const fields = [field(t("name"), name), field(t("phone"), phone), field(t("note"), note)];

  // Telefon rehberinden seçme (Android Chrome); ad ve numarayı doldurur.
  if (canPickContact()) {
    fields.unshift(h("button", {
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

  // Tedarikçiyle hangi parayla çalışıldığı: borç o parada tutulur.
  let currency = null;
  if (kind === "supplier") {
    const locked = Boolean(party?.balance);
    currency = select(CURRENCIES.map((c) => [c, t(CURRENCY_NAMES[c])]), party?.currency ?? "TRY", { disabled: locked });
    fields.push(field(t("currency"), currency, locked ? t("currencyLocked") : t("currencyHint")));
  }

  let amount;
  let direction;
  if (!party) {
    amount = numberInput({ placeholder: "0,00" });
    // Bakiye işareti: satıcıda + bize borçlu, tedarikçide + biz borçluyuz.
    const options = kind === "seller"
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
      onclick: () => {
        if (!confirm(t("confirmDelete", { name: party.name }))) return;
        saved(deleteParty(party.id), t("deleted", { name: party.name }));
      },
    }, t("delete")));
    if (busy) buttons.push(h("small", { class: "field-hint center" }, t("cantDeleteParty")));
  }
  buttons.push(closeButton());

  const title = party ? t("editParty") : t(kind === "seller" ? "newSeller" : "newSupplier");
  open(title, fields, buttons, () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    let opening = 0;
    if (!party && amount.value.trim()) {
      const a = parseMoney(amount.value);
      if (a == null) return t("badNumber");
      opening = a * Number(direction.value);
    }
    const data = { kind, name: n, phone: phone.value.trim(), note: note.value.trim() };
    if (currency) data.currency = currency.value;
    saved(saveParty(party?.id, data, opening), t("saved"));
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
  let currency = "TRY";
  return {
    el: wrap,
    get currency() { return currency; },
    set(next) {
      currency = next;
      wrap.hidden = next === "TRY";
      if (next === "TRY") {
        onchange();
        return;
      }
      label.textContent = t("rateLabel", { c: currencySymbol(next) });
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
    value: () => (currency === "TRY" ? 1 : parseRate(input.value)),
  };
}

// --- Alış / satış / emanet (ürün satırlı) ve ödeme / tahsilat ----------------------------

// Formda bir ürün satırı: ürün, miktar, birim fiyat.
function lineRow(ctx, products, onchange, onremove) {
  const product = select([["", t("chooseProduct")], ...products.map((p) => [p.id, p.name])], "");
  const qty = numberInput({ placeholder: t("qty"), "aria-label": t("qty"), oninput: onchange });
  const price = numberInput({ placeholder: t("price"), "aria-label": t("unitPrice"), oninput: onchange });
  const unit = h("span", { class: "unit" });
  const total = h("strong", { class: "line-total" });
  const hint = h("small", { class: "field-hint" });

  product.addEventListener("change", () => {
    const p = session.firm.products.get(product.value);
    unit.textContent = p ? unitLabel(p.unit) : "";
    price.value = p ? moneyInput(ctx.suggestPrice(p)) : "";
    hint.textContent = p ? t("inStockShort", { n: formatNumber(p.stock), unit: unitLabel(p.unit) }) : "";
    onchange();
    if (p) qty.focus();
  });

  const row = {
    el: h("div", { class: "line" },
      h("div", { class: "line-top" }, product, iconButton("x", t("remove"), () => onremove(row))),
      h("div", { class: "line-nums" },
        h("span", { class: "qty" }, qty, unit), h("span", { class: "times" }, "×"), price, total),
      hint),
    total() {
      const q = parseQty(qty.value);
      const p = parseMoney(price.value);
      return q && p != null ? lineTotal({ qty: q, price: p }) : 0;
    },
    refresh() {
      total.textContent = formatMoney(row.total(), ctx.currency());
    },
    // Satır boşsa null, hatalıysa hata metni, doğruysa { product, qty, price }.
    read() {
      if (!product.value && !qty.value.trim()) return null;
      if (!product.value) return t("chooseProduct");
      const q = parseQty(qty.value);
      if (!q) return t("badQty");
      const p = price.value.trim() ? parseMoney(price.value) : null;
      if (p == null) return t("enterPrice");
      return { product: product.value, qty: q, price: p };
    },
    productId: () => product.value,
    // Barkod okutulunca: ürünü seçer ya da aynı ürünse miktarı 1 artırır.
    scanned(id) {
      if (product.value !== id) {
        product.value = id;
        product.dispatchEvent(new Event("change"));
        qty.value = "1";
      } else {
        qty.value = qtyInput(roundQty((parseQty(qty.value) ?? 0) + 1));
      }
      onchange();
    },
  };
  row.refresh();
  return row;
}

// Depodakinden fazla çıkan ürünler: "Çay: depoda 4 koli, istenen 6 koli"
function shortages(lines) {
  const wanted = new Map();
  for (const l of lines) wanted.set(l.product, roundQty((wanted.get(l.product) ?? 0) + l.qty));
  const out = [];
  for (const [id, qty] of wanted) {
    const p = session.firm.products.get(id);
    if (p && qty > p.stock) {
      out.push(t("shortLine", { name: p.name, stock: formatNumber(p.stock), qty: formatNumber(qty), unit: unitLabel(p.unit) }));
    }
  }
  return out;
}

const PAID_NOW = { sale: "collection", purchase: "payment" };

export function openMoveSheet(type, { party: fixedParty } = {}) {
  const kind = PARTY_KIND[type];
  const title = t(`new_${type}`);
  const parties = [...session.firm.parties.values()].filter((p) => p.kind === kind).sort(byName);
  const products = [...session.firm.products.values()].sort(byName);
  if (!parties.length) {
    return missing(title, t(kind === "seller" ? "needSeller" : "needSupplier"),
      `+ ${t(kind === "seller" ? "newSeller" : "newSupplier")}`, () => openPartySheet(kind));
  }
  if (hasLines(type) && !products.length) {
    return missing(title, t("needProduct"), `+ ${t("newProduct")}`, () => openProductSheet());
  }

  const partySelect = select([["", t("choose")], ...parties.map((p) => [p.id, p.name])], fixedParty ?? "");
  const date = dateInput();
  const note = textInput({ maxlength: 200, placeholder: t("notePlaceholder") });
  const total = h("strong", {});
  const totalTry = h("small", { class: "field-hint" });
  const party = () => session.firm.parties.get(partySelect.value);
  const currency = () => (kind === "supplier" ? party()?.currency || "TRY" : "TRY");
  const rate = rateField(() => refresh());
  const fields = [h("div", { class: "row2" }, field(t(kind), partySelect), field(t("date"), date)), rate.el];

  let rows = [];
  let amount;
  let paidNow;
  let holder;
  const symbolEls = [];
  const symbol = () => {
    const el = h("span", { class: "cur" });
    symbolEls.push(el);
    return el;
  };

  const refresh = () => {
    for (const el of symbolEls) el.textContent = currency() === "TRY" ? "" : ` (${currencySymbol(currency())})`;
    for (const r of rows) r.refresh();
    const value = hasLines(type) ? sum(rows, (r) => r.total()) : parseMoney(amount.value) ?? 0;
    total.textContent = formatMoney(value, currency());
    const r = rate.value();
    totalTry.textContent = currency() !== "TRY" && r ? t("inLira", { amount: formatMoney(Math.round(value * r)) }) : "";
  };

  if (hasLines(type)) {
    const list = h("div", { class: "lines" });
    const ctx = {
      currency,
      // Satışta ürünün satış fiyatı, emanette o satıcıya son verilen fiyat, alışta son alış fiyatı.
      suggestPrice(p) {
        if (type === "sale") return p.price;
        if (type === "consign") return party()?.shelf?.[p.id]?.price || p.price;
        const r = rate.value();
        return currency() === "TRY" ? p.lastCost : r ? Math.round(p.lastCost / r) : 0;
      },
    };
    const addLine = () => {
      const row = lineRow(ctx, products, refresh, (r) => {
        rows = rows.filter((x) => x !== r);
        r.el.remove();
        if (!rows.length) addLine();
        refresh();
      });
      rows.push(row);
      list.append(row.el);
    };
    addLine();
    // Barkod okutunca ürün satıra gelir; aynı ürün tekrar okutulursa miktarı artar.
    const scanLine = async () => {
      const code = await scanBarcode();
      if (!code) return;
      const p = productByBarcode(code);
      if (!p) return toast(t("barcodeUnknown", { code }));
      const row = rows.find((r) => r.productId() === p.id) ?? rows.find((r) => !r.productId());
      if (row) row.scanned(p.id);
      else {
        addLine();
        rows.at(-1).scanned(p.id);
      }
      return refresh();
    };
    fields.push(
      h("p", { class: "label" }, t("products"), symbol()), list,
      h("div", { class: "line-actions" },
        h("button", { type: "button", class: "small add-line", onclick: () => { addLine(); refresh(); } }, "+ ", t("addLine")),
        canScan() && h("button", { type: "button", class: "small add-line", onclick: scanLine }, icon("barcode"), t("scanBarcode"))));
    if (type === "consign") fields.push(h("small", { class: "field-hint" }, t("consignHint")));
    if (PAID_NOW[type]) {
      paidNow = numberInput({ placeholder: "0,00" });
      fields.push(h("label", { class: "field" },
        h("span", {}, t(type === "sale" ? "paidNowSale" : "paidNowPurchase"), symbol()), paidNow,
        h("small", { class: "field-hint" }, t("paidNowHint"))));
    }
  } else {
    amount = numberInput({ placeholder: "0,00", oninput: refresh });
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
    holder = partnerField(t(type === "sale" || type === "collection" ? "holderIn" : "holderOut"));
    fields.push(holder.field);
  }
  fields.push(field(t("note"), note), h("div", { class: "total" }, h("span", {}, t("total")), h("span", { class: "total-values" }, total, totalTry)));

  partySelect.addEventListener("change", () => rate.set(currency()));
  rate.set(currency());

  open(title, fields, [saveButton(), closeButton()], () => {
    const p = party();
    if (!p) return t(kind === "seller" ? "chooseSeller" : "chooseSupplier");
    if (!date.value) return t("chooseDate");
    const input = { type, party: p.id, date: date.value, note: note.value.trim(), holder: holder?.el.value };
    const cur = currency();
    if (cur !== "TRY") {
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
      if (type === "sale" || type === "consign") {
        const short = shortages(lines);
        if (short.length && !confirm(t("confirmShort", { list: short.join("\n") }))) return undefined;
      }
      if (paidNow?.value.trim()) {
        const paid = parseMoney(paidNow.value);
        if (!paid) return t("badNumber");
        extra.push({ ...input, lines: undefined, type: PAID_NOW[type], note: t("paidNowNote"), amount: paid });
      }
    } else {
      const a = parseMoney(amount.value);
      if (!a) return t("enterAmount");
      input.amount = a;
    }
    record([input, ...extra].map(({ lines, ...rest }) => (lines ? { ...rest, lines } : rest)));
    return undefined;
  });
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
  let items = [];

  const refresh = () => {
    for (const it of items) it.refresh();
    total.textContent = formatMoney(sum(items, (it) => it.total()));
  };

  const build = () => {
    const party = session.firm.parties.get(partySelect.value);
    items = Object.entries(party?.shelf ?? {})
      .filter(([, s]) => s.stock > 0)
      .map(([id, s]) => shelfItem(id, s, count, refresh));
    list.replaceChildren(...(items.length ? items.map((it) => it.el) : [h("p", { class: "muted center" }, t("chooseSeller"))]));
    refresh();
  };
  partySelect.addEventListener("change", build);

  const fields = [
    h("div", { class: "row2" }, field(t("seller"), partySelect), field(t("date"), date)),
    h("small", { class: "field-hint" }, t(count ? "countHint" : "returnHint")),
    list,
  ];
  let paidNow;
  let holder;
  if (count) {
    paidNow = numberInput({ placeholder: "0,00" });
    holder = partnerField(t("holderIn"));
    fields.push(field(t("paidNowSale"), paidNow, t("paidNowHint")), holder.field);
  }
  fields.push(h("div", { class: "total" }, h("span", {}, t(count ? "soldTotal" : "returnTotal")), total));
  build();

  open(title, fields, [saveButton(), closeButton()], () => {
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

// Raftaki bir ürün. Sayımda "kalan" yazılır, satılan hesaplanır; iadede iade edilen miktar yazılır.
function shelfItem(id, shelf, count, onchange) {
  const p = session.firm.products.get(id);
  const unit = unitLabel(p?.unit);
  const input = numberInput({ placeholder: count ? t("remaining") : "0", "aria-label": count ? t("remaining") : t("returnQty"), oninput: onchange });
  const price = numberInput({ value: moneyInput(shelf.price), "aria-label": t("unitPrice"), oninput: onchange });
  const result = h("span", { class: "shelf-result" });
  // Sayımda satılan = raftaki − kalan; iadede yazılan miktar.
  const qty = () => {
    const v = parseQty(input.value);
    if (v == null) return null;
    return count ? roundQty(shelf.stock - v) : v;
  };
  const item = {
    el: h("div", { class: "line" },
      h("div", { class: "shelf-top" },
        h("span", { class: "title" }, h("bdi", {}, p?.name ?? "?")),
        h("span", { class: "meta" }, t("onShelfQty", { n: formatNumber(shelf.stock), unit }))),
      h("div", { class: "shelf-nums" },
        field(count ? t("remaining") : t("returnQty"), input),
        count
          ? field(t("unitPrice"), price)
          : h("button", { type: "button", class: "small all", onclick: () => { input.value = qtyInput(shelf.stock); onchange(); } }, t("returnAll"))),
      result),
    total() {
      const q = qty();
      const pr = count ? parseMoney(price.value) : shelf.price;
      return q > 0 && pr != null ? lineTotal({ qty: q, price: pr }) : 0;
    },
    refresh() {
      const q = qty();
      if (!input.value.trim() || q == null) result.textContent = "";
      else if (count) result.textContent = q > 0 ? t("soldLine", { n: formatNumber(q), unit, amount: formatMoney(item.total()) }) : t("noneSold");
      else result.textContent = q > 0 ? t("returnLine", { n: formatNumber(q), unit }) : "";
      result.classList.toggle("bad", q != null && (q < 0 || q > shelf.stock));
    },
    read() {
      if (!input.value.trim()) return null;
      const q = qty();
      if (q == null || q < 0 || q > shelf.stock) return t(count ? "badRemaining" : "badReturn", { name: p?.name ?? "?" });
      if (q === 0) return null;
      const pr = count ? parseMoney(price.value) : shelf.price;
      if (pr == null) return t("enterPrice");
      return { product: id, qty: q, price: pr };
    },
  };
  return item;
}

// --- Kasa işlemleri: gider, para koyma/çekme, devir ------------------------------------

export function openCashSheet(type) {
  const firm = currentFirm();
  if (type === "transfer" && firm.members.length < 2) return;
  const amount = numberInput({ placeholder: "0,00" });
  const date = dateInput();
  const note = textInput({ maxlength: 200, placeholder: t(type === "expense" ? "expensePlaceholder" : "notePlaceholder") });
  const fields = [h("div", { class: "row2" }, field(t("amount"), amount), field(t("date"), date))];
  const capitalMove = type === "capitalIn" || type === "withdraw";

  // Para koyma/çekmede önce kimin parası olduğu seçilir (uygulamasız ortak da olabilir);
  // uygulamasız ortağın parasını eline alan/veren uygulamadaki ortak ayrıca seçilir.
  let owner;
  const holder = partnerField(t(capitalMove ? `handler_${type}` : `holder_${type}`));
  if (capitalMove) {
    const all = partners(firm);
    owner = select(all.map((p) => [p.uid, p.uid === session.uid ? `${p.name} (${t("you")})` : p.name]), session.uid);
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
      const keep = others.includes(to.value) ? to.value : others[0];
      to.replaceChildren(...others.map((uid) => h("option", { value: uid, selected: uid === keep }, person(firm, uid).name)));
    };
    holder.el.addEventListener("change", fillTo);
    fillTo();
    fields.push(field(t("holder_transfer"), holder.el), field(t("transferTo"), to));
  } else if (!capitalMove) {
    fields.push(holder.field);
  }

  // Gider bir ürün ortaklığına ait olabilir; o zaman o ortaklığın kârından düşer.
  let deal;
  const deals = Object.entries(firm.deals ?? {});
  if (type === "expense" && deals.length) {
    deal = select([["", t("generalShares")], ...deals.map(([id, d]) => [id, d.name])], "");
    fields.push(field(t("expenseDeal"), deal));
  }
  fields.push(field(t(type === "expense" ? "expenseFor" : "note"), note), h("small", { class: "field-hint" }, t(`hint_${type}`)));

  open(t(`new_${type}`), fields, [saveButton(), closeButton()], () => {
    const a = parseMoney(amount.value);
    if (!a) return t("enterAmount");
    if (type === "expense" && !note.value.trim()) return t("enterExpenseFor");
    const input = { type, party: "", date: date.value, note: note.value.trim(), amount: a, holder: holder.el.value };
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
    record([input]);
    return undefined;
  });
  amount.focus();
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
    }, h("bdi", {}, p.name), other && h("small", {}, ` · ${other.name}`));
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
      onclick: () => {
        if (!confirm(t("confirmDeleteDeal", { name: deal.name }))) return;
        saved(deleteDeal(dealId), t("deleted", { name: deal.name }));
      },
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
export function openGuestAddSheet() {
  const name = textInput({ maxlength: 40, placeholder: t("guestNamePlaceholder") });
  open(t("addGuest"), [field(t("name"), name), h("small", { class: "field-hint" }, t("guestHint"))], [saveButton(), closeButton()], () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    saved(saveGuest(null, n).done, t("saved"));
    return undefined;
  });
  name.focus();
}

// Uygulamasız ortağın adını değiştirme / silme.
export function openGuestSheet(guestId) {
  const firm = currentFirm();
  const guest = firm.guests?.[guestId];
  if (!guest) return;
  const name = textInput({ maxlength: 40, value: guest.name });
  const inDeal = Object.values(firm.deals ?? {}).some((d) => d.shares?.[guestId]) || firm.shares?.[guestId];
  const acc = session.firm.accounts.get(guestId);
  const busy = Boolean(inDeal || acc?.capital);
  open(t("guestPartner"), [
    field(t("name"), name),
    h("small", { class: "field-hint" }, t("guestHint")),
  ], [
    saveButton(),
    h("button", {
      type: "button", class: "block danger", disabled: busy,
      onclick: () => {
        if (!confirm(t("confirmDelete", { name: guest.name }))) return;
        saved(deleteGuest(guestId), t("deleted", { name: guest.name }));
      },
    }, t("delete")),
    busy && h("small", { class: "field-hint center" }, t("cantDeleteGuest")),
    closeButton(),
  ], () => {
    const n = name.value.trim();
    if (!n) return t("enterName");
    saved(saveGuest(guestId, n).done, t("saved"));
    return undefined;
  });
}

// --- Hareket ayrıntısı ve iptal -------------------------------------------------

export function openMoveDetail(move) {
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
    cur && fact(t("rate"), `1 ${cur} = ₺${formatRate(move.rate)}`),
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
  if (cur) totals.push(fact(t("inLiraShort"), formatMoney(Math.round(move.total * move.rate))));
  if (move.type === "sale" || move.type === "consignSale") {
    const cost = sum(move.lines, (l) => l.cost ?? 0);
    totals.push(fact(t("cost"), formatMoney(cost)), fact(t("grossProfit"), formatMoney(move.total - cost)));
  }
  fields.push(h("div", { class: "facts" }, totals));
  if (move.note && move.type !== "expense") fields.push(h("p", { class: "note" }, h("bdi", {}, move.note)));
  if (move.type === "expense") fields.unshift(h("p", { class: "note" }, h("bdi", {}, move.note)));

  const title = t(`type_${move.type}`);
  if (move.voided) {
    fields.push(h("p", { class: "voided-note" },
      t("voidedBy", { name: person(firm, move.voided.by).name, reason: move.voided.reason })));
    return open(title, fields, [closeButton()]);
  }
  const reason = textInput({ maxlength: 200, placeholder: t("voidReasonPlaceholder") });
  fields.push(field(t("voidReason"), reason, t("voidHint")));
  open(title, fields, [h("button", { class: "block danger" }, t("voidMove")), closeButton()], () => {
    const r = reason.value.trim();
    if (!r) return t("enterVoidReason");
    if (!confirm(t("confirmVoid"))) return undefined;
    saved(voidMoves([move], r), t("moveVoided"));
    return undefined;
  });
}
