// Hareket defteri. Stoklar, emanetler, cari bakiyeler, ortak kasaları ve aylık kâr
// hareketlerden hesaplanır; bu dosya sadece hesaptır (Firestore'a dokunmaz),
// test/ledger.test.js ile test edilir.
//
// Hareket türleri:
//   purchase     tedarikçiden alış: depoya mal girer, tedarikçiye borçlanılır (döviz olabilir)
//   payment      tedarikçiye ödeme: borç düşer, ödeyen ortağın kasasından para çıkar
//   sale         satıcıya veresiye satış: depodan mal çıkar, satıcının borcu artar
//   collection   satıcıdan tahsilat: satıcının borcu düşer, alan ortağın kasasına para girer
//   consign      emanet: mal depodan satıcının rafına geçer ama hâlâ bizimdir, borç oluşmaz
//   consignSale  sayım: raftan satılan emanet mal satıcının borcuna yazılır
//   return       emanet iadesi: satıcının rafındaki mal depoya döner
//   saleReturn   satış iadesi: müşteri satın aldığı malı geri getirir; mal depoya girer, borcu ve satış düşer
//   refund       para iadesi: müşteriye para geri verilir; ödeyen ortağın kasasından çıkar
//   expense      gider (yakıt, kira…): kârdan ve ödeyen ortağın kasasından düşer
//   capitalIn    ortak işe para koydu
//   withdraw     ortak işten para çekti
//   transfer     para bir ortağın kasasından diğerine geçti (holder → to)
//   opening      açılış: eldeki stok (lines) ya da bir kişinin mevcut bakiyesi (amount, eksi olabilir)
//
// Para kuruş (ya da cent) cinsinden tam sayıdır. Bakiye kişinin para birimindedir:
// satıcıda + "bize borçlu", tedarikçide + "biz borçluyuz" demektir.
// Stok durumu { stock, value }: value elde kalan malın toplam TL maliyetidir,
// ortalama maliyet value / stock (ağırlıklı ortalama). Depo için ürünün kendisi,
// emanet için satıcının rafı (shelf, ayrıca o satıcıya verilen birim fiyat: price) kullanılır.
// Kasa (cash) ortağın elindeki işletme parasıdır (TL); capital koyduğu eksi çektiğidir.
// Aylık kâr: revenue (satış) − cogs (satılan malın maliyeti) − expenses (giderler).

export const MOVE_TYPES = [
  "purchase", "payment", "sale", "collection", "consign", "consignSale", "return", "saleReturn", "refund",
  "expense", "capitalIn", "withdraw", "transfer", "opening",
];
export const PARTY_KIND = {
  purchase: "supplier", payment: "supplier",
  sale: "seller", collection: "seller", consign: "seller", consignSale: "seller", return: "seller",
  saleReturn: "seller", refund: "seller",
};
export const LINE_TYPES = ["purchase", "sale", "consign", "consignSale", "return", "saleReturn"];
export const hasLines = (type) => LINE_TYPES.includes(type);

export const roundQty = (n) => Math.round(n * 1000) / 1000;
export const lineTotal = (line) => Math.round(line.qty * line.price);
export const shelfKey = (party, product) => `${party}/${product}`;
export const monthOf = (date) => date.slice(0, 7);

export function moveTotal(move) {
  return move.lines ? move.lines.reduce((sum, l) => sum + lineTotal(l), 0) : move.amount;
}

const EMPTY = { stock: 0, value: 0, lastCost: 0 };
const EMPTY_SHELF = { stock: 0, value: 0, price: 0 };
const unit = (cost, qty) => (qty ? cost / qty : 0);

export function avgCost(p) {
  return p.stock > 0 ? p.value / p.stock : p.lastCost || 0;
}

// Stoka mal girişi.
export function stockIn(p, qty, unitCost) {
  const stock = roundQty(p.stock + qty);
  // Alışı girilmeden satılmış mal (eksi stok) varsa gelen mal önce o açığı kapatır.
  const value = p.stock < 0 ? Math.max(stock, 0) * unitCost : p.value + qty * unitCost;
  return { ...p, stock, value: stock > 0 ? Math.round(value) : 0 };
}

// Stoktan mal çıkışı; cost çıkan malın maliyetidir. Stokta olmayan kısım son alış fiyatından sayılır.
export function stockOut(p, qty) {
  const avg = avgCost(p);
  const fromStock = Math.min(qty, Math.max(p.stock, 0));
  const cost = Math.round(fromStock * avg + (qty - fromStock) * (p.lastCost || avg));
  const stock = roundQty(p.stock - qty);
  const value = stock > 0 ? p.value - Math.round(fromStock * avg) : 0;
  return { product: { ...p, stock, value }, cost };
}

// İptalde bilinen maliyetle çıkış.
function removeExact(p, qty, cost) {
  const stock = roundQty(p.stock - qty);
  return { ...p, stock, value: stock > 0 ? Math.max(p.value - cost, 0) : 0 };
}

// Bir hareketin değiştirdiği ürünleri ve rafları biriktirir.
function tracker(get) {
  const products = new Map();
  const shelves = new Map();
  return {
    products,
    shelves,
    product: (id) => products.get(id) ?? { ...EMPTY, ...get.product?.(id) },
    shelf: (party, id) => shelves.get(shelfKey(party, id))?.next ?? { ...EMPTY_SHELF, ...get.shelf?.(party, id) },
    setProduct: (id, p) => products.set(id, p),
    setShelf: (party, id, next) => shelves.set(shelfKey(party, id), { party, product: id, next }),
  };
}

// Hareketin cari bakiyeye etkisi (kişinin para biriminde).
export function balanceOf(move) {
  switch (move.type) {
    case "opening": return move.lines ? 0 : move.amount;
    case "purchase": case "sale": case "consignSale": return moveTotal(move);
    case "payment": case "collection": return -move.amount;
    case "saleReturn": return -moveTotal(move);
    case "refund": return move.amount;
    default: return 0;
  }
}

// Kasa, sermaye ve aylık kâr etkileri. sign: 1 uygula, -1 geri al.
function moneyEffects(move, lines, sign) {
  const cash = new Map();
  const capital = new Map();
  const add = (map, uid, value) => {
    if (uid && value) map.set(uid, (map.get(uid) ?? 0) + sign * value);
  };
  const holder = move.holder || move.by;
  // Para koyma/çekmede sermaye sahibi (partner) uygulamayı kullanmayan bir ortak olabilir;
  // o zaman parayı eline alan/veren ortak holder'dır.
  const owner = move.partner || holder;
  switch (move.type) {
    case "collection": add(cash, holder, move.amount); break;
    case "payment": add(cash, holder, -Math.round(move.amount * (move.rate || 1))); break;
    case "expense": add(cash, holder, -move.amount); break;
    case "refund": add(cash, holder, -move.amount); break;
    case "capitalIn": add(cash, holder, move.amount); add(capital, owner, move.amount); break;
    case "withdraw": add(cash, holder, -move.amount); add(capital, owner, -move.amount); break;
    case "transfer": add(cash, holder, -move.amount); add(cash, move.to, move.amount); break;
    default: break;
  }
  // Aylık kâr, ortaklık (deal) bazında da tutulur: satış satırının ortaklığı satış anında yazılır;
  // ortaklığa girmeyen ürünler ve giderler "general" (genel paylar) kovasına gider.
  let month = null;
  // Satış iadesi satışın tersidir: o ayın satışından ve satılan malın maliyetinden düşer.
  if (move.type === "sale" || move.type === "consignSale" || move.type === "saleReturn") {
    const s = move.type === "saleReturn" ? -sign : sign;
    month = emptyMonth();
    month.by = {};
    for (const l of lines) {
      const b = (month.by[l.deal || GENERAL] ??= emptyMonth());
      b.revenue += s * lineTotal(l);
      b.cogs += s * (l.cost ?? 0);
      month.revenue += s * lineTotal(l);
      month.cogs += s * (l.cost ?? 0);
    }
  } else if (move.type === "expense") {
    month = { revenue: 0, cogs: 0, expenses: sign * move.amount, by: { [move.deal || GENERAL]: { revenue: 0, cogs: 0, expenses: sign * move.amount } } };
  }
  if (month) month.key = monthOf(move.date);
  return { cash, capital, month };
}

export const GENERAL = "general";

// Bir hareketin etkisi: değişen ürünler ve raflar (yeni durumları), cari bakiye farkı,
// kasa/sermaye farkları, aylık kâr farkı ve maliyeti eklenmiş satırlar (harekete kaydedilir).
// get.product(id) ve get.shelf(party, id) şimdiki durumu verir (yoksa undefined).
export function applyMove(move, get) {
  const t = tracker(get);
  const lines = [];
  for (const line of move.lines ?? []) {
    const { product: id, qty } = line;
    let cost;
    if (move.type === "sale") {
      const out = stockOut(t.product(id), qty);
      t.setProduct(id, out.product);
      cost = out.cost;
    } else if (move.type === "consign") {
      const out = stockOut(t.product(id), qty);
      t.setProduct(id, out.product);
      cost = out.cost;
      t.setShelf(move.party, id, { ...stockIn(t.shelf(move.party, id), qty, unit(cost, qty)), price: line.price });
    } else if (move.type === "consignSale") {
      const out = stockOut(t.shelf(move.party, id), qty);
      t.setShelf(move.party, id, out.product);
      cost = out.cost;
    } else if (move.type === "return") {
      const out = stockOut(t.shelf(move.party, id), qty);
      t.setShelf(move.party, id, out.product);
      cost = out.cost;
      t.setProduct(id, stockIn(t.product(id), qty, unit(cost, qty)));
    } else if (move.type === "saleReturn") {
      // Geri gelen mal depoya ortalama maliyetle girer (yoksa son alış fiyatıyla).
      const p = t.product(id);
      const unitCost = avgCost(p);
      cost = Math.round(qty * unitCost);
      t.setProduct(id, stockIn(p, qty, unitCost));
    } else {
      // Alış ve açılış: dövizli alışta maliyet o günün kuruyla TL'ye çevrilir.
      const rate = move.rate || 1;
      cost = Math.round(qty * line.price * rate);
      t.setProduct(id, { ...stockIn(t.product(id), qty, unit(cost, qty)), lastCost: Math.round(line.price * rate) });
    }
    lines.push({ ...line, cost });
  }
  return { products: t.products, shelves: t.shelves, balance: balanceOf(move), lines, ...moneyEffects(move, lines, 1) };
}

// İptal edilen hareketin etkisini, harekete kaydedilmiş maliyetlerle tam olarak geri alır.
export function revertMove(move, get) {
  const t = tracker(get);
  const lines = move.lines ?? [];
  for (const line of lines) {
    const { product: id, qty } = line;
    const cost = line.cost ?? lineTotal(line);
    if (move.type === "sale") {
      t.setProduct(id, stockIn(t.product(id), qty, unit(cost, qty)));
    } else if (move.type === "consign") {
      t.setShelf(move.party, id, removeExact(t.shelf(move.party, id), qty, cost));
      t.setProduct(id, stockIn(t.product(id), qty, unit(cost, qty)));
    } else if (move.type === "consignSale") {
      t.setShelf(move.party, id, stockIn(t.shelf(move.party, id), qty, unit(cost, qty)));
    } else if (move.type === "return") {
      t.setProduct(id, removeExact(t.product(id), qty, cost));
      t.setShelf(move.party, id, stockIn(t.shelf(move.party, id), qty, unit(cost, qty)));
    } else {
      t.setProduct(id, removeExact(t.product(id), qty, cost));
    }
  }
  return { products: t.products, shelves: t.shelves, balance: -balanceOf(move), lines, ...moneyEffects(move, lines, -1) };
}

function emptyMonth() {
  return { revenue: 0, cogs: 0, expenses: 0 };
}
const addTo = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);

// Ay özetine bir farkı ekler (toplamlar ve ortaklık kovaları).
export function addMonth(m, d) {
  const out = { revenue: m.revenue + d.revenue, cogs: m.cogs + d.cogs, expenses: m.expenses + d.expenses, by: { ...(m.by ?? {}) } };
  for (const [bucket, b] of Object.entries(d.by ?? {})) {
    const cur = out.by[bucket] ?? emptyMonth();
    out.by[bucket] = { revenue: cur.revenue + b.revenue, cogs: cur.cogs + b.cogs, expenses: cur.expenses + b.expenses };
  }
  return out;
}

// Kayıt sırası: zaman, aynı anda yazılanlarda seq.
export const byTime = (a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0);

// Bütün defteri baştan işler (iptal edilenler atlanır). "Yeniden hesapla" bunu kullanır.
// moves: { type, party, lines?, amount?, at: milisaniye, seq?, voided?, ... }
export function replay(moves) {
  const state = {
    products: new Map(), shelves: new Map(), balances: new Map(),
    cash: new Map(), capital: new Map(), months: new Map(),
  };
  const get = {
    product: (id) => state.products.get(id),
    shelf: (party, id) => state.shelves.get(shelfKey(party, id)),
  };
  for (const move of [...moves].sort(byTime)) {
    if (move.voided) continue;
    const fx = applyMove(move, get);
    for (const [id, p] of fx.products) state.products.set(id, p);
    for (const [key, s] of fx.shelves) state.shelves.set(key, s.next);
    if (move.party && fx.balance) addTo(state.balances, move.party, fx.balance);
    for (const [uid, d] of fx.cash) addTo(state.cash, uid, d);
    for (const [uid, d] of fx.capital) addTo(state.capital, uid, d);
    if (fx.month) state.months.set(fx.month.key, addMonth(state.months.get(fx.month.key) ?? { ...emptyMonth(), by: {} }, fx.month));
  }
  return state;
}

// Ayları toplar. months: Map/obje "2026-10" → { revenue, cogs, expenses, by: { kova: {…} } };
// from/to dahil "YYYY-MM" (boşsa sınırsız). Dönen by her kovanın kârını da verir.
// Ortaklık özelliğinden önceki aylarda kova yoktur; toplamın kovalara dağılmayan kısmı genele sayılır.
export function sumMonths(months, from = "", to = "9999-99") {
  const total = emptyMonth();
  const by = {};
  const add = (bucket, m) => {
    const b = (by[bucket] ??= emptyMonth());
    b.revenue += m.revenue || 0;
    b.cogs += m.cogs || 0;
    b.expenses += m.expenses || 0;
  };
  for (const [key, m] of months instanceof Map ? months : Object.entries(months)) {
    if (key < from || key > to) continue;
    add("_total", m);
    const rest = { revenue: m.revenue || 0, cogs: m.cogs || 0, expenses: m.expenses || 0 };
    for (const [bucket, b] of Object.entries(m.by ?? {})) {
      add(bucket, b);
      rest.revenue -= b.revenue || 0;
      rest.cogs -= b.cogs || 0;
      rest.expenses -= b.expenses || 0;
    }
    if (rest.revenue || rest.cogs || rest.expenses) add(GENERAL, rest);
  }
  Object.assign(total, by._total ?? emptyMonth());
  delete by._total;
  for (const b of Object.values(by)) b.profit = b.revenue - b.cogs - b.expenses;
  return { ...total, profit: total.revenue - total.cogs - total.expenses, by };
}

// Kovaların kârını ortaklara böler. plan(kova) → { ids, shares } (kimler, yüzdeleri).
// Dönen Map: ortak id → toplam pay.
export function splitBuckets(by, plan) {
  const out = new Map();
  for (const [bucket, b] of Object.entries(by)) {
    const { ids, shares } = plan(bucket);
    if (!ids.length) continue;
    for (const [id, part] of splitProfit(b.profit, ids, shares)) out.set(id, (out.get(id) ?? 0) + part);
  }
  return out;
}

// Kârı ortaklara yüzdeleriyle böler. shares: { uid: yüzde }; yoksa eşit bölünür.
// Kuruş yuvarlamasından kalan son ortağa eklenir ki toplam tam tutsun.
export function splitProfit(profit, uids, shares = {}) {
  const given = uids.reduce((s, uid) => s + (shares[uid] || 0), 0);
  const pct = (uid) => (given > 0 ? (shares[uid] || 0) / given : 1 / uids.length);
  const out = new Map();
  let rest = profit;
  uids.forEach((uid, i) => {
    const part = i === uids.length - 1 ? rest : Math.round(profit * pct(uid));
    out.set(uid, part);
    rest -= part;
  });
  return out;
}
