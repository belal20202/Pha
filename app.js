import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocFromCache, setDoc, writeBatch, onSnapshot,
  query, orderBy, limit, serverTimestamp, increment, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

// كاش محلي دائم: يقلل القراءات ويسمح بالعمل بدون إنترنت
let db;
try {
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  db = getFirestore(fbApp);
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PAGE = 60;      // عدد البطاقات بكل دفعة
const LOG_PAGE = 50;  // عدد السجلات بكل دفعة

let me = null, pid = null;
let meds = [], logs = [], daily = null;
let tab = "all", searchText = "", sortBy = "name", logFilter = "all";
let shown = PAGE, logLimit = LOG_PAGE;
let isRegister = false, registering = false;
let unsubs = [], logsUnsub = null;
let editingId = null, currentImage = "", origImage = "";
let qtyMed = null, dayKey = "";
let TODAY = new Date();

const imgCache = new Map();
const imgLoading = new Map();

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
const imagesPath = () => `pharmacies/${pid}/images`;
const logsPath = () => `pharmacies/${pid}/logs`;
const dailyPath = () => `pharmacies/${pid}/daily`;
const medRef = (id) => doc(db, medsPath(), id);

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

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

/* ---------- العلب والأشرطة والأسعار ---------- */
// الكمية (qty) تُخزَّن دائماً بالأشرطة. إذا أشرطة العلبة = 1 فالكمية = عدد العلب.
const spbOf = (m) => Math.max(1, parseInt(m.stripsPerBox, 10) || 1);
const unitPriceOf = (m) =>
  m.unitPrice != null ? Number(m.unitPrice) || 0 : (Number(m.price) || 0) / spbOf(m);
const minOf = (m) => Number(m.minBoxes ?? m.minQty ?? 0) || 0;

function fmtQtyRaw(qty, spb) {
  qty = qty || 0;
  if (spb <= 1) return `${qty} علبة`;
  const b = Math.floor(qty / spb);
  const s = qty % spb;
  const parts = [];
  if (b) parts.push(`${b} علبة`);
  if (s) parts.push(`${s} شريط`);
  return parts.length ? parts.join(" + ") : "0";
}
const fmtQty = (m) => fmtQtyRaw(m.qty, spbOf(m));
const fmtPrice = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString("en-US");
const fmtMoney = (n) => Math.round(n || 0).toLocaleString("en-US") + " د.ع";

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

function subscribeDaily() {
  dayKey = todayKey();
  unsubs.push(onSnapshot(
    doc(db, dailyPath(), dayKey),
    (snap) => { daily = snap.exists() ? snap.data() : null; renderStats(); },
    () => {}
  ));
}

async function startApp(user, pharmacyId) {
  me = user;
  pid = pharmacyId;
  $("pharmName").textContent = "الصيدلية: " + pid;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  unsubs.forEach((u) => u());
  unsubs = [];
  unsubs.push(onSnapshot(
    collection(db, medsPath()),
    (snap) => { meds = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    () => toast("خطأ في تحميل الأدوية")
  ));
  subscribeDaily();
  syncLogs();
}

function stopApp() {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (logsUnsub) { logsUnsub(); logsUnsub = null; }
  me = null; pid = null; meds = []; logs = []; daily = null;
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
}

// السجل يُحمَّل فقط وأنت داخل تبويب السجل (لتوفير القراءات)
function syncLogs() {
  if (logsUnsub) { logsUnsub(); logsUnsub = null; }
  if (!me || tab !== "logs") return;
  logsUnsub = onSnapshot(
    query(collection(db, logsPath()), orderBy("at", "desc"), limit(logLimit)),
    (snap) => { logs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    () => toast("تعذر تحميل السجل")
  );
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me && dayKey !== todayKey()) {
    // بدأ يوم جديد: أعد الاشتراك بمبيعات اليوم الجديد
    unsubs.forEach((u) => u());
    unsubs = [];
    startApp(me, pid);
  }
});

/* ---------- حالة الدواء ---------- */
function daysLeft(m) {
  if (!m.expiry) return null;
  return Math.ceil((new Date(m.expiry + "T00:00:00") - TODAY) / 864e5);
}
function flags(m) {
  const d = daysLeft(m);
  const q = m.qty || 0;
  return {
    out: q <= 0,
    low: q > 0 && q <= minOf(m) * spbOf(m),
    expired: d !== null && d < 0,
    soon: d !== null && d >= 0 && d <= 60,
    days: d
  };
}

/* ---------- الصور (تُحمَّل عند الحاجة فقط) ---------- */
function loadImage(id, rev) {
  const key = `${id}_${rev}`;
  if (imgCache.has(key)) return Promise.resolve(imgCache.get(key));
  if (imgLoading.has(key)) return imgLoading.get(key);
  const p = (async () => {
    const ref = doc(db, imagesPath(), key);
    let snap = null;
    try { snap = await getDocFromCache(ref); } catch (e) { snap = null; }
    if (!snap || !snap.exists()) {
      try { snap = await getDoc(ref); } catch (e) { snap = null; }
    }
    const data = snap && snap.exists() ? snap.data().data || "" : "";
    imgCache.set(key, data);
    imgLoading.delete(key);
    return data;
  })();
  imgLoading.set(key, p);
  return p;
}

const io = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const el = en.target;
        io.unobserve(el);
        loadImage(el.dataset.mid, el.dataset.rev).then((data) => {
          if (data && el.isConnected) el.outerHTML = `<img class="thumb" src="${data}" alt="">`;
        });
      });
    }, { rootMargin: "200px" })
  : null;

function observeLazy() {
  document.querySelectorAll(".thumb.lazy").forEach((el) => {
    if (io) io.observe(el);
    else loadImage(el.dataset.mid, el.dataset.rev).then((data) => {
      if (data && el.isConnected) el.outerHTML = `<img class="thumb" src="${data}" alt="">`;
    });
  });
}

function thumbHTML(m) {
  if (m.imgRev) {
    const key = `${m.id}_${m.imgRev}`;
    if (imgCache.has(key)) {
      const c = imgCache.get(key);
      return c ? `<img class="thumb" src="${c}" alt="">` : `<div class="thumb">💊</div>`;
    }
    return `<div class="thumb lazy" data-mid="${m.id}" data-rev="${m.imgRev}">💊</div>`;
  }
  if (m.image) return `<img class="thumb" src="${m.image}" alt="">`; // صور النسخة القديمة
  return `<div class="thumb">💊</div>`;
}

/* ---------- العرض ---------- */
const TYPE_LABEL = { sell: "بيع", restock: "إضافة كمية", add: "دواء جديد", edit: "تعديل", delete: "حذف" };

function renderStats() {
  if (!me) return;
  TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);
  let low = 0, out = 0, soon = 0, value = 0;
  meds.forEach((m) => {
    const f = flags(m);
    if (f.out) out++; else if (f.low) low++;
    if (f.soon || f.expired) soon++;
    value += (m.qty || 0) * unitPriceOf(m);
  });
  $("stTotal").textContent = meds.length;
  $("stLow").textContent = low;
  $("stOut").textContent = out;
  $("stSoon").textContent = soon;
  $("stValue").textContent = fmtMoney(value);
  $("stSales").textContent = fmtMoney(daily ? daily.revenue : 0);
  $("stSalesSub").textContent = daily && daily.ops ? `${daily.strips || 0} وحدة مباعة · ${daily.ops} عملية` : "لا مبيعات بعد";
}

const tsOf = (m) => (m.updatedAt && m.updatedAt.toMillis ? m.updatedAt.toMillis() : Date.now());
const sorters = {
  name: (a, b) => String(a.name).localeCompare(String(b.name), "ar"),
  qty: (a, b) => (a.qty || 0) / spbOf(a) - (b.qty || 0) / spbOf(b),
  expiry: (a, b) => String(a.expiry || "9999").localeCompare(String(b.expiry || "9999")),
  new: (a, b) => tsOf(b) - tsOf(a)
};

function render() {
  if (!me) return;
  renderStats();
  const list = $("list");

  if (tab === "logs") {
    const q = searchText.trim().toLowerCase();
    const items = logs.filter((l) => {
      if (logFilter !== "all" && l.type !== logFilter) return false;
      if (q && !(`${l.medName} ${l.by} ${l.text}`.toLowerCase().includes(q))) return false;
      return true;
    });
    let html = items.length
      ? items.map((l) => {
          const t = l.at && l.at.toDate ? l.at.toDate().toLocaleString("ar-IQ") : "الآن";
          return `<div class="logrow t-${esc(l.type)}">
            <div class="lhead"><span class="badge">${esc(TYPE_LABEL[l.type] || l.type)}</span><b>${esc(l.medName)}</b></div>
            <div class="ltext">${esc(l.text)}</div>
            <small>${esc(l.by)} — ${esc(t)}</small></div>`;
        }).join("")
      : `<div class="empty">لا توجد حركات مطابقة</div>`;
    if (logs.length >= logLimit) html += `<button class="btn more" data-act="logmore">تحميل المزيد</button>`;
    list.innerHTML = html;
    return;
  }

  const q = searchText.trim().toLowerCase();
  const items = meds
    .filter((m) => {
      if (q && !(`${m.name} ${m.barcode || ""} ${m.category || ""}`.toLowerCase().includes(q))) return false;
      const f = flags(m);
      if (tab === "low") return f.out || f.low;
      if (tab === "soon") return f.soon || f.expired;
      return true;
    })
    .sort(sorters[sortBy]);

  if (!items.length) {
    list.innerHTML = `<div class="empty">${meds.length ? "لا توجد نتائج" : "لا توجد أدوية. اضغط ＋ لإضافة أول دواء"}</div>`;
    return;
  }

  const visible = items.slice(0, shown);
  let html = visible.map((m) => {
    const f = flags(m);
    const spb = spbOf(m);
    const up = unitPriceOf(m);
    const cls = f.out ? "out" : f.low ? "low" : "ok";
    const chips = [];
    if (f.out) chips.push(`<span class="chip red">خالص</span>`);
    else if (f.low) chips.push(`<span class="chip org">قليل</span>`);
    else chips.push(`<span class="chip">متوفر</span>`);
    if (f.expired) chips.push(`<span class="chip red">منتهي</span>`);
    else if (f.soon) chips.push(`<span class="chip yel">ينتهي بعد ${f.days} يوم</span>`);
    if (m.category) chips.push(`<span class="chip" style="background:#7a8f89">${esc(m.category)}</span>`);
    const priceLine = spb > 1
      ? `سعر الشريط ${fmtPrice(up)} · العلبة ${fmtPrice(up * spb)}`
      : `السعر ${fmtPrice(up)}`;
    const totals = spb > 1
      ? `إجمالي الأشرطة: ${m.qty || 0} · علب كاملة: ${Math.floor((m.qty || 0) / spb)}`
      : "";
    const stripBtn = spb > 1 ? `<button class="qbtn txt" data-act="sell-strip" data-id="${m.id}">−شريط</button>` : "";
    return `
    <div class="card ${cls}">
      ${thumbHTML(m)}
      <div class="info">
        <h3>${esc(m.name)}</h3>
        <div class="meta">${m.barcode ? "▦ " + esc(m.barcode) + " · " : ""}${priceLine}${m.expiry ? " · " + esc(m.expiry) : ""}</div>
        <div class="chips">${chips.join("")}</div>
        <div class="qtybox"><b>${esc(fmtQty(m))}</b>${totals ? `<small>${totals}</small>` : ""}</div>
        <div class="actions">
          ${stripBtn}
          <button class="qbtn txt" data-act="sell-box" data-id="${m.id}">−علبة</button>
          <button class="qbtn txt plus" data-act="add-box" data-id="${m.id}">+علبة</button>
          <button class="sm" data-act="adj" data-id="${m.id}">كمية</button>
          <button class="sm" data-act="edit" data-id="${m.id}">تعديل</button>
          <button class="sm del" data-act="del" data-id="${m.id}">حذف</button>
        </div>
      </div>
    </div>`;
  }).join("");
  if (items.length > shown) html += `<button class="btn more" data-act="more">عرض المزيد (${items.length - shown})</button>`;
  list.innerHTML = html;
  observeLazy();
}

$("search").addEventListener("input", (e) => { searchText = e.target.value; shown = PAGE; render(); });
$("sortSel").addEventListener("change", (e) => { sortBy = e.target.value; shown = PAGE; render(); });

function setTab(t) {
  tab = t;
  shown = PAGE;
  logLimit = LOG_PAGE;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
  $("logFilters").classList.toggle("hidden", t !== "logs");
  syncLogs();
  render();
}
document.querySelectorAll(".tab").forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
document.querySelectorAll(".chipf").forEach((b) => {
  b.onclick = () => {
    logFilter = b.dataset.lf;
    document.querySelectorAll(".chipf").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});

/* ---------- السجل: كل حركة تُسجَّل ---------- */
function addLogTo(batch, type, medId, medName, text, extra) {
  batch.set(doc(collection(db, logsPath())), {
    type, medId: medId || "", medName, text: text || "",
    by: who(), uid: me.uid, at: serverTimestamp(), ...(extra || {})
  });
}

function runBatch(batch, okMsg) {
  batch.commit().catch((e) => toast("فشلت العملية: " + e.message));
  if (okMsg) toast(okMsg);
}

/* ---------- الكميات: بيع وإضافة ---------- */
// delta بالأشرطة (سالب = بيع، موجب = إضافة)
function changeQty(m, delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  const spb = spbOf(m);
  if ((m.qty || 0) + delta < 0) { toast("الكمية المتوفرة أقل من المطلوب"); return; }
  const sell = delta < 0;
  const n = Math.abs(delta);
  const left = (m.qty || 0) + delta;
  const revenue = sell ? n * unitPriceOf(m) : 0;
  const text = `${sell ? "بيع" : "إضافة"} ${fmtQtyRaw(n, spb)}` +
    (sell ? ` بمبلغ ${fmtMoney(revenue)}` : "") + ` — المتبقي: ${fmtQtyRaw(left, spb)}`;

  const batch = writeBatch(db);
  batch.update(medRef(m.id), { qty: increment(delta), updatedAt: serverTimestamp(), updatedBy: who() });
  addLogTo(batch, sell ? "sell" : "restock", m.id, m.name, text, { strips: n, revenue });
  if (sell) {
    batch.set(doc(db, dailyPath(), todayKey()), {
      date: todayKey(), revenue: increment(revenue), strips: increment(n), ops: increment(1)
    }, { merge: true });
  }
  runBatch(batch, sell ? "تم البيع" : "تمت الإضافة");
}

/* ---------- حذف دواء ---------- */
function deleteMed(m) {
  if (!confirm(`حذف "${m.name}" نهائياً لكل المستخدمين؟`)) return;
  const batch = writeBatch(db);
  batch.delete(medRef(m.id));
  if (m.imgRev) batch.delete(doc(db, imagesPath(), `${m.id}_${m.imgRev}`));
  addLogTo(batch, "delete", m.id, m.name, `حذف الدواء وكان متوفراً: ${fmtQty(m)}`);
  runBatch(batch, "تم الحذف");
}

/* ---------- أحداث القائمة ---------- */
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "more") { shown += PAGE; render(); return; }
  if (act === "logmore") { logLimit += LOG_PAGE; syncLogs(); return; }
  const m = meds.find((x) => x.id === b.dataset.id);
  if (!m) return;
  if (act === "sell-strip") changeQty(m, -1);
  else if (act === "sell-box") changeQty(m, -spbOf(m));
  else if (act === "add-box") changeQty(m, spbOf(m));
  else if (act === "adj") openQty(m);
  else if (act === "edit") openForm(m);
  else if (act === "del") deleteMed(m);
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

function updateSummary() {
  const spb = Math.max(1, parseInt($("fSpb").value, 10) || 1);
  const up = parseFloat($("fPrice").value) || 0;
  const boxes = Math.max(0, parseInt($("fBoxes").value, 10) || 0);
  const extra = spb > 1 ? Math.max(0, parseInt($("fStrips").value, 10) || 0) : 0;
  const total = boxes * spb + extra;
  $("stripsWrap").classList.toggle("hidden", spb <= 1);
  $("priceLabel").textContent = spb > 1 ? "سعر الشريط (د.ع)" : "سعر العلبة / الوحدة (د.ع)";
  $("summary").innerHTML =
    `الإجمالي: <b>${esc(fmtQtyRaw(total, spb))}</b>${spb > 1 ? ` (${total} شريط)` : ""}<br>` +
    (spb > 1 ? `سعر العلبة: <b>${fmtPrice(up * spb)}</b> د.ع · ` : "") +
    `قيمة هذا الدواء بالمخزون: <b>${fmtMoney(total * up)}</b>`;
}
["fSpb", "fPrice", "fBoxes", "fStrips"].forEach((id) => $(id).addEventListener("input", updateSummary));

async function openForm(m, barcode) {
  editingId = m ? m.id : null;
  currentImage = "";
  origImage = "";
  $("formTitle").textContent = m ? "تعديل دواء" : "إضافة دواء";
  $("fName").value = m ? m.name : "";
  $("fBarcode").value = m ? m.barcode || "" : barcode || "";
  $("fCategory").value = m ? m.category || "" : "";
  $("fExpiry").value = m ? m.expiry || "" : "";
  if (m) {
    const spb = spbOf(m);
    $("fSpb").value = spb;
    $("fPrice").value = Math.round(unitPriceOf(m) * 100) / 100;
    $("fBoxes").value = Math.floor((m.qty || 0) / spb);
    $("fStrips").value = (m.qty || 0) % spb;
    $("fMin").value = minOf(m);
  } else {
    $("fSpb").value = 1;
    $("fPrice").value = "";
    $("fBoxes").value = "";
    $("fStrips").value = 0;
    $("fMin").value = 5;
  }
  $("fNotes").value = m ? m.notes || "" : "";
  setPreview();
  updateSummary();
  $("medModal").classList.remove("hidden");
  if (m) {
    if (m.imgRev) {
      origImage = await loadImage(m.id, m.imgRev);
      currentImage = origImage;
    } else if (m.image) {
      currentImage = m.image; // صورة قديمة: تُنقل للمجموعة الجديدة عند الحفظ
    }
    setPreview();
  }
}
function closeForm() { $("medModal").classList.add("hidden"); }

$("fab").onclick = () => openForm(null);
$("cancelForm").onclick = closeForm;
$("medModal").addEventListener("click", (e) => { if (e.target.id === "medModal") closeForm(); });

function resizeImage(file, max = 160) {
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
      resolve(c.toDataURL("image/jpeg", 0.6));
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

function diffList(o, d, imgChanged) {
  const L = [];
  const ch = (label, a, b) => {
    if (String(a ?? "") !== String(b ?? "")) L.push(`${label}: من ${a === "" || a == null ? "—" : a} إلى ${b === "" || b == null ? "—" : b}`);
  };
  ch("الاسم", o.name, d.name);
  ch("الباركود", o.barcode || "", d.barcode);
  ch("التصنيف", o.category || "", d.category);
  ch(d.stripsPerBox > 1 ? "سعر الشريط" : "السعر", Math.round(unitPriceOf(o) * 100) / 100, d.unitPrice);
  ch("أشرطة بالعلبة", spbOf(o), d.stripsPerBox);
  ch("حد التنبيه (علب)", minOf(o), d.minBoxes);
  ch("تاريخ الانتهاء", o.expiry || "", d.expiry);
  if ((o.notes || "") !== d.notes) L.push("تعديل الملاحظات");
  if ((o.qty || 0) !== d.qty) {
    L.push(`الكمية: من ${fmtQtyRaw(o.qty || 0, spbOf(o))} إلى ${fmtQtyRaw(d.qty, d.stripsPerBox)}`);
  }
  if (imgChanged) L.push(d.imgRev ? "تغيير الصورة" : "حذف الصورة");
  return L;
}

$("medForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = $("fName").value.trim();
  if (!name) return;
  const barcode = $("fBarcode").value.trim();
  if (barcode && meds.some((m) => m.barcode === barcode && m.id !== editingId)) {
    toast("هذا الباركود مسجل لدواء آخر");
    return;
  }

  const spb = Math.max(1, parseInt($("fSpb").value, 10) || 1);
  const boxes = Math.max(0, parseInt($("fBoxes").value, 10) || 0);
  const extra = spb > 1 ? Math.max(0, parseInt($("fStrips").value, 10) || 0) : 0;
  const old = editingId ? meds.find((m) => m.id === editingId) : null;
  const ref = editingId ? medRef(editingId) : doc(collection(db, medsPath()));
  const batch = writeBatch(db);

  // الصورة: مجموعة منفصلة، ورقم نسخة جديد عند كل تغيير
  const imgChanged = currentImage !== origImage;
  let rev = old ? old.imgRev || 0 : 0;
  if (imgChanged) {
    if (old && old.imgRev) batch.delete(doc(db, imagesPath(), `${ref.id}_${old.imgRev}`));
    rev = currentImage ? Date.now() : 0;
    if (currentImage) {
      batch.set(doc(db, imagesPath(), `${ref.id}_${rev}`), { data: currentImage });
      imgCache.set(`${ref.id}_${rev}`, currentImage);
    }
  }

  const data = {
    name, barcode,
    category: $("fCategory").value.trim(),
    unitPrice: Math.round((parseFloat($("fPrice").value) || 0) * 100) / 100,
    stripsPerBox: spb,
    qty: boxes * spb + extra,
    minBoxes: Math.max(0, parseInt($("fMin").value, 10) || 0),
    expiry: $("fExpiry").value,
    notes: $("fNotes").value.trim(),
    imgRev: rev,
    updatedAt: serverTimestamp(),
    updatedBy: who()
  };

  if (old) {
    const changes = diffList(old, data, imgChanged);
    if (!changes.length) { closeForm(); toast("لا توجد تغييرات"); return; }
    batch.update(ref, { ...data, image: deleteField(), price: deleteField(), minQty: deleteField() });
    addLogTo(batch, "edit", ref.id, name, changes.join(" ، "));
  } else {
    batch.set(ref, { ...data, createdAt: serverTimestamp(), createdBy: who() });
    addLogTo(batch, "add", ref.id, name,
      `إضافة دواء جديد بكمية ${fmtQtyRaw(data.qty, spb)} وسعر ${spb > 1 ? "الشريط" : "الوحدة"} ${fmtPrice(data.unitPrice)}`);
  }
  closeForm();
  runBatch(batch, "تم الحفظ");
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
    setTab("all");
    toast("تم العثور على: " + m.name);
  } else if (confirm("هذا الباركود غير موجود. هل تريد إضافة دواء جديد به؟")) {
    openForm(null, code);
  }
});

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
