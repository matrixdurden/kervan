// "Telefona yükle" butonları.
// Android/masaüstü Chrome tarayıcının kendi yükleme penceresini açar (beforeinstallprompt);
// iPhone'da bu yok, onun yerine Safari'de ana ekrana ekleme adımlarını gösteririz.

import { $, store } from "./ui.js";

let deferredPrompt = null;

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// iPadOS kendini Mac olarak tanıtır; dokunmatik ekran ile ayırt edilir.
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function update() {
  const can = !isStandalone() && (deferredPrompt !== null || isIOS);
  $("#install-login").hidden = !can;
  $("#install-card").hidden = !can || store.get("installDismissed") === "1";
}

async function install() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") deferredPrompt = null;
    update();
  } else if (isIOS) {
    $("#ios-install").showModal();
  }
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // tarayıcının kendi küçük çubuğu yerine bizim butonumuz
  deferredPrompt = e;
  update();
});

addEventListener("appinstalled", () => {
  deferredPrompt = null;
  update();
});

$("#install-login").addEventListener("click", install);
$("#install-card-button").addEventListener("click", install);
$("#install-card-close").addEventListener("click", () => {
  store.set("installDismissed", "1");
  update();
});

update();
