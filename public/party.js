// Bir satıcının ya da tedarikçinin hesabı: bakiye, emanetteki mal, işlemler ve hareket ekstresi.

import {
  collection, query, where, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { $, h, icon, toast } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { session } from "./session.js";
import { balanceOf } from "./ledger.js";
import { formatMoney, formatNumber } from "./money.js";
import { moveRow, balanceText, emptyState, actionButton, newestFirst } from "./views.js";
import { openMoveSheet, openMoveDetail, openPartySheet, openShelfSheet } from "./forms.js";
import { show } from "./nav.js";
import { whatsappUrl } from "./receipt.js";
import { currentFirm } from "./session.js";
import { productLabel } from "./data.js";

// WhatsApp'a gidecek hesap özeti: bakiye ve (satıcıda) emanetteki mal.
function statementText(party) {
  const plain = (s) => s.replace(/[⁦⁩]/g, "");
  const b = balanceText(party.kind, party.balance, party.currency);
  const lines = [t("statementHello", { name: party.name, firm: currentFirm().name }), `${b.label}: ${plain(b.amount)}`];
  const items = Object.entries(party.shelf ?? {}).filter(([, s]) => s.stock > 0);
  if (items.length) {
    lines.push("", `${t("onShelf")}:`);
    for (const [id, s] of items) {
      const p = session.firm.products.get(id);
      lines.push(`• ${productLabel(p) || "?"}: ${formatNumber(s.stock)} ${unitLabel(p?.unit)}`);
    }
  }
  return lines.join("\n");
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
      party.currency && party.currency !== "TRY" && h("span", { class: "badge" }, t("currencyAccount", { c: party.currency })),
      party.note && h("p", { class: "meta" }, h("bdi", {}, party.note)),
      h("div", { class: "contact-actions" },
        party.phone && h("a", { class: "pill", href: `tel:${party.phone.replace(/[^\d+]/g, "")}`, dir: "ltr" }, icon("phone"), party.phone),
        h("a", { class: "pill whatsapp", href: whatsappUrl(party.phone, statementText(party)), target: "_blank", rel: "noopener" },
          icon("whatsapp"), t("sendStatement")))),
  ];

  if (seller) {
    out.push(
      h("div", { class: "quicks two" },
        actionButton("sale", t("quick_sale"), open("sale")),
        actionButton("collection", t("quick_collection"), open("collection"))),
      h("div", { class: "quicks three" },
        actionButton("consign", t("quick_consign"), open("consign")),
        actionButton("consignSale", t("quick_count"), () => openShelfSheet("count", partyId), !hasShelf),
        actionButton("return", t("quick_return"), () => openShelfSheet("return", partyId), !hasShelf)),
      shelfCard(party));
  } else {
    out.push(h("div", { class: "quicks two" },
      actionButton("purchase", t("quick_purchase"), open("purchase")),
      actionButton("payment", t("quick_payment"), open("payment"))));
  }

  if (moves?.length) {
    // Ekstre: en yeniden geriye doğru, her hareketten sonraki bakiye.
    let running = party.balance;
    const rows = moves.map((m) => {
      const after = running;
      const row = moveRow(m, { onclick: () => openMoveDetail(m, { balanceAfter: after }), after, kind: party.kind, currency: party.currency });
      if (!m.voided) running -= balanceOf(m);
      return row;
    });
    out.push(h("h2", { class: "sec" }, t("statement")), h("ul", { class: "cards" }, rows));
  } else if (moves) {
    out.push(emptyState("📒", t("noPartyMoves")));
  }
  $("#party-view").replaceChildren(...out.filter(Boolean));
}
