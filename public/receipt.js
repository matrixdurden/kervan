// Satış fişi, KDV dökümlü fatura bilgisi ve ödeme/tahsilat makbuzu: kanvasa (PNG, WhatsApp için) ve
// yazdırılabilir HTML'e. Para kuruş cinsinden tam sayıdır. Uygulamadaki fiyatlar KDV dahildir; net ve KDV
// satır satır ayrılır. Bu belge e-Fatura/e-Arşiv değildir; resmi işaret, karekod, mühür benzeri hiçbir şey çizilmez.

export const RECEIPT_LABEL_KEYS = [
  "dir", "receiptTitle", "invoiceTitle", "number", "date", "customer", "taxOffice", "taxNo", "phone",
  "address", "product", "qty", "unitPrice", "unitPriceNet", "vat", "lineTotal", "net", "vatTotal",
  "total", "paid", "balanceOwed", "balanceCredit", "note", "thanks", "disclaimer",
  "paymentTitle", "collectionTitle", "paidTo", "receivedFrom", "amount", "rate",
  "statementTitle", "previousBalance", "onShelf", "returnTitle", "refunded", "refundTitle",
  "stDesc", "stTotalDebit", "stTotalCredit", "stAccountType", "stCurrentAccount", "stNone",
];

// Makbuz belgeleri (kind): tedarikçiye ödeme ve satıcıdan tahsilat. Satır yok; tek tutar var.
export const MONEY_KINDS = ["payment", "collection", "refund"];

const FONT = "Nunito, Tajawal, system-ui, sans-serif";
const SCALE = 2;
const C = {
  text: "#1E2B2A", text2: "#566664", text3: "#8A9694", border: "#D9D1C1", soft: "#E9E2D4",
  primary: "#1F6F68", accent: "#C8873A", tint: "#EAF3F2", debit: "#B23A2E", credit: "#1E7B4F",
};

const moneyFormats = new Map();
// 125050 → "₺1.250,50" (yalıtım işareti yok; kanvas ve HTML kendi yönünü verir)
function money(kurus, currency = "TRY") {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat("tr-TR", { style: "currency", currency }));
  }
  return moneyFormats.get(currency).format((kurus || 0) / 100);
}
const qtyFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });
const qty = (n) => qtyFormat.format(n || 0);
const rateFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 });
// Kur satırı ana para cinsinden: "1 USD = ₺49,738" ya da işareti olmayan parada "1 TRY = 0,0241 USD".
const BASE_SIGNS = { TRY: "₺", USD: "$", EUR: "€", GBP: "£" };
const rateText = (doc) => {
  const b = doc.base ?? "TRY";
  if (!doc.rate || !doc.currency || doc.currency === b) return "";
  const r = rateFormat.format(doc.rate);
  return BASE_SIGNS[b] ? `1 ${doc.currency} = ${BASE_SIGNS[b]}${r}` : `1 ${doc.currency} = ${r} ${b}`;
};
// Makbuzda kişi satırı: ödemede "Ödeme yapılan", tahsilatta "Ödeyen".
const moneyParty = (doc, L) => (doc.party?.name ? `${doc.kind === "collection" ? L.receivedFrom : L.paidTo}: ${doc.party.name}` : "");
const pct = (rate, rtl) => (rtl ? `${qtyFormat.format(rate)}%` : `%${qtyFormat.format(rate)}`);
// "2026-10-25" → "25.10.2026"
const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d.split("-").reverse().join(".") : d || "");
const when = (doc) => [day(doc.date), doc.time].filter(Boolean).join(" ");
const taxLine = (o, L) => [o?.taxOffice && `${L.taxOffice}: ${o.taxOffice}`, o?.taxNo && `${L.taxNo}: ${o.taxNo}`]
  .filter(Boolean).join(" · ");
const balanceRow = (doc, L) => doc.balanceAfter == null ? null
  : [doc.balanceAfter >= 0 ? L.balanceOwed : L.balanceCredit, money(Math.abs(doc.balanceAfter), doc.currency || "TRY")];
// KDV hariç birim fiyat (yalnız gösterim; satır neti ayrıca tam hesaplanır)
const unitNet = (l) => Math.round((l.price || 0) / (1 + (Number(l.vatRate) || 0) / 100));

// Satır brütü = round(miktar × fiyat); net = round(brüt / (1 + oran)), KDV = brüt − net.
// Böylece her satırda net + KDV == brüt, toplamlar da satır brütlerinin toplamıdır.
export function invoiceTotals(lines = []) {
  const out = lines.map((l) => {
    const rate = Number(l.vatRate) || 0;
    const gross = Math.round((Number(l.qty) || 0) * (l.price || 0));
    const net = Math.round(gross / (1 + rate / 100));
    return { ...l, gross, net, vat: gross - net };
  });
  const rates = new Map();
  for (const l of out) {
    const rate = Number(l.vatRate) || 0;
    const r = rates.get(rate) ?? { rate, net: 0, vat: 0, gross: 0 };
    r.net += l.net; r.vat += l.vat; r.gross += l.gross;
    rates.set(rate, r);
  }
  const sum = (k) => out.reduce((a, l) => a + l[k], 0);
  return { lines: out, byRate: [...rates.values()].sort((a, b) => a.rate - b.rate), net: sum("net"), vat: sum("vat"), gross: sum("gross") };
}

// ---------- Telefon ve WhatsApp ----------

// Telefonu wa.me için uluslararası rakamlara çevirir; olmuyorsa null.
export function waPhone(phone) {
  const raw = String(phone ?? "").trim();
  let d = raw.replace(/\D/g, "");
  let intl = raw.startsWith("+");
  if (!intl && d.startsWith("00")) { d = d.slice(2); intl = true; }
  if (!intl && d.length === 11 && d.startsWith("0")) d = "90" + d.slice(1); // 0532…
  else if (!intl && d.length === 10 && !d.startsWith("0")) d = "90" + d; // 532…
  if (d.startsWith("900") && d.length === 13) d = "90" + d.slice(3); // +90 (0532) …
  if (d.startsWith("90")) return d.length === 12 ? d : null;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Telefonda iki WhatsApp (normal ve Business) varsa hangisinin açılacağı: ayarlardan, bu cihaza özel.
// Android'de uygulama paket adıyla açılır; başka cihazlarda wa.me (hangisi açılacağını cihaz seçer).
export const WA_APPS = { w: "com.whatsapp", b: "com.whatsapp.w4b" };
const savedWaApp = () => {
  try { return localStorage.getItem("kervan.waApp") || ""; } catch { return ""; }
};
const onAndroid = () => /Android/i.test(globalThis.navigator?.userAgent ?? "");

export function whatsappUrl(phone, text, app = onAndroid() ? savedWaApp() : "") {
  const digits = phone == null ? null : waPhone(phone);
  if (WA_APPS[app]) {
    const query = [digits && `phone=${digits}`, text && `text=${encodeURIComponent(text)}`].filter(Boolean).join("&");
    return `intent://send/?${query}#Intent;scheme=whatsapp;package=${WA_APPS[app]};end`;
  }
  return `https://wa.me/${digits ?? ""}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename || "fis.png" });
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Bu cihaz resim dosyası paylaşabiliyor mu (telefonlarda evet, çoğu bilgisayarda hayır)?
export function canShareFiles() {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([""], "fis.png", { type: "image/png" })] }));
  } catch {
    return false;
  }
}

// Dosya paylaşılabiliyorsa paylaşım menüsü; yoksa wa.me bağlantısı (+ PNG indirilir, elle eklensin).
export async function shareOnWhatsApp({ blob, filename = "fis.png", text = "", phone = null } = {}) {
  if (blob) {
    const file = new File([blob], filename, { type: blob.type || "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text });
        return "shared";
      } catch (e) {
        if (e?.name === "AbortError") return "cancelled";
        // NotAllowedError vb. (dokunuş süresi geçti): bağlantıya düş
      }
    }
    downloadBlob(blob, filename);
  }
  openChat(phone, text);
  return "link";
}

// Kişinin WhatsApp sohbetini doğrudan açar (telefon yoksa WhatsApp'ta kişi seçilir).
export function openChat(phone, text = "") {
  const url = whatsappUrl(phone, text);
  // Android uygulama bağlantısı yeni sekmede değil, olduğu yerde açılır (sayfa yerinde kalır).
  if (url.startsWith("intent:")) {
    location.href = url;
    return;
  }
  const w = window.open(url, "_blank");
  if (w) w.opener = null;
  else location.href = url;
}

// Bu cihaz resmi panoya kopyalayabiliyor mu (Android Chrome, iPhone Safari: evet)?
export function canCopyImage() {
  const CI = globalThis.ClipboardItem;
  if (!globalThis.navigator?.clipboard?.write || !CI) return false;
  return typeof CI.supports === "function" ? CI.supports("image/png") : true;
}

// Fiş fotoğrafını panoya kopyalar ve kişinin sohbetini doğrudan açar; kullanıcı mesaj kutusuna
// yapıştırır (klavyenin üstünde çıkan fotoğrafa dokunur). Tarayıcı belli bir sohbete dosya
// ekleyemediği için en kısa yol budur. blob bir Promise olabilir: kopyalama dokunuşla aynı anda başlar.
export async function copyImageAndOpenChat(blob, phone) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": Promise.resolve(blob) })]);
  } catch {
    return false;
  }
  openChat(phone, "");
  return true;
}

// ---------- Kanvas ----------

const fontOf = (o) => `${o.weight ?? 400} ${o.size ?? 22}px ${FONT}`;

// Metni genişliğe göre satırlara böler; tek kelime sığmazsa harf harf böler.
function wrap(ctx, s, w) {
  const out = [];
  for (const para of String(s).split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(next).width <= w) { cur = next; continue; }
      if (cur) out.push(cur);
      let ch = [...word];
      while (ch.length > 1 && ctx.measureText(ch.join("")).width > w) {
        let n = ch.length - 1;
        while (n > 1 && ctx.measureText(ch.slice(0, n).join("")).width > w) n--;
        out.push(ch.slice(0, n).join(""));
        ch = ch.slice(n);
      }
      cur = ch.join("");
    }
    out.push(cur);
  }
  return out;
}

// Mantıksal (soldan sağa) kutu → sağdan sola ise aynalanmış fiziksel kutu.
const box = (c, left = c.P, w = c.W - 2 * c.P) => ({ x: c.rtl ? c.W - left - w : left, w });
const physAlign = (c, align) => (align === "center" ? "center" : (align === "end") === c.rtl ? "left" : "right");

// Metni çizim listesine ekler, yüksekliğini döner (y'yi ilerletmez).
function put(c, s, o = {}) {
  const size = o.size ?? 22, lh = Math.round(size * (o.lh ?? 1.4)), font = fontOf(o);
  const b = box(c, o.left, o.w);
  const align = physAlign(c, o.align ?? "start");
  const x = align === "left" ? b.x : align === "right" ? b.x + b.w : b.x + b.w / 2;
  c.ctx.font = font;
  const rows = wrap(c.ctx, s ?? "", b.w);
  const dir = o.ltr || !c.rtl ? "ltr" : "rtl";
  rows.forEach((r, i) => c.ops.push({ t: "text", s: r, x, y: c.y + i * lh + (lh - size) / 2, font, color: o.color ?? C.text, align, dir }));
  return rows.length * lh;
}
function line(c, s, o = {}) { if (s) c.y += put(c, s, o) + (o.gap ?? 2); }
// Başta etiket, sonda değer (tutar) aynı satırda.
function pair(c, a, b, o = {}) {
  c.ctx.font = fontOf(o);
  const inner = (o.w ?? c.W - 2 * c.P), left = o.left ?? c.P;
  const bw = Math.min(c.ctx.measureText(b).width + 2, inner * 0.6);
  const h = Math.max(put(c, a, { ...o, left, w: inner - bw - 16 }), put(c, b, { ...o, left: left + inner - bw, w: bw, align: "end", ltr: true }));
  c.y += h + (o.gap ?? 4);
}
function rule(c, o = {}) {
  c.y += o.before ?? 8;
  c.ops.push({ t: "rule", y: c.y, x0: c.P, x1: c.W - c.P, color: o.color ?? C.border, width: o.width ?? 1.5, dash: o.dash ?? [] });
  c.y += o.after ?? 12;
}
function logoAt(c, bmp, o) {
  const k = Math.min(1, o.maxW / bmp.width, o.maxH / bmp.height);
  const w = bmp.width * k, h = bmp.height * k, b = box(c, o.left, o.w);
  const align = physAlign(c, o.align);
  const x = align === "left" ? b.x : align === "right" ? b.x + b.w - w : b.x + (b.w - w) / 2;
  c.ops.push({ t: "img", bmp, x, y: c.y, w, h });
  c.y += h + (o.gap ?? 12);
}

async function loadLogo(src) {
  if (!src || typeof createImageBitmap !== "function") return null;
  try { return await createImageBitmap(await (await fetch(src)).blob()); } catch { return null; }
}

// Fişin sonu: ayarlardaki ek satır (IBAN, adres notu…) ve teşekkür yazısı (boşsa hiç yazılmaz).
function thanks(c, L) {
  if (L.footer) line(c, L.footer, { size: 19, align: "center", color: C.text2 });
  if (L.thanks) line(c, L.thanks, { size: 23, weight: 800, align: "center", color: C.accent });
}
const thanksHtml = (L) => `${L.footer ? `<p class="c mute">${esc(L.footer)}</p>` : ""}${L.thanks ? `<p class="c thanks">${esc(L.thanks)}</p>` : ""}`;

function drawReceipt(c, doc, L, logo) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, tot = invoiceTotals(doc.lines);
  if (logo) logoAt(c, logo, { align: "center", maxW: 220, maxH: 110 });
  line(c, f.name || f.title, { size: 30, weight: 800, align: "center", color: C.primary, lh: 1.25 });
  line(c, f.phone, { size: 19, align: "center", color: C.text2, ltr: true });
  line(c, f.address, { size: 19, align: "center", color: C.text2 });
  rule(c, { dash: [6, 5] });
  line(c, doc.title || L.receiptTitle, { size: 25, weight: 800, align: "center", gap: 8 });
  pair(c, doc.number ? `${L.number}: ${doc.number}` : "", when(doc), { size: 19, color: C.text2 });
  if (doc.party?.name) line(c, `${L.customer}: ${doc.party.name}`, { size: 21, weight: 600 });
  rule(c, { dash: [6, 5] });
  for (const l of tot.lines) {
    line(c, l.name, { size: 21, weight: 600, gap: 0 });
    pair(c, `${qty(l.qty)} ${l.unit || ""} × ${money(l.price, cur)}`, money(l.gross, cur), { size: 20, color: C.text2, gap: 10 });
  }
  rule(c, { before: 2 });
  pair(c, L.total, money(tot.gross, cur), { size: 28, weight: 800 });
  if (doc.paid) pair(c, doc.paidLabel || L.paid, money(doc.paid, cur), { size: 21 });
  const bal = balanceRow(doc, L);
  if (bal) pair(c, bal[0], bal[1], { size: 21, weight: 600, color: doc.balanceAfter > 0 ? C.text : C.primary });
  if (doc.note) { c.y += 8; line(c, `${L.note}: ${doc.note}`, { size: 19, color: C.text2 }); }
  rule(c, { dash: [6, 5] });
  thanks(c, L);
}

// Ödeme / tahsilat makbuzu: fişle aynı dar biçim; ürün satırları yerine tek büyük tutar ve kalan borç.
function drawMoney(c, doc, L, logo) {
  const cur = doc.currency || "TRY", f = doc.firm || {};
  if (logo) logoAt(c, logo, { align: "center", maxW: 220, maxH: 110 });
  line(c, f.name || f.title, { size: 30, weight: 800, align: "center", color: C.primary, lh: 1.25 });
  line(c, f.phone, { size: 19, align: "center", color: C.text2, ltr: true });
  line(c, f.address, { size: 19, align: "center", color: C.text2 });
  rule(c, { dash: [6, 5] });
  line(c, L[`${doc.kind}Title`], { size: 25, weight: 800, align: "center", gap: 8 });
  pair(c, doc.number ? `${L.number}: ${doc.number}` : "", when(doc), { size: 19, color: C.text2 });
  line(c, moneyParty(doc, L), { size: 21, weight: 600 });
  rule(c, { dash: [6, 5] });
  pair(c, L.amount, money(doc.amount, cur), { size: 30, weight: 800 });
  if (rateText(doc)) pair(c, L.rate, rateText(doc), { size: 19, color: C.text2 });
  const bal = balanceRow(doc, L);
  if (bal) pair(c, bal[0], bal[1], { size: 22, weight: 700, color: doc.balanceAfter > 0 ? C.text : C.primary });
  if (doc.note) { c.y += 8; line(c, `${L.note}: ${doc.note}`, { size: 19, color: C.text2 }); }
  rule(c, { dash: [6, 5] });
  thanks(c, L);
}

// Hesap ekstresi, bölüm bölüm (geniş sayfa): üstte işletme ve belge adı, kişi bilgileri kutusu;
// 1. bölüm borç kalemleri (satış/alış fişleri, ürünleriyle), 2. bölüm ödemeler ve iadeler; altta toplamlar
// ve kalan bakiye. doc.rows: [{ date, label, number, detail, lines: [{ name, qty, unit, price }], qty, amount,
// side: "debit" | "credit" }] eskiden yeniye. Bölüm başlıkları ve kişi etiketi uygulama dilinde hazır gelir.
export function statementSections(doc) {
  const prev = doc.previous ?? 0;
  const debit = doc.rows.filter((r) => r.side === "debit");
  const credit = doc.rows.filter((r) => r.side === "credit");
  const sumOf = (list) => list.reduce((a, r) => a + (r.amount || 0), 0);
  return {
    debit, credit,
    totalDebit: sumOf(debit) + Math.max(prev, 0),
    totalCredit: sumOf(credit) + Math.max(-prev, 0),
  };
}
const lineText = (l, cur) => `${l.name} (${qty(l.qty)}${l.unit ? ` ${l.unit}` : ""} × ${money(l.price, cur)} = ${money(Math.round((l.qty || 0) * (l.price || 0)), cur)})`;
const rowTitle = (r, L) => `${r.label}${r.number ? ` · ${L.number || "No"} ${r.number}` : ""}`;
const rowSub = (r) => [day(r.date), r.lines?.length ? "" : r.detail].filter(Boolean).join(" · ");

function drawStatement(c, doc, L, logo) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, p = doc.party || {};
  const inner = c.W - 2 * c.P;
  const { debit, credit, totalDebit, totalCredit } = statementSections(doc);

  // Üst: solda işletme, sağda belge adı ve tarih.
  const y0 = c.y, wEnd = Math.round(inner * 0.42), fw = { w: inner - wEnd - 20 };
  if (logo) logoAt(c, logo, { ...fw, align: "start", maxW: 200, maxH: 90, gap: 8 });
  line(c, f.name || f.title, { ...fw, size: 30, weight: 800, color: C.primary, lh: 1.25 });
  line(c, f.phone, { ...fw, size: 18, color: C.text2, ltr: true });
  const y1 = c.y;
  c.y = y0;
  const eo = { left: c.P + inner - wEnd, w: wEnd, align: "end" };
  line(c, L.statementTitle, { ...eo, size: 30, weight: 800, lh: 1.2, gap: 4 });
  line(c, when(doc), { ...eo, size: 18, color: C.text2 });
  c.y = Math.max(c.y, y1);
  rule(c, { color: C.primary, width: 3, before: 12, after: 16 });

  // Kişi bilgileri: iki sütunlu açık zeminli kutu.
  const info = [[p.label || L.customer, p.name], [L.phone, p.phone], [L.date, day(doc.date)], [L.stAccountType, L.stCurrentAccount]]
    .filter(([k, v]) => k && v);
  const bg = { t: "rect", x: c.P, y: c.y, w: inner, h: 0, color: C.tint };
  c.ops.push(bg);
  c.y += 14;
  const half = (inner - 48) / 2;
  const cell = (j, k, v, ltr) => {
    const o = { left: c.P + 16 + j * (half + 16), w: half };
    const h1 = put(c, k, { ...o, size: 15, weight: 800, color: C.text3 });
    c.y += h1;
    const h2 = put(c, v, { ...o, size: 20, weight: 700, ltr });
    c.y -= h1;
    return h1 + h2;
  };
  for (let i = 0; i < info.length; i += 2) {
    c.y += Math.max(...info.slice(i, i + 2).map(([k, v], j) => cell(j, k, v, k === L.phone))) + 8;
  }
  c.y += 6;
  bg.h = c.y - bg.y;
  c.y += 26;

  // Tablo: başlık şeridi, satırlar arasında ince çizgi. widths mantıksal soldan sağa.
  const table = (title, widths, head, rows) => {
    line(c, title, { size: 22, weight: 800, color: C.primary, gap: 8 });
    const cols = widths.map((w, i) => ({ left: c.P + widths.slice(0, i).reduce((a, b) => a + b, 0) + 8, w: w - 16, align: i < 2 ? "start" : "end" }));
    c.ctx.font = fontOf({ size: 16, weight: 800 });
    const headH = Math.max(...head.map((s, i) => wrap(c.ctx, s, cols[i].w).length)) * Math.round(16 * 1.4) + 18;
    c.ops.push({ t: "rect", x: c.P, y: c.y, w: inner, h: headH, color: C.tint });
    c.y += 9;
    Math.max(...head.map((s, i) => put(c, s, { ...cols[i], size: 16, weight: 800, color: C.primary })));
    c.y += headH - 9;
    rows.forEach((r, i) => {
      c.y += 10;
      const desc = cols[1], start = c.y;
      c.y += put(c, r.title, { ...desc, size: 19, weight: 700 });
      if (r.sub) c.y += put(c, r.sub, { ...desc, size: 16, color: C.text3 });
      for (const it of r.items ?? []) c.y += put(c, `• ${it}`, { ...desc, size: 16, color: C.text2 });
      const hDesc = c.y - start;
      c.y = start;
      const ends = r.cells.map((s, j) => put(c, s, { ...cols[cols.length - r.cells.length + j], size: 19, weight: j === r.cells.length - 1 ? 800 : 400,
        color: j === r.cells.length - 1 ? r.color : C.text2, ltr: true }));
      const hNo = put(c, String(i + 1), { ...cols[0], size: 17, color: C.text3 });
      c.y += Math.max(hDesc, hNo, ...ends);
      rule(c, { color: C.soft, width: 1, before: 10, after: 0 });
    });
    c.y += 26;
  };
  const prev = doc.previous ?? 0;
  const prevRow = (side) => ({ title: L.previousBalance, sub: "", items: [], cells: side === "debit" ? ["", money(Math.abs(prev), cur)] : [money(Math.abs(prev), cur)],
    color: side === "debit" ? C.debit : C.credit });
  const none = (n) => ({ title: L.stNone, sub: "", items: [], cells: Array(n).fill("—"), color: C.text3 });
  const debitRows = [
    ...(prev > 0 ? [prevRow("debit")] : []),
    ...debit.map((r) => ({ title: rowTitle(r, L), sub: rowSub(r), items: (r.lines ?? []).map((l) => lineText(l, cur)),
      cells: [r.qty ? qty(r.qty) : "—", money(r.amount, cur)], color: C.debit })),
  ];
  const creditRows = [
    ...(prev < 0 ? [prevRow("credit")] : []),
    ...credit.map((r) => ({ title: rowTitle(r, L), sub: rowSub(r), items: (r.lines ?? []).map((l) => lineText(l, cur)),
      cells: [money(r.amount, cur)], color: C.credit })),
  ];
  table(`1. ${doc.debitTitle || ""}`, [56, inner - 56 - 110 - 190, 110, 190], ["#", L.stDesc, L.qty, L.amount], debitRows.length ? debitRows : [none(2)]);
  table(`2. ${doc.creditTitle || ""}`, [56, inner - 56 - 190, 190], ["#", L.stDesc, L.amount], creditRows.length ? creditRows : [none(1)]);

  // Toplamlar ve kalan bakiye: çerçeveli kutu.
  const frame = { t: "box", x: c.P, y: c.y, w: inner, h: 0, color: C.primary };
  c.ops.push(frame);
  const so = { left: c.P + 20, w: inner - 40 };
  c.y += 16;
  pair(c, L.stTotalDebit, money(totalDebit, cur), { ...so, size: 21, color: C.debit, gap: 8 });
  pair(c, L.stTotalCredit, money(totalCredit, cur), { ...so, size: 21, color: C.credit, gap: 4 });
  c.ops.push({ t: "rule", y: c.y + 6, x0: c.P + 20, x1: c.W - c.P - 20, color: C.border, width: 1.5, dash: [] });
  c.y += 18;
  pair(c, doc.balanceLabel, money(Math.abs(doc.balance), cur), { ...so, size: 30, weight: 800, color: doc.balance ? C.text : C.primary, gap: 0 });
  c.y += 16;
  frame.h = c.y - frame.y;

  if (doc.shelf?.length) {
    c.y += 22;
    line(c, `${L.onShelf}:`, { size: 20, weight: 700, gap: 4 });
    for (const s of doc.shelf) pair(c, s.name, s.qty, { size: 19, color: C.text2 });
  }
  c.y += 18;
  thanks(c, L);
}

// Özet fişi (ortak hesabı gibi): başlık, kişi, satır satır etiket – değer, altta büyük toplam.
// doc: { kind: "summary", title, subtitle, rows: [[etiket, değer]], total: [etiket, değer], note }.
function drawSummary(c, doc, L, logo) {
  const f = doc.firm || {};
  if (logo) logoAt(c, logo, { align: "center", maxW: 220, maxH: 110 });
  line(c, f.name || f.title, { size: 30, weight: 800, align: "center", color: C.primary, lh: 1.25 });
  rule(c, { dash: [6, 5] });
  line(c, doc.title, { size: 25, weight: 800, align: "center", gap: 6 });
  pair(c, doc.subtitle ?? "", when(doc), { size: 21, weight: 700 });
  rule(c, { dash: [6, 5] });
  for (const [label, value] of doc.rows) pair(c, label, value, { size: 21, gap: 8 });
  if (doc.total) {
    rule(c, { before: 2 });
    pair(c, doc.total[0], doc.total[1], { size: 28, weight: 800 });
  }
  if (doc.note) { c.y += 8; line(c, doc.note, { size: 18, color: C.text2 }); }
  rule(c, { dash: [6, 5] });
  thanks(c, L);
}

const DRAW = { invoice: drawInvoice, statement: drawStatement, summary: drawSummary, payment: drawMoney, collection: drawMoney };

function drawInvoice(c, doc, L, logo) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, p = doc.party || {}, tot = invoiceTotals(doc.lines);
  const inner = c.W - 2 * c.P, wEnd = Math.round(inner * 0.36), endLeft = c.P + inner - wEnd;
  const y0 = c.y;
  const fw = { w: inner - wEnd - 24 };
  line(c, f.title || f.name, { ...fw, size: 34, weight: 800, color: C.primary, lh: 1.25, gap: 6 });
  line(c, taxLine(f, L), { ...fw, size: 20, color: C.text2 });
  line(c, f.address, { ...fw, size: 20, color: C.text2 });
  line(c, f.phone && `${L.phone}: ${f.phone}`, { ...fw, size: 20, color: C.text2 });
  const y1 = c.y;
  c.y = y0;
  const eo = { left: endLeft, w: wEnd, align: "end" };
  if (logo) logoAt(c, logo, { ...eo, maxW: wEnd, maxH: 120 });
  line(c, L.invoiceTitle, { ...eo, size: 34, weight: 800, lh: 1.2, gap: 6 });
  line(c, doc.number && `${L.number}: ${doc.number}`, { ...eo, size: 20, color: C.text2 });
  line(c, when(doc) && `${L.date}: ${when(doc)}`, { ...eo, size: 20, color: C.text2 });
  c.y = Math.max(c.y, y1);
  rule(c, { color: C.primary, width: 4, before: 16, after: 20 });

  if (doc.party) {
    line(c, L.customer, { size: 18, weight: 800, color: C.text3, gap: 2 });
    line(c, p.title || p.name, { size: 24, weight: 800 });
    if (p.title && p.name && p.title !== p.name) line(c, p.name, { size: 20 });
    line(c, taxLine(p, L), { size: 20, color: C.text2 });
    line(c, p.address, { size: 20, color: C.text2 });
    line(c, p.phone && `${L.phone}: ${p.phone}`, { size: 20, color: C.text2 });
    c.y += 20;
  }

  // Sütunlar (mantıksal soldan sağa; sağdan solada box() aynalar)
  const widths = [inner - 680, 160, 190, 110, 220];
  const cols = widths.map((w, i) => ({ left: c.P + widths.slice(0, i).reduce((a, b) => a + b, 0) + 10, w: w - 20, align: i ? "end" : "start" }));
  const row = (cells, o) => Math.max(...cells.map((s, i) => put(c, s, { ...o, ...cols[i], ltr: i === 2 || i === 4 })));
  const head = [L.product, L.qty, L.unitPriceNet, L.vat, L.net];
  c.ctx.font = fontOf({ size: 18, weight: 800 });
  const headH = Math.max(...head.map((s, i) => wrap(c.ctx, s, cols[i].w).length)) * Math.round(18 * 1.4) + 20;
  c.ops.push({ t: "rect", x: c.P, y: c.y, w: inner, h: headH, color: C.tint });
  c.y += 10;
  row(head, { size: 18, weight: 800, color: C.primary });
  c.y += headH - 10 + 6;
  for (const l of tot.lines) {
    c.y += 6;
    c.y += row([l.name, `${qty(l.qty)} ${l.unit || ""}`.trim(), money(unitNet(l), cur), pct(Number(l.vatRate) || 0, c.rtl), money(l.net, cur)], { size: 20 });
    rule(c, { color: C.soft, width: 1, before: 6, after: 0 });
  }
  c.y += 20;

  const so = { left: c.P + inner - 520, w: 520, size: 20 };
  pair(c, L.net, money(tot.net, cur), so);
  for (const r of tot.byRate) {
    pair(c, `${L.vat} ${pct(r.rate, c.rtl)} (${money(r.net, cur)})`, money(r.vat, cur), { ...so, color: C.text2 });
  }
  pair(c, L.vatTotal, money(tot.vat, cur), so);
  c.ops.push({ t: "rule", y: c.y + 4, x0: c.rtl ? c.P : c.P + inner - 520, x1: c.rtl ? c.P + 520 : c.W - c.P, color: C.primary, width: 2, dash: [] });
  c.y += 14;
  pair(c, L.total, money(tot.gross, cur), { ...so, size: 28, weight: 800, color: C.primary });
  if (doc.paid) pair(c, L.paid, money(doc.paid, cur), so);
  const bal = balanceRow(doc, L);
  if (bal) pair(c, bal[0], bal[1], { ...so, weight: 600 });
  if (doc.note) { c.y += 16; line(c, `${L.note}: ${doc.note}`, { size: 20, color: C.text2 }); }

  c.y += 32;
  const frame = { t: "box", x: c.P, y: c.y, w: inner, h: 0, color: C.border };
  c.ops.push(frame);
  c.y += 14;
  c.y += put(c, L.disclaimer, { left: c.P + 18, w: inner - 36, size: 18, weight: 600, color: C.text2 });
  c.y += 14;
  frame.h = c.y - frame.y;
}

export async function receiptCanvas(doc, labels) {
  const L = labels || {}, invoice = doc.kind === "invoice";
  try {
    await Promise.all([document.fonts.load(`400 20px Nunito`), document.fonts.load(`800 20px Nunito`),
      document.fonts.load(`400 20px Tajawal`, "ع"), document.fonts.load(`800 20px Tajawal`, "ع")]);
  } catch { /* çevrimdışı: yedek yazı tipi */ }
  await document.fonts?.ready;
  const logo = await loadLogo(doc.firm?.logo);
  const canvas = document.createElement("canvas");
  const wide = doc.kind === "statement";
  const W = invoice ? 1240 : wide ? 900 : 576;
  const c = { ctx: canvas.getContext("2d"), W, P: invoice ? 72 : wide ? 40 : 28, rtl: L.dir === "rtl", y: 0, ops: [] };
  c.y = c.P;
  (DRAW[doc.kind] ?? drawReceipt)(c, doc, L, logo);
  const H = Math.ceil(c.y + c.P);
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";
  for (const op of c.ops) {
    if (op.t === "text") {
      Object.assign(ctx, { font: op.font, fillStyle: op.color, textAlign: op.align, direction: op.dir });
      ctx.fillText(op.s, op.x, op.y);
    } else if (op.t === "rule") {
      Object.assign(ctx, { strokeStyle: op.color, lineWidth: op.width });
      ctx.setLineDash(op.dash);
      ctx.beginPath(); ctx.moveTo(op.x0, op.y); ctx.lineTo(op.x1, op.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (op.t === "rect") {
      ctx.fillStyle = op.color;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.t === "box") {
      Object.assign(ctx, { strokeStyle: op.color, lineWidth: 1.5 });
      ctx.strokeRect(op.x, op.y, op.w, op.h);
    } else if (op.t === "img") {
      ctx.drawImage(op.bmp, op.x, op.y, op.w, op.h);
    }
  }
  logo?.close?.();
  return canvas;
}

export async function receiptBlob(doc, labels) {
  const canvas = await receiptCanvas(doc, labels);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG oluşturulamadı"))), "image/png"));
}

// ---------- PDF ----------

// JPEG resmini tek sayfalık PDF'e koyar; resim sayfayı tam kaplar. pw/ph resmin pikseli, w/h sayfanın
// boyu (pt). Kütüphane gerekmez: PDF, resmi olduğu gibi (DCTDecode) taşıyan birkaç nesneden ibarettir.
export function jpegPdf(jpeg, pw, ph, w, h) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    size += b.length;
  };
  const obj = (n, ...body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // ikili dosya işareti
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(5, `<< /Type /XObject /Subtype /Image /Width ${pw} /Height ${ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg, "\nendstream");
  const xref = size;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Fişin PDF'i: kanvas resmi (fişle birebir aynı) ekran pikseli başına 0,75 pt boyunda bir sayfaya konur.
export async function receiptPdf(doc, labels) {
  const canvas = await receiptCanvas(doc, labels);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG oluşturulamadı"))), "image/jpeg", 0.92));
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const pt = (px) => Math.round((px / SCALE) * 0.75 * 100) / 100;
  return new Blob([jpegPdf(jpeg, canvas.width, canvas.height, pt(canvas.width), pt(canvas.height))], { type: "application/pdf" });
}

// ---------- Yazdırma (HTML) ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const safeLogo = (src) => (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(src || "") ? src : "");
const m = (kurus, cur) => `<span class="m">${esc(money(kurus, cur))}</span>`;
const p = (s, cls = "") => (s ? `<p${cls ? ` class="${cls}"` : ""}>${esc(s)}</p>` : "");
const tr = (a, b, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${a}</td><td class="e">${b}</td></tr>`;

const BASE_CSS = `*{box-sizing:border-box}body{margin:0;font-family:${FONT};color:${C.text};background:#fff;
-webkit-print-color-adjust:exact;print-color-adjust:exact}p{margin:0 0 2px}table{width:100%;border-collapse:collapse}
td,th{padding:2px 0;vertical-align:top;text-align:start}.e{text-align:end;white-space:nowrap}.c{text-align:center}
.m{unicode-bidi:isolate;direction:ltr}.mute{color:${C.text2}}img.logo{max-height:28mm;max-width:60mm}`;

const RECEIPT_CSS = `@page{size:80mm auto;margin:0}body{width:80mm;padding:4mm;font-size:12px}
h1{font-size:16px;margin:2px 0;color:${C.primary}}h2{font-size:14px;margin:4px 0}
hr{border:0;border-top:1px dashed ${C.border};margin:6px 0}.name{font-weight:600;padding-top:4px}
.tot td{font-size:15px;font-weight:800;padding-top:4px}.thanks{color:${C.accent};font-weight:800;font-size:14px;margin-top:6px}`;

const INVOICE_CSS = `@page{size:A4;margin:14mm}body{font-size:11pt}header{display:flex;justify-content:space-between;
gap:16px;border-bottom:3px solid ${C.primary};padding-bottom:10px;margin-bottom:14px}header .end{text-align:end}
h1{font-size:17pt;margin:0 0 4px;color:${C.primary}}h2{font-size:17pt;margin:0 0 4px}.party{margin-bottom:14px}
.party .lbl{font-size:9pt;font-weight:800;color:${C.text3}}.party b{font-size:13pt}
.lines th{background:${C.tint};color:${C.primary};font-size:9.5pt;padding:6px}.lines th:not(:first-child){text-align:end}
.lines td{padding:6px;border-bottom:1px solid ${C.soft}}.sum{width:90mm;margin:12px 0 0 auto;margin-inline-start:auto;margin-inline-end:0}
.sum td{padding:3px 0}.sum .tot td{font-size:14pt;font-weight:800;color:${C.primary};border-top:2px solid ${C.primary};padding-top:6px}
.disc{margin-top:18px;border:1px solid ${C.border};padding:8px 10px;font-size:9pt;font-weight:600;color:${C.text2}}`;

const STATEMENT_CSS = `.info{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;background:${C.tint};padding:10px 12px;margin-bottom:16px}
.info .lbl{font-size:8.5pt;font-weight:800;color:${C.text3}}.info b{display:block;font-size:11.5pt}
h3{font-size:12.5pt;color:${C.primary};margin:14px 0 6px}.lines td{vertical-align:top}.lines .no{width:8mm;color:${C.text3}}
.lines .it{font-size:9pt;color:${C.text2}}.lines .sub{font-size:9pt;color:${C.text3}}.dr{color:${C.debit};font-weight:800}
.cr{color:${C.credit};font-weight:800}.sbox{border:2px solid ${C.primary};padding:8px 12px;margin-top:16px}
.sbox td{padding:3px 0}.sbox .tot td{font-size:15pt;font-weight:800;border-top:1px solid ${C.border};padding-top:6px}
.thanks{color:${C.accent};font-weight:800;margin-top:10px}`;

function receiptBody(doc, L) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, tot = invoiceTotals(doc.lines), logo = safeLogo(f.logo);
  const bal = balanceRow(doc, L);
  const rows = tot.lines.map((l) => `<tr><td colspan="2" class="name">${esc(l.name)}</td></tr>`
    + tr(`<span class="mute">${esc(`${qty(l.qty)} ${l.unit || ""}`)} × ${m(l.price, cur)}</span>`, m(l.gross, cur))).join("");
  return `<div class="c">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}<h1>${esc(f.name || f.title)}</h1>
${p(f.phone, "mute")}${p(f.address, "mute")}</div><hr><h2 class="c">${esc(doc.title || L.receiptTitle)}</h2>
<table>${tr(doc.number ? esc(`${L.number}: ${doc.number}`) : "", esc(when(doc)), "mute")}</table>
${doc.party?.name ? p(`${L.customer}: ${doc.party.name}`) : ""}<hr><table>${rows}</table><hr>
<table>${tr(esc(L.total), m(tot.gross, cur), "tot")}${doc.paid ? tr(esc(doc.paidLabel || L.paid), m(doc.paid, cur)) : ""}${bal ? tr(esc(bal[0]), esc(bal[1])) : ""}</table>
${doc.note ? `<hr>${p(`${L.note}: ${doc.note}`, "mute")}` : ""}<hr>${thanksHtml(L)}`;
}

function moneyBody(doc, L) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, logo = safeLogo(f.logo), bal = balanceRow(doc, L);
  return `<div class="c">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}<h1>${esc(f.name || f.title)}</h1>
${p(f.phone, "mute")}${p(f.address, "mute")}</div><hr><h2 class="c">${esc(L[`${doc.kind}Title`])}</h2>
<table>${tr(doc.number ? esc(`${L.number}: ${doc.number}`) : "", esc(when(doc)), "mute")}</table>
${p(moneyParty(doc, L))}<hr><table>${tr(esc(L.amount), m(doc.amount, cur), "tot")}${rateText(doc) ? tr(esc(L.rate), esc(rateText(doc)), "mute") : ""}
${bal ? tr(esc(bal[0]), esc(bal[1])) : ""}</table>
${doc.note ? `<hr>${p(`${L.note}: ${doc.note}`, "mute")}` : ""}<hr>${thanksHtml(L)}`;
}

const head = (f, logo) => `<div class="c">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}<h1>${esc(f.name || f.title)}</h1>${p(f.phone, "mute")}</div>`;

function statementBody(doc, L) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, pt = doc.party || {}, logo = safeLogo(f.logo);
  const { debit, credit, totalDebit, totalCredit } = statementSections(doc);
  const prev = doc.previous ?? 0;
  const info = [[pt.label || L.customer, pt.name], [L.phone, pt.phone], [L.date, day(doc.date)], [L.stAccountType, L.stCurrentAccount]]
    .filter(([k, v]) => k && v).map(([k, v]) => `<div><span class="lbl">${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  const desc = (r) => `<b>${esc(rowTitle(r, L))}</b>${rowSub(r) ? `<div class="sub">${esc(rowSub(r))}</div>` : ""}`
    + (r.lines ?? []).map((l) => `<div class="it">• ${esc(lineText(l, cur))}</div>`).join("");
  const prevRow = (cols) => `<tr><td class="no">·</td><td><b>${esc(L.previousBalance)}</b></td>${cols === 4 ? "<td></td>" : ""}`
    + `<td class="e ${cols === 4 ? "dr" : "cr"}">${m(Math.abs(prev), cur)}</td></tr>`;
  const none = (cols) => `<tr><td class="no">—</td><td class="sub" colspan="${cols - 1}">${esc(L.stNone)}</td></tr>`;
  const dRows = (prev > 0 ? prevRow(4) : "") + debit.map((r, i) => `<tr><td class="no">${i + 1}</td><td>${desc(r)}</td>`
    + `<td class="e">${r.qty ? esc(qty(r.qty)) : "—"}</td><td class="e dr">${m(r.amount, cur)}</td></tr>`).join("");
  const cRows = (prev < 0 ? prevRow(3) : "") + credit.map((r, i) => `<tr><td class="no">${i + 1}</td><td>${desc(r)}</td>`
    + `<td class="e cr">${m(r.amount, cur)}</td></tr>`).join("");
  const th = (cells) => `<thead><tr>${cells.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead>`;
  const shelf = doc.shelf?.length ? `<h3>${esc(L.onShelf)}</h3><table>${doc.shelf.map((s) => tr(esc(s.name), esc(s.qty))).join("")}</table>` : "";
  return `<header><div>${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}<h1>${esc(f.name || f.title)}</h1>${p(f.phone, "mute")}</div>
<div class="end"><h2>${esc(L.statementTitle)}</h2>${p(when(doc), "mute")}</div></header>
<section class="info">${info}</section>
<h3>${esc(`1. ${doc.debitTitle || ""}`)}</h3><table class="lines">${th(["#", L.stDesc, L.qty, L.amount])}<tbody>${dRows || none(4)}</tbody></table>
<h3>${esc(`2. ${doc.creditTitle || ""}`)}</h3><table class="lines">${th(["#", L.stDesc, L.amount])}<tbody>${cRows || none(3)}</tbody></table>
<section class="sbox"><table>${tr(esc(L.stTotalDebit), `<span class="dr">${m(totalDebit, cur)}</span>`)}${tr(esc(L.stTotalCredit), `<span class="cr">${m(totalCredit, cur)}</span>`)}
${tr(esc(doc.balanceLabel), m(Math.abs(doc.balance), cur), "tot")}</table></section>${shelf}${thanksHtml(L)}`;
}

function summaryBody(doc, L) {
  const f = doc.firm || {};
  return `${head(f, safeLogo(f.logo))}<hr><h2 class="c">${esc(doc.title)}</h2>
<table>${tr(`<b>${esc(doc.subtitle ?? "")}</b>`, esc(when(doc)))}</table><hr>
<table>${doc.rows.map(([a, b]) => tr(esc(a), esc(b))).join("")}</table>
${doc.total ? `<hr><table>${tr(esc(doc.total[0]), esc(doc.total[1]), "tot")}</table>` : ""}
${doc.note ? p(doc.note, "mute") : ""}<hr>${thanksHtml(L)}`;
}

function invoiceBody(doc, L) {
  const cur = doc.currency || "TRY", f = doc.firm || {}, pt = doc.party, tot = invoiceTotals(doc.lines), logo = safeLogo(f.logo);
  const rtl = L.dir === "rtl", bal = balanceRow(doc, L);
  const rows = tot.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="e">${esc(`${qty(l.qty)} ${l.unit || ""}`.trim())}</td>`
    + `<td class="e">${m(unitNet(l), cur)}</td><td class="e">${esc(pct(Number(l.vatRate) || 0, rtl))}</td><td class="e">${m(l.net, cur)}</td></tr>`).join("");
  const party = pt ? `<section class="party"><div class="lbl">${esc(L.customer)}</div><b>${esc(pt.title || pt.name)}</b>
${pt.title && pt.name && pt.title !== pt.name ? p(pt.name) : ""}${p(taxLine(pt, L), "mute")}${p(pt.address, "mute")}${p(pt.phone && `${L.phone}: ${pt.phone}`, "mute")}</section>` : "";
  return `<header><div><h1>${esc(f.title || f.name)}</h1>${p(taxLine(f, L), "mute")}${p(f.address, "mute")}${p(f.phone && `${L.phone}: ${f.phone}`, "mute")}</div>
<div class="end">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}<h2>${esc(L.invoiceTitle)}</h2>
${p(doc.number && `${L.number}: ${doc.number}`, "mute")}${p(when(doc) && `${L.date}: ${when(doc)}`, "mute")}</div></header>${party}
<table class="lines"><thead><tr>${[L.product, L.qty, L.unitPriceNet, L.vat, L.net].map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
<table class="sum">${tr(esc(L.net), m(tot.net, cur))}${tot.byRate.map((r) => tr(`<span class="mute">${esc(`${L.vat} ${pct(r.rate, rtl)}`)} (${m(r.net, cur)})</span>`, m(r.vat, cur))).join("")}
${tr(esc(L.vatTotal), m(tot.vat, cur))}${tr(esc(L.total), m(tot.gross, cur), "tot")}${doc.paid ? tr(esc(L.paid), m(doc.paid, cur)) : ""}${bal ? tr(esc(bal[0]), esc(bal[1])) : ""}</table>
${doc.note ? `<p style="margin-top:12px" class="mute">${esc(`${L.note}: ${doc.note}`)}</p>` : ""}<p class="disc">${esc(L.disclaimer)}</p>`;
}

export function receiptHtml(doc, labels) {
  const L = labels || {}, invoice = doc.kind === "invoice", dir = L.dir === "rtl" ? "rtl" : "ltr";
  const moneyDoc = MONEY_KINDS.includes(doc.kind);
  const heading = invoice ? L.invoiceTitle : moneyDoc ? L[`${doc.kind}Title`]
    : doc.kind === "statement" ? L.statementTitle : doc.kind === "summary" ? doc.title : doc.title || L.receiptTitle;
  const title = `${heading} ${doc.number ?? ""}`.trim();
  const body = invoice ? invoiceBody(doc, L) : moneyDoc ? moneyBody(doc, L)
    : doc.kind === "statement" ? statementBody(doc, L) : doc.kind === "summary" ? summaryBody(doc, L) : receiptBody(doc, L);
  return `<!doctype html><html dir="${dir}" lang="${dir === "rtl" ? "ar" : "tr"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;800&family=Tajawal:wght@400;500;800&display=swap">
<style>${BASE_CSS}${invoice ? INVOICE_CSS : doc.kind === "statement" ? INVOICE_CSS + STATEMENT_CSS : L.paper === "58" ? RECEIPT_CSS.replaceAll("80mm", "58mm") : RECEIPT_CSS}</style></head><body>${body}</body></html>`;
}

// Gizli iframe'e koyup yazdırır; bitince (afterprint ya da 60 sn) iframe kaldırılır.
export function printReceipt(doc, labels) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0";
    let done = false;
    const cleanup = () => { if (!done) { done = true; frame.remove(); resolve(); } };
    frame.onload = async () => {
      const w = frame.contentWindow;
      try {
        await Promise.race([w.document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
        w.addEventListener("afterprint", () => setTimeout(cleanup, 100));
        w.focus();
        w.print();
      } catch { cleanup(); }
      setTimeout(cleanup, 60000);
    };
    frame.srcdoc = receiptHtml(doc, labels);
    document.body.append(frame);
  });
}
