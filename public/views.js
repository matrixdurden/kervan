// Birden çok ekranda kullanılan parçalar: hareket satırı, bakiye yazısı, liste araçları.

import { h, icon, formatDay, millis } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { currentFirm, person } from "./session.js";
import { formatMoney, formatNumber, base, currencySymbol } from "./money.js";
import { avgCost } from "./ledger.js";

export const TYPE_ICON = {
  purchase: "in", sale: "out", payment: "coin", collection: "coin",
  consign: "send", consignSale: "clipboard", return: "undo", saleReturn: "undo", refund: "coin", stockCount: "clipboard", costFix: "pencil", debtOut: "out", debtIn: "in", fundMove: "swap", fundAdjust: "wallet", purchaseReturn: "undo", supplierRefund: "coin",
  expense: "receipt", capitalIn: "plusCircle", withdraw: "minusCircle", transfer: "swap", opening: "flag",
};

// Ürünün birim maliyeti: depodaki malın ortalaması (stok yoksa son alış). Yakıt ve diğer birim başı
// masraflar (ürün formundan) sadece kâr hesabı için üstüne eklenir; defterdeki stok değerine girmez.
export const unitCostOf = (p) => (p.stock > 0 ? avgCost(p) : p.lastCost || 0);
export const extraCostOf = (p) => (p.fuel || 0) + (p.extras ?? []).reduce((s, e) => s + (e.amount || 0), 0);
export const landedCost = (p) => unitCostOf(p) + extraCostOf(p);

// Fiş numarası: tarih + kayıt kimliğinin başı ("20261026-AB12"). Fişte, listede ve aramada aynıdır.
export const receiptNumber = (move) => `${move.date.replace(/-/g, "")}-${move.id.slice(0, 4).toUpperCase()}`;
export const NUMBERED = ["sale", "consignSale", "saleReturn", "collection", "payment", "refund", "debtOut", "debtIn", "purchaseReturn", "supplierRefund"];

// Hareket aramada eşleşiyor mu: kişi, not, fiş numarası, ürün adları, kasa.
// Belge adıyla arama: "fiş" yazınca satış fişleri, "fatura" yazınca satış ve alış faturaları, "makbuz" yazınca
// tahsilat/ödeme makbuzları çıkar. Kelimeler dile göre (search_words_{tür}); türün kendi adı da aranır.
const DOC_WORDS = ["sale", "saleReturn", "purchase", "purchaseReturn", "collection", "payment", "refund", "supplierRefund", "expense"];
function docWordMatch(move, s) {
  if (s.length < 3) return false;
  const lower = s.toLocaleLowerCase("tr");
  const words = [t(`type_${move.type}`), ...(DOC_WORDS.includes(move.type) ? t(`search_words_${move.type}`).split(",") : [])];
  return words.some((w) => w.trim().toLocaleLowerCase("tr").split(/\s+/).some((part) => part.startsWith(lower)));
}

export function moveMatches(move, q) {
  const s = q.trim();
  if (!s) return true;
  const squash = (x) => x.replace(/[-\s]/g, "").toLocaleUpperCase("tr");
  if (move.id && squash(receiptNumber(move)).includes(squash(s))) return true;
  if (docWordMatch(move, s)) return true;
  return [move.partyName, move.note, move.methodName, move.categoryName, ...(move.lines ?? []).map((l) => l.name)].some((x) => matches(x, s));
}

// Doğal sıra: "Ürün 2", "Ürün 10"dan önce gelir.
export const byName = (a, b) => a.name.localeCompare(b.name, "tr", { numeric: true });

// Defter sırası: en yeni üstte; aynı anda yazılanlarda (satış + peşin tahsilat) sonra yazılan üstte.
export const newestFirst = (a, b) => millis(b.at) - millis(a.at) || (b.seq ?? 0) - (a.seq ?? 0);

// Arama: Türkçe büyük/küçük harf farkı gözetmeden ("ç" = "Ç", "i" = "İ").
export const matches = (text, query) =>
  (text || "").toLocaleLowerCase("tr").includes(query.trim().toLocaleLowerCase("tr"));

export function linesSummary(lines, max = 2) {
  const parts = lines.slice(0, max).map((l) => `${l.name} ${formatNumber(l.qty)} ${unitLabel(l.unit)}`);
  if (lines.length > max) parts.push(`+${lines.length - max}`);
  return parts.join(", ");
}

// Bakiyenin ne demek olduğu, kişinin türüne göre:
// satıcıda ve borç defterindeki kişide + bize borçlu, tedarikçide + biz borçluyuz.
export function balanceText(kind, balance, currency = base()) {
  if (!balance) return { label: t("settled"), amount: formatMoney(0, currency), tone: "zero" };
  const theyOwe = kind === "seller" || kind === "person" ? balance > 0 : balance < 0;
  return {
    label: t(theyOwe ? "theyOweUs" : "weOweThem"),
    amount: formatMoney(Math.abs(balance), currency),
    tone: theyOwe ? "in" : "out",
  };
}

// Hareketin başlığı: kişi, ortak ya da ürünler.
function moveTitle(move, firm) {
  if (move.type === "transfer") return `${person(firm, move.holder).name} → ${person(firm, move.to).name}`;
  if (move.type === "capitalIn" || move.type === "withdraw") return person(firm, move.partner || move.holder).name;
  if (move.type === "expense") return move.note || t("type_expense");
  if (move.type === "fundMove") return `${move.methodName} → ${move.toMethodName}`;
  if (move.type === "fundAdjust") return move.methodName || t("type_fundAdjust");
  return move.partyName || (move.lines ? linesSummary(move.lines) : t("type_opening"));
}

// Defter satırı. Kişi ekstresinde (kind verilince) başlık kişinin adı yerine hareketin türüdür;
// after o hareketten sonraki bakiyedir.
export function moveRow(move, { onclick, after, kind, currency } = {}) {
  const firm = currentFirm();
  const typeLabel = t(`type_${move.type}`);
  const title = kind ? typeLabel : moveTitle(move, firm);
  // Üst bilgi parçaları bölünmez (fiş numarası satır sonunda ikiye ayrılmasın); sığmayan parça alt satıra geçer.
  const meta = [kind ? null : typeLabel, formatDay(move.date), person(firm, move.by).name,
    NUMBERED.includes(move.type) && move.id ? `No ${receiptNumber(move)}` : null].filter(Boolean)
    .flatMap((part, i) => [i ? " · " : null, h("span", { class: "nb" }, part)]);
  let sub = move.lines && (kind || move.partyName) ? linesSummary(move.lines) : move.type === "expense" ? "" : move.note;
  if (move.currency) sub = [sub, `1 ${move.currency} = ${currencySymbol(base())}${move.rate}`].filter(Boolean).join(" · ");
  const balance = after != null && !move.voided ? balanceText(kind, after, currency) : null;
  return h("li", {},
    h("button", { type: "button", class: `card row move ${move.type}${move.voided ? " voided" : ""}`, onclick },
      h("span", { class: "move-icon" }, icon(TYPE_ICON[move.type])),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, title)),
        h("span", { class: "meta" }, ...meta),
        sub && h("span", { class: "meta sub" }, h("bdi", {}, sub))),
      h("span", { class: "end" },
        h("span", { class: "amount" }, formatMoney(move.total, move.currency)),
        move.voided && h("span", { class: "badge warn" }, t("voided")),
        balance && h("span", { class: "after" }, `${balance.label} ${balance.amount}`))));
}

export function emptyState(emoji, text, ...actions) {
  return h("div", { class: "empty" }, h("span", { class: "big-emoji", "aria-hidden": "true" }, emoji), h("span", {}, text), ...actions);
}

// Arama kutusu; onscan verilirse kutunun içinde, sonda bir "Barkod" düğmesi olur.
export function searchBox(placeholder, value, oninput, onscan) {
  return h("div", { class: `search${onscan ? " with-scan" : ""}` }, icon("search"),
    h("input", { type: "search", placeholder, "aria-label": placeholder, value, dir: "auto", autocomplete: "off", oninput: (e) => oninput(e.target.value) }),
    onscan && h("button", { type: "button", class: "scan-in", onclick: onscan }, icon("barcode"), h("span", {}, t("barcode"))));
}

// Ürünün küçük fotoğrafı; yoksa adının baş harfi.
export function productThumb(p, size = "") {
  return p.thumb
    ? h("img", { class: `thumb ${size}`, src: p.thumb, alt: "", loading: "lazy" })
    : h("span", { class: `thumb blank ${size}`, "aria-hidden": "true" }, p.name.charAt(0).toLocaleUpperCase("tr"));
}

// Ürün kategorileri (ürünlerden toplanır; ayrı bir liste tutulmaz): [[ad, ürün sayısı], …] ada göre.
// Ürünsüz açılan kategoriler de (işletmede saklı liste) 0 ürünle listelenir.
export function productCategories(products, extra = currentFirm()?.productCats ?? []) {
  const counts = new Map(extra.map((c) => [c, 0]));
  for (const p of products) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0], "tr", { numeric: true }));
}

// Kategoriye göre süzme: "" hepsi, NO_CATEGORY kategorisizler, diğerleri kategori adı.
export const NO_CATEGORY = "\u0000";
export const inCategory = (p, cat) => !cat || (cat === NO_CATEGORY ? !p.category : p.category === cat);

// Kategori baloncukları (yatay kayar): Hepsi, her kategori sayısıyla, varsa kategorisizler.
// Hiç kategori yoksa null (gösterilmez).
export function categoryBubbles(products, value, onchange) {
  const cats = productCategories(products);
  if (!cats.length) return null;
  const loose = products.filter((p) => !p.category).length;
  const options = [["", t("filterAll"), products.length], ...cats.map(([c, n]) => [c, c, n]), ...(loose ? [[NO_CATEGORY, t("noCategory"), loose]] : [])];
  return bubbleRow(options, value, onchange, t("category"));
}

// Yatay kayan baloncuk sırası: options [[değer, etiket, sayı], …]; seçili olan koyu.
export function bubbleRow(options, value, onchange, label = "") {
  const el = h("div", { class: "bubbles", role: "group", "aria-label": label });
  const render = (current) => el.replaceChildren(...options.map(([v, text, n]) => h("button", {
    type: "button", class: "bubble", "aria-pressed": String(v === current),
    onclick: () => { render(v); onchange(v); },
  }, h("bdi", {}, text), n != null ? h("small", {}, String(n)) : null)));
  render(value);
  return el;
}

// Seçenek düğmeleri: [[değer, etiket], …]. style "tabs": sayfanın üstünde tam genişlik sekmeler.
export function segmented(options, value, onchange, style = "") {
  const el = h("div", { class: style === "tabs" ? "tabs" : "seg", role: "group" });
  const render = (current) => el.replaceChildren(...options.map(([v, label]) => h("button", {
    type: "button", "aria-pressed": String(v === current),
    onclick: () => { render(v); onchange(v); },
  }, label)));
  render(value);
  return el;
}

// Büyük işlem düğmesi (özet ve kişi ekranında).
export function actionButton(type, label, onclick, disabled = false) {
  return h("button", { type: "button", class: `quick ${type}`, onclick, disabled },
    icon(TYPE_ICON[type]), h("span", {}, label));
}
