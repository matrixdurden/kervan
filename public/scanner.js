// Barkod okutma: telefonun arka kamerası açılır, barkod görülünce kapanır.
// Tarayıcının kendi BarcodeDetector'ı varsa (Android Chrome) o kullanılır; yoksa (iPhone Safari,
// masaüstü) aynı arayüzü sunan zxing tabanlı kütüphane ilk kullanımda yüklenir.

import { $, toast } from "./ui.js";
import { t } from "./i18n.js";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];
const PONYFILL = "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js";

let detector = null;

async function getDetector() {
  if (detector) return detector;
  if ("BarcodeDetector" in window) {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    if (formats.length) return (detector = new window.BarcodeDetector({ formats }));
  }
  const { BarcodeDetector } = await import(PONYFILL);
  return (detector = new BarcodeDetector({ formats: FORMATS }));
}

export const canScan = () => Boolean(navigator.mediaDevices?.getUserMedia);

// Okunan barkodu döner; vazgeçilirse ya da kamera açılamazsa null.
export function scanBarcode() {
  const dialog = $("#scanner");
  const video = dialog.querySelector("video");
  let stream = null;
  let timer = null;
  let done = false;

  return new Promise((resolve) => {
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.onclose = () => finish(null);
    dialog.querySelector("[data-close]").onclick = () => finish(null);
    dialog.showModal();

    const loop = async () => {
      if (done) return;
      try {
        if (video.readyState >= 2) {
          const [hit] = await detector.detect(video);
          if (hit?.rawValue) {
            navigator.vibrate?.(60);
            finish(hit.rawValue);
            return;
          }
        }
      } catch { /* bir kare okunamadı; devam */ }
      timer = setTimeout(loop, 180);
    };

    Promise.all([
      getDetector(),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
    ]).then(([, s]) => {
      stream = s;
      if (done) return finish(null);
      video.srcObject = s;
      video.play().catch(() => {});
      loop();
      return undefined;
    }).catch((err) => {
      console.error(err);
      toast(t(err?.name === "NotAllowedError" ? "cameraDenied" : "cameraFailed"));
      finish(null);
    });
  });
}
