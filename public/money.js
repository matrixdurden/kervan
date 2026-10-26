// Sayı ve para okuma/yazma. Para her yerde kuruş cinsinden tam sayıdır (12,50 TL → 1250),
// böylece 0,1 + 0,2 gibi ondalık hataları toplamlara karışmaz.

// "1.250,50" · "1250.5" · "12,5" · "₺40" · "1.000" → sayı. Okunamazsa null.
// Türkiye'de nokta binlik, virgül ondalık ayıracıdır; ama telefon klavyesinde
// "12.5" de yazılır. Tek bir noktadan sonra tam 3 hane varsa binlik sayılır ("1.250"),
// yoksa ondalık ("12.5", "0.500").
export function parseNumber(input) {
  const s = String(input ?? "").replace(/\s|₺|\$|€|£|tl|usd|eur/gi, "");
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const commas = s.split(",").length - 1;
  const dots = s.split(".").length - 1;
  let dec = null;
  if (commas && dots) dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
  else if (commas === 1) dec = ",";
  else if (dots === 1) {
    const [whole, frac] = s.split(".");
    dec = frac.length === 3 && whole !== "" && whole !== "0" ? null : ".";
  }

  const group = dec === "," ? "." : dec === "." ? "," : /[.,]/;
  const parts = dec ? s.split(dec) : [s];
  if (parts.length > 2) return null;
  const whole = parts[0].split(group).join("");
  const normal = parts.length === 2 ? `${whole}.${parts[1]}` : whole;
  if (!/^\d*(\.\d+)?$/.test(normal) || normal === "") return null;
  return Number(normal);
}

export function parseMoney(input) {
  const n = parseNumber(input);
  return n == null ? null : Math.round(n * 100);
}

export function parseQty(input) {
  const n = parseNumber(input);
  return n == null ? null : Math.round(n * 1000) / 1000;
}

// Kur: "41,2345" ya da "41.234" → 41.2345 / 41.234. Kurda nokta hep ondalıktır (binlik olmaz).
export function parseRate(input) {
  const s = String(input ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// İşletmenin ana para birimi (Ayarlar → Ana para birimi; varsayılan Türk lirası). Bütün tutarlar, stok
// değeri, kasa ve kâr bu paradadır. Döviz hesabı olan tedarikçinin borcu kendi parasında tutulur ve
// kayıttaki kurla ana paraya çevrilir. Ana para değişince tutarlar çevrilmez, sadece işaret değişir.
let baseCurrency = "TRY";
export const setBaseCurrency = (c) => { baseCurrency = /^[A-Z]{3}$/.test(c ?? "") ? c : "TRY"; };
export const base = () => baseCurrency;

// Seçilebilen para birimleri; adları cihazın dilinde Intl'den gelir.
export const CURRENCIES = [
  "TRY", "USD", "EUR", "GBP", "CHF", "SAR", "AED", "QAR", "KWD", "BHD", "OMR", "JOD", "IQD", "SYP", "LBP",
  "EGP", "LYD", "TND", "DZD", "MAD", "SDG", "YER", "IRR", "AZN", "GEL", "AMD", "RUB", "UAH", "KZT", "UZS",
  "TMT", "KGS", "TJS", "AFN", "PKR", "INR", "BDT", "CNY", "JPY", "KRW", "IDR", "MYR", "SGD", "THB", "PHP",
  "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "RSD", "ALL", "MKD", "BAM",
  "ILS", "BRL", "MXN", "ZAR", "NGN", "KES", "ETB",
];
const SYMBOLS = {
  TRY: "₺", USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", RUB: "₽", INR: "₹", KRW: "₩", UAH: "₴",
  ILS: "₪", AZN: "₼", GEL: "₾", KZT: "₸", NGN: "₦", PHP: "₱", THB: "฿",
};
export const currencySymbol = (currency = baseCurrency) => SYMBOLS[currency] ?? currency;
export function currencyName(code, lang = "tr") {
  try {
    const name = new Intl.DisplayNames([lang], { type: "currency" }).of(code);
    return SYMBOLS[code] && SYMBOLS[code] !== code ? `${name} (${SYMBOLS[code]})` : `${name} (${code})`;
  } catch {
    return code;
  }
}

const moneyFormats = new Map();
const numberFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });
const rateFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 });

// 125050 → "₺1.250,50"; dövizde 125050, "USD" → "$1.250,50"
// Arapça (sağdan sola) metnin içinde ₺ işareti kaymasın diye tutar soldan sağa yalıtılır (U+2066…U+2069).
// Tutarlar her parada kuruş (1/100) olarak tutulduğu için hep iki ondalık gösterilir.
export function formatMoney(kurus, currency = baseCurrency) {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat("tr-TR", {
      style: "currency", currency, currencyDisplay: SYMBOLS[currency] ? "narrowSymbol" : "code",
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }));
  }
  return `⁦${moneyFormats.get(currency).format((kurus || 0) / 100)}⁩`;
}

export const formatRate = (n) => rateFormat.format(n || 0);

// 12.5 → "12,5"
export const formatNumber = (n) => numberFormat.format(n || 0);

// Forma geri yazmak için: 125050 → "1250,50", 4500 → "45"
export function moneyInput(kurus) {
  if (!kurus) return "";
  const whole = Math.trunc(kurus / 100);
  const frac = Math.abs(kurus % 100);
  return frac ? `${whole},${String(frac).padStart(2, "0")}` : String(whole);
}

export const qtyInput = (n) => (n ? String(n).replace(".", ",") : "");
