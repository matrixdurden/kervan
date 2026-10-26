// Giriş, işletme listesi, işletme oluşturma/katılma ve menüler.
// İşletme ekranı firm.js'de, kişi hesabı party.js'de, formlar forms.js'de.

import {
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  doc, collection, query, where, getDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp,
  arrayUnion, arrayRemove, deleteField,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import {
  $, h, store, toast, avatar, avatarStack, PALETTE, randomCode, normalizeCode, formatCode,
} from "./ui.js";
import { session, currentFirm, myName, myColor, members } from "./session.js";
import { show } from "./nav.js";
import {
  openFirm, closeFirm, refreshFirm, rebuildFirm, currentFirmId, currentPage, closePage, firmMark,
} from "./firm.js";
import { closeParty, currentPartyId } from "./party.js";
import { lang, setLang, t, applyStatic } from "./i18n.js";
import "./install.js";

applyStatic();

// Davet linkiyle gelindiyse (?join=ABC123) giriş sonrası katılma penceresini aç.
// Yönlendirmeli girişte sayfa yeniden yüklendiği için kod saklanır.
const linkInvite = normalizeCode(new URLSearchParams(location.search).get("join"));
if (linkInvite) {
  store.set("invite", linkInvite);
  history.replaceState(null, "", location.pathname);
}
let pendingInvite = store.get("invite");

// --- Giriş ------------------------------------------------------------------

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

$("#google").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    // Yerel testte (emülatör) yönlendirmeli giriş: bazı gömülü tarayıcılar açılır pencereyi aynı sekmede açar.
    if (location.hostname === "localhost") {
      await signInWithRedirect(auth, provider);
      return;
    }
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Açılır pencere engellenirse yönlendirmeli girişe geç.
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (!["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) {
      console.error(err);
      $("#login-error").textContent = t("loginFailed");
    }
  } finally {
    button.disabled = false;
  }
});

getRedirectResult(auth).catch((err) => {
  console.error(err);
  $("#login-error").textContent = t("loginFailed");
});

$("#login-lang").addEventListener("click", () => switchLang(lang === "ar" ? "tr" : "ar"));

onAuthStateChanged(auth, (user) => {
  if (!user || user.isAnonymous) {
    stopFirms();
    session.uid = null;
    session.user = null;
    show("login");
    return;
  }
  if (session.uid === user.uid) return;
  session.uid = user.uid;
  session.user = user;
  startFirms();
});

// --- İşletmeler ---------------------------------------------------------------

let unsubFirms = null;

function startFirms() {
  show("loading");
  let first = true;
  const q = query(collection(db, "firms"), where("members", "array-contains", session.uid));
  unsubFirms = onSnapshot(q, (snap) => {
    session.firms = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    ensureProfile();
    renderFirms();
    const open = currentFirmId();
    if (open && !session.firms.has(open)) goFirms();
    else refreshFirm();
    if (first) {
      first = false;
      route();
    }
  }, (err) => {
    console.error(err);
    toast(t("readFailed"));
  });
}

function stopFirms() {
  unsubFirms?.();
  unsubFirms = null;
  closeParty();
  closeFirm();
  session.firms = new Map();
}

// Her işletmede adım kayıtlı olsun ve rengim başka bir ortağınkiyle çakışmasın.
// Çakışmada sadece sonra katılan renk değiştirir, böylece iki kişi birbirini kovalamaz.
function ensureProfile() {
  const uid = session.uid;
  for (const firm of session.firms.values()) {
    const me = firm.people?.[uid];
    const earlier = firm.members.slice(0, firm.members.indexOf(uid)).map((m) => firm.people?.[m]?.color);
    const taken = Object.entries(firm.people || {}).filter(([m]) => m !== uid).map(([, p]) => p.color);
    const update = {};
    if (!me?.name) update[`people.${uid}.name`] = myName();
    if (!me?.color || earlier.includes(me.color)) {
      update[`people.${uid}.color`] = PALETTE.find((c) => !taken.includes(c)) || PALETTE[0];
    }
    if (Object.keys(update).length) updateDoc(doc(db, "firms", firm.id), update).catch(() => {});
  }
}

function route() {
  if (pendingInvite) {
    show("firms");
    openJoin(pendingInvite);
    pendingInvite = null;
    store.set("invite", null);
    return;
  }
  const last = store.get("firm");
  if (last && session.firms.has(last)) goFirm(last);
  else if (session.firms.size === 1) goFirm([...session.firms.keys()][0]);
  else show("firms");
}

function renderFirms() {
  const name = myName();
  $("#me-name").textContent = name;
  $("#me-avatar").replaceChildren(avatar({ name, color: myColor() }, "lg"));
  const firms = [...session.firms.values()].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  $("#firm-list").replaceChildren(...firms.map((firm) => h("li", {},
    h("button", { type: "button", class: "card row firm-card", onclick: () => goFirm(firm.id) },
      firmMark(firm),
      h("span", { class: "main" },
        h("span", { class: "title" }, h("bdi", {}, firm.name)),
        avatarStack(members(firm)))))));
  $("#no-firms").hidden = firms.length > 0;
}

// --- Ekranlar arası geçiş (Android geri tuşu da çalışsın diye history kullanılır) ---

function goFirm(id) {
  store.set("firm", id);
  history.pushState({ firm: id }, "");
  openFirm(id);
  show("firm");
}

function goFirms() {
  closeParty();
  closeFirm();
  store.set("firm", null);
  show(session.uid ? "firms" : "login");
}

// Geri: önce kişi hesabı, sonra bölüm sayfası, sonra işletme kapanır.
addEventListener("popstate", () => {
  if (currentPartyId()) {
    closeParty();
    show("firm");
  } else if (currentPage()) {
    closePage();
  } else if (currentFirmId()) {
    goFirms();
  }
});

// Ayarlar sayfasından gelen istekler.
document.addEventListener("kervan:firm-menu", () => openFirmMenu());
document.addEventListener("kervan:account", () => $("#account-open").click());
document.addEventListener("kervan:firms", () => goFirms());
document.addEventListener("kervan:lang", () => { if (session.uid) renderFirms(); });

// --- Yeni işletme -------------------------------------------------------------

const newFirmDialog = $("#new-firm-dialog");

$("#new-firm").addEventListener("click", () => {
  $("#new-firm-name").value = "";
  $("#new-firm-error").textContent = "";
  newFirmDialog.showModal();
});

$("#new-firm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#new-firm-name").value.trim();
  if (!name) {
    $("#new-firm-error").textContent = t("enterFirmName");
    return;
  }
  const button = $("#new-firm-create");
  button.disabled = true;
  try {
    let code;
    for (let i = 0; i < 5 && !code; i++) {
      const candidate = randomCode();
      if (!(await getDoc(doc(db, "invites", candidate))).exists()) code = candidate;
    }
    const firmRef = doc(collection(db, "firms"));
    const batch = writeBatch(db);
    batch.set(firmRef, {
      name,
      code,
      members: [session.uid],
      people: { [session.uid]: { name: myName(), color: myColor() } },
      createdBy: session.uid,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(db, "invites", code), {
      firmId: firmRef.id, firmName: name, createdBy: session.uid, createdAt: serverTimestamp(),
    });
    await batch.commit();
    newFirmDialog.close();
    goFirm(firmRef.id);
  } catch (err) {
    console.error(err);
    $("#new-firm-error").textContent = t("genericError");
  } finally {
    button.disabled = false;
  }
});

// --- Davet koduyla katıl --------------------------------------------------------

const joinDialog = $("#join-dialog");

function openJoin(code = "") {
  $("#join-code").value = code ? formatCode(code) : "";
  $("#join-error").textContent = "";
  $("#join-firm-name").textContent = "";
  joinDialog.showModal();
  if (code) previewInvite(code);
}

async function previewInvite(code) {
  try {
    const invite = await getDoc(doc(db, "invites", code));
    if (invite.exists()) $("#join-firm-name").textContent = t("joinPrompt", { firm: invite.data().firmName });
  } catch { /* önizleme olmasa da katılınabilir */ }
}

$("#join-firm").addEventListener("click", () => openJoin());
$("#join-code").addEventListener("input", () => { $("#join-error").textContent = ""; });

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = normalizeCode($("#join-code").value);
  if (code.length !== 6) {
    $("#join-error").textContent = t("codeLength");
    return;
  }
  const button = $("#join-submit");
  button.disabled = true;
  try {
    const invite = await getDoc(doc(db, "invites", code));
    if (!invite.exists()) {
      $("#join-error").textContent = t("noSuchFirm");
      return;
    }
    const { firmId } = invite.data();
    if (!session.firms.has(firmId)) {
      await updateDoc(doc(db, "firms", firmId), {
        members: arrayUnion(session.uid),
        [`people.${session.uid}`]: { name: myName(), color: myColor() },
        joinedWith: code,
      });
    }
    joinDialog.close();
    goFirm(firmId);
  } catch (err) {
    console.error(err);
    $("#join-error").textContent = t("genericError");
  } finally {
    button.disabled = false;
  }
});

// --- Ortaklar ve davet (Ayarlar sayfasından açılır) ---------------------------------

const firmMenu = $("#firm-menu");

function openFirmMenu() {
  const firm = currentFirm();
  if (!firm) return;
  $("#firm-menu-title").textContent = firm.name;
  $("#firm-menu-code").textContent = formatCode(firm.code);
  $("#member-list").replaceChildren(...firm.members.map((uid) => {
    const p = firm.people?.[uid] || {};
    const label = uid === session.uid ? `${p.name || myName()} (${t("you")})` : p.name || "?";
    return h("li", {}, avatar({ name: p.name, color: p.color || PALETTE[0] }), h("bdi", {}, label));
  }));
  firmMenu.showModal();
}

$("#invite").addEventListener("click", async () => {
  const firm = currentFirm();
  if (!firm) return;
  const url = `${location.origin}/?join=${firm.code}`;
  const text = t("inviteText", { firm: firm.name, code: formatCode(firm.code) });
  try {
    if (navigator.share) {
      await navigator.share({ title: "kervan", text, url });
    } else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast(t("linkCopied"));
    }
  } catch { /* paylaşım iptal edildi */ }
});

$("#leave-firm").addEventListener("click", async () => {
  const firm = currentFirm();
  if (!firm || !confirm(t("confirmLeaveFirm", { firm: firm.name }))) return;
  firmMenu.close();
  try {
    await updateDoc(doc(db, "firms", firm.id), {
      members: arrayRemove(session.uid),
      [`people.${session.uid}`]: deleteField(),
    });
    goFirms();
  } catch (err) {
    console.error(err);
    toast(t("saveFailed"));
  }
});

// --- Hesap menüsü (işletme listesinde kendi avatarına basınca) -------------------

const accountMenu = $("#account");

function markLang() {
  for (const btn of $("#lang-seg").querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.lang === lang));
  }
}

function switchLang(next) {
  setLang(next);
  markLang();
  if (session.uid) renderFirms();
  rebuildFirm();
}

$("#account-open").addEventListener("click", () => {
  $("#account-name").value = myName();
  $("#account-email").textContent = session.user?.email || "";
  markLang();
  accountMenu.showModal();
});

$("#lang-seg").addEventListener("click", (e) => {
  const next = e.target.closest("button")?.dataset.lang;
  if (next && next !== lang) switchLang(next);
});

$("#account-name").addEventListener("change", (e) => {
  const name = e.target.value.trim();
  if (!name) {
    e.target.value = myName();
    return;
  }
  store.set("name", name);
  const batch = writeBatch(db);
  for (const firm of session.firms.values()) {
    batch.update(doc(db, "firms", firm.id), { [`people.${session.uid}.name`]: name });
  }
  batch.commit().catch(() => toast(t("saveFailed")));
  renderFirms();
  toast(t("nameUpdated"));
});

$("#sign-out").addEventListener("click", async () => {
  accountMenu.close();
  store.set("firm", null);
  store.set("name", null);
  await signOut(auth);
});

// --- Çevrimdışı kullanım için service worker --------------------------------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
