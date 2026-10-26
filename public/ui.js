// Ekran yardımcıları: DOM oluşturma, ikonlar, avatarlar, bildirim, tarih.

import { lang } from "./i18n.js";

export const $ = (sel) => document.querySelector(sel);

export const store = {
  get(key) {
    try { return localStorage.getItem(`kervan.${key}`); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`kervan.${key}`);
      else localStorage.setItem(`kervan.${key}`, value);
    } catch { /* gizli sekme vb. */ }
  },
};

// Güvenli DOM oluşturucu: metinler her zaman textContent olarak eklenir.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value ?? "";
    else if (value === true) el.setAttribute(key, "");
    else if (value != null && value !== false) el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  box: '<path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 8v8l8 4 8-4V8"/><path d="M12 12v8"/>',
  store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5 11v9h14v-9"/>',
  truck: '<path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  in: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  out: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2-.4-2.5-1.2M12 6.5v1.5M12 16v1.5"/>',
  flag: '<path d="M6 20V4"/><path d="M6 5h11l-2 4 2 4H6"/>',
  phone: '<path d="M6 3h3l1.5 4.5-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2L21 15v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  wallet: '<path d="M4 7a2 2 0 0 1 2-2h11v4"/><path d="M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.3"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.3a3 3 0 0 1 0 5.4M17.5 13.6A5.5 5.5 0 0 1 20.5 19"/>',
  send: '<path d="M4 12h12"/><path d="M12 7l5 5-5 5"/><path d="M20 5v14"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12l2 2 4-4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  minusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
  swap: '<path d="M4 8h14l-3-3"/><path d="M20 16H6l3 3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v12M14 6v12M16 6v12M20 6v12"/><path d="M2 4v3M2 17v3M22 4v3M22 17v3"/>',
  contact: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  fileScan: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h4"/><path d="M17.5 2.5l1 1.5 1.5 1"/>',
  whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8.4 19z"/><path d="M9 8.5c0 3 2.5 6.5 6.5 6.5l1-1.5-2-1-1 1c-1-.5-2.5-2-3-3l1-1-1-2z"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
};

export function icon(name) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  if (name === "back" || name === "chevron") el.classList.add("flip");
  el.innerHTML = ICONS[name];
  return el;
}

export function iconButton(name, label, onclick) {
  return h("button", { type: "button", class: "icon", "aria-label": label, title: label, onclick }, icon(name));
}

// Ortak renkleri. Bir işletmede herkes farklı bir renk alır (bkz. app.js ensureProfile).
export const PALETTE = ["#1F7A72", "#C8742F", "#3D4F7A", "#9C4F8B", "#5C8A2E", "#B5473A", "#3F8FB5", "#8A6A2F"];

const initial = (name) => (name || "?").trim().charAt(0).toLocaleUpperCase("tr");

export function avatar(person, size = "") {
  return h("span", { class: `av ${size}`, style: `--c:${person.color}`, title: person.name, "aria-hidden": "true" },
    initial(person.name));
}

export function avatarStack(people, max = 5) {
  return h("span", { class: "stack" }, people.slice(0, max).map((p) => avatar(p, "sm")));
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // karışan 0/O, 1/I/L yok
export const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint32Array(6)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
export const normalizeCode = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (c) => `${c.slice(0, 3)}-${c.slice(3)}`;

export const millis = (t) => t?.toMillis?.() ?? 0;

// Yerel tarih "2026-10-25" biçiminde (hareketlerin iş günü).
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Tarihler arayüz dilinde, rakamlar her dilde 0-9 (ortaklar aynı rakamları görsün).
export const dateLocale = () => (lang === "ar" ? "ar-u-nu-latn" : "tr-TR");

// "2026-10-25" → "25 Eki" (bu yıl) / "25 Eki 2025"
export function formatDay(date) {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  const opts = y === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(dateLocale(), opts).format(new Date(y, m - 1, d));
}

// "2026-10" → "Ekim 2026"
export function formatMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(dateLocale(), { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
}

// Bildirim "popover" olarak açılır ki açık bir formun (dialog) üstünde de görünsün.
let toastTimer;
export function toast(message, undo) {
  const el = $("#toast");
  const btn = el.querySelector("button");
  const hide = () => (el.hidePopover ? el.matches(":popover-open") && el.hidePopover() : (el.hidden = true));
  el.querySelector("span").textContent = message;
  btn.hidden = !undo;
  btn.onclick = () => { hide(); undo(); };
  if (el.showPopover) {
    hide(); // yeniden açınca en üste gelir
    el.showPopover();
  } else {
    el.hidden = false;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, undo ? 5000 : 3000);
}
