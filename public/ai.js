// Anahtarsız fatura okuma: fatura, işletmenin Cloudflare Worker'ına (worker/index.js) gider; o da
// Cloudflare Workers AI'ın ücretsiz kotasıyla okur. Kullanıcı hiçbir anahtar girmez; Worker isteği
// sadece Google ile girmiş kullanıcının Firebase kimlik jetonuyla kabul eder. Kota tüm işletmeler
// için ortaktır ve günlük sınıra gelince durur (para çıkmaz).
// Fotoğraf telefonda küçültülüp JPEG olarak, PDF ise metni varsa metin olarak (yoksa sayfaları
// resme çevrilerek) gönderilir; böylece hem istek küçük kalır hem kota daha uzun yeter.

import { auth, isLocal } from "./firebase.js";
import { aiReaderUrl } from "./firebase-config.js";
import { aiFileType, parseAiText } from "./invoice.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";
const MAX_SIDE = 1600; // görselin uzun kenarı (px)
const MAX_PAGES = 3;
const MIN_TEXT = 80; // bundan az harf varsa PDF taranmış sayılır, resme çevrilir

export const sharedAiReady = () => Boolean(aiReaderUrl) && !isLocal;

const codeError = (code) => Object.assign(new Error(code), { code });

function toJpeg(canvas) {
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Görseli (ImageBitmap ya da canvas) uzun kenarı MAX_SIDE olacak şekilde küçültür.
function scaled(source) {
  const k = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * k);
  canvas.height = Math.round(source.height * k);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imagePayload(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw codeError("ai-unsupported"); } // ör. HEIC çoğu tarayıcıda açılmaz
  try { return { image: toJpeg(scaled(bitmap)) }; } finally { bitmap.close?.(); }
}

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

async function pdfPayload(file) {
  const { getDocument } = await loadPdfJs();
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) pages.push(await pdf.getPage(i));
    // Dijital PDF: metin katmanı satır satır (aynı yükseklikteki parçalar bir satır).
    const texts = [];
    for (const page of pages) {
      const rows = new Map();
      for (const item of (await page.getTextContent()).items) {
        if (!item.str?.trim()) continue;
        const y = Math.round(item.transform[5]);
        rows.set(y, [...(rows.get(y) ?? []), item]);
      }
      texts.push([...rows.entries()].sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.transform[4] - b.transform[4]).map((it) => it.str.trim()).join("  "))
        .join("\n"));
    }
    const text = texts.join("\n\n");
    if ((text.match(/\p{L}/gu) ?? []).length >= MIN_TEXT) return { text };
    // Taranmış PDF: sayfalar alt alta tek resim.
    const canvases = [];
    for (const page of pages) {
      const view = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, MAX_SIDE / Math.max(view.width, view.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      canvases.push(canvas);
    }
    const sheet = document.createElement("canvas");
    sheet.width = Math.max(...canvases.map((c) => c.width));
    sheet.height = canvases.reduce((sum, c) => sum + c.height, 0);
    const g = sheet.getContext("2d");
    let y = 0;
    for (const c of canvases) { g.drawImage(c, 0, y); y += c.height; }
    return { image: toJpeg(scaled(sheet)) };
  } finally {
    pdf.destroy();
  }
}

export async function readInvoiceShared(file) {
  if (!sharedAiReady()) throw codeError("ai-no-key");
  const mime = await aiFileType(file);
  const payload = mime === "application/pdf" ? await pdfPayload(file) : await imagePayload(file);
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw codeError("ai-setup");
  let res;
  try {
    res = await fetch(aiReaderUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw codeError("ai-network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw codeError(data?.error ?? (res.status === 429 ? "ai-quota" : "ai-failed"));
  return parseAiText(data?.text);
}
