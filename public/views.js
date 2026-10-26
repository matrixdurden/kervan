// Birden çok ekranda kullanılan parçalar: hareket satırı, bakiye yazısı, liste araçları.

import { h, icon, formatDay, millis } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { currentFirm, person } from "./session.js";
import { formatMoney, formatNumber } from "./money.js";

export const TYPE_ICON = {
  purchase: "in", sale: "out", payment: "coin", collection: "coin",
  consign: "send", consignSale: "clipboard", return: "undo",
  expense: "receipt", capitalIn: "plusCircle", withdraw: "minusCircle", transfer: "swap", opening: "flag",
};

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
// satıcıda + bize borçlu, tedarikçide + biz borçluyuz.
export function balanceText(kind, balance, currency = "TRY") {
  if (!balance) return { label: t("settled"), amount: formatMoney(0, currency), tone: "zero" };
  const theyOwe = kind === "seller" ? balance > 0 : balance < 0;
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
  return move.partyName || (move.lines ? linesSummary(move.lines) : t("type_opening"));
}

// Defter satırı. Kişi ekstresinde (kind verilince) başlık kişinin adı yerine hareketin türüdür;
// after o hareketten sonraki bakiyedir.
export function moveRow(move, { onclick, after, kind, currency } = {}) {
  const firm = currentFirm();
  const typeLabel = t(`type_${move.type}`);
  const title = kind ? typeLabel : moveTitle(move, firm);
  const meta = [kind ? null : typeLabel, formatDay(move.date), person(firm, move.by).name].filter(Boolean).join(" · ");
  let sub = move.lines && (kind || move.partyName) ? linesSummary(move.lines) : move.type === "expense" ? "" : move.note;
  if (move.currency) sub = [sub, `1 ${move.currency} = ₺${move.rate}`].filter(Boolean).join(" · ");
  const balance = after != null && !move.voided ? balanceText(kind, after, currency) : null;
  return h("li", {},
    h("button", { type: "button", class: `card row move ${move.type}${move.voided ? " voided" : ""}`, onclick },
      h("span", { class: "move-icon" }, icon(TYPE_ICON[move.type])),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, title)),
        h("span", { class: "meta" }, meta),
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
