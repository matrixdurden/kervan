// Döviz kuru önerisi: önce bu cihazda son kullanılan kur, sonra Avrupa Merkez Bankası'nın
// günlük kuru (frankfurter.dev, ücretsiz, anahtarsız). Kur her zaman elle değiştirilebilir.

import { store } from "./ui.js";

export const lastRate = (currency) => Number(store.get(`rate.${currency}`)) || null;
export const rememberRate = (currency, rate) => store.set(`rate.${currency}`, String(rate));

const cache = new Map();

export async function fetchRate(currency) {
  if (cache.has(currency)) return cache.get(currency);
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=TRY`);
    const rate = (await res.json()).rates?.TRY ?? null;
    if (rate) cache.set(currency, rate);
    return rate;
  } catch {
    return null; // internet yoksa son kur kalır
  }
}
