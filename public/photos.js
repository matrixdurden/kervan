// Ürün fotoğrafları. Firebase'in ücretsiz planında dosya deposu (Storage) yok; bu yüzden fotoğraf
// telefonda küçültülüp veritabanına yazılır: listede görünen küçük hali (thumb) ürünün kendisinde,
// büyük hali images/{ürünId} belgesinde durur. Böylece liste hızlı açılır, büyük hal sadece
// ürün açılınca okunur.

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { session } from "./session.js";

const THUMB = 160; // px, ~8 KB
const FULL = 720; // px, ~70 KB

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
    return { thumb: await shrink(bitmap, THUMB, 0.7), full: await shrink(bitmap, FULL, 0.75) };
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
