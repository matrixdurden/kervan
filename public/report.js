// Dönem raporu: dönemin hareketlerinden özet rakamlar, satış grafiği ve dökümler (saf fonksiyonlar).
// Para kuruş cinsinden tam sayıdır; dövizli alış ve ödeme kayıttaki kurla TL'ye çevrilir.
// İptal edilmiş (çöp kutusundaki) hareketler sayılmaz.

import { lineTotal, roundQty } from "./ledger.js";

const SALES = ["sale", "consignSale"];
export const REPORT_TYPES = [...SALES, "purchase", "expense", "collection", "payment"];

// Dövizli hareketin TL karşılığı.
export const inLira = (m) => (m.currency && m.rate ? Math.round(m.total * m.rate) : m.total);

const bump = (map, key, init, fn) => {
  const cur = map.get(key) ?? init();
  fn(cur);
  map.set(key, cur);
};

export function buildReport(moves) {
  const r = {
    sales: 0, cogs: 0, salesCount: 0, purchases: 0, expenses: 0, collections: 0, payments: 0,
    days: new Map(), // "YYYY-MM-DD" → { sales, profit }
    customers: new Map(), // kişi → { name, sales, profit, count }
    products: new Map(), // ürün → { name, unit, qty, revenue, profit }
    suppliers: new Map(), // kişi → { name, total, count }
    categories: new Map(), // kategori adı → tutar
  };
  for (const m of moves) {
    if (m.voided) continue;
    if (SALES.includes(m.type)) {
      const cost = (m.lines ?? []).reduce((s, l) => s + (l.cost ?? 0), 0);
      const profit = m.total - cost;
      r.sales += m.total;
      r.cogs += cost;
      r.salesCount += 1;
      bump(r.days, m.date, () => ({ sales: 0, profit: 0 }), (d) => { d.sales += m.total; d.profit += profit; });
      if (m.party) {
        bump(r.customers, m.party, () => ({ name: m.partyName ?? "", sales: 0, profit: 0, count: 0 }), (c) => {
          c.sales += m.total;
          c.profit += profit;
          c.count += 1;
        });
      }
      for (const l of m.lines ?? []) {
        bump(r.products, l.product, () => ({ name: l.name, unit: l.unit, qty: 0, revenue: 0, profit: 0 }), (p) => {
          p.qty = roundQty(p.qty + l.qty);
          p.revenue += lineTotal(l);
          p.profit += lineTotal(l) - (l.cost ?? 0);
        });
      }
    } else if (m.type === "purchase") {
      r.purchases += inLira(m);
      bump(r.suppliers, m.party, () => ({ name: m.partyName ?? "", total: 0, count: 0 }), (s) => {
        s.total += inLira(m);
        s.count += 1;
      });
    } else if (m.type === "expense") {
      r.expenses += m.total;
      bump(r.categories, m.categoryName || "", () => ({ total: 0 }), (c) => { c.total += m.total; });
    } else if (m.type === "collection") {
      r.collections += m.total;
    } else if (m.type === "payment") {
      r.payments += inLira(m);
    }
  }
  return r;
}

const pad = (n) => String(n).padStart(2, "0");
const daysIn = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
const nextMonth = (ym) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};

// Grafiğin sütunları: tek ayda günler, daha uzun dönemde aylar (en fazla son 12 ay).
// from / to: "YYYY-MM" (tümünde from boş; o zaman verinin ilk ayından başlanır). today: "YYYY-MM-DD".
export function salesSeries(days, { from, to, today }) {
  if (from && from === to) {
    const last = from === today.slice(0, 7) ? Number(today.slice(8, 10)) : daysIn(from);
    return Array.from({ length: last }, (_, i) => {
      const key = `${from}-${pad(i + 1)}`;
      return { key, unit: "day", ...(days.get(key) ?? { sales: 0, profit: 0 }) };
    });
  }
  const byMonth = new Map();
  for (const [day, v] of days) {
    bump(byMonth, day.slice(0, 7), () => ({ sales: 0, profit: 0 }), (m) => { m.sales += v.sales; m.profit += v.profit; });
  }
  const end = to > today.slice(0, 7) ? today.slice(0, 7) : to;
  const start = from || [...byMonth.keys()].sort()[0] || end;
  const out = [];
  for (let key = start; key <= end; key = nextMonth(key)) out.push({ key, unit: "month", ...(byMonth.get(key) ?? { sales: 0, profit: 0 }) });
  return out.slice(-12);
}

// En büyükten küçüğe ilk n kayıt: [[id, değer], …]
export const topBy = (map, field, n = 10) => [...map.entries()].sort((a, b) => b[1][field] - a[1][field]).slice(0, n);
