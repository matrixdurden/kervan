// Döviz kuru önerisi (1 döviz kaç ana para): önce bu cihazda son kullanılan kur, sonra günün kuru:
// Avrupa Merkez Bankası (frankfurter.dev); orada olmayan paralar (riyal, dinar…) için ExchangeRate-API'nin
// açık kuru. İkisi de ücretsiz ve anahtarsızdır. Kur her zaman elle değiştirilebilir.

import { store } from "./ui.js";
import { base } from "./money.js";

// Ana para Türk lirasıyken eski kayıtlar ("rate.USD") aynen okunur.
const key = (c, b) => (b === "TRY" ? `rate.${c}` : `rate.${c}.${b}`);
export const lastRate = (currency, to = base()) => Number(store.get(key(currency, to))) || null;
export const rememberRate = (currency, rate, to = base()) => store.set(key(currency, to), String(rate));

const cache = new Map();

async function json(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

export async function fetchRate(currency, to = base()) {
  const k = `${currency}>${to}`;
  if (cache.has(k)) return cache.get(k);
  let rate = null;
  try {
    rate = (await json(`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=${to}`))?.rates?.[to] ?? null;
  } catch { /* bu para ECB'de yok ya da internet yok */ }
  if (!rate) {
    try {
      rate = (await json(`https://open.er-api.com/v6/latest/${currency}`))?.rates?.[to] ?? null;
    } catch { /* internet yoksa son kur kalır */ }
  }
  if (rate) cache.set(k, rate);
  return rate;
}
