// Açık işletmeye yazan işlemler. Her hareket, etkilediği ürün stokları, satıcı rafları,
// cari bakiyeler, ortak kasaları ve aylık kâr özetiyle aynı batch'te yazılır. Bu özet alanlar
// increment ile güncellenir: internet yokken de çalışır, iki ortak aynı anda kayıt girse de
// birbirinin rakamını ezmez. Bir şey kayarsa recompute() hepsini hareketlerden baştan kurar.

import {
  doc, collection, writeBatch, serverTimestamp, increment, getDocs, updateDoc, deleteDoc, deleteField,
  arrayUnion, arrayRemove,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { session, currentFirm } from "./session.js";
import { applyMove, revertMove, replay, moveTotal, roundQty, shelfKey, addMonth } from "./ledger.js";
import { millis, today, PALETTE } from "./ui.js";

const EMPTY = { stock: 0, value: 0, lastCost: 0 };
const MONEY_TYPES = ["payment", "collection", "expense", "capitalIn", "withdraw", "transfer"];
const firmRef = () => doc(db, "firms", session.firm.id);
const ref = (name, id) => doc(db, "firms", session.firm.id, name, id);
const newRef = (name) => doc(collection(db, "firms", session.firm.id, name));

// Aynı batch'te yeni oluşturulan ürün/kişi henüz session'da yoktur; added ile verilir.
function lookup(added = {}) {
  const product = (id) => added.products?.get(id) ?? session.firm.products.get(id);
  const party = (id) => added.parties?.get(id) ?? session.firm.parties.get(id);
  return { product, party, shelf: (partyId, id) => party(partyId)?.shelf?.[id] };
}

// Hareketleri (ya da iptallerini) sırayla işleyip toplam etkiyi çıkarır.
function accumulate(steps, find) {
  const acc = {
    products: new Map(), shelves: new Map(), balances: new Map(),
    cash: new Map(), capital: new Map(), months: new Map(), lines: [],
  };
  const get = {
    product: (id) => acc.products.get(id) ?? find.product(id),
    shelf: (party, id) => acc.shelves.get(shelfKey(party, id))?.next ?? find.shelf(party, id),
  };
  const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
  for (const { move, revert } of steps) {
    const fx = (revert ? revertMove : applyMove)(move, get);
    for (const [id, p] of fx.products) acc.products.set(id, p);
    for (const [key, s] of fx.shelves) acc.shelves.set(key, s);
    if (move.party && fx.balance) add(acc.balances, move.party, fx.balance);
    for (const [uid, d] of fx.cash) add(acc.cash, uid, d);
    for (const [uid, d] of fx.capital) add(acc.capital, uid, d);
    if (fx.month) {
      acc.months.set(fx.month.key, addMonth(acc.months.get(fx.month.key) ?? { revenue: 0, cogs: 0, expenses: 0 }, fx.month));
    }
    acc.lines.push(fx.lines);
  }
  return acc;
}

// Toplam etkiyi increment olarak yazar. Silinmiş ürün/kişi atlanır.
function writeEffects(batch, acc, find) {
  // Ürünün "satıcılarda" toplamı raf değişimlerinden çıkar.
  const consigned = new Map();
  const partyUpdates = new Map();
  const partyUpdate = (id) => partyUpdates.get(id) ?? partyUpdates.set(id, {}).get(id);
  for (const { party, product, next } of acc.shelves.values()) {
    const old = find.shelf(party, product) ?? { stock: 0, value: 0 };
    const dq = roundQty(next.stock - old.stock);
    consigned.set(product, roundQty((consigned.get(product) ?? 0) + dq));
    const u = partyUpdate(party);
    u[`shelf.${product}.stock`] = increment(dq);
    u[`shelf.${product}.value`] = increment(next.value - old.value);
    u[`shelf.${product}.price`] = next.price ?? 0;
  }
  for (const id of new Set([...acc.products.keys(), ...consigned.keys()])) {
    const old = find.product(id);
    if (!old) continue;
    const fields = {};
    const p = acc.products.get(id);
    if (p) {
      fields.stock = increment(roundQty(p.stock - (old.stock ?? 0)));
      fields.value = increment(p.value - (old.value ?? 0));
      fields.lastCost = p.lastCost ?? 0;
    }
    if (consigned.get(id)) fields.consigned = increment(consigned.get(id));
    batch.update(ref("products", id), fields);
  }
  for (const [id, delta] of acc.balances) partyUpdate(id).balance = increment(delta);
  for (const [id, fields] of partyUpdates) {
    if (find.party(id) && Object.keys(fields).length) batch.update(ref("parties", id), fields);
  }
  for (const uid of new Set([...acc.cash.keys(), ...acc.capital.keys()])) {
    batch.set(ref("accounts", uid), {
      cash: increment(acc.cash.get(uid) ?? 0), capital: increment(acc.capital.get(uid) ?? 0),
    }, { merge: true });
  }
  const inc = (m) => ({ revenue: increment(m.revenue), cogs: increment(m.cogs), expenses: increment(m.expenses) });
  for (const [key, m] of acc.months) {
    const by = Object.fromEntries(Object.entries(m.by ?? {}).map(([bucket, b]) => [bucket, inc(b)]));
    batch.set(ref("months", key), { ...inc(m), by }, { merge: true });
  }
}

// Ürünün şu anki ortaklığı (yoksa "" → genel paylar).
export function dealOf(productId) {
  const deals = currentFirm()?.deals ?? {};
  return Object.keys(deals).find((id) => deals[id].products?.includes(productId)) ?? "";
}

// seq: aynı anda yazılan hareketlerin (satış + peşin tahsilat gibi) sırası; zaman damgaları aynıdır.
function moveDoc(input, lines, find, seq) {
  const move = {
    type: input.type,
    party: input.party || "",
    partyName: find.party(input.party)?.name ?? "",
    date: input.date || today(),
    note: input.note || "",
    total: moveTotal(input),
    by: session.uid,
    at: serverTimestamp(),
    seq,
  };
  if (input.lines) {
    // Ürün adı ve birimi harekete de yazılır: ürün sonradan değişse de defter okunur kalır.
    move.lines = lines.map((l) => ({
      product: l.product,
      name: productLabel(find.product(l.product)),
      unit: find.product(l.product)?.unit ?? "",
      qty: l.qty,
      price: l.price,
      cost: l.cost,
      ...(l.deal && { deal: l.deal }),
    }));
  } else {
    move.amount = input.amount;
  }
  if (input.currency && input.currency !== "TRY") {
    move.currency = input.currency;
    move.rate = input.rate;
  }
  if (input.holder) move.holder = input.holder;
  if (input.partner && input.partner !== input.holder) move.partner = input.partner;
  if (input.deal) move.deal = input.deal;
  if (input.category) {
    move.category = input.category;
    move.categoryName = input.categoryName ?? "";
  }
  if (input.invoiceNo) move.invoiceNo = input.invoiceNo;
  if (input.type === "transfer") move.to = input.to;
  // Düzenlemede yerine geçtiği, çöp kutusundan geri yüklemede kopyası olduğu kayıt.
  if (input.replaces) move.replaces = input.replaces;
  if (input.restoredFrom) move.restoredFrom = input.restoredFrom;
  return move;
}

// Kaydedilmiş bir hareketten yeniden kaydedilebilir girdi (düzenleme ve geri yükleme için).
export function inputOf(move) {
  const input = { type: move.type, party: move.party || "", date: move.date, note: move.note || "" };
  for (const key of ["holder", "partner", "deal", "category", "categoryName", "invoiceNo", "to", "currency", "rate"]) {
    if (move[key] != null && move[key] !== "") input[key] = move[key];
  }
  if (move.lines) input.lines = move.lines.map((l) => ({ product: l.product, qty: l.qty, price: l.price }));
  else input.amount = move.amount;
  return input;
}

// Ürünün görünen adı: "Kulaklık · Siyah"
export function productLabel(p) {
  if (!p) return "";
  return p.variant ? `${p.name} · ${p.variant}` : p.name;
}

const PROFIT_TYPES = ["sale", "consignSale"];

// Hareketleri ve etkilerini batch'e ekler; yazılan hareketleri (id'leriyle) döner.
// reverted: aynı batch'te iptal edilen hareketler (düzenleme); etkileri önce geri alınır ki
// yeni kayıt (örneğin satışın maliyeti) eski kayıt yokmuş gibi hesaplansın.
function addMoves(batch, rawInputs, find, reverted = []) {
  // Giren ve (para hareketlerinde) parası değişen ortak, hesaplanmadan önce belirlenir
  // ki anlık hesap ile kaydedilen hareket aynı olsun.
  // Satış satırlarına ürünün o anki ortaklığı yazılır: ortaklık sonra değişse de geçmiş kâr bozulmaz.
  const inputs = rawInputs.map((input) => ({
    ...input,
    by: session.uid,
    ...(MONEY_TYPES.includes(input.type) && { holder: input.holder || session.uid }),
    ...(PROFIT_TYPES.includes(input.type) && { lines: input.lines.map((l) => ({ ...l, deal: dealOf(l.product) })) }),
  }));
  const acc = accumulate([
    ...[...reverted].reverse().map((move) => ({ move, revert: true })),
    ...inputs.map((move) => ({ move })),
  ], find);
  const moves = inputs.map((input, i) => {
    const moveRef = newRef("moves");
    const data = moveDoc(input, acc.lines[reverted.length + i], find, i);
    batch.set(moveRef, data);
    return { id: moveRef.id, ...data };
  });
  writeEffects(batch, acc, find);
  return moves;
}

// inputs: [{ type, party, date, note, lines: [{ product, qty, price }] | amount, currency?, rate?, holder?, to? }]
// Yerel önbelleğe hemen yazılır; done sunucu onayını bekler. moves geri almak (undo) içindir.
// newProducts: aynı anda oluşturulacak ürünler (faturadan alışta) → { geçiciId: { name, unit, price, … } };
// satırlarda bu geçici id'ler kullanılabilir, gerçek id'ye çevrilir.
// newParty: aynı anda oluşturulacak tedarikçi { tempId, data }.
export function recordMoves(inputs, { newProducts = {}, newParty = null } = {}) {
  const batch = writeBatch(db);
  const products = new Map();
  const ids = new Map();
  for (const [tempId, data] of Object.entries(newProducts)) {
    const productRef = newRef("products");
    const product = { unit: "adet", price: 0, barcode: "", ...data, ...EMPTY, consigned: 0 };
    batch.set(productRef, { ...product, createdBy: session.uid, createdAt: serverTimestamp() });
    products.set(productRef.id, product);
    ids.set(tempId, productRef.id);
  }
  const parties = new Map();
  let partyId = null;
  if (newParty) {
    const partyRef = newRef("parties");
    const party = { phone: "", note: "", balance: 0, ...newParty.data };
    batch.set(partyRef, { ...party, createdBy: session.uid, createdAt: serverTimestamp() });
    parties.set(partyRef.id, party);
    partyId = partyRef.id;
  }
  const resolved = inputs.map((input) => ({
    ...input,
    party: newParty && input.party === newParty.tempId ? partyId : input.party,
    ...(input.lines && { lines: input.lines.map((l) => ({ ...l, product: ids.get(l.product) ?? l.product })) }),
  }));
  const moves = addMoves(batch, resolved, lookup({ products, parties }));
  return { moves, done: batch.commit() };
}

// İşletme ayarları (logo, fatura bilgileri, gider kategorileri, yapay zekâ anahtarı, varsayılan KDV).
export const saveFirmSettings = (fields) => updateDoc(firmRef(), fields);

// Düzenleme: eski kayıt "düzenlendi" diye iptal edilir (çöp kutusuna gider), yerine yenisi yazılır;
// ikisi tek batch'te. Defterde iz kalır, yeni kayıt replaces ile eskisini gösterir.
export function replaceMove(old, input, reason) {
  const batch = writeBatch(db);
  batch.update(ref("moves", old.id), { voided: { by: session.uid, at: serverTimestamp(), reason } });
  const moves = addMoves(batch, [{ ...input, replaces: old.id }], lookup(), [old]);
  return { moves, done: batch.commit() };
}

// Çöp kutusundan geri yükleme: iptal edilmiş kaydın aynısı yeniden yazılır (etkileri yeniden işlenir)
// ve eski kayda "restored" işareti konur ki çöp kutusunda bir daha görünmesin.
export function restoreMove(move) {
  const batch = writeBatch(db);
  const [copy] = addMoves(batch, [{ ...inputOf(move), restoredFrom: move.id }], lookup());
  batch.update(ref("moves", move.id), { restored: { by: session.uid, at: serverTimestamp(), move: copy.id } });
  return { move: copy, done: batch.commit() };
}

// İptal: kayıt silinmez; "voided" yazılır ve etkisi kayıtlı maliyetlerle geri alınır.
export function voidMoves(moves, reason) {
  const find = lookup();
  const batch = writeBatch(db);
  const acc = accumulate([...moves].reverse().map((move) => ({ move, revert: true })), find);
  for (const move of moves) {
    batch.update(ref("moves", move.id), { voided: { by: session.uid, at: serverTimestamp(), reason } });
  }
  writeEffects(batch, acc, find);
  return batch.commit();
}

// Ürünü kaydeder. extra:
//   opening: { qty, cost }    yeni ürün eldeki stokla açılır
//   photo: { thumb, full }    yeni fotoğraf; null fotoğrafı kaldırır; undefined dokunmaz
//   deal: ortaklık id'si      "" genel paylara döner; undefined dokunmaz
// fields: { name, unit, price, barcode, variant, groupId, minStock, vat }
export function saveProduct(id, fields, { opening, photo, deal } = {}) {
  const batch = writeBatch(db);
  const productRef = id ? ref("products", id) : newRef("products");
  fields = { ...fields };
  if (photo) fields.thumb = photo.thumb;
  if (photo === null && id) fields.thumb = deleteField();

  if (id) {
    batch.update(productRef, fields);
  } else {
    const product = { ...fields, ...EMPTY, consigned: 0 };
    batch.set(productRef, { ...product, createdBy: session.uid, createdAt: serverTimestamp() });
    if (opening) {
      addMoves(batch, [{ type: "opening", party: "", lines: [{ product: productRef.id, qty: opening.qty, price: opening.cost }] }],
        lookup({ products: new Map([[productRef.id, product]]) }));
    }
  }
  if (photo?.full) batch.set(ref("images", productRef.id), { data: photo.full });
  if (photo === null && id) batch.delete(ref("images", id));
  if (deal !== undefined) addDealMove(batch, productRef.id, deal);
  // Kaydın sonucuyla birlikte ürünün kimliği de döner: satış formundan açılan yeni ürün hemen sepete girsin.
  return Object.assign(batch.commit(), { id: productRef.id });
}

// Ürünü bir ortaklığa taşır ("" → genel paylar); diğer ortaklıklardan çıkarır.
function addDealMove(batch, productId, dealId) {
  const update = {};
  for (const [id, d] of Object.entries(currentFirm().deals ?? {})) {
    const has = d.products?.includes(productId);
    if (id === dealId && !has) update[`deals.${id}.products`] = arrayUnion(productId);
    if (id !== dealId && has) update[`deals.${id}.products`] = arrayRemove(productId);
  }
  if (Object.keys(update).length) batch.update(firmRef(), update);
}

// Barkodla ürün bulur.
export const productByBarcode = (code) =>
  [...session.firm.products.values()].find((p) => p.barcode && p.barcode === code.trim());

// fields: { kind, name, phone, note, currency?, taxNo, taxOffice, address }
// opening: kişinin mevcut bakiyesi (satıcıda + bize borçlu, tedarikçide + biz borçluyuz).
// photo: { thumb } yeni fotoğraf; null kaldırır; undefined dokunmaz.
export function saveParty(id, { kind, ...fields }, opening, photo) {
  // Firestore undefined değer kabul etmez (örn. satıcının para birimi yok).
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (photo) clean.thumb = photo.thumb;
  if (id) {
    if (photo === null) clean.thumb = deleteField();
    return updateDoc(ref("parties", id), clean);
  }
  const batch = writeBatch(db);
  const partyRef = newRef("parties");
  const party = { kind, ...clean, balance: 0 };
  batch.set(partyRef, { ...party, createdBy: session.uid, createdAt: serverTimestamp() });
  if (opening) {
    addMoves(batch, [{ type: "opening", party: partyRef.id, amount: opening }],
      lookup({ parties: new Map([[partyRef.id, party]]) }));
  }
  return batch.commit();
}

// Ürünle birlikte fotoğrafı silinir ve ortaklıklardan çıkarılır.
export function deleteProduct(id) {
  const batch = writeBatch(db);
  batch.delete(ref("products", id));
  batch.delete(ref("images", id));
  addDealMove(batch, id, "");
  return batch.commit();
}
export const deleteParty = (id) => deleteDoc(ref("parties", id));

// Genel ortaklık payları: { ortakId: yüzde } (ürün ortaklığına girmeyen her şey için).
export const saveShares = (shares) => updateDoc(firmRef(), { shares });

const newId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

// Ürün ortaklığı: { name, products: [ürünId], shares: { ortakId: yüzde } }.
// Bir ürün tek bir ortaklıkta olur; seçilen ürünler başka ortaklıklardan çıkarılır.
export function saveDeal(id, { name, products, shares }) {
  const dealId = id || newId("d");
  const update = { [`deals.${dealId}`]: { name, products, shares } };
  for (const [otherId, other] of Object.entries(currentFirm().deals ?? {})) {
    if (otherId === dealId) continue;
    const rest = (other.products ?? []).filter((p) => !products.includes(p));
    if (rest.length !== (other.products ?? []).length) update[`deals.${otherId}.products`] = rest;
  }
  return updateDoc(firmRef(), update);
}

export const deleteDeal = (id) => updateDoc(firmRef(), { [`deals.${id}`]: deleteField() });

// Uygulamayı kullanmayan ortak (sadece adı). Kimliği "g" ile başlar.
export function saveGuest(id, name) {
  const firm = currentFirm();
  const guestId = id || newId("g");
  const used = [...Object.values(firm.people ?? {}), ...Object.values(firm.guests ?? {})].map((p) => p.color);
  const color = firm.guests?.[guestId]?.color ?? PALETTE.find((c) => !used.includes(c)) ?? PALETTE[0];
  return { id: guestId, color, done: updateDoc(firmRef(), { [`guests.${guestId}`]: { name, color } }) };
}

export const deleteGuest = (id) => updateDoc(firmRef(), { [`guests.${id}`]: deleteField() });

// Bütün defteri okuyup tüm özetleri baştan hesaplar. Düzeltilen kayıt sayısını döner.
export async function recompute() {
  const snap = await getDocs(collection(db, "firms", session.firm.id, "moves"));
  const moves = snap.docs.map((d) => ({ ...d.data(), at: millis(d.data().at) }));
  const state = replay(moves);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const writes = [];

  const consigned = new Map();
  const shelves = new Map();
  for (const [key, s] of state.shelves) {
    const [party, product] = key.split("/");
    consigned.set(product, roundQty((consigned.get(product) ?? 0) + s.stock));
    if (!s.stock && !s.value) continue;
    const shelf = shelves.get(party) ?? shelves.set(party, {}).get(party);
    shelf[product] = { stock: s.stock, value: s.value, price: s.price };
  }

  for (const [id, p] of session.firm.products) {
    const n = state.products.get(id) ?? { ...EMPTY, lastCost: p.lastCost };
    const next = { stock: n.stock, value: n.value, lastCost: n.lastCost, consigned: consigned.get(id) ?? 0 };
    const cur = { stock: p.stock, value: p.value, lastCost: p.lastCost, consigned: p.consigned ?? 0 };
    if (!same(next, cur)) writes.push(["update", ref("products", id), next]);
  }
  for (const [id, party] of session.firm.parties) {
    const next = { balance: state.balances.get(id) ?? 0, shelf: shelves.get(id) ?? {} };
    const cur = { balance: party.balance, shelf: cleanShelf(party.shelf) };
    if (!same(next, cur)) writes.push(["update", ref("parties", id), next]);
  }
  for (const uid of new Set([...session.firm.accounts.keys(), ...state.cash.keys(), ...state.capital.keys()])) {
    const next = { cash: state.cash.get(uid) ?? 0, capital: state.capital.get(uid) ?? 0 };
    const a = session.firm.accounts.get(uid);
    if (!same(next, { cash: a?.cash ?? 0, capital: a?.capital ?? 0 })) writes.push(["set", ref("accounts", uid), next]);
  }
  for (const key of new Set([...session.firm.months.keys(), ...state.months.keys()])) {
    const next = cleanMonth(state.months.get(key));
    if (!same(next, cleanMonth(session.firm.months.get(key)))) writes.push(["set", ref("months", key), next]);
  }

  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(db);
    for (const [op, r, fields] of writes.slice(i, i + 400)) batch[op](r, fields);
    await batch.commit();
  }
  return writes.length;
}

// Ay özetini karşılaştırma için sabit biçime getirir (sıfır kovalar atılır, anahtarlar sıralı).
function cleanMonth(m = {}) {
  const pick = (x) => ({ revenue: x.revenue ?? 0, cogs: x.cogs ?? 0, expenses: x.expenses ?? 0 });
  const by = {};
  for (const bucket of Object.keys(m.by ?? {}).sort()) {
    const b = pick(m.by[bucket]);
    if (b.revenue || b.cogs || b.expenses) by[bucket] = b;
  }
  return { ...pick(m), by };
}

// Sıfırlanmış raf satırlarını karşılaştırma için atar; alanları sabit sırada döndürür.
function cleanShelf(shelf = {}) {
  const out = {};
  for (const [id, s] of Object.entries(shelf)) {
    if (s.stock || s.value) out[id] = { stock: s.stock, value: s.value, price: s.price };
  }
  return out;
}
