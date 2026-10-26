// Tedarikçi faturasından alış satırları. İki yol:
//   e-Fatura / e-Arşiv XML (UBL-TR 1.2) → burada, yapay zekâsız ve kesin okunur;
//   PDF ya da fotoğraf → Google Gemini (kullanıcının kendi API anahtarıyla) okur.
// İkisi de normalizeInvoice'tan geçer: para kuruş (ya da cent) cinsinden tam sayı,
// tutarlar KDV hariç. Hatalar .code taşır, arayüz onu çevirir; API anahtarı hiçbir
// mesaja ya da loga yazılmaz. Tarayıcıda da Node'da da çalışır (DOMParser yok).

import { parseNumber } from "./money.js";

export const MAX_AI_BYTES = 15 * 1024 * 1024;
export const AI_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const API = "https://generativelanguage.googleapis.com/v1beta";

const codeError = (code, message = code, extra = {}) => Object.assign(new Error(message), { code }, extra);

// ---- Küçük XML okuyucu ----
// Düğüm: { name (öneksiz), qname, attrs, children, text }. Yorumlar, <?…?> ve DOCTYPE atlanır.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (s) => (s.includes("&") ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITIES[e] ?? m;
  const n = /x/i.test(e[1]) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
}) : s);
const localName = (q) => q.slice(q.indexOf(":") + 1);

export function parseXml(text) {
  const raw = String(text ?? "");
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // BOM
  const root = { name: "#root", qname: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const until = (end, from) => {
    const at = s.indexOf(end, from);
    if (at < 0) throw codeError("xml-invalid");
    return at + end.length;
  };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { top().text += decode(s.slice(i)); break; }
    if (lt > i) top().text += decode(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) { i = until("-->", lt + 4); continue; }
    if (s.startsWith("<![CDATA[", lt)) { i = until("]]>", lt + 9); top().text += s.slice(lt + 9, i - 3); continue; }
    if (s.startsWith("<?", lt)) { i = until("?>", lt + 2); continue; }
    if (s.startsWith("<!", lt)) {
      const m = /^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(s.slice(lt, lt + 100000));
      i = m ? lt + m[0].length : until(">", lt);
      continue;
    }
    // Etiketin sonu: tırnak içindeki ">" sayılmaz.
    let j = lt + 1, quote = "";
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) { if (c === quote) quote = ""; } else if (c === "\"" || c === "'") quote = c; else if (c === ">") break;
    }
    if (j >= s.length) throw codeError("xml-invalid");
    const body = s.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === "/") {
      // Kapanış: eşleşen açılışa kadar yığından düş; eşi yoksa yok say.
      const q = body.slice(1).trim();
      const at = stack.findLastIndex((el) => el.qname === q);
      if (at > 0) stack.length = at;
      continue;
    }
    const qname = /^[^\s/>]+/.exec(body)?.[0];
    if (!qname) throw codeError("xml-invalid");
    const attrs = {};
    for (const m of body.slice(qname.length).matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[m[1]] = decode(m[2] ?? m[3]);
    }
    const el = { name: localName(qname), qname, attrs, children: [], text: "" };
    top().children.push(el);
    if (!body.endsWith("/")) stack.push(el);
  }
  if (!root.children.length) throw codeError("xml-invalid");
  return root;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => el?.children.find((c) => c.name === name);
const at = (el, path) => path.split("/").reduce((e, n) => kid(e, n), el);
const txt = (el, path) => (path ? at(el, path) : el)?.text.trim() ?? "";
const attr = (el, name) => el?.attrs[name] ?? Object.entries(el?.attrs ?? {}).find(([k]) => localName(k) === name)?.[1] ?? "";
const findDeep = (el, name) => {
  for (const c of el.children) {
    const hit = c.name === name ? c : findDeep(c, name);
    if (hit) return hit;
  }
  return null;
};
// XML ondalığı her zaman noktalıdır ("1.500" = 1,5); Türkçe sayı okuyucusuna verilmez.
const num = (s) => (s && Number.isFinite(Number(s)) ? Number(s) : null);

// ---- UBL-TR ----

function ublLine(el) {
  const qty = num(txt(el, "InvoicedQuantity"));
  const price = num(txt(el, "Price/PriceAmount"));
  const net = num(txt(el, "LineExtensionAmount"));
  const item = kid(el, "Item");
  // Barkod (GTIN) önce, sonra satıcının ve alıcının ürün kodu.
  const code = ["StandardItemIdentification", "SellersItemIdentification", "BuyersItemIdentification",
    "ManufacturersItemIdentification"].map((n) => txt(item, `${n}/ID`)).find(Boolean) ?? "";
  const subs = kids(kid(el, "TaxTotal"), "TaxSubtotal");
  const kdv = subs.find((t) => txt(t, "TaxCategory/TaxScheme/TaxTypeCode") === "0015") ?? subs[0];
  const vat = kdv ? num(txt(kdv, "Percent") || txt(kdv, "TaxCategory/Percent")) : null;
  // Satır iskontosu varsa gerçek birim fiyat net tutar / miktardır.
  const unitPrice = qty > 0 && net != null && (price == null || Math.abs(price * qty - net) > 0.005) ? net / qty : price;
  return {
    name: txt(item, "Name") || txt(item, "Description"), code, qty,
    unit: attr(kid(el, "InvoicedQuantity"), "unitCode"), unitPrice, vatRate: vat, total: net,
  };
}

export function parseUblInvoice(xmlText) {
  const inv = findDeep(parseXml(xmlText), "Invoice");
  if (!inv) throw codeError("xml-invalid");
  const party = at(inv, "AccountingSupplierParty/Party");
  const ids = kids(party, "PartyIdentification").map((p) => kid(p, "ID")).filter(Boolean);
  const taxId = ids.find((e) => /^(VKN|TCKN)$/i.test(attr(e, "schemeID")));
  const person = kid(party, "Person");
  const personName = ["FirstName", "MiddleName", "FamilyName"].map((n) => txt(person, n)).filter(Boolean).join(" ");
  const addr = kid(party, "PostalAddress");
  const street = [txt(addr, "StreetName"), txt(addr, "BuildingName"), txt(addr, "BuildingNumber")].filter(Boolean).join(" ");
  const city = [txt(addr, "CitySubdivisionName"), txt(addr, "CityName")].filter(Boolean).join("/");
  const address = [street, txt(addr, "District"), city, txt(addr, "PostalZone")].filter(Boolean).join(", ");
  const money = kid(inv, "LegalMonetaryTotal");
  const taxTotals = kids(inv, "TaxTotal");
  const result = normalizeInvoice({
    number: txt(inv, "ID"), date: txt(inv, "IssueDate"), currency: txt(inv, "DocumentCurrencyCode"), source: "xml",
    supplier: {
      name: txt(party, "PartyName/Name") || personName,
      taxNo: txt(taxId), taxOffice: txt(party, "PartyTaxScheme/TaxScheme/Name"),
      address, phone: txt(party, "Contact/Telephone"),
    },
    lines: kids(inv, "InvoiceLine").map(ublLine),
    totals: {
      net: num(txt(money, "TaxExclusiveAmount")),
      vat: taxTotals.length ? taxTotals.reduce((sum, t) => sum + (num(txt(t, "TaxAmount")) ?? 0), 0) : null,
      gross: num(txt(money, "TaxInclusiveAmount")) ?? num(txt(money, "PayableAmount")),
    },
  });
  if (!result.lines.length) throw codeError("xml-invalid");
  return result;
}

// ---- Ortak düzeltici ----

const UNIT_CODES = {
  adet: ["adet", "ad", "pcs", "pc", "piece", "c62", "niu", "h87", "ea", "tane"],
  koli: ["koli", "ct", "cs", "case", "carton"], paket: ["paket", "pa", "pk", "pkt", "pack"],
  kutu: ["kutu", "bx", "box"], kg: ["kg", "kgm", "kilo", "kilogram"], lt: ["lt", "l", "ltr", "litre", "liter", "lıtre"],
  m: ["m", "mtr", "metre", "meter"], çuval: ["çuval", "cuval", "sa", "bag", "sack"], deste: ["deste", "dzn"],
};
const UNIT_OF = new Map(Object.entries(UNIT_CODES).flatMap(([u, codes]) => codes.map((c) => [c, u])));
const toUnit = (v) => UNIT_OF.get(String(v ?? "").trim().replace(/[İI]/g, "i").toLowerCase().replace(/\.$/, "")) ?? "adet";

const clean = (v, max = 200) => (typeof v === "string" || typeof v === "number"
  ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "");

// Sayı ya da "1.234,56" · "1234.56" · "₺40" · "%20" · "-12,5" → sayı; okunamazsa null.
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/\s|₺|tl|try|usd|eur|\$|€|%/gi, "");
  const neg = s.startsWith("-");
  const n = parseNumber(neg ? s.slice(1) : s);
  return n == null ? null : neg ? -n : n;
}
// toFixed: 12.345 * 100 = 1234.4999… yuvarlama hatasını önler.
const toMinor = (v) => {
  const n = toNumber(v);
  return n == null ? null : Math.round(Number((n * 100).toFixed(4)));
};
const toRate = (v) => {
  const n = toNumber(v);
  return n == null || n < 0 || n > 100 ? null : Math.round(n * 100) / 100;
};

function toDate(v) {
  const s = clean(v, 40);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const [y, mo, d] = m ? [m[1], m[2], m[3]] : (m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s)) ? [m[3], m[2], m[1]] : [];
  if (!y) return "";
  const date = new Date(Date.UTC(+y, mo - 1, +d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === +d ? date.toISOString().slice(0, 10) : "";
}

const CURRENCY_ALIASES = { TL: "TRY", TRL: "TRY", YTL: "TRY", "₺": "TRY", $: "USD", "€": "EUR" };
function toCurrency(v) {
  const s = clean(v, 8).toUpperCase();
  const c = CURRENCY_ALIASES[s] ?? s;
  return /^[A-Z]{3}$/.test(c) ? c : "TRY";
}
const toTaxNo = (v) => {
  const digits = clean(v, 40).replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? digits : clean(v, 40);
};

export function normalizeInvoice(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sup = r.supplier ?? {};
  const lines = [];
  for (const l of Array.isArray(r.lines) ? r.lines : Array.isArray(r.items) ? r.items : []) {
    if (!l || typeof l !== "object") continue;
    const name = clean(l.name);
    const n = toNumber(l.qty ?? l.quantity);
    const qty = n == null ? 0 : Math.round(n * 1000) / 1000;
    if (!name || !(qty > 0)) continue;
    let unitPrice = toMinor(l.unitPrice);
    let total = toMinor(l.total);
    if (unitPrice == null && total != null) unitPrice = Math.round(total / qty);
    if (total == null && unitPrice != null) total = Math.round(qty * unitPrice);
    if (total < 0 || unitPrice < 0) continue; // iskonto satırı, ürün değil
    lines.push({
      name, code: clean(l.code, 64), qty, unit: toUnit(l.unit),
      unitPrice: unitPrice ?? 0, vatRate: toRate(l.vatRate), total: total ?? 0,
    });
  }
  const t = r.totals ?? {};
  const net = toMinor(t.net);
  const gross = toMinor(t.gross);
  let vat = toMinor(t.vat);
  if (vat == null && net != null && gross != null) vat = gross - net;
  return {
    number: clean(r.number, 64), date: toDate(r.date), currency: toCurrency(r.currency),
    source: r.source === "xml" ? "xml" : "ai",
    supplier: {
      name: clean(sup.name), taxNo: toTaxNo(sup.taxNo), taxOffice: clean(sup.taxOffice, 100),
      address: clean(sup.address, 300), phone: clean(sup.phone, 40),
    },
    lines,
    totals: { net: net ?? 0, vat: vat ?? 0, gross: gross ?? (net != null && vat != null ? net + vat : 0) },
  };
}

// ---- Eşleştirme ----

const FOLD = { ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c", â: "a", î: "i", û: "u" };
const COMPANY_WORDS = new Set(["ltd", "sti", "as", "san", "sanayi", "tic", "ticaret", "ve", "limited", "sirketi",
  "sirket", "anonim", "ith", "ihr", "ithalat", "ihracat", "paz", "pazarlama", "ltdsti"]);

// "ÇAY 1KG" → "cay 1 kg"; şirket adında "San. ve Tic. Ltd. Şti." gibi ekler atılır.
function foldKey(s, company = false) {
  const key = String(s ?? "").toLocaleLowerCase("tr").replace(/[ışğüöçâîû]/g, (c) => FOLD[c])
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/(\d)(?=[a-z])|([a-z])(?=\d)/g, "$1$2 ").trim();
  if (!company) return key;
  const kept = key.split(" ").filter((w) => w.length > 1 && !COMPANY_WORDS.has(w)).join(" ");
  return kept || key;
}

const isNum = (w) => /^\d+$/.test(w);
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 0.98;
  if (a.replaceAll(" ", "") === b.replaceAll(" ", "")) return 0.95;
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  let score = (2 * common) / (ta.size + tb.size);
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) score = Math.min(0.97, score + 0.2);
  // "Çay 1 kg" ile "Çay 5 kg" aynı ürün değildir.
  const na = [...ta].filter(isNum).sort().join(), nb = [...tb].filter(isNum).sort().join();
  if (na && nb && na !== nb) score *= 0.5;
  return score;
}

const squash = (v) => String(v ?? "").replace(/[\s-]/g, "").toUpperCase();

export function matchProduct(line, products) {
  const list = Array.isArray(products) ? products : [];
  const code = squash(line?.code);
  if (code.length >= 3) {
    const hit = list.find((p) => squash(p.barcode) === code || squash(p.code) === code);
    if (hit) return { id: hit.id, score: 1 };
  }
  const name = foldKey(line?.name);
  if (!name) return null;
  let best = null;
  for (const p of list) {
    const score = Math.max(similarity(name, foldKey(p.name)),
      p.variant ? similarity(name, foldKey(`${p.name} ${p.variant}`)) : 0);
    if (score >= 0.6 && (!best || score > best.score)) best = { id: p.id, score: Math.round(score * 100) / 100 };
  }
  return best;
}

export function matchSupplier(supplier, parties) {
  const list = (Array.isArray(parties) ? parties : []).filter((p) => p?.kind === "supplier");
  const tax = String(supplier?.taxNo ?? "").replace(/\D/g, "");
  if (tax.length >= 10) {
    const hit = list.find((p) => String(p.taxNo ?? "").replace(/\D/g, "") === tax);
    if (hit) return hit.id;
  }
  const name = foldKey(supplier?.name, true);
  if (!name) return null;
  let best = null, bestScore = 0;
  for (const p of list) {
    const score = similarity(name, foldKey(p.name, true));
    if (score >= 0.7 && score > bestScore) { best = p.id; bestScore = score; }
  }
  return best;
}

// ---- Gemini ----

const PROMPT = `You are reading a supplier's purchase invoice (fatura) from Turkey: a PDF, a scan or a phone photo.
Extract exactly what is printed and answer with JSON that matches the schema.
- supplier: the SELLER who issued the invoice (not the buyer shown as "Sayın …"): name (ünvan), taxNo (VKN 10 digits or TCKN 11 digits, digits only), taxOffice (vergi dairesi), address, phone.
- number: invoice number (Fatura No / Belge No). date: invoice date (Fatura Tarihi) as YYYY-MM-DD. currency: ISO 4217 code (TL or ₺ → TRY).
- lines: one entry per product or service row of the items table, in printed order. name as printed; code: product code or barcode if printed on that row, else null; qty; unit as printed (adet, kg, lt, m, koli, paket, kutu, çuval, deste…); unitPrice: unit price EXCLUDING VAT (KDV hariç birim fiyat; if only VAT-included prices are printed, convert); vatRate: KDV percent as a number (20 for %20); total: line amount EXCLUDING VAT after any line discount (Mal Hizmet Tutarı).
- totals: net (VAT excluded total after discounts, Mal Hizmet Toplam / KDV Matrahı), vat (Hesaplanan KDV total), gross (Vergiler Dahil Toplam / Ödenecek Tutar).
- Numbers: plain JSON numbers with a dot as the decimal separator, no thousands separators, no currency signs. Turkish invoices print 1.234,56 meaning 1234.56 (dot groups thousands, comma is the decimal mark).
- Do not invent or guess lines or values. Subtotal, discount, VAT and summary rows are not lines. If a value is missing or unreadable use null. If this is not an invoice or no product rows are readable, return an empty lines array.`;

const S = { type: "STRING", nullable: true }, N = { type: "NUMBER", nullable: true };
const OBJ = (properties, required) => ({ type: "OBJECT", properties, ...(required && { required }) });
const SCHEMA = OBJ({
  supplier: OBJ({ name: S, taxNo: S, taxOffice: S, address: S, phone: S }),
  number: S, date: S, currency: S,
  lines: { type: "ARRAY", items: OBJ({ name: { type: "STRING" }, code: S, qty: N, unit: S, unitPrice: N, vatRate: N, total: N }, ["name", "qty"]) },
  totals: OBJ({ net: N, vat: N, gross: N }),
}, ["supplier", "lines"]);

export function buildGeminiRequest(base64, mimeType) {
  return {
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
  };
}

// Google'ın hata gövdesinden kod; mesaja anahtar ya da Google'ın metni konmaz.
function apiError(status, data) {
  const e = data?.error ?? {};
  const s = `${e.status ?? ""} ${e.message ?? ""} ${JSON.stringify(e.details ?? "")}`;
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(s)) return codeError("ai-bad-key", "Gemini anahtarı geçersiz", { status });
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(s)) return codeError("ai-quota", "Gemini kotası doldu", { status });
  return codeError("ai-failed", `Gemini hatası ${status} ${e.status ?? ""}`.trim(), { status });
}

async function callGemini(path, apiKey, body, signal) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method: body ? "POST" : "GET", signal,
      headers: body ? { "x-goog-api-key": apiKey, "content-type": "application/json" } : { "x-goog-api-key": apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw codeError("ai-network", "Gemini'ye ulaşılamadı");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(res.status, data);
  if (!data) throw codeError("ai-failed", "Gemini boş yanıt verdi");
  return data;
}

const modelCache = new Map();
const version = (name) => (/gemini-([\d.]+)/.exec(name)?.[1] ?? "0").split(".").map(Number);
const newer = (a, b) => {
  const va = version(a), vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
  return a.includes("lite") - b.includes("lite") || a.length - b.length;
};

// Model adları zamanla değişir: listeden generateContent destekleyen en uygun "flash" seçilir.
export async function pickGeminiModel(apiKey, { signal } = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw codeError("ai-no-key");
  if (modelCache.has(key)) return modelCache.get(key);
  const data = await callGemini("models?pageSize=1000", key, null, signal);
  const names = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => String(m.name ?? "").replace(/^models\//, ""));
  const special = /image|tts|live|audio|thinking|exp|preview|embedding/;
  const model = names.find((n) => n.includes("flash-latest") && !special.test(n))
    ?? names.filter((n) => /gemini-[\d.]+-flash(?!.*(image|tts|live|audio|thinking|exp|preview))/.test(n)).sort(newer)[0]
    ?? names.find((n) => n.includes("flash") && !special.test(n))
    ?? names.find((n) => n.includes("flash"));
  if (!model) throw codeError("ai-failed", "Uygun Gemini modeli yok");
  modelCache.set(key, model);
  return model;
}

const MIME_BY_EXT = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
const extOf = (file) => /\.([a-z0-9]+)$/i.exec(file?.name ?? "")?.[1].toLowerCase() ?? "";
const latin1 = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

function sniff(b) {
  const starts = (...xs) => xs.every((x, i) => b[i] === x);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && latin1(b, 8, 12) === "WEBP") return "image/webp";
  if (/^ftyp(heic|heix|hevc|heif|mif1)/.test(latin1(b, 4, 12))) return "image/heic";
  return "";
}

function mimeOf(file, head) {
  const type = String(file?.type ?? "").toLowerCase();
  if (type && type !== "application/octet-stream") return type === "image/jpg" ? "image/jpeg" : type;
  return MIME_BY_EXT[extOf(file)] || sniff(head) || type;
}

function toBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function readInvoiceWithAI(file, { apiKey, model, signal } = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw codeError("ai-no-key");
  if (file.size > MAX_AI_BYTES) throw codeError("ai-too-big");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = mimeOf(file, bytes);
  if (!AI_TYPES.includes(mime)) throw codeError("ai-unsupported");
  const body = buildGeminiRequest(toBase64(bytes), mime);
  let data;
  for (let attempt = 0; ; attempt++) {
    const name = model || await pickGeminiModel(key, { signal });
    try {
      data = await callGemini(`models/${name}:generateContent`, key, body, signal);
      break;
    } catch (err) {
      // Seçilen model kaldırılmışsa listeyi yenileyip bir kez daha dene.
      if (model || attempt || err.status !== 404) throw err;
      modelCache.delete(key);
    }
  }
  const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  let raw;
  try { raw = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")); } catch { throw codeError("ai-unreadable"); }
  const invoice = normalizeInvoice({ ...raw, source: "ai" });
  if (!invoice.lines.length) throw codeError("ai-unreadable");
  return invoice;
}

// ---- Dosya seçimi ----

// Bildirilen kodlamayla çöz (GİB UTF-8 ister ama windows-1254 / ISO-8859-9 da görülür).
function decodeXml(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const enc = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(latin1(bytes, 0, Math.min(bytes.length, 200)))?.[1];
  let decoder;
  try { decoder = new TextDecoder(enc ?? "utf-8"); } catch { decoder = new TextDecoder("utf-8"); }
  return decoder.decode(bytes);
}

function isXml(file, head) {
  const type = String(file?.type ?? "").toLowerCase();
  if (type === "text/xml" || type === "application/xml" || type.endsWith("+xml") || extOf(file) === "xml") return true;
  const start = latin1(head, 0, head.length).replace(/^(\xef\xbb\xbf|\s)+/, "");
  return /^<(\?xml|([\w-]+:)?Invoice\b)/.test(start);
}

export async function readInvoiceFile(file, options = {}) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (isXml(file, head)) return parseUblInvoice(decodeXml(new Uint8Array(await file.arrayBuffer())));
  if (AI_TYPES.includes(mimeOf(file, head))) return readInvoiceWithAI(file, options);
  throw codeError("ai-unsupported");
}
