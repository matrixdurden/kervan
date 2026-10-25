// Sayı ve para okuma/yazma. Para her yerde kuruş cinsinden tam sayıdır (12,50 TL → 1250),
// böylece 0,1 + 0,2 gibi ondalık hataları toplamlara karışmaz.

// "1.250,50" · "1250.5" · "12,5" · "₺40" · "1.000" → sayı. Okunamazsa null.
// Türkiye'de nokta binlik, virgül ondalık ayıracıdır; ama telefon klavyesinde
// "12.5" de yazılır. Tek bir noktadan sonra tam 3 hane varsa binlik sayılır ("1.250"),
// yoksa ondalık ("12.5", "0.500").
export function parseNumber(input) {
  const s = String(input ?? "").replace(/\s|₺|tl/gi, "");
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

export const CURRENCIES = ["TRY", "USD", "EUR"];
export const currencySymbol = (currency = "TRY") => ({ TRY: "₺", USD: "$", EUR: "€" })[currency] ?? currency;

const moneyFormats = new Map();
const numberFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });
const rateFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 });

// 125050 → "₺1.250,50"; dövizde 125050, "USD" → "$1.250,50"
// Arapça (sağdan sola) metnin içinde ₺ işareti kaymasın diye tutar soldan sağa yalıtılır (U+2066…U+2069).
export function formatMoney(kurus, currency = "TRY") {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat("tr-TR", { style: "currency", currency }));
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
