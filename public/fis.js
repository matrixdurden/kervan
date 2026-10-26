// Fiş bağlantısı (/r/{kod}): müşterinin WhatsApp'tan açtığı sayfa. Giriş gerekmez; shared/{kod}
// belgesi okunur, fiş resim olarak çizilir, PDF / resim indirilir ya da yazdırılır.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "/firebase-config.js";
import { receiptCanvas, receiptPdf, downloadBlob, printReceipt } from "/receipt.js";

const TEXT = {
  tr: {
    loading: "Fiş yükleniyor…", missing: "Fiş bulunamadı. Bağlantı eksik ya da fiş silinmiş olabilir.",
    failed: "Fiş açılamadı. İnternet bağlantını kontrol edip sayfayı yenile.", pdf: "PDF indir", image: "Resim indir", print: "Yazdır",
  },
  ar: {
    loading: "جارٍ تحميل الإيصال…", missing: "لم يُعثر على الإيصال. ربما الرابط ناقص أو حُذف الإيصال.",
    failed: "تعذّر فتح الإيصال. تحقّق من الاتصال ثم حدّث الصفحة.", pdf: "تنزيل PDF", image: "تنزيل الصورة", print: "طباعة",
  },
};

const $ = (id) => document.getElementById(id);
const status = (s) => { $("status").textContent = s; $("status").hidden = !s; };
let T = TEXT[navigator.language?.startsWith("ar") ? "ar" : "tr"];
status(T.loading);

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const app = initializeApp(isLocal ? { ...firebaseConfig, apiKey: "demo-key", projectId: "demo-kervan" } : firebaseConfig);
const db = getFirestore(app);
if (isLocal) connectFirestoreEmulator(db, location.hostname, 8080);

// Kod adresin sonundadır: /r/AbC… (ya da fis.html?id=AbC…).
const id = location.pathname.match(/^\/r\/([A-Za-z0-9]{20,40})\/?$/)?.[1] ?? new URLSearchParams(location.search).get("id");

async function show() {
  if (!id) return status(T.missing);
  let snap;
  try {
    snap = await getDoc(doc(db, "shared", id));
  } catch (err) {
    console.error(err);
    return status(T.failed);
  }
  if (!snap.exists()) return status(T.missing);
  const { doc: receipt, labels, lang } = snap.data();
  T = TEXT[lang] ?? T;
  document.documentElement.lang = lang === "ar" ? "ar" : "tr";
  document.documentElement.dir = labels.dir === "rtl" ? "rtl" : "ltr";
  const heading = receipt.kind === "statement" ? labels.statementTitle : receipt.kind === "summary" ? receipt.title
    : receipt.title || labels[`${receipt.kind}Title`] || labels.receiptTitle;
  document.title = [receipt.firm?.name, heading].filter(Boolean).join(" · ");
  const name = `${heading || "fis"}-${receipt.number || receipt.date || id.slice(0, 6)}`.replace(/[\\/:*?"<>|\s]+/g, "-");

  const canvas = await receiptCanvas(receipt, labels);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", document.title);
  $("paper").replaceChildren(canvas);
  status("");

  $("pdf").textContent = T.pdf;
  $("image").textContent = T.image;
  $("print").textContent = T.print;
  $("pdf").onclick = async () => downloadBlob(await receiptPdf(receipt, labels), `${name}.pdf`);
  $("image").onclick = () => canvas.toBlob((b) => b && downloadBlob(b, `${name}.png`), "image/png");
  $("print").onclick = () => printReceipt(receipt, labels);
  document.querySelector(".actions").hidden = false;
}

show();
