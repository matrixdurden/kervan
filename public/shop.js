// Online mağaza: işletmenin herkese açık vitrini (kervanim.web.app/m/{adres}).
// Ürünler shops/{adres}/items altına kopyalanır: ad, kategori, satış fiyatı, fotoğraf ve "tükendi".
// Maliyet, stok adedi ve kişiler asla kopyalanmaz. Ürün değiştikçe vitrin kendiliğinden güncellenir
// (sadece değişen ürünler yazılır). Müşterinin siparişi shops/{adres}/orders altına düşer.

import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, onSnapshot, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { session, currentFirm } from "./session.js";
import { productLabel, saveFirmSettings } from "./data.js";
import { base } from "./money.js";
import { unitLabel } from "./i18n.js";

// İşletmenin mağaza ayarı: { slug, on, phone, showPrices, hideSoldOut } (yoksa null).
export const shopOf = (firm = currentFirm()) => firm?.shop ?? null;
export const shopUrl = (slug) => `${location.origin}/m/${slug}`;

// Adres: küçük harf, Türkçe harfler sadeleşir ("Doğu Toptan" → "dogu-toptan").
export function slugify(s) {
  return String(s ?? "").toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Kısa özet: aynı içerik aynı özeti verir; değişmeyen ürün yeniden yazılmaz.
function hashOf(value) {
  const s = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Vitrin ayarlarını kaydeder ve vitrini açar/kapatır. Adres başka işletmenin elindeyse "taken" hatası.
export async function saveShop(settings) {
  const firm = currentFirm();
  const old = shopOf(firm)?.slug;
  const shop = { ...settings, slug: slugify(settings.slug) };
  try {
    await setDoc(doc(db, "shops", shop.slug), {
      firm: firm.id, by: session.uid, name: firm.name, logo: firm.logo ?? "", phone: shop.phone ?? "",
      currency: base(), showPrices: shop.showPrices !== false, hideSoldOut: Boolean(shop.hideSoldOut), open: Boolean(shop.on),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    if (err?.code === "permission-denied") throw Object.assign(new Error("taken"), { code: "taken" });
    throw err;
  }
  await saveFirmSettings({ shop });
  if (old && old !== shop.slug) await updateDoc(doc(db, "shops", old), { open: false }).catch(() => {});
  published = null;
  if (shop.on) await syncShop();
  return shop;
}

// İşletmenin adı, logosu ya da para birimi değişince vitrinin üst bilgisi de güncellenir.
async function syncHeader(shop) {
  const firm = currentFirm();
  const head = { name: firm.name, logo: firm.logo ?? "", currency: base() };
  const h = hashOf(head);
  if (h === headerHash) return;
  await updateDoc(doc(db, "shops", shop.slug), { ...head, updatedAt: serverTimestamp() });
  headerHash = h;
}

let published = null; // ürünId → { hash, img } (vitrinde şu an olan)
let headerHash = "";
let timer = null;
let running = null;

// Ürünler değişince kısa bir bekleyişten sonra vitrin eşitlenir.
export function scheduleShopSync() {
  if (!shopOf()?.on) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncShop().catch((err) => console.error(err)); }, 2500);
}

export function resetShopSync() {
  clearTimeout(timer);
  published = null;
  headerHash = "";
}

// Fiyatı olan ve "mağazada gizle" denmemiş ürünler vitrine çıkar.
export async function syncShop() {
  if (running) return running;
  running = (async () => {
    const shop = shopOf();
    if (!shop?.on) return;
    const firmId = session.firm.id;
    const items = collection(db, "shops", shop.slug, "items");
    if (!published) {
      const snap = await getDocs(items);
      published = new Map(snap.docs.map((d) => [d.id, { hash: d.data().hash, img: d.data().img }]));
    }
    await syncHeader(shop);
    const want = new Map();
    for (const p of session.firm.products.values()) {
      if (p.shopHide || !p.price) continue;
      const item = {
        name: productLabel(p), category: p.category ?? "", price: p.price, unit: unitLabel(p.unit),
        thumb: p.thumb ?? "", soldOut: !(p.stock > 0),
      };
      want.set(p.id, { ...item, hash: hashOf(item), img: hashOf(item.thumb) });
    }
    const writes = [];
    const images = [];
    for (const [id, item] of want) {
      const cur = published.get(id);
      if (cur?.hash === item.hash) continue;
      writes.push(["set", id, item]);
      if (item.thumb && cur?.img !== item.img) images.push(id);
    }
    for (const id of published.keys()) if (!want.has(id)) writes.push(["delete", id]);
    for (let i = 0; i < writes.length; i += 200) {
      const batch = writeBatch(db);
      for (const [op, id, item] of writes.slice(i, i + 200)) {
        if (op === "set") batch.set(doc(items, id), { ...item, updatedAt: serverTimestamp() });
        else {
          batch.delete(doc(items, id));
          batch.delete(doc(db, "shops", shop.slug, "images", id));
        }
      }
      await batch.commit();
    }
    // Büyük fotoğraf (ürün açılınca görünen) ayrı belgede; sadece fotoğraf değişince kopyalanır.
    for (const id of images) {
      const full = await getDoc(doc(db, "firms", firmId, "images", id)).catch(() => null);
      if (full?.exists()) await setDoc(doc(db, "shops", shop.slug, "images", id), { data: full.data().data });
    }
    published = new Map([...want].map(([id, it]) => [id, { hash: it.hash, img: it.img }]));
  })().finally(() => { running = null; });
  return running;
}

// Gelen siparişler (en yeni üstte). onchange(orders) her değişimde çağrılır.
export function listenOrders(onchange) {
  const shop = shopOf();
  if (!shop?.slug) return () => {};
  return onSnapshot(query(collection(db, "shops", shop.slug, "orders"), orderBy("at", "desc"), limit(100)),
    (snap) => onchange(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))),
    (err) => console.error(err));
}

// Siparişin durumu: new (yeni), done (satışa çevrildi), rejected (reddedildi).
export const setOrderStatus = (id, status) => updateDoc(doc(db, "shops", shopOf().slug, "orders", id), { status });
export const deleteOrder = (id) => deleteDoc(doc(db, "shops", shopOf().slug, "orders", id));
