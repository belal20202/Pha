import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let me = null, pid = null;
let meds = [], logs = [];
let tab = "all", searchText = "";
let isRegister = false, registering = false;
let unsubs = [];
let editingId = null, currentImage = "";
let qtyMed = null;

const today = new Date();
today.setHours(0, 0, 0, 0);

/* ---------- أدوات ---------- */
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
const who = () => (me && (me.displayName || me.email)) || "مستخدم";
const medsPath = () => `pharmacies/${pid}/medicines`;
const logsPath = () => `pharmacies/${pid}/logs`;

function authMsg(e) {
  const m = {
    "auth/invalid-credential": "البريد أو كلمة المرور غير صحيحة",
    "auth/invalid-login-credentials": "البريد أو كلمة المرور غير صحيحة",
    "auth/email-already-in-use": "هذا البريد مسجل مسبقاً",
    "auth/weak-password": "كلمة المرور ضعيفة (6 أحرف على الأقل)",
    "auth/invalid-email": "البريد الإلكتروني غير صالح",
    "auth/network-request-failed": "لا يوجد اتصال بالإنترنت",
    "auth/too-many-requests": "محاولات كثيرة، انتظر قليلاً"
  };
  return m[e.code] || "خطأ: " + (e.message || e.code);
}

/* ---------- العلب والأشرطة ---------- */
// الكمية (qty) تُخزَّن دائماً بالأشرطة. إذا أشرطة العلبة = 1 فالكمية = عدد العلب.
const spbOf = (m) => Math.max(1, parseInt(m.stripsPerBox, 10) || 1);

function fmtQty(m) {
  const spb = spbOf(m);
  const q = m.qty || 0;
  if (spb <= 1) return `${q} علبة`;
  const b = Math.floor(q / spb);
  const s = q % spb;
  const parts = [];
  if (b) parts.push(`${b} علبة`);
  if (s) parts.push(`${s} شريط`);
  return parts.length ? parts.join(" + ") : "0";
}

/* ---------- الدخول والتسجيل ---------- */
$("toggleAuth").onclick = () => {
  isRegister = !isRegister;
  document.querySelectorAll(".reg-only").forEach((el) => el.classList.toggle("hidden", !isRegister));
  $("authBtn").textContent = isRegister ? "إنشاء حساب" : "دخول";
  $("toggleAuth").textContent = isRegister ? "لدي حساب؟ تسجيل الدخول" : "ليس لديك حساب؟ إنشاء حساب";
  $("authErr").textContent = "";
};

$("authForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("email").value.trim();
  const pass = $("password").value;
  const name = $("userName").value.trim();
  const code = $("pharmacyCode").value.trim().toLowerCase();
  $("authErr").textContent = "";
  $("authBtn").disabled = true;
  try {
    if (isRegister) {
      if (!name) { $("authErr").textContent = "اكتب اسمك"; return; }
      if (!/^[a-z0-9_-]{3,30}$/.test(code)) {
        $("authErr").textContent = "رمز الصيدلية: حروف إنكليزية صغيرة وأرقام فقط (3 إلى 30)";
        return;
      }
      registering = true;
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "users", cred.user.uid), { pharmacyId: code, name });
      registering = false;
      await startApp(cred.user, code);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (e) {
    registering = false;
    $("authErr").textContent = authMsg(e);
  } finally {
    $("authBtn").disabled = false;
  }
});

onAuthStateChanged(auth, async (user) => {
  if (registering) return;
  if (!user) { stopApp(); return; }
  try {
    const s = await getDoc(doc(db, "users", user.uid));
    if (!s.exists()) {
      $("authErr").textContent = "الحساب غير مرتبط بصيدلية";
      await signOut(auth);
      return;
    }
    await startApp(user, s.data().pharmacyId);
  } catch (e) {
    $("authErr").textContent = "تعذر تحميل الحساب: " + e.message;
  }
});

$("logout").onclick = () => signOut(auth);

async function startApp(user, pharmacyId) {
  me = user;
  pid = pharmacyId;
  $("pharmName").textContent = "الصيدلية: " + pid;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  unsubs.forEach((u) => u());
  unsubs = [];
  unsubs.push(onSnapshot(
    query(collection(db, medsPath()), orderBy("name")),
    (snap) => { meds = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    () => toast("خطأ في تحميل الأدوية")
  ));
  unsubs.push(onSnapshot(
    query(collection(db, logsPath()), orderBy("at", "desc"), limit(60)),
    (snap) => { logs = snap.docs.map((d) => d.data()); render(); },
    () => {}
  ));
}

function stopApp() {
  unsubs.forEach((u) => u());
  unsubs = [];
  me = null; pid = null; meds = []; logs = [];
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
}

/* ---------- حالة الدواء ---------- */
function daysLeft(m) {
  if (!m.expiry) return null;
  return Math.ceil((new Date(m.expiry + "T00:00:00") - today) / 864e5);
}
function flags(m) {
  const d = daysLeft(m);
  const q = m.qty || 0;
  return {
    out: q <= 0,
    low: q > 0 && q <= (m.minQty || 0) * spbOf(m),
    expired: d !== null && d < 0,
    soon: d !== null && d >= 0 && d <= 60,
    days: d
  };
}

/* ---------- العرض ---------- */
function render() {
  if (!me) return;
  let low = 0, out = 0, soon = 0;
  meds.forEach((m) => {
    const f = flags(m);
    if (f.out) out++; else if (f.low) low++;
    if (f.soon || f.expired) soon++;
  });
  $("stTotal").textContent = meds.length;
  $("stLow").textContent = low;
  $("stOut").textContent = out;
  $("stSoon").textContent = soon;

  const list = $("list");
  if (tab === "logs") {
    list.innerHTML = logs.length
      ? logs.map((l) => {
          const t = l.at && l.at.toDate ? l.at.toDate().toLocaleString("ar-IQ") : "الآن";
          return `<div class="logrow"><b>${esc(l.type)}</b>: ${esc(l.medName)} ${l.amount ? "× " + esc(l.amount) : ""}<small>${esc(l.by)} — ${esc(t)}</small></div>`;
        }).join("")
      : `<div class="empty">لا توجد حركات بعد</div>`;
    return;
  }

  const q = searchText.trim().toLowerCase();
  const items = meds.filter((m) => {
    if (q && !(`${m.name} ${m.barcode || ""} ${m.category || ""}`.toLowerCase().includes(q))) return false;
    const f = flags(m);
    if (tab === "low") return f.out || f.low;
    if (tab === "soon") return f.soon || f.expired;
    return true;
  });

  if (!items.length) {
    list.innerHTML = `<div class="empty">${meds.length ? "لا توجد نتائج" : "لا توجد أدوية. اضغط ＋ لإضافة أول دواء"}</div>`;
    return;
  }

  list.innerHTML = items.map((m) => {
    const f = flags(m);
    const spb = spbOf(m);
    const cls = f.out ? "out" : f.low ? "low" : "ok";
    const chips = [];
    if (f.out) chips.push(`<span class="chip red">خالص</span>`);
    else if (f.low) chips.push(`<span class="chip org">قليل</span>`);
    else chips.push(`<span class="chip">متوفر</span>`);
    if (f.expired) chips.push(`<span class="chip red">منتهي</span>`);
    else if (f.soon) chips.push(`<span class="chip yel">ينتهي بعد ${f.days} يوم</span>`);
    if (m.category) chips.push(`<span class="chip" style="background:#7a8f89">${esc(m.category)}</span>`);
    const img = m.image ? `<img class="thumb" src="${m.image}" alt="">` : `<div class="thumb">💊</div>`;
    const stripBtn = spb > 1 ? `<button class="qbtn txt" data-act="sell-strip" data-id="${m.id}">−شريط</button>` : "";
    return `
    <div class="card ${cls}">
      ${img}
      <div class="info">
        <h3>${esc(m.name)}</h3>
        <div class="meta">${m.barcode ? "▦ " + esc(m.barcode) + " · " : ""}${m.price ? esc(m.price) + " د.ع" : ""}${spb > 1 ? " · " + spb + " شريط/علبة" : ""}${m.expiry ? " · " + esc(m.expiry) : ""}</div>
        <div class="chips">${chips.join("")}</div>
        <div class="actions">
          <span class="qty">${esc(fmtQty(m))}</span>
          ${stripBtn}
          <button class="qbtn txt" data-act="sell-box" data-id="${m.id}">−علبة</button>
          <button class="qbtn txt plus" data-act="add-box" data-id="${m.id}">+علبة</button>
        </div>
        <div class="actions">
          <button class="sm" data-act="adj" data-id="${m.id}">كمية</button>
          <button class="sm" data-act="edit" data-id="${m.id}">تعديل</button>
          <button class="sm del" data-act="del" data-id="${m.id}">حذف</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

$("search").addEventListener("input", (e) => { searchText = e.target.value; render(); });
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});

/* ---------- الكميات والحذف ---------- */
async function addLog(type, medName, amount) {
  try {
    await addDoc(collection(db, logsPath()), { type, medName, amount: amount || "", by: who(), at: serverTimestamp() });
  } catch (e) {}
}

// delta بالأشرطة (سالب = بيع، موجب = إضافة)
async function changeQty(m, delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  if ((m.qty || 0) + delta < 0) { toast("الكمية المتوفرة أقل من المطلوب"); return; }
  try {
    await updateDoc(doc(db, medsPath(), m.id), {
      qty: increment(delta), updatedAt: serverTimestamp(), updatedBy: who()
    });
    const text = fmtQty({ qty: Math.abs(delta), stripsPerBox: spbOf(m) });
    addLog(delta < 0 ? "بيع" : "إضافة كمية", m.name, text);
  } catch (e) { toast("فشل التحديث: " + e.message); }
}

$("list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const m = meds.find((x) => x.id === b.dataset.id);
  if (!m) return;
  const act = b.dataset.act;
  if (act === "sell-strip") changeQty(m, -1);
  else if (act === "sell-box") changeQty(m, -spbOf(m));
  else if (act === "add-box") changeQty(m, spbOf(m));
  else if (act === "adj") openQty(m);
  else if (act === "edit") openForm(m);
  else if (act === "del") {
    if (!confirm(`حذف "${m.name}" نهائياً لكل المستخدمين؟`)) return;
    try {
      await deleteDoc(doc(db, medsPath(), m.id));
      addLog("حذف دواء", m.name, "");
      toast("تم الحذف");
    } catch (err) { toast("فشل الحذف: " + err.message); }
  }
});

/* ---------- نافذة بيع / إضافة كمية ---------- */
function openQty(m) {
  qtyMed = m;
  $("qtyTitle").textContent = m.name;
  $("qtyCurrent").textContent = "الموجود حالياً: " + fmtQty(m);
  $("qBoxes").value = 0;
  $("qStrips").value = 0;
  document.querySelector('input[name="qtype"][value="sell"]').checked = true;
  $("qStripsWrap").classList.toggle("hidden", spbOf(m) <= 1);
  $("qtyModal").classList.remove("hidden");
}
function closeQty() { $("qtyModal").classList.add("hidden"); qtyMed = null; }

$("cancelQty").onclick = closeQty;
$("qtyModal").addEventListener("click", (e) => { if (e.target.id === "qtyModal") closeQty(); });
$("qtyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!qtyMed) return;
  const spb = spbOf(qtyMed);
  const boxes = Math.max(0, parseInt($("qBoxes").value, 10) || 0);
  const strips = spb > 1 ? Math.max(0, parseInt($("qStrips").value, 10) || 0) : 0;
  const total = boxes * spb + strips;
  if (total <= 0) { toast("اكتب كمية أكبر من صفر"); return; }
  const sign = document.querySelector('input[name="qtype"]:checked').value === "sell" ? -1 : 1;
  changeQty(qtyMed, sign * total);
  closeQty();
});

/* ---------- نافذة الدواء ---------- */
function setPreview() {
  const p = $("imgPreview");
  if (currentImage) { p.src = currentImage; p.style.visibility = "visible"; }
  else { p.removeAttribute("src"); p.style.visibility = "hidden"; }
}

function openForm(m, barcode) {
  editingId = m ? m.id : null;
  $("formTitle").textContent = m ? "تعديل دواء" : "إضافة دواء";
  $("fName").value = m ? m.name : "";
  $("fBarcode").value = m ? m.barcode || "" : barcode || "";
  $("fPrice").value = m ? m.price ?? "" : "";
  $("fCategory").value = m ? m.category || "" : "";
  if (m) {
    const spb = spbOf(m);
    $("fSpb").value = spb;
    $("fBoxes").value = Math.floor((m.qty || 0) / spb);
    $("fStrips").value = (m.qty || 0) % spb;
  } else {
    $("fSpb").value = 1;
    $("fBoxes").value = "";
    $("fStrips").value = 0;
  }
  $("fMin").value = m ? m.minQty ?? 5 : 5;
  $("fExpiry").value = m ? m.expiry || "" : "";
  $("fNotes").value = m ? m.notes || "" : "";
  currentImage = m ? m.image || "" : "";
  setPreview();
  $("medModal").classList.remove("hidden");
}
function closeForm() { $("medModal").classList.add("hidden"); }

$("fab").onclick = () => openForm(null);
$("cancelForm").onclick = closeForm;
$("medModal").addEventListener("click", (e) => { if (e.target.id === "medModal") closeForm(); });

function resizeImage(file, max = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.65));
    };
    img.onerror = reject;
    img.src = url;
  });
}

$("imgInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { currentImage = await resizeImage(f); setPreview(); }
  catch { toast("تعذر قراءة الصورة"); }
  e.target.value = "";
});
$("imgRemove").onclick = () => { currentImage = ""; setPreview(); };

$("medForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const barcode = $("fBarcode").value.trim();
  if (barcode && meds.some((m) => m.barcode === barcode && m.id !== editingId)) {
    toast("هذا الباركود مسجل لدواء آخر");
    return;
  }
  const spb = Math.max(1, parseInt($("fSpb").value, 10) || 1);
  const boxes = Math.max(0, parseInt($("fBoxes").value, 10) || 0);
  const strips = spb > 1 ? Math.max(0, parseInt($("fStrips").value, 10) || 0) : 0;
  const data = {
    name: $("fName").value.trim(),
    barcode,
    price: parseFloat($("fPrice").value) || 0,
    category: $("fCategory").value.trim(),
    stripsPerBox: spb,
    qty: boxes * spb + strips,
    minQty: Math.max(0, parseInt($("fMin").value, 10) || 0),
    expiry: $("fExpiry").value,
    notes: $("fNotes").value.trim(),
    image: currentImage,
    updatedAt: serverTimestamp(),
    updatedBy: who()
  };
  if (!data.name) return;
  try {
    if (editingId) {
      await updateDoc(doc(db, medsPath(), editingId), data);
      addLog("تعديل", data.name, "");
    } else {
      await addDoc(collection(db, medsPath()), data);
      addLog("دواء جديد", data.name, fmtQty(data));
    }
    closeForm();
    toast("تم الحفظ");
  } catch (e) { toast("فشل الحفظ: " + e.message); }
});

/* ---------- ماسح الباركود ---------- */
let scanner = null;

async function closeScanner() {
  if (scanner) {
    try { await scanner.stop(); scanner.clear(); } catch (e) {}
    scanner = null;
  }
  $("scanner").classList.add("hidden");
}

function openScanner(onResult) {
  if (typeof Html5Qrcode === "undefined") { toast("مكتبة الماسح لم تُحمّل، تأكد من الإنترنت"); return; }
  $("scanner").classList.remove("hidden");
  scanner = new Html5Qrcode("reader");
  let done = false;
  scanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 260, height: 150 } },
    async (text) => {
      if (done) return;
      done = true;
      await closeScanner();
      onResult(text.trim());
    },
    () => {}
  ).catch(() => { toast("تعذر فتح الكاميرا. اسمح بالصلاحية"); closeScanner(); });
}

$("closeScan").onclick = closeScanner;
$("scanForm").onclick = () => openScanner((code) => { $("fBarcode").value = code; });
$("scanSearch").onclick = () => openScanner((code) => {
  const m = meds.find((x) => x.barcode === code);
  if (m) {
    $("search").value = m.name;
    searchText = m.name;
    tab = "all";
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "all"));
    render();
    toast("تم العثور على: " + m.name);
  } else if (confirm("هذا الباركود غير موجود. هل تريد إضافة دواء جديد به؟")) {
    openForm(null, code);
  }
});

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
