// Oturum durumu: giriş yapan kişi, ortağı olduğu işletmeler ve açık işletmenin verisi.

import { PALETTE, store } from "./ui.js";

const emptyFirm = (id = null) => ({
  id,
  products: new Map(),
  parties: new Map(),
  accounts: new Map(), // ortak uid → { cash, capital }
  months: new Map(), // "2026-10" → { revenue, cogs, expenses }
});

export const session = {
  uid: null,
  user: null,
  firms: new Map(), // id → işletme belgesi
  firm: emptyFirm(), // açık işletme (firm.js canlı dinler)
};

export const resetFirm = (id) => { session.firm = emptyFirm(id); };
export const currentFirm = () => session.firms.get(session.firm.id);

// Görünen ad: bu cihazda seçilen ad → herhangi bir işletmedeki adın → Google adının ilk kelimesi.
export function myName() {
  const saved = store.get("name");
  if (saved) return saved;
  for (const firm of session.firms.values()) {
    const name = firm.people?.[session.uid]?.name;
    if (name) return name;
  }
  const google = session.user?.displayName || session.user?.email?.split("@")[0] || "";
  return google.split(" ")[0];
}

export function myColor() {
  for (const firm of session.firms.values()) {
    const color = firm.people?.[session.uid]?.color;
    if (color) return color;
  }
  return PALETTE[0];
}

// Bir işletmedeki kişinin (uygulamadaki ortak ya da uygulamasız ortak) adı ve rengi.
export function person(firm, uid) {
  const p = firm?.people?.[uid] ?? firm?.guests?.[uid];
  return { uid, name: p?.name || "?", color: p?.color || "#8A9A98", guest: Boolean(firm?.guests?.[uid]) };
}

export function members(firm) {
  return (firm?.members || []).map((uid) => person(firm, uid));
}

// Bütün ortaklar: önce uygulamadakiler, sonra uygulamayı kullanmayanlar.
export function partners(firm) {
  return [...members(firm), ...Object.keys(firm?.guests ?? {}).map((id) => person(firm, id))];
}

// Genel paylar girilmemişse uygulamadaki ortaklar eşit pay alır.
export function generalShares(firm) {
  const shares = firm?.shares ?? {};
  const ids = Object.keys(shares).filter((id) => shares[id] > 0);
  return ids.length ? { ids, shares } : { ids: firm?.members ?? [], shares: {} };
}

// Bir kâr kovasının ("general" ya da ortaklık id'si) kimler arasında hangi yüzdelerle bölüneceği.
// Silinmiş bir ortaklığın geçmiş kârı genel paylarla bölünür.
export function sharePlan(firm) {
  return (bucket) => {
    const deal = firm?.deals?.[bucket];
    if (!deal) return generalShares(firm);
    const ids = Object.keys(deal.shares ?? {}).filter((id) => deal.shares[id] > 0);
    return ids.length ? { ids, shares: deal.shares } : generalShares(firm);
  };
}
