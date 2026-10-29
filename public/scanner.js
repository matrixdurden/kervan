// Barkod okutma: telefonun arka kamerası açılır. Tek okuma (scanBarcode) barkod görülünce kapanır;
// sürekli okuma (scanMany) kamera üstte açık kalır, altında seçilen ürünler görünür, her okunan ürün
// bir artar ve "Tamam" (satışta "Satışı tamamla") ile forma dönülür. Okununca kasa gibi "bip" sesi;
// tanınmayan barkodda alçak iki ses.
// Tarayıcının kendi BarcodeDetector'ı varsa (Android Chrome) o kullanılır; yoksa (iPhone Safari,
// masaüstü) aynı arayüzü sunan zxing tabanlı kütüphane ilk kullanımda yüklenir.

import { $, toast } from "./ui.js";
import { t } from "./i18n.js";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];
const PONYFILL = "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js";
const SAME_CODE_GAP = 1200; // aynı barkod kadrajda kaldıkça tekrar sayılmaz; bu kadar ms görünmezse sayılır

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

// Ses: dokunuşla (okutma düğmesi) açılır ki telefon sonradan çalmasına izin versin.
let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume().catch(() => {});
  } catch { audio = null; }
}

export function beep(ok = true) {
  if (!audio) return;
  try {
    const tones = ok ? [[1900, 0, 0.09]] : [[440, 0, 0.12], [330, 0.17, 0.16]];
    for (const [f, at, len] of tones) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "square";
      o.frequency.value = f;
      const t0 = audio.currentTime + at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + len + 0.02);
    }
  } catch { /* ses çalınamadı */ }
}

// Kamerayı açar ve kareleri okur. onHit(barkod) true dönerse okuma biter ve promise o barkodla çözülür;
// pencere kapanınca null. ready(finish): dışarıdan bitirmek için.
function runCamera(dialog, onHit, ready) {
  const video = dialog.querySelector("video");
  let stream = null;
  let timer = null;
  let done = false;
  unlockAudio();

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
    ready?.(finish);
    dialog.onclose = () => finish(null);
    dialog.querySelectorAll("[data-close]").forEach((b) => { b.onclick = () => finish(null); });
    dialog.showModal();

    const loop = async () => {
      if (done) return;
      try {
        if (video.readyState >= 2) {
          const [hit] = await detector.detect(video);
          if (hit?.rawValue && onHit(hit.rawValue)) {
            finish(hit.rawValue);
            return;
          }
        }
      } catch { /* bir kare okunamadı; devam */ }
      timer = setTimeout(loop, 150);
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

// Okunan barkodu döner; vazgeçilirse ya da kamera açılamazsa null.
export function scanBarcode() {
  const dialog = $("#scanner");
  dialog.classList.remove("multi");
  return runCamera(dialog, () => {
    beep(true);
    navigator.vibrate?.(60);
    return true;
  });
}

// Sürekli okuma. panel: kameranın altında gösterilecek öğe (seçilenler, arama…); done: alttaki düğmenin
// yazısı. onCode(barkod) her yeni okumada çağrılır; false dönerse "tanınmadı" sesi çalar.
// Dönüş: { closed: Promise, pause(evet/hayır), close() }. Duraklatılmışken (ör. yeni ürün formu açık)
// okunanlar sayılmaz.
export function scanMany({ panel, done, onCode }) {
  const dialog = $("#scanner");
  dialog.classList.add("multi");
  dialog.querySelector(".scan-panel").replaceChildren(panel);
  dialog.querySelector("[data-done]").textContent = done;
  let paused = false;
  let last = "";
  let lastSeen = 0;
  let finish = () => {};
  const closed = runCamera(dialog, (code) => {
    const now = Date.now();
    const repeat = code === last && now - lastSeen < SAME_CODE_GAP;
    last = code;
    lastSeen = now;
    if (repeat || paused) return false;
    const ok = onCode(code) !== false;
    beep(ok);
    navigator.vibrate?.(ok ? 40 : [60, 50, 60]);
    return false;
  }, (f) => { finish = f; }).then(() => {
    dialog.classList.remove("multi");
    dialog.querySelector(".scan-panel").replaceChildren();
  });
  return {
    closed,
    pause: (on) => { paused = on; if (!on) last = ""; },
    close: () => finish(null),
  };
}
