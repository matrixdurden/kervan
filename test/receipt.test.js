import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceTotals, waPhone, whatsappUrl, receiptHtml, jpegPdf, RECEIPT_LABEL_KEYS } from "../public/receipt.js";

const labels = {
  dir: "ltr", receiptTitle: "Satış Fişi", invoiceTitle: "Fatura Bilgisi", number: "No", date: "Tarih",
  customer: "Müşteri", taxOffice: "Vergi Dairesi", taxNo: "Vergi No", phone: "Telefon", address: "Adres",
  product: "Ürün", qty: "Miktar", unitPrice: "Birim fiyat", unitPriceNet: "Birim fiyat (KDV hariç)", vat: "KDV",
  lineTotal: "Tutar", net: "Net", vatTotal: "Toplam KDV", total: "Toplam", paid: "Ödenen",
  balanceOwed: "Kalan borç", balanceCredit: "Alacak", note: "Not", thanks: "Teşekkürler",
  disclaimer: "Bu belge e-Fatura / e-Arşiv fatura yerine geçmez.",
  paymentTitle: "Ödeme Makbuzu", collectionTitle: "Tahsilat Makbuzu", paidTo: "Ödeme yapılan", receivedFrom: "Ödeyen",
  amount: "Tutar", rate: "Kur", statementTitle: "Hesap Ekstresi", previousBalance: "Önceki bakiye", onShelf: "Emanetteki mal",
  returnTitle: "İade Fişi", refunded: "Geri verilen", refundTitle: "Para İadesi Makbuzu",
};

const doc = (kind, lines) => ({
  kind, number: "S-12", date: "2026-10-25", time: "14:05", currency: "TRY",
  firm: { name: "Kervan Toptan", title: "Kervan Gıda Ltd. Şti.", taxOffice: "Kadıköy", taxNo: "1234567890", address: "İstanbul", phone: "0532 000 00 00", logo: "" },
  party: { name: "Ayşe", title: "", taxOffice: "", taxNo: "", address: "", phone: "" },
  lines, paid: 5000, balanceAfter: 12000, note: "",
});

test("invoiceTotals: karışık oranlarda satır başına net + KDV = brüt", () => {
  const r = invoiceTotals([
    { name: "Çay", qty: 3, unit: "adet", price: 1999, vatRate: 20 },
    { name: "Un", qty: 2.5, unit: "kg", price: 333, vatRate: 10 },
    { name: "Kitap", qty: 1, unit: "adet", price: 10000, vatRate: 0 },
    { name: "Şeker", qty: 1, unit: "kg", price: 101, vatRate: 20 },
  ]);
  assert.deepEqual(r.lines.map((l) => [l.gross, l.net, l.vat]), [
    [5997, 4998, 999], // 5997 / 1,2 = 4997,5 → 4998
    [833, 757, 76], // 2,5 × 333 = 832,5 → 833; 833 / 1,1 = 757,27
    [10000, 10000, 0],
    [101, 84, 17],
  ]);
  for (const l of r.lines) assert.equal(l.net + l.vat, l.gross);
  assert.deepEqual(r.byRate, [
    { rate: 0, net: 10000, vat: 0, gross: 10000 },
    { rate: 10, net: 757, vat: 76, gross: 833 },
    { rate: 20, net: 5082, vat: 1016, gross: 6098 },
  ]);
  assert.equal(r.gross, 5997 + 833 + 10000 + 101);
  assert.equal(r.net + r.vat, r.gross);
  assert.equal(r.byRate.reduce((a, b) => a + b.gross, 0), r.gross);
  assert.equal(r.lines[0].name, "Çay");
});

test("invoiceTotals: boş liste sıfır döner", () => {
  assert.deepEqual(invoiceTotals([]), { lines: [], byRate: [], net: 0, vat: 0, gross: 0 });
});

test("waPhone: Türkiye biçimleri", () => {
  for (const s of ["+90 532 123 45 67", "0090 532 123 45 67", "0532 123 45 67", "(0532) 123-45-67",
    "532 123 45 67", "905321234567", "+90 (0532) 123 45 67"]) {
    assert.equal(waPhone(s), "905321234567", s);
  }
});

test("waPhone: yabancı numara ve bozuk girdi", () => {
  assert.equal(waPhone("+49 151 2345 6789"), "4915123456789");
  assert.equal(waPhone("0049 151 2345 6789"), "4915123456789");
  for (const s of ["", null, undefined, "abc", "12345", "0532 123", "+90 532 12"]) assert.equal(waPhone(s), null, String(s));
});

test("whatsappUrl: Türkçe metin ve satır sonu kodlanır", () => {
  const text = "Merhaba Ayşe\nToplam: ₺1.250,50";
  const enc = "Merhaba%20Ay%C5%9Fe%0AToplam%3A%20%E2%82%BA1.250%2C50";
  assert.equal(whatsappUrl("0532 123 45 67", text), `https://wa.me/905321234567?text=${enc}`);
  assert.equal(whatsappUrl(null, text), `https://wa.me/?text=${enc}`);
});

test("RECEIPT_LABEL_KEYS tam liste", () => {
  assert.deepEqual([...RECEIPT_LABEL_KEYS].sort(), Object.keys(labels).sort());
  assert.equal(new Set(RECEIPT_LABEL_KEYS).size, 37);
});

test("receiptHtml: hesap ekstresi satırlar, önceki ve güncel bakiye, emanet", () => {
  const st = {
    kind: "statement", date: "2026-10-26", time: "14:10", currency: "USD",
    firm: { name: "Kervan Toptan", logo: "" }, party: { name: "Doğu <Elektronik>", phone: "" },
    previous: 0,
    rows: [
      { date: "2026-10-20", label: "Alış", detail: "Kulaklık 10 adet", amount: 97848, sign: "+", balance: 97848 },
      { date: "2026-10-26", label: "Ödeme", detail: "1 USD = ₺49.738", amount: 20000, sign: "−", balance: 77848 },
    ],
    balance: 77848, balanceLabel: "Biz borçluyuz", shelf: [{ name: "Çay", qty: "5 paket" }],
  };
  const html = receiptHtml(st, labels);
  assert.ok(html.includes("Hesap Ekstresi") && html.includes("Doğu &lt;Elektronik&gt;"));
  assert.ok(html.includes("20.10.2026  Alış") && html.includes("26.10.2026  Ödeme"));
  assert.ok(html.includes("Önceki bakiye") && html.includes("Biz borçluyuz") && html.includes("Emanetteki mal"));
  const sum = receiptHtml({ kind: "summary", title: "Ortak Hesap Özeti", subtitle: "Ali", date: "2026-10-26", firm: { name: "K" },
    rows: [["Dönem", "Bu ay"], ["Kâr payı", "₺100"]], total: ["Toplam hakkı", "₺500"] }, labels);
  assert.ok(sum.includes("Ortak Hesap Özeti") && sum.includes("Kâr payı") && sum.includes("Toplam hakkı"));
});

test("receiptHtml: ödeme makbuzu tutar, kur ve kalan borcu yazar", () => {
  const pay = {
    kind: "payment", number: "20261026-AB12", date: "2026-10-26", time: "13:20", currency: "USD", rate: 49.738,
    firm: { name: "Kervan Toptan", logo: "" }, party: { name: "Doğu <Elektronik>", phone: "" },
    amount: 10000, balanceAfter: 47848, note: "",
  };
  const html = receiptHtml(pay, labels);
  assert.ok(html.includes("Ödeme Makbuzu"));
  assert.ok(html.includes("Ödeme yapılan: Doğu &lt;Elektronik&gt;"));
  assert.ok(html.includes("$100.00") || html.includes("$100,00"));
  assert.ok(html.includes("1 USD = ₺49,738"));
  assert.ok(html.includes("Kalan borç"));
  assert.ok(!html.includes(labels.disclaimer));
  const col = receiptHtml({ ...pay, kind: "collection", currency: "TRY", rate: null, balanceAfter: -500 }, labels);
  assert.ok(col.includes("Tahsilat Makbuzu") && col.includes("Ödeyen: Doğu") && col.includes("Alacak"));
  assert.ok(!col.includes("Kur"));
});

test("receiptHtml: ürün adı kaçırılır, uyarı yalnız faturada", () => {
  const lines = [{ name: "<script>alert(1)</script>", qty: 2, unit: "adet", price: 1500, vatRate: 20 }];
  const fis = receiptHtml(doc("receipt", lines), labels);
  const fatura = receiptHtml(doc("invoice", lines), labels);
  for (const html of [fis, fatura]) {
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  }
  assert.ok(fatura.includes(labels.disclaimer));
  assert.ok(!fis.includes(labels.disclaimer));
  assert.ok(fis.includes("size:80mm auto"));
  assert.ok(fatura.includes("size:A4"));
  assert.ok(fis.includes("₺30,00") && fis.includes("Kalan borç") && fis.includes("Teşekkürler"));
  assert.ok(fatura.includes("₺25,00") && fatura.includes("₺5,00")); // net + KDV %20
});

test("receiptHtml: sağdan sola ve logo süzgeci", () => {
  const d = doc("receipt", []);
  d.firm.logo = "javascript:alert(1)";
  const html = receiptHtml(d, { ...labels, dir: "rtl" });
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(!html.includes("javascript:"));
  d.firm.logo = "data:image/png;base64,iVBORw0KGgo=";
  assert.ok(receiptHtml(d, labels).includes('src="data:image/png;base64,iVBORw0KGgo="'));
});

test("receiptHtml: iade fişi kendi başlığıyla, geri verilen para; para iadesi makbuzu", () => {
  const ret = { ...doc("receipt", [{ name: "Çay", qty: 1, unit: "paket", price: 15000, vatRate: 20 }]), title: "İade Fişi", paid: 15000, paidLabel: "Geri verilen" };
  const html = receiptHtml(ret, labels);
  assert.match(html, /<h2 class="c">İade Fişi<\/h2>/);
  assert.match(html, /Geri verilen/);
  assert.doesNotMatch(html, /Satış Fişi/);
  const refund = receiptHtml({ kind: "refund", number: "R-1", date: "2026-10-26", currency: "TRY", firm: { name: "K" }, party: { name: "Ali" }, amount: 15000 }, labels);
  assert.match(refund, /Para İadesi Makbuzu/);
  assert.match(refund, /Ödeme yapılan: Ali/);
});

test("jpegPdf: geçerli tek sayfalık PDF, xref adresleri nesnelerin başını gösterir", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const pdf = jpegPdf(jpeg, 1152, 800, 432, 300);
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.match(text, /\/MediaBox \[0 0 432 300\]/);
  assert.match(text, /\/Width 1152 \/Height 800 .*\/Length 7 >>/);
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o)));
  const start = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.startsWith("xref", start));
  assert.ok(text.includes(Buffer.from(jpeg).toString("latin1")));
});

test("whatsappUrl: seçilen WhatsApp (normal / Business) Android paket adıyla açılır", () => {
  assert.equal(whatsappUrl("0532 111 22 33", "a b", "b"), "intent://send/?phone=905321112233&text=a%20b#Intent;scheme=whatsapp;package=com.whatsapp.w4b;end");
  assert.equal(whatsappUrl(null, "x", "w"), "intent://send/?text=x#Intent;scheme=whatsapp;package=com.whatsapp;end");
  assert.equal(whatsappUrl("0532 111 22 33", "x", ""), "https://wa.me/905321112233?text=x");
});
