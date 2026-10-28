// Ürün fotoğrafları. Firebase'in ücretsiz planında dosya deposu (Storage) yok; bu yüzden fotoğraf
// telefonda küçültülüp veritabanına yazılır: listede görünen küçük hali (thumb) ürünün kendisinde,
// büyük hali images/{ürünId} belgesinde durur. Böylece liste hızlı açılır, büyük hal sadece
// ürün açılınca okunur.

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { session } from "./session.js";

const THUMB = 320; // px, ~20 KB: kutucuklarda büyük ve net görünsün
const FULL = 720; // px, ~70 KB
const THUMB_MAX = 38000; // karakter; veritabanı kuralı küçük resmi 40 000 karakterle sınırlar

// Dosya seçtirir (telefonda kamera ya da galeri). Vazgeçilirse null.
export function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

// Görseli en uzun kenarı size olacak şekilde küçültüp JPEG data URL'e çevirir.
async function shrink(bitmap, size, quality) {
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // saydam PNG'ler siyah görünmesin
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// Seçilen dosyadan { thumb, full } üretir.
export async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file);
  try {
    // Küçük resim sınırı aşarsa önce kalite, sonra boyut düşürülür.
    let thumb = "";
    for (const [size, quality] of [[THUMB, 0.72], [THUMB, 0.55], [256, 0.6], [200, 0.6], [160, 0.6]]) {
      thumb = await shrink(bitmap, size, quality);
      if (thumb.length <= THUMB_MAX) break;
    }
    return { thumb, full: await shrink(bitmap, FULL, 0.75) };
  } finally {
    bitmap.close?.();
  }
}

// Kategori fotoğrafı: ortadan kare kırpılır, 220 px JPEG (~12 KB); işletme belgesinde durduğu için küçük.
// photoField ile aynı şekli döner ({ thumb, full }).
export async function prepareSquare(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const size = Math.min(220, side);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    let thumb = "";
    for (const q of [0.72, 0.6, 0.5]) {
      thumb = canvas.toDataURL("image/jpeg", q);
      if (thumb.length <= 20000) break;
    }
    return { thumb, full: thumb };
  } finally {
    bitmap.close?.();
  }
}

// Mağazanın kapak fotoğrafı: en uzun kenarı 900 px, ~90 KB'ı geçmez (işletme belgesinde durur).
export async function prepareCover(file) {
  const bitmap = await createImageBitmap(file);
  try {
    let full = "";
    for (const [size, quality] of [[900, 0.72], [900, 0.6], [760, 0.6], [640, 0.55]]) {
      full = await shrink(bitmap, size, quality);
      if (full.length <= 90000) break;
    }
    return { thumb: full, full };
  } finally {
    bitmap.close?.();
  }
}

// Ürünün büyük fotoğrafı (yoksa null).
export async function loadFullPhoto(productId) {
  try {
    const snap = await getDoc(doc(db, "firms", session.firm.id, "images", productId));
    return snap.exists() ? snap.data().data : null;
  } catch {
    return null;
  }
}
