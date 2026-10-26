// Faturadan alış: tedarikçinin faturası (e-Fatura XML, PDF ya da fotoğraf) seçilir, okunur ve
// bir onay ekranında ürün eşleşmeleri gösterilir. Kullanıcı onaylamadan hiçbir şey kaydedilmez.
// XML yapay zekâsız ve kesin okunur; PDF/fotoğraf için işletmenin Gemini anahtarı gerekir.

import { $, h, icon, iconButton, toast, today } from "./ui.js";
import { t, UNITS, unitLabel } from "./i18n.js";
import { session, currentFirm } from "./session.js";
import { parseMoney, parseQty, formatMoney, moneyInput, qtyInput } from "./money.js";
import { lineTotal } from "./ledger.js";
import { recordMoves, voidMoves, productLabel } from "./data.js";
import { byName, productCategories } from "./views.js";
import { readInvoiceFile, matchProduct, matchSupplier } from "./invoice.js";
import { rememberRate } from "./rates.js";
import { sharedAiReady, readInvoiceShared } from "./ai.js";
import {
  openSheet, field, textInput, numberInput, select, saveButton, closeButton, failed, rateField, openAiSheet,
} from "./forms.js";

const NEW = "__new";
const ACCEPT = ".xml,text/xml,application/xml,application/pdf,image/*";

// Dosya seçtirir (telefonda kamera da çıkar). Vazgeçilirse null.
function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

const isXml = (file) => /xml/.test(file.type) || /\.xml$/i.test(file.name);

export function openInvoiceImport() {
  const firm = currentFirm();
  const hasKey = Boolean(firm.ai?.key) || sharedAiReady(); // kendi anahtarı ya da ortak (anahtarsız) yol
  openSheet(t("page_invoice"), [
    h("p", { class: "muted" }, t("invoiceIntro")),
    h("button", { type: "button", class: "big-action primary", onclick: () => choose() }, icon("fileScan"), h("span", {}, t("chooseInvoice"))),
    h("small", { class: "field-hint" }, t(hasKey ? "invoiceKinds" : "invoiceKindsNoKey")),
    !hasKey && h("button", { type: "button", class: "block", onclick: () => openAiSheet() }, t("aiSetup")),
  ], [closeButton()]);
}

async function choose() {
  const file = await pickFile();
  if (!file) return;
  const firm = currentFirm();
  if (!isXml(file) && !firm.ai?.key && !sharedAiReady()) {
    openSheet(t("page_invoice"), [h("p", { class: "muted center" }, t("aiNeeded"))], [
      h("button", { type: "button", class: "primary block", onclick: () => openAiSheet() }, t("aiSetup")), closeButton(),
    ]);
    return;
  }
  openSheet(t("page_invoice"), [
    h("div", { class: "reading" }, h("span", { class: "spinner" }), h("strong", {}, t("readingInvoice")), h("small", { class: "muted" }, file.name)),
  ], [closeButton()]);
  try {
    const invoice = await readInvoiceFile(file, { apiKey: firm.ai?.key, reader: readInvoiceShared });
    if (!$("#sheet").open) return; // vazgeçildi
    if (!invoice.lines.length) throw Object.assign(new Error("empty"), { code: "ai-unreadable" });
    review(invoice);
  } catch (err) {
    console.error(err);
    openSheet(t("page_invoice"), [h("p", { class: "error" }, t(`err_${(err.code ?? "ai-failed").replace(/-/g, "_")}`))], [
      h("button", { type: "button", class: "primary block", onclick: () => choose() }, t("tryAgain")), closeButton(),
    ]);
  }
}

// Onay ekranı (okunmuş bir faturayla doğrudan da açılabilir).
export function review(invoice) {
  const firm = currentFirm();
  const suppliers = [...session.firm.parties.values()].filter((p) => p.kind === "supplier").sort(byName);
  const products = [...session.firm.products.values()].sort(byName);
  const matchedSupplier = matchSupplier(invoice.supplier, suppliers);
  const supplier = select([
    ...(invoice.supplier.name && !matchedSupplier ? [[NEW, t("newSupplierNamed", { name: invoice.supplier.name })]] : []),
    ["", t("choose")],
    ...suppliers.map((p) => [p.id, p.name]),
  ], matchedSupplier ?? (invoice.supplier.name ? NEW : ""));
  const date = h("input", { type: "date", value: invoice.date || today() });
  const invoiceNo = textInput({ maxlength: 40, value: invoice.number, dir: "ltr" });
  const withVat = h("input", { type: "checkbox" });
  const total = h("strong", {});
  const currency = invoice.currency || "TRY";
  const rate = rateField(() => refresh());

  let rows = [];
  const refresh = () => {
    for (const r of rows) r.refresh(withVat.checked);
    total.textContent = formatMoney(rows.reduce((s, r) => s + r.total(), 0), currency);
  };
  rows = invoice.lines.map((line) => lineRow(line, products, refresh));
  withVat.addEventListener("change", () => {
    for (const r of rows) r.applyVat(withVat.checked);
    refresh();
  });

  const fields = [
    h("div", { class: "invoice-head card" },
      h("strong", {}, h("bdi", {}, invoice.supplier.name || t("unknownSupplier"))),
      h("small", { class: "muted" }, [invoice.supplier.taxNo && `${t("taxNo")}: ${invoice.supplier.taxNo}`, invoice.number, invoice.source === "ai" ? t("readByAi") : t("readFromXml")].filter(Boolean).join(" · "))),
    field(t("supplier"), supplier),
    h("div", { class: "row2" }, field(t("date"), date), field(t("invoiceNo"), invoiceNo)),
    rate.el,
    h("label", { class: "check" }, withVat, h("span", {}, t("costWithVat"))),
    h("small", { class: "field-hint" }, t("costWithVatHint")),
    h("p", { class: "label" }, t("invoiceLines", { n: rows.length })),
    h("div", { class: "lines" }, rows.map((r) => r.el)),
    invoice.source === "ai" && h("small", { class: "field-hint" }, t("aiCheck")),
    h("div", { class: "total" }, h("span", {}, t("total")), total),
  ];
  rate.set(currency);
  refresh();

  openSheet(t("reviewInvoice"), fields, [saveButton(t("savePurchase")), closeButton()], () => {
    if (!supplier.value) return t("chooseSupplier");
    if (rows.length > 100) return t("tooManyLines");
    const existing = session.firm.parties.get(supplier.value);
    const supplierCurrency = existing ? existing.currency || "TRY" : currency;
    if (supplierCurrency !== currency) return t("currencyMismatch", { a: currency, b: supplierCurrency });
    const newProducts = {};
    const lines = [];
    for (const [i, r] of rows.entries()) {
      const line = r.read();
      if (typeof line === "string") return line;
      if (!line) continue;
      if (line.product === NEW) {
        const tempId = `new${i}`;
        newProducts[tempId] = r.newProduct(firm);
        line.product = tempId;
      }
      lines.push(line);
    }
    if (!lines.length) return t("addAtLeastOne");
    const input = {
      type: "purchase", party: supplier.value === NEW ? "__supplier" : supplier.value, date: date.value || today(),
      note: t("fromInvoice"), invoiceNo: invoiceNo.value.trim(), lines,
    };
    if (currency !== "TRY") {
      const r = rate.value();
      if (!r) return t("enterRate");
      Object.assign(input, { currency, rate: r });
      rememberRate(currency, r);
    }
    const newParty = supplier.value === NEW ? {
      tempId: "__supplier",
      data: {
        kind: "supplier", name: invoice.supplier.name.slice(0, 80), phone: invoice.supplier.phone.slice(0, 24),
        taxNo: invoice.supplier.taxNo.slice(0, 20), taxOffice: invoice.supplier.taxOffice.slice(0, 60),
        address: invoice.supplier.address.slice(0, 300), note: "", currency,
      },
    } : null;
    const { moves, done } = recordMoves([input], { newProducts, newParty });
    done.catch(failed);
    $("#sheet").close();
    toast(t("purchaseSaved", { n: lines.length }), () => voidMoves(moves, t("undoReason")).then(() => toast(t("undone")), failed));
    return undefined;
  });
}

// Faturanın bir satırı: hangi ürüne gideceği (eşleşen, başka bir ürün ya da yeni ürün), miktar, fiyat.
function lineRow(line, products, onchange) {
  const match = matchProduct(line, products.map((p) => ({ id: p.id, name: p.name, variant: p.variant, barcode: p.barcode })));
  const product = select([
    [NEW, t("addAsNewProduct")],
    ...products.map((p) => [p.id, productLabel(p)]),
    ["", t("skipLine")],
  ], match?.id ?? NEW);
  const qty = numberInput({ value: qtyInput(line.qty), "aria-label": t("qty"), oninput: onchange });
  const net = line.unitPrice;
  const gross = Math.round(net * (1 + (line.vatRate ?? 0) / 100));
  const price = numberInput({ value: moneyInput(net), "aria-label": t("unitPrice"), oninput: onchange });
  const sum = h("strong", { class: "line-total" });
  const unit = select(UNITS.map((u) => [u, unitLabel(u)]), UNITS.includes(line.unit) ? line.unit : "adet");
  // Yeni ürün: faturada okunan ad düzeltilebilir; kategori (var olanlardan seçilir ya da yazılır) ve
  // satış fiyatı da hemen verilebilir.
  const name = textInput({ maxlength: 80, value: line.name.slice(0, 80), "aria-label": t("productName") });
  const listId = `cats-${Math.random().toString(36).slice(2, 8)}`;
  const category = textInput({ maxlength: 40, list: listId, placeholder: t("categoryOptional") });
  const salePrice = numberInput({ placeholder: "0,00", "aria-label": t("salePrice") });
  const newOnly = h("div", { class: "new-product" },
    field(t("productName"), name, t("nameFixHint")),
    h("div", { class: "row2" }, field(t("category"), category), field(t("unit"), unit)),
    field(t("salePrice"), salePrice),
    h("datalist", { id: listId }, productCategories([...session.firm.products.values()]).map(([c]) => h("option", { value: c }))));
  const status = h("small", { class: "field-hint" });
  const sync = () => {
    newOnly.hidden = product.value !== NEW;
    status.textContent = product.value === NEW ? t("willCreateProduct")
      : product.value === "" ? t("lineSkipped")
        : match?.id === product.value ? t("matchedAuto") : "";
    onchange();
  };
  product.addEventListener("change", sync);

  const row = {
    el: h("div", { class: "line invoice-line" },
      h("bdi", { class: "invoice-name" }, line.name),
      line.code && h("small", { class: "muted", dir: "ltr" }, line.code),
      product,
      h("div", { class: "line-nums" },
        h("span", { class: "qty" }, qty), h("span", { class: "times" }, "×"), price, sum),
      line.vatRate != null && h("small", { class: "field-hint" }, t("vatPct", { pct: line.vatRate })),
      newOnly,
      status),
    total() {
      const q = parseQty(qty.value);
      const p = parseMoney(price.value);
      return product.value !== "" && q && p != null ? lineTotal({ qty: q, price: p }) : 0;
    },
    refresh() {
      sum.textContent = formatMoney(row.total());
    },
    applyVat(on) {
      price.value = moneyInput(on ? gross : net);
    },
    read() {
      if (product.value === "") return null;
      if (product.value === NEW && !name.value.trim()) return t("enterName");
      const q = parseQty(qty.value);
      if (!q) return t("badQty");
      const p = parseMoney(price.value);
      if (p == null) return t("enterPrice");
      return { product: product.value, qty: q, price: p };
    },
    newProduct(firm) {
      const barcode = /^\d{8,14}$/.test(line.code ?? "") ? line.code : "";
      return {
        name: name.value.trim().slice(0, 80), category: category.value.trim(), unit: unit.value, price: parseMoney(salePrice.value) ?? 0,
        barcode, vat: line.vatRate ?? firm.defaultVat ?? 20, minStock: 0,
      };
    },
  };
  sync();
  return row;
}
