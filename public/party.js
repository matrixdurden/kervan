// Bir satıcının ya da tedarikçinin hesabı: bakiye, emanetteki mal, işlemler ve hareket ekstresi.

import {
  collection, query, where, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, toast } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { session } from "./session.js";
import { balanceOf } from "./ledger.js";
import { formatMoney, formatNumber, base, currencySymbol } from "./money.js";
import { moveRow, balanceText, emptyState, actionButton, newestFirst, linesSummary, TYPE_ICON } from "./views.js";
import { openMoveSheet, openMoveDetail, openPartySheet, openShelfSheet, receiptLabels, receiptFirm, openSheet, closeButton, sendPhoto, pastePhoto, directPhoto, photoHint } from "./forms.js";
import { show } from "./nav.js";
import { receiptBlob, printReceipt } from "./receipt.js";
import { currentFirm } from "./session.js";
import { productLabel, clearPartyPrice } from "./data.js";
import { today } from "./ui.js";

const STATEMENT_ROWS = 60; // ekstre resmine en son bu kadar hareket; öncesi "önceki bakiye" olur

// Hesap ekstresi belgesi: hareketler eskiden yeniye, her birinin tutarı ve sonraki bakiye.
function statementDoc(party) {
  const firm = currentFirm();
  const list = (moves ?? []).filter((m) => !m.voided);
  const recent = list.slice(0, STATEMENT_ROWS); // en yeniden geriye
  let running = party.balance;
  const rows = recent.map((m) => {
    const after = running;
    const fx = balanceOf(m);
    running -= fx;
    const detail = m.lines ? linesSummary(m.lines, 2) : m.currency ? `1 ${m.currency} = ${currencySymbol(base())}${m.rate}` : m.note || "";
    return { date: m.date, label: t(`type_${m.type}`), detail, amount: m.total, sign: fx > 0 ? "+" : fx < 0 ? "−" : "", balance: after };
  }).reverse();
  const shelf = Object.entries(party.shelf ?? {}).filter(([, s]) => s.stock > 0).map(([id, s]) => {
    const p = session.firm.products.get(id);
    return { name: productLabel(p) || "?", qty: `${formatNumber(s.stock)} ${unitLabel(p?.unit)}` };
  });
  const truncated = list.length > recent.length || (moves?.length ?? 0) >= 200;
  return {
    kind: "statement",
    date: today(),
    time: new Date().toTimeString().slice(0, 5),
    currency: party.currency || base(),
    firm: receiptFirm(firm),
    party: { name: party.name, phone: party.phone ?? "" },
    previous: truncated || running ? running : null,
    rows,
    balance: party.balance,
    balanceLabel: balanceText(party.kind, party.balance, party.currency).label,
    shelf,
  };
}

// Ekstre resmi hareketler değiştikçe arka planda hazırlanır ki paylaş dokunuşu kaybolmasın (Safari).
let statement = { key: "", blob: null, doc: null };
function prepareStatement(party) {
  const key = `${party.id}|${party.balance}|${moves?.length ?? -1}|${moves?.[0]?.id ?? ""}|${moves?.filter((m) => m.voided).length ?? 0}`;
  if (statement.key === key) return;
  const doc = statementDoc(party);
  statement = { key, blob: null, doc };
  receiptBlob(doc, receiptLabels()).then((b) => { if (statement.key === key) statement.blob = b; }).catch((err) => console.error(err));
}

// Cari detayının resmi (hazırsa hemen, değilse çizilerek).
function statementBlob(party) {
  prepareStatement(party);
  return statement.blob ? Promise.resolve(statement.blob) : receiptBlob(statement.doc, receiptLabels());
}

let partyId = null;
let unsub = null;
let moves = null;

export const currentPartyId = () => partyId;

export function openParty(id) {
  partyId = id;
  moves = null;
  history.pushState({ party: id }, "");
  show("party");
  const q = query(collection(db, "firms", session.firm.id, "moves"),
    where("party", "==", id), orderBy("at", "desc"), limit(200));
  unsub = onSnapshot(q, (snap) => {
    moves = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(newestFirst);
    render();
  }, (err) => { console.error(err); toast(t("readFailed")); });
  render();
}

export function closeParty() {
  unsub?.();
  unsub = null;
  partyId = null;
  moves = null;
}

export function refreshParty() {
  if (!partyId) return;
  if (!session.firm.parties.has(partyId)) {
    history.back(); // silindi
    return;
  }
  render();
}

$("#party-back").addEventListener("click", () => history.back());
$("#party-edit").addEventListener("click", () => {
  const party = session.firm.parties.get(partyId);
  if (party) openPartySheet(party.kind, party);
});

// Müşteriye özel fiyatlar: pazarlıkla verilen fiyatlar; her birinde "Sıfırla" (liste fiyatı geri gelir).
function pricesCard(party) {
  const items = Object.entries(party.prices ?? {})
    .map(([id, price]) => [session.firm.products.get(id), id, price])
    .filter(([p]) => p);
  if (!items.length) return null;
  return h("div", { class: "card shelf" },
    h("p", { class: "shelf-title" }, icon("tag"), h("span", {}, t("specialPrices"))),
    h("ul", { class: "line-list" }, items.map(([p, id, price]) => h("li", {},
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
        h("span", { class: "meta" }, t("listShort", { list: formatMoney(p.price ?? 0) }))),
      h("strong", {}, formatMoney(price)),
      h("button", {
        type: "button", class: "small",
        onclick: () => clearPartyPrice(party.id, id).then(() => toast(t("saved")), () => toast(t("saveFailed"))),
      }, t("resetPrice"))))),
    h("small", { class: "field-hint" }, t("specialPricesHint")));
}

// Hesap hareketlerinin üstünde türlere ayrılmış kutular (üstteki işlem düğmeleri gibi düzenli):
// her kutuda o türün kaç kaydı ve toplamı; dokununca sadece o türün hareketleri açılır.
// Tam liste altta "Hesap hareketleri"nde olduğu gibi kalır.
const TYPE_BOXES = {
  seller: [["sale", ["sale"], "type_sale"], ["collection", ["collection"], "type_collection"],
    ["saleReturn", ["saleReturn", "refund"], "type_saleReturn"], ["consign", ["consign", "consignSale", "return"], "page_consign"]],
  supplier: [["purchase", ["purchase"], "type_purchase"], ["payment", ["payment"], "type_payment"],
    ["purchaseReturn", ["purchaseReturn", "supplierRefund"], "type_purchaseReturn"]],
  person: [["debtOut", ["debtOut"], "type_debtOut"], ["debtIn", ["debtIn"], "type_debtIn"]],
};

function typeBoxes(party, moves, row) {
  const boxes = TYPE_BOXES[party.kind] ?? [];
  const live = moves.filter((m) => !m.voided);
  return h("div", { class: `type-boxes n${boxes.length}` }, boxes.map(([icon_, types, label]) => {
    const list = live.filter((m) => types.includes(m.type));
    const total = list.reduce((s, m) => s + m.total, 0);
    return h("button", {
      type: "button", class: `card type-box ${icon_}`, disabled: !list.length,
      onclick: () => openSheet(t(label), [
        h("p", { class: "total-line" }, h("span", {}, t("moveCount", { n: list.length })), h("strong", {}, formatMoney(total, party.currency || undefined))),
        h("ul", { class: "cards" }, moves.filter((m) => types.includes(m.type)).map(row)),
      ], [closeButton()]),
    },
    h("span", { class: "tb-ic" }, icon(TYPE_ICON[icon_] ?? "book")),
    h("span", { class: "tb-label" }, t(label)),
    h("strong", { class: "tb-total" }, formatMoney(total, party.currency || undefined)),
    h("small", { class: "tb-count" }, t("moveCount", { n: list.length })));
  }));
}

// Satıcının rafındaki emanet mal.
function shelfCard(party) {
  const items = Object.entries(party.shelf ?? {}).filter(([, s]) => s.stock > 0);
  if (!items.length) return null;
  const total = items.reduce((sum, [, s]) => sum + Math.round(s.stock * s.price), 0);
  return h("div", { class: "card shelf" },
    h("p", { class: "shelf-title" }, icon("send"), h("span", {}, t("onShelf")), h("strong", {}, formatMoney(total))),
    h("ul", { class: "line-list" }, items.map(([id, s]) => {
      const p = session.firm.products.get(id);
      return h("li", {},
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, productLabel(p) || "?")),
          h("span", { class: "meta" }, `${formatNumber(s.stock)} ${unitLabel(p?.unit)} × ${formatMoney(s.price)}`)),
        h("strong", {}, formatMoney(Math.round(s.stock * s.price))));
    })),
    h("small", { class: "field-hint" }, t("shelfHint")));
}

function render() {
  const party = session.firm.parties.get(partyId);
  if (!party) return;
  $("#party-title").textContent = party.name;
  const b = balanceText(party.kind, party.balance, party.currency);
  const seller = party.kind === "seller";
  const hasShelf = Object.values(party.shelf ?? {}).some((s) => s.stock > 0);
  const open = (type) => () => openMoveSheet(type, { party: partyId });

  const out = [
    h("div", { class: `card balance ${b.tone}` },
      party.thumb && h("img", { class: "thumb round lg", src: party.thumb, alt: "" }),
      h("span", { class: "tile-label" }, b.label),
      h("strong", {}, b.amount),
      party.currency && party.currency !== base() && h("span", { class: "badge" }, t("currencyAccount", { c: party.currency })),
      party.note && h("p", { class: "meta" }, h("bdi", {}, party.note)),
      h("div", { class: "contact-actions" },
        party.phone && h("a", { class: "pill", href: `tel:${party.phone.replace(/[^\d+]/g, "")}`, dir: "ltr" }, icon("phone"), party.phone)),
      // Ekstre: bütün hareketler ve bakiye; yeşil düğme fotoğraf olarak (dosya paylaşamayan cihazda
      // yazı + bağlantı), yanındaki doğrudan kişinin sohbetine yazı + bağlantı, "Yazdır" kâğıda.
      h("div", { class: "statement-actions" },
        h("button", {
          type: "button", class: "whatsapp",
          onclick: () => sendPhoto(statementBlob(party), party.phone, `cari-${party.name}.png`),
        }, icon("whatsapp"), t("sendStatement")),
        directPhoto(party.phone) && h("button", {
          type: "button", class: "small", "aria-label": t("pasteToChat"), title: t("pasteToChat"),
          onclick: () => pastePhoto(statementBlob(party), party.phone, `cari-${party.name}.png`),
        }, icon("clipboard")),
        h("button", { type: "button", class: "small", "aria-label": t("print"), title: t("print"), onclick: () => { prepareStatement(party); printReceipt(statement.doc, receiptLabels()); } },
          icon("printer"))),
      h("small", { class: "field-hint" }, photoHint())),
  ];
  if (moves) prepareStatement(party);

  if (seller) {
    out.push(
      h("div", { class: "quicks three first" },
        actionButton("sale", t("quick_sale"), open("sale")),
        actionButton("collection", t("quick_collection"), open("collection")),
        actionButton("saleReturn", t("quick_saleReturn"), open("saleReturn"))),
      h("div", { class: "quicks three" },
        actionButton("consign", t("quick_consign"), open("consign")),
        actionButton("consignSale", t("quick_count"), () => openShelfSheet("count", partyId), !hasShelf),
        actionButton("return", t("quick_return"), () => openShelfSheet("return", partyId), !hasShelf)),
      shelfCard(party),
      pricesCard(party));
  } else if (party.kind === "person") {
    // Borç defteri: kişiye para verildi / kişiden para alındı (borç ya da geri ödeme).
    out.push(h("div", { class: "quicks two" },
      actionButton("debtOut", t("quick_debtOut"), open("debtOut")),
      actionButton("debtIn", t("quick_debtIn"), open("debtIn"))),
    h("small", { class: "field-hint" }, t("debtHint")));
  } else {
    out.push(h("div", { class: "quicks three first" },
      actionButton("purchase", t("quick_purchase"), open("purchase")),
      actionButton("payment", t("quick_payment"), open("payment")),
      actionButton("purchaseReturn", t("quick_purchaseReturn"), open("purchaseReturn"))));
  }

  if (moves?.length) {
    // Ekstre: en yeniden geriye doğru, her hareketten sonraki bakiye.
    let running = party.balance;
    const afters = new Map();
    for (const m of moves) {
      afters.set(m.id, running);
      if (!m.voided) running -= balanceOf(m);
    }
    const row = (m) => moveRow(m, { onclick: () => openMoveDetail(m, { balanceAfter: afters.get(m.id) }), after: afters.get(m.id), kind: party.kind, currency: party.currency });
    out.push(typeBoxes(party, moves, row), h("h2", { class: "sec" }, t("statement")), h("ul", { class: "cards" }, moves.map(row)));
  } else if (moves) {
    out.push(emptyState("📒", t("noPartyMoves")));
  }
  $("#party-view").replaceChildren(...out.filter(Boolean));
}
