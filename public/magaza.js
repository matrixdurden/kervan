// Online mağaza (vitrin): /m/{adres}. Giriş gerekmez. Ürünler shops/{adres}/items'tan okunur; müşteri
// sepete ekler, adını yazar ve siparişi ya WhatsApp'tan (dükkânın sohbeti doğrudan açılır, mesajda
// siparişin fotoğraf/PDF bağlantısı vardır) ya da doğrudan gönderir. İki yolda da sipariş
// shops/{adres}/orders'a düşer ve uygulamada "Siparişler"de görünür.
// /m/{adres}/o/{sipariş}: siparişin fişi (resim, PDF indir).

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig, aiReaderUrl } from "/firebase-config.js";
import { formatMoney } from "/money.js";
import { receiptCanvas, receiptPdf, downloadBlob, whatsappUrl, waPhone } from "/receipt.js";

const TEXT = {
  tr: {
    eyebrow: "ONLINE MAĞAZA", title: "Online Mağaza", search: "Ne arıyorsun?", all: "Tümü", products: "Ürünler", items: "{n} ürün",
    soldOut: "Tükendi", ask: "Fiyat için sorun", add: "Sepete ekle", added: "Sepete eklendi", noMatch: "Aradığın ürün bulunamadı.",
    noProducts: "Vitrinde henüz ürün yok.", cart: "Sepetin", cartCount: "{n} ürün", seeCart: "Sepeti gör", emptyCart: "Sepetin boş.",
    total: "Toplam", name: "Adın soyadın", phone: "Telefonun", note: "Not (isteğe bağlı)", notePh: "Adres, teslim zamanı…",
    sendWa: "WhatsApp ile sipariş ver", sendDirect: "Siparişi doğrudan gönder",
    orderHint: "Sipariş dükkâna iletilir; sana dönüş yapabilmeleri için telefonunu yaz.",
    needName: "Adını yaz.", failed: "Sipariş gönderilemedi. İnternet bağlantını kontrol edip tekrar dene.",
    doneTitle: "Siparişin alındı", doneText: "Dükkân siparişini gördü; en kısa sürede sana dönecek.", code: "Sipariş no {code}",
    pdf: "PDF indir", image: "Resim indir", back: "Alışverişe dön", close: "Kapat",
    closed: "Mağaza şu an kapalı.", missing: "Mağaza bulunamadı.", loadFailed: "Mağaza açılamadı. İnternet bağlantını kontrol edip sayfayı yenile.",
    orderMissing: "Sipariş bulunamadı.", orderTitle: "Sipariş", waOrder: "Yeni sipariş", orderLink: "Siparişin fotoğrafı ve PDF'i",
    rc: { receiptTitle: "Sipariş", number: "No", customer: "Müşteri", total: "Toplam", paid: "Ödenen", note: "Not", thanks: "Teşekkür ederiz", balanceOwed: "Kalan", balanceCredit: "Alacak" },
    madeWith: "kervan ile hazırlandı",
    install: "Uygulamayı telefona yükle", installIos: "Yüklemek için: Paylaş düğmesi → Ana Ekrana Ekle",
    installAndroid: "Uygulama olarak yüklemek için: sayfayı Chrome'da aç, sağ üstteki ⋮ menüsünden \"Uygulamayı yükle\" ya da \"Ana ekrana ekle\".",
    installDesktop: "Bilgisayarda (Chrome ya da Edge): adres çubuğunun sağındaki yükle simgesine ya da tarayıcının ⋮ menüsünden \"Yükle\" / \"Uygulamayı yükle\"ye tıkla.",
    installPreview: "Bu, mağazanın önizlemesi. Müşterin mağaza bağlantısını telefonunda açınca bu düğmeyle mağazayı uygulama olarak yükler.",
    installDone: "Yüklenince mağaza, telefonun ya da bilgisayarın ana ekranında kendi simgesiyle açılır.",
  },
  ar: {
    eyebrow: "متجر إلكتروني", title: "متجر إلكتروني", search: "عمّ تبحث؟", all: "الكل", products: "المنتجات", items: "{n} منتج",
    soldOut: "نفد", ask: "اسأل عن السعر", add: "أضف إلى السلة", added: "أضيف إلى السلة", noMatch: "لم يُعثر على المنتج.",
    noProducts: "لا توجد منتجات في المتجر بعد.", cart: "سلتك", cartCount: "{n} منتج", seeCart: "عرض السلة", emptyCart: "سلتك فارغة.",
    total: "المجموع", name: "اسمك", phone: "هاتفك", note: "ملاحظة (اختياري)", notePh: "العنوان، وقت التسليم…",
    sendWa: "اطلب عبر واتساب", sendDirect: "أرسل الطلب مباشرة",
    orderHint: "يصل الطلب إلى المتجر؛ اكتب هاتفك ليتواصلوا معك.",
    needName: "اكتب اسمك.", failed: "تعذّر إرسال الطلب. تحقّق من الاتصال وحاول مجددًا.",
    doneTitle: "تم استلام طلبك", doneText: "رأى المتجر طلبك وسيتواصل معك قريبًا.", code: "رقم الطلب {code}",
    pdf: "تنزيل PDF", image: "تنزيل الصورة", back: "متابعة التسوق", close: "إغلاق",
    closed: "المتجر مغلق حاليًا.", missing: "لم يُعثر على المتجر.", loadFailed: "تعذّر فتح المتجر. تحقّق من الاتصال ثم حدّث الصفحة.",
    orderMissing: "لم يُعثر على الطلب.", orderTitle: "طلب", waOrder: "طلب جديد", orderLink: "صورة الطلب وملف PDF",
    rc: { receiptTitle: "طلب", number: "رقم", customer: "العميل", total: "المجموع", paid: "المدفوع", note: "ملاحظة", thanks: "شكرًا لكم", balanceOwed: "المتبقي", balanceCredit: "له" },
    madeWith: "صُنع بـ kervan",
    install: "ثبّت التطبيق على الهاتف", installIos: "للتثبيت: زر المشاركة ← إضافة إلى الشاشة الرئيسية",
    installAndroid: "للتثبيت كتطبيق: افتح الصفحة في Chrome، ثم من قائمة ⋮ اختر \"تثبيت التطبيق\" أو \"إضافة إلى الشاشة الرئيسية\".",
    installDesktop: "على الكمبيوتر (Chrome أو Edge): اضغط أيقونة التثبيت يمين شريط العنوان أو اختر \"تثبيت\" من قائمة ⋮ في المتصفح.",
    installPreview: "هذه معاينة المتجر. عندما يفتح عميلك رابط المتجر على هاتفه يثبّته كتطبيق بهذا الزر.",
    installDone: "بعد التثبيت يفتح المتجر من الشاشة الرئيسية للهاتف أو الكمبيوتر بأيقونته الخاصة.",
  },
};

const ICON = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  bag: '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  whatsapp: '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z"/><path d="M9 8.5c.2-.5.5-.5.8-.5h.5c.2 0 .4 0 .5.4l.7 1.7c.1.3 0 .5-.1.6l-.5.6c-.1.2-.2.3 0 .6.5.8 1.5 1.8 2.5 2.3.3.1.4.1.6-.1l.6-.7c.2-.2.4-.2.6-.1l1.6.8c.3.1.4.3.4.5 0 .6-.3 1.4-1 1.7-.6.3-1.5.4-3-.3-1.8-.8-3.3-2.5-3.9-3.6-.6-1.1-.6-2.3-.3-2.9z"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8"/>',
};
const icon = (name) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICON[name];
  return s;
};

// Güvenli DOM oluşturucu: metin hep textContent olarak girer.
// replaceChildren boş değerleri (null, false) yazı olarak koyar; h() gibi atlansın.
const clean = (...kids) => kids.filter((c) => c != null && c !== false);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(key) { try { return localStorage.getItem(`shop.${key}`); } catch { return null; } },
  set(key, value) { try { value == null ? localStorage.removeItem(`shop.${key}`) : localStorage.setItem(`shop.${key}`, value); } catch { /* gizli sekme */ } },
};

// --- Firebase (girişsiz; yerelde emülatör) ---
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const app = initializeApp(isLocal ? { ...firebaseConfig, apiKey: "demo-key", projectId: "demo-kervan" } : firebaseConfig, "shop");
const db = getFirestore(app);
if (isLocal) connectFirestoreEmulator(db, location.hostname, 8080);

// Adres: /m/{adres} ya da /m/{adres}/o/{sipariş}; yerelde magaza.html?s=…&o=…
const route = (() => {
  const m = location.pathname.match(/^\/m\/([a-z0-9-]{3,40})(?:\/o\/([A-Za-z0-9]{10,40}))?\/?$/);
  if (m) return { slug: m[1], order: m[2] ?? null, pretty: true };
  const q = new URLSearchParams(location.search);
  return { slug: q.get("s") ?? "", order: q.get("o"), pretty: false };
})();
const orderLink = (id) => (route.pretty ? `${location.origin}/m/${route.slug}/o/${id}` : `${location.origin}/magaza.html?s=${route.slug}&o=${id}`);

let lang = store.get("lang") || (navigator.language?.startsWith("ar") ? "ar" : "tr");
const say = (key, vars = {}) => String(TEXT[lang][key] ?? TEXT.tr[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const plain = (s) => s.replace(/[⁦⁩]/g, "");

let shop = null;
let items = [];
let query = "";
let cat = "";
let cart = new Map();
const app$ = document.getElementById("app");
const sheet = document.getElementById("sheet");

const money = (v) => formatMoney(v, shop?.currency || "TRY");
const matches = (text, q) => (text || "").toLocaleLowerCase("tr").includes(q.trim().toLocaleLowerCase("tr"));
const saveCart = () => store.set(`cart.${route.slug}`, cart.size ? JSON.stringify([...cart]) : null);

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 1800);
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

const photo = (it, cls = "") => (it.thumb ? h("img", { src: it.thumb, alt: "", loading: "lazy", class: cls }) : h("span", { class: `blank ${cls}` }, (it.name || "?").charAt(0).toLocaleUpperCase("tr")));

// --- Vitrin ---

function stepper(it) {
  const n = cart.get(it.id) ?? 0;
  if (!n) {
    return h("button", { type: "button", class: "add", "aria-label": say("add"), disabled: it.soldOut, onclick: (e) => { e.stopPropagation(); change(it, 1); } }, icon("plus"));
  }
  return h("div", { class: "step", onclick: (e) => e.stopPropagation() },
    h("button", { type: "button", "aria-label": "−", onclick: () => change(it, -1) }, icon("minus")),
    h("strong", {}, String(n)),
    h("button", { type: "button", "aria-label": "+", onclick: () => change(it, 1) }, icon("plus")));
}

function change(it, d) {
  const n = Math.max(0, (cart.get(it.id) ?? 0) + d);
  if (n) cart.set(it.id, n);
  else cart.delete(it.id);
  if (d > 0 && n === 1) navigator.vibrate?.(12);
  saveCart();
  render();
  if (sheet.open && sheet.dataset.view === "cart") openCart();
}

function card(it) {
  return h("article", { class: "card" },
    h("button", { type: "button", class: "photo", "aria-label": it.name, onclick: () => openDetail(it) },
      photo(it), it.soldOut && h("span", { class: "badge" }, say("soldOut"))),
    h("div", { class: "body" },
      it.category && h("span", { class: "cat-name" }, it.category),
      h("h3", {}, it.name),
      h("div", { class: "foot" },
        shop.showPrices ? h("span", { class: "price" }, money(it.price)) : h("span", { class: "price ask" }, say("ask")),
        stepper(it))));
}

// Mağaza adı tek satıra sığsın: sığmıyorsa yazı adım adım küçülür (en az 13 px), yine de sığmazsa "…".
function fitTitle() {
  const el = document.querySelector(".hero h1");
  if (!el) return;
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth + 1 && size > 13) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}
addEventListener("resize", () => fitTitle());

function categories() {
  const seen = new Map();
  for (const it of items) if (it.category && !seen.has(it.category)) seen.set(it.category, it);
  // İşletmenin ayarladığı sıra (listede olmayanlar sonda, ada göre).
  const order = Array.isArray(shop.catOrder) ? shop.catOrder : [];
  const at = (c) => { const i = order.indexOf(c); return i < 0 ? Infinity : i; };
  return [...seen].sort((a, b) => at(a[0]) - at(b[0]) || a[0].localeCompare(b[0], "tr"));
}

let searchInput = null;
function render() {
  if (!shop) return;
  const cats = categories();
  if (cat && !cats.some(([c]) => c === cat)) cat = "";
  const list = items.filter((it) => (!cat || it.category === cat) && (!query || matches(it.name, query) || matches(it.category, query)));
  const count = [...cart.values()].reduce((s, n) => s + n, 0);
  const total = [...cart].reduce((s, [id, n]) => s + (items.find((x) => x.id === id)?.price ?? 0) * n, 0);
  const keepFocus = document.activeElement === searchInput;
  searchInput = h("input", {
    type: "search", value: query, placeholder: say("search"), "aria-label": say("search"), enterkeyhint: "search", autocomplete: "off",
    oninput: (e) => { query = e.target.value; render(); },
  });
  app$.replaceChildren(...clean(
    // İnce üst şerit: logo, tek satırda adı (uzunsa yazı küçülür) ve dil.
    h("header", { class: "hero" },
      shop.logo ? h("img", { class: "logo", src: shop.logo, alt: "" }) : h("span", { class: "logo" }, shop.name.charAt(0).toLocaleUpperCase("tr")),
      h("div", { class: "titles" }, h("h1", {}, shop.name)),
      // Dil: tek düğme, öbür dilin işareti (yer kaplamasın).
      h("button", {
        type: "button", class: "lang", "aria-label": lang === "tr" ? "العربية" : "Türkçe",
        onclick: () => { lang = lang === "tr" ? "ar" : "tr"; store.set("lang", lang); applyLang(); render(); },
      }, lang === "tr" ? "ع" : "TR")),
    shop.cover && h("img", { class: "cover", src: shop.cover, alt: "" }),
    // Yüklenmemişse aramanın üstünde, tam genişlikte ince altın çerçeveli "Uygulamayı telefona yükle".
    route.pretty && !standalone() && h("button", { type: "button", class: "install-chip", onclick: install }, icon("download"), say("install")),
    h("div", { class: "search-wrap" },
      h("label", { class: "search" }, icon("search"), searchInput,
        query && h("button", { type: "button", class: "clear", "aria-label": say("close"), onclick: () => { query = ""; render(); } }, icon("x")))),
    cats.length > 1 && h("nav", { class: "cats", "aria-label": say("products") },
      h("button", { type: "button", class: "cat", "aria-pressed": String(!cat), onclick: () => { cat = ""; render(); } },
        h("span", { class: "ring" }, icon("grid")), h("span", { class: "name" }, say("all"))),
      cats.map(([c, it]) => h("button", { type: "button", class: "cat", "aria-pressed": String(cat === c), onclick: () => { cat = cat === c ? "" : c; render(); } },
        h("span", { class: "ring" }, (shop.cats?.[c] || it.thumb) ? h("img", { src: shop.cats?.[c] || it.thumb, alt: "" }) : icon("grid")), h("span", { class: "name" }, c)))),
    h("div", { class: "section-head" }, h("h2", {}, cat || say("products")), h("small", {}, say("items", { n: list.length }))),
    h("section", { class: "grid" },
      list.length ? list.map(card) : h("p", { class: "empty" }, say(items.length ? "noMatch" : "noProducts"))),
    installButton(),
    h("p", { class: "footer" }, h("a", { href: "https://kervanim.web.app", target: "_blank", rel: "noopener" }, say("madeWith"))),
    count > 0 && h("button", { type: "button", class: "cart-bar", onclick: openCart },
      h("span", { class: "count" }, String(count)),
      h("span", { class: "sum" }, h("small", {}, say("cartCount", { n: count })), h("strong", {}, shop.showPrices ? money(total) : say("cart"))),
      h("span", { class: "go" }, say("seeCart")))));
  fitTitle();
  if (keepFocus) {
    searchInput.focus();
    searchInput.setSelectionRange(query.length, query.length);
  }
}

// --- Pencereler ---

function openSheet(view, title, body, foot) {
  sheet.dataset.view = view;
  sheet.replaceChildren(...clean(
    h("div", { class: "sheet-head" }, h("h2", {}, title),
      h("button", { type: "button", class: "icon-btn", "aria-label": say("close"), onclick: () => sheet.close() }, icon("x"))),
    h("div", { class: "sheet-body" }, body),
    foot && h("div", { class: "sheet-foot" }, foot)));
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });

async function openDetail(it) {
  const img = h("div", { class: "detail-photo" }, photo(it));
  const qty = () => cart.get(it.id) ?? 0;
  const draw = () => openSheet("detail", "", h("div", { class: "detail" },
    img,
    it.category && h("p", { class: "eyebrow" }, it.category),
    h("h3", {}, it.name),
    h("p", { class: "meta" }, it.unit ? `1 ${it.unit}` : "", it.soldOut ? ` · ${say("soldOut")}` : ""),
    h("div", { class: "row" },
      shop.showPrices ? h("span", { class: "price" }, money(it.price)) : h("span", { class: "price ask" }, say("ask")),
      qty() ? h("div", { class: "step" },
        h("button", { type: "button", "aria-label": "−", onclick: () => { change(it, -1); draw(); } }, icon("minus")),
        h("strong", {}, String(qty())),
        h("button", { type: "button", "aria-label": "+", onclick: () => { change(it, 1); draw(); } }, icon("plus"))) : null)),
  h("button", {
    type: "button", class: "btn", disabled: it.soldOut,
    onclick: () => { if (!qty()) change(it, 1); toast(say("added")); sheet.close(); },
  }, icon("bag"), say("add")));
  draw();
  // Büyük fotoğraf ayrı belgede.
  try {
    const big = await getDoc(doc(db, "shops", route.slug, "images", it.id));
    if (big.exists()) img.replaceChildren(h("img", { src: big.data().data, alt: "" }));
  } catch { /* küçük fotoğraf kalır */ }
}

const form = { name: store.get("name") ?? "", phone: store.get("phone") ?? "", note: "" };

function openCart() {
  const lines = [...cart].map(([id, n]) => [items.find((x) => x.id === id), n]).filter(([it]) => it);
  if (!lines.length) {
    openSheet("cart", say("cart"), h("p", { class: "empty" }, say("emptyCart")));
    return;
  }
  const total = lines.reduce((s, [it, n]) => s + it.price * n, 0);
  const error = h("p", { class: "error", role: "alert" });
  const input = (key, attrs) => h("input", { ...attrs, value: form[key], oninput: (e) => { form[key] = e.target.value; } });
  openSheet("cart", say("cart"), [
    h("ul", { class: "lines" }, lines.map(([it, n]) => h("li", {},
      photo(it),
      h("div", { class: "main" }, h("b", {}, it.name), shop.showPrices && h("small", {}, `${plain(money(it.price))} × ${n}`)),
      h("div", { class: "step" },
        h("button", { type: "button", "aria-label": "−", onclick: () => change(it, -1) }, icon("minus")),
        h("strong", {}, String(n)),
        h("button", { type: "button", "aria-label": "+", onclick: () => change(it, 1) }, icon("plus")))))),
    shop.showPrices && h("div", { class: "total-row" }, h("span", {}, say("total")), h("strong", {}, money(total))),
    h("label", { class: "field" }, h("span", {}, say("name")), input("name", { autocomplete: "name", maxlength: 80 })),
    h("label", { class: "field" }, h("span", {}, say("phone")), input("phone", { type: "tel", autocomplete: "tel", maxlength: 24, dir: "ltr" })),
    h("label", { class: "field" }, h("span", {}, say("note")),
      h("textarea", { maxlength: 300, placeholder: say("notePh"), oninput: (e) => { form.note = e.target.value; } }, form.note)),
    h("p", { class: "hint" }, say("orderHint")),
    error,
  ], [
    shop.phone && waPhone(shop.phone) && h("button", { type: "button", class: "btn wa", onclick: () => send("whatsapp", lines, total, error) }, icon("whatsapp"), say("sendWa")),
    h("button", { type: "button", class: `btn${shop.phone ? " outline" : ""}`, onclick: () => send("direct", lines, total, error) }, icon("send"), say("sendDirect")),
  ]);
}

// Sipariş: belge kimliği hemen alınır ki WhatsApp penceresi dokunuşla aynı anda açılabilsin.
function send(via, lines, total, error) {
  const name = form.name.trim();
  if (!name) {
    error.textContent = say("needName");
    return;
  }
  store.set("name", name);
  store.set("phone", form.phone.trim() || null);
  const ref = doc(collection(db, "shops", route.slug, "orders"));
  const code = ref.id.slice(0, 6).toUpperCase();
  const order = {
    code, name: name.slice(0, 80), phone: form.phone.trim().slice(0, 24), note: form.note.trim().slice(0, 300),
    lines: lines.map(([it, n]) => ({ id: it.id, name: it.name, qty: n, price: shop.showPrices ? it.price : 0, unit: it.unit ?? "" })),
    total: shop.showPrices ? total : 0, currency: shop.currency || "TRY", at: serverTimestamp(), status: "new", via,
  };
  const saving = setDoc(ref, order);
  if (via === "whatsapp") {
    const text = [
      `*${say("waOrder")}* · ${code}`,
      [name, form.phone.trim()].filter(Boolean).join(" · "),
      "",
      ...lines.map(([it, n]) => `• ${it.name} × ${n}${shop.showPrices ? ` = ${plain(money(it.price * n))}` : ""}`),
      ...(shop.showPrices ? ["", `*${say("total")}: ${plain(money(total))}*`] : []),
      ...(order.note ? ["", order.note] : []),
      "",
      `${say("orderLink")}:`,
      orderLink(ref.id),
    ].join("\n");
    const url = whatsappUrl(shop.phone, text);
    const w = window.open(url, "_blank");
    if (w) w.opener = null;
    else location.href = url;
  }
  // Dükkânın telefonuna bildirim (uygulama kapalı olsa da); başarısız olursa sipariş yine kayıtlı.
  saving.then(() => fetch(`${aiReaderUrl}/push/notify`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: route.slug, order: ref.id }),
  }).catch(() => {}));
  saving.then(() => {
    cart.clear();
    saveCart();
    form.note = "";
    render();
    showDone(ref.id, code);
  }, (err) => {
    console.error(err);
    error.textContent = say("failed");
  });
}

function receiptDoc(order) {
  const at = order.at?.toDate?.() ?? new Date();
  return {
    kind: "receipt", title: say("orderTitle"), number: order.code, date: at.toISOString().slice(0, 10), time: at.toTimeString().slice(0, 5),
    currency: order.currency || "TRY",
    firm: { name: shop?.name ?? "", logo: shop?.logo ?? "", phone: shop?.phone ?? "" },
    party: { name: [order.name, order.phone].filter(Boolean).join(" · ") },
    lines: order.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit ?? "", price: l.price, vatRate: 0 })),
    paid: 0, balanceAfter: null, note: order.note ?? "",
  };
}
const labels = () => ({ dir: lang === "ar" ? "rtl" : "ltr", ...TEXT[lang].rc });

async function downloads(order) {
  const docData = receiptDoc(order);
  const name = `siparis-${order.code}`;
  return [
    h("button", { type: "button", class: "btn", onclick: async () => downloadBlob(await receiptPdf(docData, labels()), `${name}.pdf`) }, icon("file"), say("pdf")),
    h("button", {
      type: "button", class: "btn outline",
      onclick: async () => (await receiptCanvas(docData, labels())).toBlob((b) => b && downloadBlob(b, `${name}.png`), "image/png"),
    }, icon("image"), say("image")),
  ];
}

async function showDone(id, code) {
  const snap = await getDoc(doc(db, "shops", route.slug, "orders", id)).catch(() => null);
  const order = snap?.exists() ? snap.data() : null;
  openSheet("done", "", h("div", { class: "done" },
    h("div", { class: "check" }, icon("check")),
    h("h3", {}, say("doneTitle")),
    h("p", {}, say("doneText")),
    h("span", { class: "code" }, say("code", { code }))), [
    ...(order ? await downloads(order) : []),
    h("button", { type: "button", class: "btn outline", onclick: () => sheet.close() }, say("back")),
  ]);
}

// --- Siparişin fişi (/m/{adres}/o/{sipariş}) ---
async function showOrder() {
  const snap = await getDoc(doc(db, "shops", route.slug, "orders", route.order));
  if (!snap.exists()) return state(say("orderMissing"));
  const order = snap.data();
  document.title = `${say("orderTitle")} ${order.code} · ${shop.name}`;
  const canvas = await receiptCanvas(receiptDoc(order), labels());
  canvas.style.width = ""; // telefonda ekrana sığsın (CSS genişliği verir)
  app$.replaceChildren(h("div", { class: "order-view" }, canvas, h("div", { class: "actions" }, await downloads(order))));
  return undefined;
}

function state(text, title = "") {
  app$.replaceChildren(h("div", { class: "state" }, title && h("h1", {}, title), h("p", {}, text)));
}

// --- Telefona uygulama olarak yükleme ---
// Mağazanın kendi uygulama tanımı (/m/{adres}/manifest.webmanifest) ve çalışanı (/m/{adres}/sw.js):
// yüklenen uygulama doğrudan bu mağazayla açılır. Android'de "Yükle" düğmesi (üstte ve altta); tarayıcı
// yükleme önermiyorsa (WhatsApp içinden açıldı, ya da zaten önerilmedi) Chrome menüsünden yol gösterilir.
let installPrompt = null;
// Dükkân sahibinin uygulamasındaki önizleme (çerçeve içinde): yüklü uygulamanın içinde de "Yükle" görünsün.
const framed = window.top !== window;
const standalone = () => !framed && (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isAndroid = /android/i.test(navigator.userAgent);
// Tarayıcı yüklemeyi öneriyorsa doğrudan yükler; önermiyorsa (WhatsApp içinden açıldı, iPhone, zaten
// önerilmedi) cihaza göre yol gösterir.
async function install() {
  if (framed) {
    openSheet("install", say("install"), h("div", { class: "install-help" }, h("p", {}, say("installPreview")), h("p", { class: "hint" }, say("installDone"))));
    return;
  }
  if (!installPrompt) {
    const steps = isIos ? ["installIos"] : isAndroid ? ["installAndroid"] : ["installDesktop", "installAndroid"];
    openSheet("install", say("install"), h("div", { class: "install-help" },
      steps.map((k) => h("p", {}, say(k))), h("p", { class: "hint" }, say("installDone"))));
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  render();
}
function setupInstall() {
  if (!route.pretty || framed) return;
  const base = `/m/${route.slug}/`;
  // Uygulamanın kapsamı /m/{adres}/: sayfa da bu adreste olsun ki yükleme düğmesi çıksın.
  if (!route.order && location.pathname !== base) history.replaceState(null, "", base + location.search);
  document.head.append(h("link", { rel: "manifest", href: `${base}manifest.webmanifest` }));
  document.head.append(h("meta", { name: "apple-mobile-web-app-capable", content: "yes" }));
  document.head.append(h("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }));
  navigator.serviceWorker?.register(`${base}sw.js`, { scope: base }).catch(() => {});
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    render();
  });
  addEventListener("appinstalled", () => { installPrompt = null; render(); });
}
function installButton() {
  if (standalone() || !route.pretty) return null;
  return h("button", { type: "button", class: "btn outline install", onclick: install }, icon("bag"), say("install"));
}

async function start() {
  applyLang();
  setupInstall();
  if (!route.slug) return state(say("missing"));
  try {
    const snap = await getDoc(doc(db, "shops", route.slug));
    if (!snap.exists()) return state(say("missing"));
    shop = { ...snap.data(), showPrices: snap.data().showPrices !== false };
    document.title = `${shop.name} · ${say("title")}`;
    document.head.append(h("meta", { name: "apple-mobile-web-app-title", content: shop.name }));
    if (route.order) return showOrder();
    if (!shop.open) return state(say("closed"), shop.name);
    const list = await getDocs(collection(db, "shops", route.slug, "items"));
    items = list.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((it) => !(shop.hideSoldOut && it.soldOut))
      .sort((a, b) => Number(a.soldOut) - Number(b.soldOut) || a.name.localeCompare(b.name, "tr", { numeric: true }));
    try {
      cart = new Map(JSON.parse(store.get(`cart.${route.slug}`) || "[]").filter(([id]) => items.some((x) => x.id === id)));
    } catch {
      cart = new Map();
    }
    render();
    // Ürün bağlantısıyla gelindiyse (?p=ürünId) o ürün açılır.
    const linked = items.find((x) => x.id === new URLSearchParams(location.search).get("p"));
    if (linked) openDetail(linked);
  } catch (err) {
    console.error(err);
    state(say("loadFailed"));
  }
  return undefined;
}

start();
