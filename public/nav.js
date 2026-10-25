// Ekranlar arası geçiş ve açılış ekranı.

import { $ } from "./ui.js";

const SCREENS = ["login", "firms", "firm", "party"];

export function show(screen) {
  for (const id of SCREENS) $(`#${id}`).hidden = id !== screen;
  if (screen !== "loading") hideLoader();
  scrollTo(0, 0);
}

// Açılış ekranını fontlar hazır olunca (en fazla 0,7 sn bekleyerek) yumuşakça kaldırır.
let loaderGone = false;
function hideLoader() {
  if (loaderGone) return;
  loaderGone = true;
  const el = $("#loading");
  const fontsReady = Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 700))]);
  fontsReady.then(() => {
    el.classList.add("fade");
    setTimeout(() => el.remove(), 400);
  });
}
