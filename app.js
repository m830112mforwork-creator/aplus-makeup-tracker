// ============================================================
// 國小英語 補課派工與進度追蹤系統
// ------------------------------------------------------------
// 設定方式：請看 README.md「第一步」，照著做完後把 firebaseConfig 貼到
// 下面的 FIREBASE_CONFIG，並依 README「第三步」建立共用帳號、貼上 Firestore 規則。
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp, setDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Firebase 專案：makeupclass（網頁設定值本來就會出現在網頁原始碼裡，不是密碼）
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBgud6AEG61Tj3FMukDckme7d7Mx9Z9TEM",
  authDomain: "makeupclass-39f6b.firebaseapp.com",
  projectId: "makeupclass-39f6b",
  storageBucket: "makeupclass-39f6b.firebasestorage.app",
  messagingSenderId: "737072892980",
  appId: "1:737072892980:web:b87951f3ba78f5122bce61",
  measurementId: "G-Y5FW7C1VG5"
};

// ------------------------------------------------------------
// 要不要在進系統前先問密碼？
//
//   false = 不問，打開網址就能用（目前設定）
//           Firestore 規則請貼 firestore.rules（完全開放）
//
//   true  = 要問部門共用密碼
//           改成 true 之前請先做完 README「附錄：之後想開密碼保護時」，
//           並把 firestore.with-password.rules 貼到 Firebase 規則
// ------------------------------------------------------------
const REQUIRE_PASSWORD = false;

// 全部門共用的那一組帳號。使用者只需要輸入密碼，帳號由系統自動帶入。
// 這個 email 不需要是真的信箱，但必須跟你在 Firebase Authentication
// 後台建立的那一組完全一致。只有 REQUIRE_PASSWORD = true 時才會用到。
const SHARED_ACCOUNT_EMAIL = "staff@aplus-makeup.local";

const WEEKDAY_LABEL = { Mon:"週一", Tue:"週二", Wed:"週三", Thu:"週四", Fri:"週五" };
const OVERDUE_DAYS = 3; // 缺課日期超過幾天沒補課 = 逾期，管理職儀表板會標紅

let db = null;
let auth = null;
let unsubscribers = [];   // Firestore 監聽器，登出時要一起收掉
let records = [];
let roster = [];
let state = { role: "teacher", name: "" };
let selectedSlot = null; // {weekday, time, ta}
let adminFilter = { search: "", status: "all", ta: "" };
let teacherFilter = { status: "all" };
// 兩個 Firestore 集合第一次載入完成了沒。還沒載入時名單是空的，
// 不要急著把使用者的名字標成「不在名單」。
let loaded = { records: false, roster: false };

// 總表一次最多畫幾列。紀錄累積到上千筆時，全部塞進 DOM 會讓頁面長到幾十萬
// 像素、節點數破六萬，捲動開始頓。超過的部分按「顯示更多」再追加。
const ADMIN_PAGE_SIZE = 100;   // 總表一次 100 列
const CARD_PAGE_SIZE = 50;     // 卡片列表一次 50 張（卡片比表格列重）
let adminShown = ADMIN_PAGE_SIZE;
let teacherShown = CARD_PAGE_SIZE;
let taPendingShown = CARD_PAGE_SIZE;
let taDoneShown = CARD_PAGE_SIZE;

// 「顯示 N / M 筆」＋兩顆按鈕。四個列表共用。
function renderMoreBar(el, shownCount, totalCount, step, onMore, onAll){
  if(!el) return;
  if(totalCount <= shownCount){ el.innerHTML = ""; return; }
  el.innerHTML = `<div class="more-bar">
    <span>顯示 ${shownCount} / ${totalCount} 筆</span>
    <button type="button" class="btn secondary small" data-act="more">再顯示 ${Math.min(step, totalCount - shownCount)} 筆</button>
    <button type="button" class="btn ghost small" data-act="all">全部顯示</button>
  </div>`;
  el.querySelector('[data-act="more"]').addEventListener("click", onMore);
  el.querySelector('[data-act="all"]').addEventListener("click", onAll);
}

// 哪些分頁的內容已經過期需要重畫。資料一有更新就把三頁都標記為過期，
// 但只重畫使用者正在看的那一頁，其餘等切過去再畫。
let dirty = { teacher: true, ta: true, admin: true };

// ---------------- Firebase 初始化 ----------------
function isConfigured(){
  return FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

function initFirebase(){
  const banner = document.getElementById("setupBanner");
  const connStatus = document.getElementById("connStatus");
  if(!isConfigured()){
    banner.style.display = "block";
    banner.innerHTML = "⚠️ 尚未設定 Firebase：請在 app.js 最上方的 FIREBASE_CONFIG 填入妳的新 Firebase 專案設定值，系統才能真正儲存資料。目前是示範狀態，資料不會被保存，也不會要求密碼。";
    connStatus.textContent = "尚未連線 Firebase（示範模式）";
    seedLocalDemoData();
    loaded.records = loaded.roster = true;
    renderAll();
    return;
  }
  const app = initializeApp(FIREBASE_CONFIG);
  db = getFirestore(app);

  if(!REQUIRE_PASSWORD){
    showApp();            // 不顯示登入畫面，也不顯示登出按鈕
    startDataListeners();
    return;
  }

  auth = getAuth(app);

  // 先蓋上登入畫面，避免 Firebase 還在確認登入狀態時閃過系統內容
  document.getElementById("lockScreen").hidden = false;
  document.getElementById("connStatus").textContent = "確認登入狀態…";

  // 登入狀態記在這台裝置上，關掉分頁再打開不用重新輸入密碼
  setPersistence(auth, browserLocalPersistence).catch(()=>{});

  onAuthStateChanged(auth, user => {
    if(user){ showApp(); startDataListeners(); }
    else { stopDataListeners(); showLockScreen(); }
  });
}

function startDataListeners(){
  const connStatus = document.getElementById("connStatus");
  if(unsubscribers.length) return;   // 已經在監聽了，不要重複掛
  connStatus.textContent = "已連線";

  unsubscribers.push(
    onSnapshot(query(collection(db,"records"), orderBy("absenceDate","desc")), snap => {
      records = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      loaded.records = true;
      renderAll();
    }, err => { connStatus.textContent = "連線錯誤：" + err.message; })
  );

  unsubscribers.push(
    // 時段表一開始是空的，由管理職照實際排班輸入（不自動建立預設時段）
    onSnapshot(collection(db,"roster"), snap => {
      roster = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      loaded.roster = true;
      renderAll();
    }, err => { connStatus.textContent = "連線錯誤：" + err.message; })
  );
}

function stopDataListeners(){
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  records = [];
  roster = [];
  renderAll();
}

// ---------------- 登入畫面 ----------------
const lockScreen = document.getElementById("lockScreen");
const lockForm = document.getElementById("lockForm");
const lockPassword = document.getElementById("lockPassword");
const lockSubmit = document.getElementById("lockSubmit");
const lockError = document.getElementById("lockError");
const signOutBtn = document.getElementById("signOutBtn");

function showLockScreen(){
  lockScreen.hidden = false;
  signOutBtn.hidden = true;
  lockPassword.value = "";
  lockError.textContent = "";
  document.getElementById("connStatus").textContent = "請先輸入密碼";
  lockPassword.focus();
}

function showApp(){
  lockScreen.hidden = true;
  signOutBtn.hidden = !REQUIRE_PASSWORD;   // 沒有密碼保護時，登出按鈕沒有意義
}

lockForm.addEventListener("submit", async e => {
  e.preventDefault();
  const pw = lockPassword.value;
  if(!pw) return;
  lockSubmit.disabled = true;
  lockError.textContent = "";
  try{
    await signInWithEmailAndPassword(auth, SHARED_ACCOUNT_EMAIL, pw);
    // 成功後 onAuthStateChanged 會自動關掉這個畫面
  }catch(err){
    const code = err.code || "";
    if(code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found"){
      lockError.textContent = "密碼不正確，請再試一次。";
    } else if(code === "auth/too-many-requests"){
      lockError.textContent = "錯誤次數太多，已被暫時鎖住，請等幾分鐘再試。";
    } else if(code === "auth/network-request-failed"){
      lockError.textContent = "連不上網路，請檢查網路連線。";
    } else {
      lockError.textContent = "登入失敗：" + (err.message || code);
    }
    lockPassword.select();
  }finally{
    lockSubmit.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  if(auth) await signOut(auth);
});

// 示範模式（未設定 Firebase 時）用記憶體假資料，方便妳先看介面
function seedLocalDemoData(){
  roster = [
    { id:"r1", weekday:"Mon", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
    { id:"r2", weekday:"Tue", time:"1:00-2:00", ta:null, quota:0 },
    { id:"r3", weekday:"Wed", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
  ];
  records = [];
}

// ---------------- 共用工具 ----------------
function uid(){ return Math.random().toString(36).slice(2,9); }
// 日期一律用「本地時間」處理。toISOString() 是國際標準時間，台灣早上 8 點前會變成前一天。
const pad2 = n => String(n).padStart(2, "0");
function toDateStr(dt){ return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`; }
function parseDate(str){ const [y, m, d] = String(str).split("-").map(Number); return new Date(y, m-1, d); }
function isDateStr(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v || ""); }
function addDays(str, n){ const dt = parseDate(str); dt.setDate(dt.getDate() + n); return toDateStr(dt); }
function todayStr(){ return toDateStr(new Date()); }
function daysSince(dateStr){
  if(!dateStr) return 0;
  return Math.round((parseDate(todayStr()) - parseDate(dateStr)) / 86400000);
}
const WEEKDAY_KEYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WEEKDAY_SHORT = { Mon:"一", Tue:"二", Wed:"三", Thu:"四", Fri:"五", Sat:"六", Sun:"日" };
function weekdayOf(dayKey){ return isDateStr(dayKey) ? WEEKDAY_KEYS[parseDate(dayKey).getDay()] : dayKey; }
function mondayOf(str){ const dt = parseDate(str); dt.setDate(dt.getDate() - (dt.getDay() + 6) % 7); return toDateStr(dt); }
function shortDate(str){ const dt = parseDate(str); return `${dt.getMonth()+1}/${dt.getDate()}`; }
// 一筆紀錄的生命週期：
//   待補課 →（助教填完成果）→ 待老師查核 →（老師簽名）→ 已完成
// 老師簽名這一步對應補課合作說明裡教師須預備的第 4 項「補課追蹤：查看助教
// 填寫的補課紀錄並簽名」。沒簽名就不算結案。
function computeStatus(r){
  if(r.cancelled) return "cancelled";   // 取消的補課不算逾期，也不佔名額
  if(r.actualDate) return r.teacherVerified ? "done" : "toVerify";
  // 助教點名記了「未到」，而且之後老師還沒改期 → 要老師處理
  if(r.lastNoShow && !(r.lastRescheduled && r.lastRescheduled.at > r.lastNoShow.at)) return "noShow";
  if(daysSince(r.absenceDate) > OVERDUE_DAYS) return "overdue";
  return "pending";
}
function statusLabel(s){
  return { pending:"待補課", overdue:"逾期未補", noShow:"未到待改期", toVerify:"待老師查核", done:"已完成", cancelled:"已取消" }[s];
}
function formatStamp(ms){
  if(!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
let toastTimer = null;
function showToast(msg, kind){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.toggle("error", kind === "error");
  t.classList.add("show");
  clearTimeout(toastTimer);
  // 錯誤訊息比較長、也比較重要，停久一點
  toastTimer = setTimeout(()=>t.classList.remove("show"), kind === "error" ? 6000 : 2200);
}

// ---------------- 寫入保護 ----------------
// 所有寫進 Firestore 的動作都走這裡：失敗一定要讓使用者看到，不能讓人以為存好了。
const SAVE_TIMEOUT_MS = 15000;
function saveErrorText(err){
  if(err?.code === "timeout") return "網路太慢，還沒確認有存到。請檢查網路，重新整理頁面確認資料是否已存入。";
  if(err?.code === "permission-denied") return "存檔被拒絕：請確認 Firestore 規則有沒有貼對。";
  if(err?.code === "unavailable") return "連不上資料庫，請檢查網路後再試一次。";
  return `存檔失敗：${err?.message || err}`;
}
async function writeSafely(work){
  let timer;
  try{
    await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject)=>{ timer = setTimeout(()=>reject({ code:"timeout" }), SAVE_TIMEOUT_MS); }),
    ]);
    return true;
  }catch(err){
    console.error(err);
    showToast(saveErrorText(err), "error");
    return false;
  }finally{
    clearTimeout(timer);
  }
}
// 存檔期間把按鈕鎖住，避免連點送出兩次、變成兩筆一樣的紀錄
async function withBusy(btn, fn, busyText){
  if(!btn || btn.dataset.busy) return;
  const original = btn.textContent;
  btn.dataset.busy = "1";
  btn.disabled = true;
  if(busyText) btn.textContent = busyText;
  try{ return await fn(); }
  finally{
    delete btn.dataset.busy;
    btn.disabled = false;
    if(busyText && btn.textContent === busyText) btn.textContent = original;
  }
}
// 名額按「某一天」計算：同一個每週時段，9/17 和 9/24 各有自己的名額。
// excludeId：改期時把「這筆自己」排除，不然它原本佔的位子會讓時段看起來比實際更滿
function rosterSlotFor(date, time, ta){
  return roster.find(s=>s.ta && s.weekday===weekdayOf(date) && s.time===time && s.ta===ta);
}
function remainingForSlot(date, time, ta, excludeId){
  const slot = rosterSlotFor(date, time, ta);
  if(!slot) return 0;
  return slot.quota - usedOnDate(date, time, ta, excludeId);
}
// 當天這個時段已經排了幾位（取消的不算；補完課的算，那天確實用掉了位子）
function usedOnDate(date, time, ta, excludeId){
  return records.filter(r=>
    r.id!==excludeId && !r.cancelled &&
    r.slotDate===date && r.slotTime===time && r.slotTA===ta
  ).length;
}
// 某個每週時段「今天起」已經排進來、還沒補課的紀錄（時段設定表用）
function upcomingInSlot(slot){
  const today = todayStr();
  return records.filter(r=>
    !r.cancelled && !r.actualDate && r.slotDate && r.slotDate >= today &&
    weekdayOf(r.slotDate)===slot.weekday && r.slotTime===slot.time && r.slotTA===slot.ta
  );
}
// dayKey 可以是日期（2026-09-17）或舊資料只有的星期（Wed）
function slotLabel(dayKey, time){
  if(isDateStr(dayKey)) return `${shortDate(dayKey)}（${WEEKDAY_SHORT[weekdayOf(dayKey)]}）${time || ""}`;
  return `${WEEKDAY_LABEL[dayKey] || dayKey || ""} ${time || ""}`.trim();
}
function slotText(dayKey, time, ta){ return `${slotLabel(dayKey, time)}（${ta || "-"}）`; }
// 時段備註（通常寫使用的輔導教室）。從時段設定即時查，管理職改了教室，舊紀錄也會顯示新的
function slotNote(dayKey, time, ta){
  return (roster.find(s=>s.ta && s.weekday===weekdayOf(dayKey) && s.time===time && s.ta===ta)?.note || "").trim();
}
function slotTextWithNote(dayKey, time, ta){
  const note = slotNote(dayKey, time, ta);
  return `${slotLabel(dayKey, time)}（${ta || "-"}${note ? `・${note}` : ""}）`;
}
// 紀錄的「哪一天」：有補課日期用日期，沒有就退回星期
function dayOf(r){ return r.slotDate || r.slotWeekday; }
// 某星期在指定日期「之後」的第一個日期（不含當天）
function nextWeekdayAfter(weekday, afterDate){
  let dt = addDays(afterDate, 1);
  for(let i = 0; i < 7 && weekdayOf(dt) !== weekday; i++) dt = addDays(dt, 1);
  return dt;
}
// 同一個星期＋時段可能排了不只一位助教，全部都要列出來
function slotsAt(weekday, time){
  return roster.filter(s=>s.weekday===weekday && s.time===time && s.ta);
}
function escapeHtml(v){
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// ---------------- 角色切換 / 身分列 ----------------
function switchRole(role){
  state.role = role;
  document.querySelectorAll("#roleTabs button").forEach(b=>b.classList.toggle("active", b.dataset.role===role));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  document.getElementById("view-"+role).classList.add("active");
  localStorage.setItem("makeup_role", role);
  window.scrollTo({ top:0, behavior:"smooth" });
  renderActiveView();   // 只畫剛切過去的那一頁
}

document.getElementById("roleTabs").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-role]");
  if(btn) switchRole(btn.dataset.role);
});

// 提示條裡的「補課合作說明」連結
document.querySelectorAll("[data-goto]").forEach(a=>{
  a.addEventListener("click", ()=>switchRole(a.dataset.goto));
});

// ---------------- 姓名：下拉選單 ----------------
// 這一欄決定你看得到誰的紀錄。原本手打，助教打成「jocelyn」或多一個空格就配對不到，
// 畫面一片空白也沒有任何提示。改成從名單挑：老師可自行新增名字；助教只能選時段設定
// 裡有的名字——助教的紀錄是靠時段設定的姓名配對的，名單外的名字填了也看不到東西。
const nameSelect = document.getElementById("myName");
const nameLabel = document.getElementById("nameLabel");
const nameAdd = document.getElementById("nameAdd");
const nameAddInput = document.getElementById("nameAddInput");
const CUSTOM_NAMES_KEY = "makeup_custom_names";

const NAME_HINT = {
  teacher: { label:"填表老師", pick:"選擇填表老師", noun:"老師" },
  ta:      { label:"助教",     pick:"選擇助教",     noun:"助教" },
  admin:   { label:"管理職",   pick:"選擇名字",     noun:"" },
  rules:   { label:"填表老師", pick:"選擇填表老師", noun:"老師" },
};

function uniqSorted(list){
  return [...new Set(list.map(n=>String(n||"").trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b, "zh-Hant"));
}
function loadCustomNames(){
  try{ return JSON.parse(localStorage.getItem(CUSTOM_NAMES_KEY) || "[]"); }catch(_){ return []; }
}
function saveCustomName(name){
  const list = loadCustomNames();
  if(list.includes(name)) return;
  list.push(name);
  try{ localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(list)); }catch(_){}
}
function taNameList(){ return uniqSorted(roster.filter(s=>s.ta).map(s=>s.ta)); }
function teacherNameList(){ return uniqSorted([...records.map(r=>r.teacherName), ...loadCustomNames()]); }
function namesForRole(role){
  if(role === "ta") return taNameList();
  if(role === "admin") return uniqSorted([...teacherNameList(), ...taNameList()]);
  return teacherNameList();
}

function refreshNameField(){
  const hint = NAME_HINT[state.role] || NAME_HINT.teacher;
  nameLabel.textContent = hint.label;
  const names = namesForRole(state.role);
  const ready = loaded.records && loaded.roster;

  // 選項沒變就不重建，否則別人存檔觸發重畫時，使用者正展開的下拉選單會被關掉
  const sig = [state.role, state.name, ready, ...names].join("|");
  if(nameSelect.dataset.sig !== sig){
    nameSelect.dataset.sig = sig;
    const e = escapeHtml;
    let html = `<option value="" disabled hidden>${hint.pick}</option>`;
    html += names.map(n=>`<option value="${e(n)}">${e(n)}</option>`).join("");
    // 目前的名字不在名單上（例如以前手打的），照樣列出來並標示，讓使用者看得到、改得掉
    if(state.name && !names.includes(state.name)){
      const suffix = ready && hint.noun ? `（不在${hint.noun}名單）` : "";
      html += `<option value="${e(state.name)}">${e(state.name)}${suffix}</option>`;
    }
    html += `<option disabled>──────────</option>`;
    html += state.role === "ta"
      ? `<option disabled>名單沒有你？請管理職先到時段設定加入</option>`
      : `<option value="__add__">＋ 新增名字…</option>`;
    nameSelect.innerHTML = html;
  }
  nameSelect.value = state.name || "";
  nameSelect.classList.toggle("empty", !state.name);
}

function setName(name){
  state.name = name;
  try{ localStorage.setItem("makeup_name", name); }catch(_){}
  renderAll();
}

nameSelect.addEventListener("change", ()=>{
  if(nameSelect.value === "__add__"){ startAddName(); return; }
  setName(nameSelect.value);
});

function startAddName(){
  nameSelect.hidden = true;
  nameAdd.hidden = false;
  nameAddInput.value = "";
  nameAddInput.focus();
}
function endAddName(){
  nameAdd.hidden = true;
  nameSelect.hidden = false;
  nameSelect.dataset.sig = "";   // 強制重建，把選單值還原成原本的名字
  refreshNameField();
}
function commitAddName(){
  const raw = nameAddInput.value.trim().replace(/\s+/g, " ");
  if(!raw){ endAddName(); return; }
  // 只差在大小寫就當成同一個人，直接用名單上的寫法，避免同一人出現兩種名字
  const known = uniqSorted([...teacherNameList(), ...taNameList()]);
  const match = known.find(n=>n.toLowerCase() === raw.toLowerCase());
  const name = match || raw;
  if(!match) saveCustomName(name);
  if(match && match !== raw) showToast(`名單上已經有「${match}」，已直接選取`);
  nameAdd.hidden = true;
  nameSelect.hidden = false;
  setName(name);
}
document.getElementById("nameAddOk").addEventListener("click", commitAddName);
document.getElementById("nameAddCancel").addEventListener("click", endAddName);
nameAddInput.addEventListener("keydown", e=>{
  if(e.key === "Enter"){ e.preventDefault(); commitAddName(); }
  if(e.key === "Escape"){ e.preventDefault(); endAddName(); }
});

state.name = (localStorage.getItem("makeup_name") || "").trim();
// 這台電腦用過的名字記下來，老師還沒送出過紀錄時，名單上也找得到自己
if(state.name) saveCustomName(state.name);
(function restoreRole(){
  const saved = localStorage.getItem("makeup_role");
  if(saved){
    state.role = saved;
    document.querySelectorAll("#roleTabs button").forEach(b=>b.classList.toggle("active", b.dataset.role===saved));
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById("view-"+saved).classList.add("active");
  }
})();

// ---------------- 時段表（新增紀錄、修改紀錄改期共用）----------------
// 以「週」顯示實際日期，名額按當天計算。
// opts.selected  目前選中的 {date, weekday, time, ta}
// opts.onPick    點了某個時段時呼叫
// opts.excludeId 改期時排除這筆自己佔的名額
function defaultWeek(){
  const today = todayStr();
  const wd = parseDate(today).getDay();
  // 週末打開就直接顯示下週
  return (wd === 0 || wd === 6) ? addDays(mondayOf(today), 7) : mondayOf(today);
}

function renderSlotGrid(wrap, opts){
  wrap._slotOpts = opts;   // 切換週次時用同一組設定重畫
  const { selected = null, onPick, excludeId } = opts;
  const today = todayStr();
  const thisMonday = mondayOf(today);
  const weekdays = ["Mon","Tue","Wed","Thu","Fri"];
  // 只算有排助教的時段；整列時段都被刪光時，那一列就不該再出現
  const times = [...new Set(roster.filter(s=>s.ta).map(s=>s.time))].sort();

  if(times.length === 0){
    wrap.innerHTML = '<div class="empty">還沒有任何補課時段。請管理職先到「管理職」頁最下方的「助教時段與名額設定」新增。</div>';
    return;
  }

  // 顯示哪一週記在容器上，重畫時不會跳回去。第一次打開：選中的是未來日期就顯示那週
  if(!wrap.dataset.week){
    wrap.dataset.week = (selected?.date && selected.date >= today) ? mondayOf(selected.date) : defaultWeek();
  }
  if(wrap.dataset.week < thisMonday) wrap.dataset.week = thisMonday;
  const week = wrap.dataset.week;
  const dates = weekdays.map((_, i)=>addDays(week, i));

  let html = `<div class="week-nav">
    <button type="button" data-nav="-7" ${week <= thisMonday ? "disabled" : ""}>‹ 上一週</button>
    <span class="week-label">${shortDate(dates[0])} – ${shortDate(dates[4])}${week === thisMonday ? "（本週）" : ""}</span>
    <button type="button" data-nav="7">下一週 ›</button>
  </div>`;
  html += '<div class="slot-scroll"><table class="slot-table"><thead><tr><th></th>';
  dates.forEach((dt, i)=>{
    const cls = dt < today ? "past" : (dt === today ? "today" : "");
    html += `<th class="${cls}">${WEEKDAY_LABEL[weekdays[i]]}<small>${shortDate(dt)}</small></th>`;
  });
  html += '</tr></thead><tbody>';

  times.forEach(t=>{
    html += `<tr><th>${escapeHtml(t)}</th>`;
    dates.forEach((dt, i)=>{
      const slots = slotsAt(weekdays[i], t);
      if(slots.length === 0){
        html += `<td><div class="slot-cell unavailable">無</div></td>`;
        return;
      }
      const past = dt < today;
      // 一格裡可能有多位助教，每位各一顆按鈕
      const buttons = slots.map(slot=>{
        const remain = remainingForSlot(dt, t, slot.ta, excludeId);
        const isSel = selected && selected.date===dt && selected.time===t && selected.ta===slot.ta;
        const cls = isSel ? "slot-cell selected"
                  : past ? "slot-cell unavailable"
                  : remain <= 0 ? "slot-cell full" : "slot-cell";
        const disabled = !isSel && (past || remain <= 0);
        return `<button type="button" class="${cls}" ${disabled ? "disabled" : ""}
          data-date="${dt}" data-w="${weekdays[i]}" data-t="${escapeHtml(t)}" data-ta="${escapeHtml(slot.ta)}"
          ${slot.note ? `title="${escapeHtml(slot.note)}"` : ""}
        >${escapeHtml(slot.ta)}${slot.note ? `<small class="slot-note">${escapeHtml(slot.note)}</small>` : ""}<small>${past ? "已過" : `剩 ${Math.max(remain,0)} 名`}</small></button>`;
      }).join("");
      html += `<td><div class="slot-multi">${buttons}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      wrap.dataset.week = addDays(wrap.dataset.week, Number(btn.dataset.nav));
      renderSlotGrid(wrap, wrap._slotOpts);
    });
  });
  wrap.querySelectorAll("button.slot-cell").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      onPick({ date:btn.dataset.date, weekday:btn.dataset.w, time:btn.dataset.t, ta:btn.dataset.ta });
    });
  });
}

function renderSlotPicker(){
  renderSlotGrid(document.getElementById("slotPicker"), {
    selected: selectedSlot,
    onPick: slot=>{
      selectedSlot = slot;
      const form = document.getElementById("teacherForm");
      form.elements.slotDate.value = slot.date;
      form.elements.slotWeekday.value = slot.weekday;
      form.elements.slotTime.value = slot.time;
      form.elements.slotTA.value = slot.ta;
      renderSlotPicker();
      // 補課合作說明：老師要前一天完成交接，排今天會來不及
      const sameDay = slot.date === todayStr() ? "　⚠ 補課就在今天，記得前一天要完成交接" : "";
      document.getElementById("teacherFormHint").textContent = `已選：${slotTextWithNote(slot.date, slot.time, slot.ta)}${sameDay}`;
    },
  });
}

// ---------------- 老師：送出新紀錄 ----------------
document.getElementById("teacherForm").addEventListener("submit", e=>{
  e.preventDefault();
  const form = e.target;
  withBusy(form.querySelector('[type="submit"]'), async ()=>{
    if(!state.name){ showToast("請先在右上角選擇你的名字"); return; }
    if(!selectedSlot){ showToast("請選擇補課日期與時段"); return; }
    const data = Object.fromEntries(new FormData(form).entries());
    if(data.absenceDate && data.slotDate < data.absenceDate){
      showToast("補課日期比缺課日期還早，請確認"); return;
    }
    // 送出前再算一次名額：挑完時段到按送出之間，別人可能剛好排走最後一個位子
    if(remainingForSlot(data.slotDate, data.slotTime, data.slotTA) <= 0){
      showToast("這個時段剛好額滿了，請選其他時段");
      selectedSlot = null;
      document.getElementById("teacherFormHint").textContent = "";
      renderSlotPicker();
      return;
    }
    data.teacherName = state.name;
    data.actualDate = "";
    data.result = ""; data.homeworkStatus = ""; data.taNote = "";
    data.parentNotified = false;
    data.createdAt = Date.now();

    if(db){
      if(!(await writeSafely(()=>addDoc(collection(db,"records"), data)))) return;   // 沒存到：表單內容保留
    } else {
      records.push({ id:uid(), ...data });
      renderAll();
    }
    form.reset();
    selectedSlot = null;
    document.getElementById("teacherFormHint").textContent = "";
    renderSlotPicker();
    showToast("已送出補課紀錄");
  }, "送出中…");
});

// ---------------- 管理職：時段設定 ----------------
document.getElementById("rosterAddForm").addEventListener("submit", e=>{
  e.preventDefault();
  const form = e.target;
  withBusy(form.querySelector('[type="submit"]'), async ()=>{
    const data = Object.fromEntries(new FormData(form).entries());
    data.quota = Number(data.quota);
    data.note = String(data.note || "").trim();
    data.ta = String(data.ta || "").trim().replace(/\s+/g, " ");
    // 大小寫不同也當同一位助教，沿用名單上既有的寫法，否則紀錄會配對不到
    const knownTa = taNameList().find(n=>n.toLowerCase() === data.ta.toLowerCase());
    if(knownTa) data.ta = knownTa;
    const existing = roster.find(s=>s.weekday===data.weekday && s.time===data.time && s.ta===data.ta);
    if(db){
      const ok = await writeSafely(()=> existing
        ? updateDoc(doc(db,"roster",existing.id), data)
        : addDoc(collection(db,"roster"), data));
      if(!ok) return;
    } else {
      if(existing) Object.assign(existing, data);
      else roster.push({ id:uid(), ...data });
      renderAll();
    }
    form.reset();
    showToast("已更新時段設定");
  });
});

// 助教通常固定用同一間教室：打完助教名字時，備註空白就先帶入他其他時段的備註
(function(){
  const form = document.getElementById("rosterAddForm");
  form.elements.ta.addEventListener("change", ()=>{
    if(form.elements.note.value.trim()) return;
    const name = form.elements.ta.value.trim().toLowerCase();
    const known = roster.find(s=>s.ta && s.note && s.ta.toLowerCase() === name);
    if(known) form.elements.note.value = known.note;
  });
})();

// ---------------- 更新紀錄（助教填寫 / 管理職編輯共用）----------------
// 都回傳 true / false：false 代表沒存到、錯誤訊息已經跳出來了，呼叫端就不要再顯示「已儲存」
async function saveRecordFields(id, fields){
  if(db) return writeSafely(()=>updateDoc(doc(db,"records",id), fields));
  const r = records.find(x=>x.id===id);
  if(r) Object.assign(r, fields);
  renderAll();
  return true;
}
async function deleteRecord(id){
  if(db) return writeSafely(()=>deleteDoc(doc(db,"records",id)));
  records = records.filter(r=>r.id!==id);
  renderAll();
  return true;
}
async function saveRosterFields(id, fields){
  if(db) return writeSafely(()=>updateDoc(doc(db,"roster",id), fields));
  const slot = roster.find(s=>s.id===id);
  if(slot) Object.assign(slot, fields);
  renderAll();
  return true;
}
async function deleteRosterSlot(id){
  if(db) return writeSafely(()=>deleteDoc(doc(db,"roster",id)));
  roster = roster.filter(s=>s.id!==id);
  renderAll();
  return true;
}

// ---------------- 訊息範本 ----------------
// 助教補完課傳給家長。只放家長需要知道的：補了什麼、學得怎樣、作業狀況。
// 「助教備註與交接」是內部交接用的，不放進來。
function buildParentMessage(r){
  const md = d => {
    const m = String(d || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${+m[1]}/${+m[2]}` : (d || "");
  };
  const callName = r.studentNameEn || r.studentNameCh;   // 內文用英文名字，沒填才用中文名字
  const lines = [
    `【補課完成通知】`,
    ``,
    `${callName} ${md(r.absenceDate)} 請假的英語課程，已於 ${md(r.actualDate)} 完成補課囉!`,
    ``,
    `【補課內容】`,
    r.assignedContent || "（無）",
    ``,
  ];
  if(r.result) lines.push(`【學習狀況】${r.result}`);
  if(r.homeworkStatus) lines.push(`【作業狀況】${r.homeworkStatus}`);
  if(r.result || r.homeworkStatus) lines.push(``);
  lines.push(`後續若需要再加強，英語導師會再與您聯繫。`, `謝謝您的配合！`);
  return lines.join("\n");
}
function buildDeptRequestMessage(r){
  const bookLine = [r.book, r.unit].filter(Boolean).join(" ");
  const note = slotNote(dayOf(r), r.slotTime, r.slotTA);
  const classLine = [r.className, r.homeroomTeacher && `${r.homeroomTeacher}英語導師`].filter(Boolean).join("／");
  return [
    `${r.studentNameCh} 英語補課申請時段：`,
    ``,
    `補課學生：${r.studentNameCh}${classLine ? `（${classLine}）` : ""}`,
    `缺課日期：${r.absenceDate}，原因：${r.leaveReason}`,
    `申請時段：${slotLabel(dayOf(r), r.slotTime)}`,
    `負責助教：${r.slotTA}${note ? `（${note}）` : ""}`,
    `需攜帶：${bookLine || "（請見指派內容）"}`,
    ``,
    `請協助提醒學生準時並攜帶課本哦! 謝謝老師`,
  ].join("\n");
}
function buildDeptUpdateMessage(r, statusChoice, newSlot, origSlot = slotLabel(dayOf(r), r.slotTime)){
  const box = (label) => statusChoice===label ? "☑" : "☐";
  return [
    `老師您好，`,
    `${r.studentNameCh}同學（${r.teacherName}英語導師）補課狀況更新：`,
    ``,
    `原訂時段：${origSlot}`,
    `狀態：${box("改期")}改期 ${box("取消")}取消`,
    `（若改期）新時段：${statusChoice==="改期" ? (newSlot || "___________") : "___________"}`,
    ``,
    `請協助一同提醒學生，謝謝！`,
  ].join("\n");
}

// ---------------- Modal ----------------
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalText = document.getElementById("modalText");
const modalExtra = document.getElementById("modalExtra");
function openModal(title, text, extraHtml=""){
  modalTitle.textContent = title;
  modalText.value = text;
  modalExtra.innerHTML = extraHtml;
  modalBackdrop.classList.add("open");
}
function closeModal(){ modalBackdrop.classList.remove("open"); }
document.getElementById("modalClose").addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", e=>{ if(e.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", e=>{
  if(e.key === "Escape" && modalBackdrop.classList.contains("open")) closeModal();
});
document.getElementById("modalCopy").addEventListener("click", ()=>{
  navigator.clipboard.writeText(modalText.value).then(()=>showToast("已複製到剪貼簿"));
});

function openParentMessageModal(r){
  openModal("傳給家長的訊息", buildParentMessage(r),
    `<label style="font-size:12.5px; display:flex; align-items:center; gap:6px; margin-bottom:8px;">
       <input type="checkbox" id="markNotifiedChk" ${r.parentNotified?"checked disabled":""}>
       ${r.parentNotified ? "已標記為通知家長" : "複製後勾選＝標記已通知家長"}
     </label>`);
  const chk = document.getElementById("markNotifiedChk");
  if(chk && !r.parentNotified){
    chk.addEventListener("change", async ()=>{
      if(chk.checked){
        chk.disabled = true;
        if(await saveRecordFields(r.id, { parentNotified:true, parentNotifiedAt: Date.now() })){
          showToast("已標記通知家長");
        } else {
          chk.checked = false;
          chk.disabled = false;
        }
      }
    });
  }
}
function openDeptRequestModal(r){
  openModal("傳給教學部：申請補課時段", buildDeptRequestMessage(r));
}
// preset：改期或取消存檔後直接帶進來，把選項和新時段先填好
//   { choice:"改期"|"取消", origSlot:"週一 1:00-2:00", newSlot:"週三 3:30-4:00" }
// 異動通知只用在改期或取消，補完課不用另外通知
function openDeptUpdateModal(r, preset = {}){
  let statusChoice = preset.choice || "改期";
  const origSlot = preset.origSlot || slotLabel(dayOf(r), r.slotTime);
  const checked = v => statusChoice === v ? "checked" : "";
  const extra = `
    <div class="status-radio">
      <label><input type="radio" name="deptStatus" value="改期" ${checked("改期")}> 改期</label>
      <label><input type="radio" name="deptStatus" value="取消" ${checked("取消")}> 取消</label>
    </div>
    <div class="field" id="newSlotField" style="display:${statusChoice==="改期" ? "block" : "none"}; margin-bottom:8px;">
      <label>新時段</label><input id="newSlotInput" placeholder="例如：9/24（三）3:30-4:00" value="${escapeHtml(preset.newSlot || "")}">
    </div>`;
  const title = preset.choice ? `已${preset.choice}，傳給教學部：異動通知` : "傳給教學部：異動通知";
  openModal(title, buildDeptUpdateMessage(r, statusChoice, preset.newSlot, origSlot), extra);
  const newSlotInput = document.getElementById("newSlotInput");
  document.querySelectorAll('input[name="deptStatus"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{
      statusChoice = radio.value;
      document.getElementById("newSlotField").style.display = statusChoice==="改期" ? "block" : "none";
      modalText.value = buildDeptUpdateMessage(r, statusChoice, newSlotInput.value, origSlot);
    });
  });
  newSlotInput.addEventListener("input", e=>{
    modalText.value = buildDeptUpdateMessage(r, statusChoice, e.target.value, origSlot);
  });
}

// ---------------- 渲染：老師的紀錄列表 ----------------
function renderTeacherRecords(){
  const wrap = document.getElementById("teacherRecordList");
  const badge = document.getElementById("teacherCount");
  const mine = records.filter(r=>r.teacherName===state.name);

  if(!state.name){
    badge.textContent = "";
    wrap.innerHTML = '<div class="empty">請先在右上角選擇你的名字，才能看到你登記的紀錄</div>';
    return;
  }

  // 待查核的筆數要一眼看到，這是老師該處理的事
  const toVerify = mine.filter(r=>computeStatus(r)==="toVerify").length;
  const noShow = mine.filter(r=>computeStatus(r)==="noShow").length;
  badge.textContent = [`${mine.length} 筆`, noShow && `${noShow} 筆未到待改期`, toVerify && `${toVerify} 筆待查核`]
    .filter(Boolean).join("・");

  if(mine.length===0){ wrap.innerHTML = '<div class="empty">還沒有登記任何紀錄</div>'; return; }

  const shown = teacherFilter.status === "all"
    ? mine
    : mine.filter(r=>computeStatus(r)===teacherFilter.status);

  if(shown.length===0){
    wrap.innerHTML = '<div class="empty">沒有符合這個狀態的紀錄</div>';
    document.getElementById("teacherMore").innerHTML = "";
    return;
  }
  const page = shown.slice(0, teacherShown);
  wrap.innerHTML = page.map(r=>recordCardHtml(r, "teacher")).join("");
  bindRecordActions(wrap, page);
  renderMoreBar(document.getElementById("teacherMore"), page.length, shown.length, CARD_PAGE_SIZE,
    ()=>{ teacherShown += CARD_PAGE_SIZE; renderTeacherRecords(); },
    ()=>{ teacherShown = Infinity; renderTeacherRecords(); });
}

document.getElementById("teacherStatusFilter").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-status]");
  if(!btn) return;
  teacherFilter.status = btn.dataset.status;
  teacherShown = CARD_PAGE_SIZE;
  document.querySelectorAll("#teacherStatusFilter button")
    .forEach(b=>b.classList.toggle("active", b===btn));
  renderTeacherRecords();
});

// ---------------- 渲染：助教的待辦 / 已完成 ----------------
// 重畫會把 DOM 整個換掉，助教打到一半的字會消失。
// 其他人一存檔 onSnapshot 就會觸發重畫，所以先把畫面上的輸入狀態記下來，畫完再放回去。
function captureTaFormState(){
  const snapshot = {};
  document.querySelectorAll(".ta-form").forEach(form=>{
    const id = form.id.replace(/^taform-/, "");
    snapshot[id] = {
      open:       form.classList.contains("open"),
      attend:     form.querySelector(".f-attend")?.value,
      actualDate: form.querySelector(".f-actualDate")?.value,
      result:     form.querySelector(".f-result")?.value,
      hw:         form.querySelector(".f-hw")?.value,
      note:       form.querySelector(".f-note")?.value,
    };
  });
  return snapshot;
}

function restoreTaFormState(snapshot){
  Object.entries(snapshot).forEach(([id, s])=>{
    const form = document.getElementById("taform-"+id);
    if(!form) return;
    if(s.open) form.classList.add("open");
    const set = (sel, val)=>{
      const el = form.querySelector(sel);
      if(el && val !== undefined && val !== null) el.value = val;
    };
    set(".f-actualDate", s.actualDate);
    set(".f-result", s.result);
    set(".f-hw", s.hw);
    set(".f-attend", s.attend);
    set(".f-note", s.note);
    applyAttendUI(form);
  });
}

function renderTaLists(){
  const pendingWrap = document.getElementById("taPendingList");
  const doneWrap = document.getElementById("taDoneList");
  const pendingBadge = document.getElementById("taPendingCount");
  const doneBadge = document.getElementById("taDoneCount");

  if(!state.name){
    pendingWrap.innerHTML = '<div class="empty">請先在右上角選擇你的名字</div>';
    doneWrap.innerHTML = "";
    pendingBadge.textContent = "";
    doneBadge.textContent = "";
    return;
  }

  const formState = captureTaFormState();

  const mine = records.filter(r=>r.slotTA===state.name && !r.cancelled);   // 取消的不用補
  // 待處理照補課日期排，最近要上的在最上面
  const pending = mine.filter(r=>!r.actualDate)
    .sort((a,b)=>String(a.slotDate || "9999").localeCompare(String(b.slotDate || "9999")));
  const done = mine.filter(r=>r.actualDate);

  pendingBadge.textContent = `${pending.length} 筆`;
  doneBadge.textContent = `${done.length} 筆`;

  const pendingPage = pending.slice(0, taPendingShown);
  const donePage = done.slice(0, taDoneShown);

  pendingWrap.innerHTML = pendingPage.length
    ? pendingPage.map(r=>recordCardHtml(r,"ta")).join("")
    : '<div class="empty">目前沒有待處理的補課</div>';
  doneWrap.innerHTML = donePage.length
    ? donePage.map(r=>recordCardHtml(r,"ta")).join("")
    : '<div class="empty">還沒有已完成的紀錄</div>';

  bindRecordActions(pendingWrap, pendingPage);
  bindRecordActions(doneWrap, donePage);

  renderMoreBar(document.getElementById("taPendingMore"), pendingPage.length, pending.length, CARD_PAGE_SIZE,
    ()=>{ taPendingShown += CARD_PAGE_SIZE; renderTaLists(); },
    ()=>{ taPendingShown = Infinity; renderTaLists(); });
  renderMoreBar(document.getElementById("taDoneMore"), donePage.length, done.length, CARD_PAGE_SIZE,
    ()=>{ taDoneShown += CARD_PAGE_SIZE; renderTaLists(); },
    ()=>{ taDoneShown = Infinity; renderTaLists(); });

  restoreTaFormState(formState);
}

// ---------------- 卡片 HTML ----------------
function recordCardHtml(r, mode){
  const status = computeStatus(r);
  const e = escapeHtml;
  const kv = (label, value) => `<div class="kv"><b>${label}</b><span>${e(value || "-")}</span></div>`;
  return `
  <div class="record-card ${status}" data-id="${e(r.id)}">
    <div class="rc-head">
      <div>
        <div class="rc-title">${e(r.studentNameCh)} ${r.studentNameEn?("("+e(r.studentNameEn)+")"):""}</div>
        <div class="rc-meta">${e(r.absenceDate)}｜${e(r.leaveReason)}｜${e(r.className)} ${e(r.homeroomTeacher)}</div>
      </div>
      <span class="tag ${status}">${statusLabel(status)}</span>
    </div>
    <div class="rc-body">
      ${kv("教學老師", r.teachingTeacher)}
      ${kv("缺課核心課程", r.coreCourse)}
      ${kv("課本", r.book)}
      ${kv("單元", r.unit)}
      ${kv("指派補課內容", r.assignedContent)}
      ${kv("預計時長", r.plannedDuration)}
      ${kv("時段/負責人", slotTextWithNote(dayOf(r), r.slotTime, r.slotTA))}
      ${r.lastRescheduled ? kv("改期紀錄", `${r.lastRescheduled.from} → ${r.lastRescheduled.to}（${formatStamp(r.lastRescheduled.at)}）`) : ``}
      ${r.cancelled ? kv("取消", `${r.cancelledBy ? r.cancelledBy + " " : ""}${formatStamp(r.cancelledAt)} 取消`) : ``}
      ${r.lastNoShow ? kv("未到紀錄", `${r.lastNoShow.date} ${r.lastNoShow.slot || ""} 未到${r.lastNoShow.by ? `（${r.lastNoShow.by} 點名）` : ""}${r.lastNoShow.note ? `：${r.lastNoShow.note}` : ""}`) : ``}
      ${r.actualDate ? `
      ${kv("實際補課日期", r.actualDate)}
      ${kv("點名", r.attendance === "出席" ? "準時出席" : r.attendance)}
      ${kv("驗收成果", r.result)}
      ${kv("作業狀況", r.homeworkStatus)}
      ${kv("助教備註", r.taNote)}
      ${kv("家長已通知", r.parentNotified ? "是" : "否")}
      ${kv("老師查核", r.teacherVerified
            ? `${r.verifiedBy || ""} 已簽名${r.verifiedAt ? `（${formatStamp(r.verifiedAt)}）` : ""}`
            : "尚未查核")}` : ``}
    </div>

    ${status === "noShow" && mode === "teacher" ? `<div class="rc-alert">學生 ${e(r.lastNoShow.date)} 沒有到。請按「修改」改期（排回下週同一時段也要按），再傳異動通知給教學部。</div>` : ``}
    ${status === "noShow" && mode === "ta" ? `<div class="rc-alert">你已記錄學生 ${e(r.lastNoShow.date)} 未到，等老師改期。學生如果之後來補了，照常填寫成果即可。</div>` : ``}
    <div class="rc-actions">
      ${mode==="teacher" && !r.cancelled ? `
        <button class="btn secondary small act-dept-request">傳給教學部：申請時段</button>
        <button class="btn secondary small act-dept-update">傳給教學部：異動通知</button>
      ` : ``}
      ${mode==="teacher" && r.actualDate && !r.teacherVerified && !r.cancelled
        ? `<button class="btn small act-verify">查核並簽名</button>` : ``}
      ${mode==="teacher" ? `<button class="btn ghost small act-edit">${r.cancelled ? "修改／恢復" : "修改"}</button>` : ``}
      ${mode==="ta" && !r.actualDate ? `<button class="btn small act-fill">填寫補課成果</button>` : ``}
      ${mode==="ta" && r.actualDate ? `<button class="btn secondary small act-parent-msg">產生家長通知訊息</button>` : ``}
    </div>

    ${mode==="ta" && !r.actualDate ? `
    <div class="ta-form" id="taform-${r.id}">
      <div class="grid">
        <div class="field">
          <label>點名</label>
          <select class="f-attend">
            <option value="出席">準時出席</option><option value="遲到">遲到</option><option value="未到">未到</option>
          </select>
        </div>
        <div class="field"><label class="f-date-label">實際補課日期</label><input type="date" class="f-actualDate" value="${todayStr()}"></div>
        <div class="field wide attend-alert" hidden>
          學生遲到或未到，請打電話給教學老師${r.teachingTeacher ? ` <b>${e(r.teachingTeacher)}</b> ` : ""}查明原因。
        </div>
        <div class="field wide f-present"><label>驗收成果</label><input class="f-result" placeholder="例如：單字補考 90分 (已過關)"></div>
        <div class="field f-present">
          <label>作業補交狀況</label>
          <select class="f-hw">
            <option>已補交並批改</option><option>部分補交(待追蹤)</option>
            <option>尚未補交</option><option>無需補交</option>
          </select>
        </div>
        <div class="field wide"><label class="f-note-label">助教備註與交接</label><textarea class="f-note"></textarea></div>
      </div>
      <button class="btn small act-save-ta" style="margin-top:10px;">儲存補課成果</button>
    </div>` : ``}
  </div>`;
}

// 點名選「未到」：不算補完課，藏起驗收成果和作業欄，日期改叫點名日期
function applyAttendUI(form){
  const attend = form.querySelector(".f-attend")?.value;
  if(!attend) return;
  const absent = attend === "未到";
  form.querySelector(".attend-alert").hidden = attend === "出席";
  form.querySelectorAll(".f-present").forEach(el=>{ el.hidden = absent; });
  form.querySelector(".f-date-label").textContent = absent ? "點名日期" : "實際補課日期";
  form.querySelector(".f-note-label").textContent = absent ? "未到說明（例如：已聯絡教學老師，原因是⋯）" : "助教備註與交接";
  form.querySelector(".act-save-ta").textContent = absent ? "記錄未到" : "儲存補課成果";
}

function bindRecordActions(container, list){
  container.querySelectorAll(".record-card").forEach(card=>{
    const r = list.find(x=>x.id===card.dataset.id);
    if(!r) return;
    card.querySelector(".act-edit")?.addEventListener("click", ()=>openEditModal(r.id));
    card.querySelector(".act-dept-request")?.addEventListener("click", ()=>openDeptRequestModal(r));
    card.querySelector(".act-dept-update")?.addEventListener("click", ()=>openDeptUpdateModal(r));
    card.querySelector(".act-parent-msg")?.addEventListener("click", ()=>openParentMessageModal(r));
    card.querySelector(".act-verify")?.addEventListener("click", async ()=>{
      if(!state.name){ showToast("請先在右上角選擇你的名字才能簽名"); return; }
      const ok = confirm(
        `確認 ${r.studentNameCh} 的補課紀錄已查核無誤？\n\n` +
        `實際補課：${r.actualDate}${r.attendance ? `（${r.attendance === "出席" ? "準時出席" : r.attendance}）` : ""}\n驗收成果：${r.result || "（未填）"}\n作業狀況：${r.homeworkStatus || "（未填）"}\n\n` +
        `簽名後會記錄為「${state.name}」查核，並把這筆結案。`
      );
      if(!ok) return;
      const saved = await saveRecordFields(r.id, {
        teacherVerified: true,
        verifiedBy: state.name,
        verifiedAt: Date.now(),
      });
      if(saved) showToast("已查核並簽名");
    });
    card.querySelector(".f-attend")?.addEventListener("change", ()=>applyAttendUI(document.getElementById("taform-"+r.id)));
    card.querySelector(".act-fill")?.addEventListener("click", ()=>{
      document.getElementById("taform-"+r.id).classList.toggle("open");
    });
    card.querySelector(".act-save-ta")?.addEventListener("click", e=>{
      withBusy(e.currentTarget, async ()=>{
        const form = document.getElementById("taform-"+r.id);
        const attend = form.querySelector(".f-attend").value;
        const date = form.querySelector(".f-actualDate").value;
        const note = form.querySelector(".f-note").value.trim();
        if(!date){ showToast(attend === "未到" ? "請填點名日期" : "請填實際補課日期"); return; }
        const callTeacher = r.teachingTeacher ? `記得打電話給教學老師 ${r.teachingTeacher}` : "記得打電話給教學老師";

        if(attend === "未到"){
          // 沒到就不算補完課：不填實際補課日期，只記一筆「未到」，老師那邊會變成「未到待改期」
          const saved = await saveRecordFields(r.id, {
            lastNoShow: { date, note, by: state.name || "", slot: slotText(dayOf(r), r.slotTime, r.slotTA), at: Date.now() },
          });
          if(!saved) return;   // 沒存到：表單內容保留，助教可以直接再按一次
          // 存好了才收起、還原表單（重畫後是新的表單元素，所以重新抓），免得下次展開還停在「未到」
          const f = document.getElementById("taform-"+r.id);
          if(f){
            f.classList.remove("open");
            f.querySelector(".f-attend").value = "出席";
            f.querySelector(".f-note").value = "";
            applyAttendUI(f);
          }
          showToast(`已記錄未到，${callTeacher}`);
          return;
        }

        const saved = await saveRecordFields(r.id, {
          actualDate: date,
          attendance: attend,
          result: form.querySelector(".f-result").value,
          homeworkStatus: form.querySelector(".f-hw").value,
          taNote: note,
        });
        if(saved) showToast(attend === "遲到" ? `已儲存補課成果；學生遲到，${callTeacher}` : "已儲存補課成果");
      });
    });
  });
}

// ---------------- 修改紀錄（老師改自己的、管理職改任何一筆）----------------
const editBackdrop = document.getElementById("editBackdrop");
const editForm = document.getElementById("editForm");
const editNotice = document.getElementById("editNotice");
let editState = null;   // { id, slot:{date,weekday,time,ta} }

function openEditModal(id){
  const r = records.find(x=>x.id===id);
  if(!r){ showToast("找不到這筆紀錄，可能已被刪除"); return; }
  editState = { id, slot: { date:r.slotDate || "", weekday:r.slotWeekday, time:r.slotTime, ta:r.slotTA } };

  // 欄位直接從老師表單複製（每一區的標題和輸入格），表單日後增減欄位，這裡自動同步
  editForm.innerHTML = "";
  document.querySelectorAll("#teacherForm .form-section").forEach(sec=>{
    const grid = sec.querySelector(".grid");
    if(!grid) return;
    const box = document.createElement("div");
    box.className = "form-section";
    box.appendChild(sec.querySelector(".sec-head").cloneNode(true));
    box.appendChild(grid.cloneNode(true));
    editForm.appendChild(box);
  });
  editForm.querySelectorAll("[name]").forEach(el=>{
    const v = r[el.name] ?? "";
    // 選單裡已經沒有的舊值（例如之前的「公假」）補回一個選項，避免存檔時被默默改掉
    if(el.tagName === "SELECT" && v && ![...el.options].some(o=>o.value===v)){
      el.add(new Option(v, v));
    }
    el.value = v;
  });

  const slotBox = document.createElement("div");
  slotBox.className = "form-section";
  slotBox.innerHTML = `<div class="sec-head">補課日期與時段</div><div id="editSlotHint" class="edit-note"></div><div id="editSlotPicker"></div>`;
  editForm.appendChild(slotBox);
  renderEditSlots();

  const notes = [];
  if(r.cancelled){
    notes.push(`<div class="edit-note warn">這筆已於 ${formatStamp(r.cancelledAt)} 取消${r.cancelledBy ? `（${escapeHtml(r.cancelledBy)}）` : ""}。按「恢復補課」可以重新排回時段。</div>`);
  }
  if(computeStatus(r) === "noShow"){
    notes.push(`<div class="edit-note warn">學生 ${escapeHtml(r.lastNoShow.date)} 在 ${escapeHtml(r.lastNoShow.slot || "")} 未到${r.lastNoShow.note ? `：${escapeHtml(r.lastNoShow.note)}` : ""}。</div>`);
  }
  if(r.actualDate){
    notes.push(`<div class="edit-note">助教已於 ${escapeHtml(r.actualDate)} 完成補課，這筆只能修改文字內容，不能改期或取消。助教填的驗收成果不在這裡改。</div>`);
  }
  editNotice.innerHTML = notes.join("");

  document.getElementById("editTitle").textContent = `修改補課紀錄：${r.studentNameCh || ""}`;
  const cancelBtn = document.getElementById("editCancelRecord");
  cancelBtn.textContent = r.cancelled ? "恢復補課" : "取消補課";
  cancelBtn.hidden = !!r.actualDate;
  editBackdrop.classList.add("open");
}

function renderEditSlots(){
  const r = records.find(x=>x.id===editState?.id);
  const hint = document.getElementById("editSlotHint");
  const wrap = document.getElementById("editSlotPicker");
  if(!r || !hint || !wrap) return;

  const cur = slotText(dayOf(r), r.slotTime, r.slotTA);
  if(r.actualDate){
    hint.className = "edit-note";
    hint.textContent = `已在 ${cur} 完成補課`;
    wrap.innerHTML = "";
    return;
  }
  const s = editState.slot;
  const changed = s.date!==(r.slotDate || "") || s.time!==r.slotTime || s.ta!==r.slotTA;
  const stillExists = !!roster.find(x=>x.ta && x.weekday===weekdayOf(dayOf(r)) && x.time===r.slotTime && x.ta===r.slotTA);
  const noShow = computeStatus(r) === "noShow";
  hint.className = "edit-note" + (!changed && (!stillExists || noShow) ? " warn" : "");
  hint.textContent = changed
    ? `改期：${cur} → ${slotText(s.date, s.time, s.ta)}。儲存後原本那天的名額會釋出。`
    : noShow && stillExists
      ? `學生上次沒到。直接按「儲存修改」＝排到 ${slotText(noShowNextDate(r), r.slotTime, r.slotTA)}；要換日期或時段就點下方。`
    : stillExists
      ? `目前：${cur}。要改期就點下方其他日期或時段。`
      : `目前時段 ${cur} 已經從時段設定刪除了，建議改到其他時段。`;

  renderSlotGrid(wrap, {
    selected: s,
    excludeId: r.id,
    onPick: slot=>{ editState.slot = slot; renderEditSlots(); },
  });
}

// 未到的學生「排回同一時段」：從今天之後找下一個同星期的日期
function noShowNextDate(r){
  const base = r.slotDate && r.slotDate > todayStr() ? r.slotDate : todayStr();
  return nextWeekdayAfter(weekdayOf(dayOf(r)), base);
}

function closeEditModal(){
  editBackdrop.classList.remove("open");
  editState = null;
}
document.getElementById("editClose").addEventListener("click", closeEditModal);
editBackdrop.addEventListener("click", e=>{ if(e.target === editBackdrop) closeEditModal(); });
document.addEventListener("keydown", e=>{
  if(e.key === "Escape" && editBackdrop.classList.contains("open")) closeEditModal();
});

document.getElementById("editSave").addEventListener("click", e=>{
  withBusy(e.currentTarget, async ()=>{
    const r = records.find(x=>x.id===editState?.id);
    if(!r){ showToast("找不到這筆紀錄，可能已被刪除"); closeEditModal(); return; }
    if(!editForm.reportValidity()) return;

    const fields = Object.fromEntries(new FormData(editForm).entries());
    let s = editState.slot;
    let slotChanged = !r.actualDate && (s.date!==(r.slotDate || "") || s.time!==r.slotTime || s.ta!==r.slotTA);
    // 未到的學生沒換時段直接儲存＝排到下一個同星期的同一時段，狀態才會從「未到待改期」回到「待補課」
    const sameSlotAgain = !slotChanged && computeStatus(r) === "noShow";
    if(sameSlotAgain){
      s = { date: noShowNextDate(r), weekday: weekdayOf(dayOf(r)), time: r.slotTime, ta: r.slotTA };
      slotChanged = true;
    }
    const origSlot = slotLabel(dayOf(r), r.slotTime);

    if(slotChanged){
      if(!r.cancelled && remainingForSlot(s.date, s.time, s.ta, r.id) <= 0){
        showToast(sameSlotAgain
          ? `${slotLabel(s.date, s.time)} 已經額滿，請在下方選其他日期或時段`
          : "這個時段剛好額滿了，請選其他時段");
        renderEditSlots();
        return;
      }
      if(fields.absenceDate && s.date < fields.absenceDate){
        showToast("補課日期比缺課日期還早，請確認"); return;
      }
      Object.assign(fields, {
        slotDate: s.date, slotWeekday: s.weekday, slotTime: s.time, slotTA: s.ta,
        lastRescheduled: {
          from: slotText(dayOf(r), r.slotTime, r.slotTA),
          to: slotText(s.date, s.time, s.ta),
          at: Date.now(),
          by: state.name || "",
        },
      });
    }
    fields.updatedAt = Date.now();
    fields.updatedBy = state.name || "";

    const merged = { ...r, ...fields };
    if(!(await saveRecordFields(r.id, fields))) return;   // 沒存到：視窗留著，改的內容不會不見
    closeEditModal();
    if(slotChanged){
      showToast(sameSlotAgain ? `已排到 ${slotLabel(s.date, s.time)}` : "已改期");
      // 改期一定要讓教學部知道，直接把異動通知帶出來
      openDeptUpdateModal(merged, { choice:"改期", origSlot, newSlot: slotLabel(s.date, s.time) });
    } else {
      showToast("已儲存修改");
    }
  }, "儲存中…");
});

document.getElementById("editCancelRecord").addEventListener("click", async ()=>{
  const r = records.find(x=>x.id===editState?.id);
  if(!r) return;

  if(r.cancelled){
    const remain = remainingForSlot(dayOf(r), r.slotTime, r.slotTA, r.id);
    const past = r.slotDate && r.slotDate < todayStr();
    const warn = past
      ? `\n\n⚠ 原本排的 ${slotLabel(r.slotDate, r.slotTime)} 已經過了，恢復後請再按「修改」改期。`
      : remain <= 0 ? `\n\n⚠ 原本那天目前已額滿，恢復後會超額，建議恢復後再改期。` : "";
    if(!confirm(`恢復 ${r.studentNameCh} 的補課，排回 ${slotText(dayOf(r), r.slotTime, r.slotTA)}？${warn}`)) return;
    if(!(await saveRecordFields(r.id, { cancelled:false, restoredAt:Date.now(), restoredBy: state.name || "" }))) return;
    closeEditModal();
    showToast("已恢復補課");
    return;
  }

  if(!confirm(
    `確定取消 ${r.studentNameCh}（缺課 ${r.absenceDate}）的補課？\n\n` +
    `取消後名額會釋出，助教那邊也不會再出現這筆。紀錄會保留並標示「已取消」，之後可以恢復。`
  )) return;
  const fields = { cancelled:true, cancelledAt:Date.now(), cancelledBy: state.name || "" };
  if(!(await saveRecordFields(r.id, fields))) return;
  closeEditModal();
  showToast("已取消補課");
  openDeptUpdateModal({ ...r, ...fields }, { choice:"取消" });
});

document.getElementById("editDelete").addEventListener("click", async ()=>{
  const r = records.find(x=>x.id===editState?.id);
  if(!r) return;
  const done = r.actualDate ? `\n\n⚠ 助教已經補完這堂課，驗收成果和查核簽名也會一起刪掉。` : "";
  if(!confirm(
    `確定要永久刪除 ${r.studentNameCh}（缺課 ${r.absenceDate}）這筆紀錄？\n\n` +
    `刪除後無法復原。如果只是補課不做了，請改用「取消補課」，紀錄會保留。${done}`
  )) return;
  if(!(await deleteRecord(r.id))) return;
  closeEditModal();
  showToast("已刪除紀錄");
});

// ---------------- 渲染：管理職儀表板 ----------------
function matchesAdminFilter(r){
  if(adminFilter.status !== "all" && computeStatus(r) !== adminFilter.status) return false;
  if(adminFilter.ta && r.slotTA !== adminFilter.ta) return false;
  const q = adminFilter.search.trim().toLowerCase();
  if(!q) return true;
  return [r.studentNameCh, r.studentNameEn, r.className, r.grade,
          r.homeroomTeacher, r.teachingTeacher, r.teacherName, r.slotTA,
          r.leaveReason, r.book, r.unit, r.assignedContent]
    .some(v => String(v||"").toLowerCase().includes(q));
}

function renderAdmin(){
  const e = escapeHtml;
  const count = s => records.filter(r=>computeStatus(r)===s).length;
  document.getElementById("adminStats").innerHTML = `
    <div class="stat"><div class="num">${records.length}</div><div class="label">總紀錄數</div></div>
    <div class="stat pending"><div class="num">${count("pending")}</div><div class="label">待補課</div></div>
    <div class="stat overdue"><div class="num">${count("overdue")}</div><div class="label">逾期未補</div></div>
    <div class="stat noShow"><div class="num">${count("noShow")}</div><div class="label">未到待改期</div></div>
    <div class="stat toVerify"><div class="num">${count("toVerify")}</div><div class="label">待老師查核</div></div>
    <div class="stat done"><div class="num">${count("done")}</div><div class="label">已完成</div></div>
    <div class="stat cancelled"><div class="num">${count("cancelled")}</div><div class="label">已取消</div></div>
  `;

  // 助教篩選下拉：從時段設定和既有紀錄收集所有助教姓名
  const taNames = [...new Set([
    ...roster.filter(s=>s.ta).map(s=>s.ta),
    ...records.map(r=>r.slotTA).filter(Boolean),
  ])].sort();
  const taSelect = document.getElementById("adminTaFilter");
  if(taSelect.dataset.names !== taNames.join("|")){
    taSelect.dataset.names = taNames.join("|");
    taSelect.innerHTML = `<option value="">所有助教</option>` +
      taNames.map(n=>`<option value="${e(n)}">${e(n)}</option>`).join("");
    taSelect.value = adminFilter.ta;
  }
  // 時段設定「助教姓名」欄的候選名單
  const taList = document.getElementById("taNameOptions");
  if(taList && taList.dataset.names !== taNames.join("|")){
    taList.dataset.names = taNames.join("|");
    taList.innerHTML = taNames.map(n=>`<option value="${e(n)}">`).join("");
  }

  const shown = records.filter(matchesAdminFilter);
  const isFiltered = adminFilter.search || adminFilter.status !== "all" || adminFilter.ta;
  document.getElementById("adminCount").textContent =
    isFiltered ? `${shown.length} / ${records.length} 筆` : `${records.length} 筆`;

  const tbody = document.getElementById("adminTableBody");
  const moreBar = document.getElementById("adminMore");
  const page = shown.slice(0, adminShown);   // 只畫前 adminShown 筆

  // 還有沒畫出來的就給一顆「顯示更多」，不要一次把上千列塞進 DOM
  renderMoreBar(moreBar, page.length, shown.length, ADMIN_PAGE_SIZE,
    ()=>{ adminShown += ADMIN_PAGE_SIZE; renderAdmin(); },
    ()=>{ adminShown = Infinity; renderAdmin(); });

  if(records.length === 0){
    tbody.innerHTML = `<tr><td colspan="14" class="empty">目前沒有紀錄</td></tr>`;
  } else if(shown.length === 0){
    tbody.innerHTML = `<tr><td colspan="14" class="empty">沒有符合篩選條件的紀錄</td></tr>`;
  } else {
    // data-label 是給手機用的：窄螢幕時表格會變成一筆一張卡，欄位名靠它顯示
    tbody.innerHTML = page.map(r=>{
      const status = computeStatus(r);
      const td = (label, html) => `<td data-label="${label}">${html}</td>`;
      return `<tr class="${status}">
        ${td("狀態", `<span class="tag ${status}">${statusLabel(status)}</span>`)}
        ${td("缺課日期", e(r.absenceDate))}
        ${td("學生", e(r.studentNameCh) + (r.studentNameEn ? " / "+e(r.studentNameEn) : ""))}
        ${td("班級/導師", e(r.className) + (r.homeroomTeacher ? "／"+e(r.homeroomTeacher) : ""))}
        ${td("原因", e(r.leaveReason))}
        ${td("指派內容", e(r.assignedContent))}
        ${td("時段", e(slotLabel(dayOf(r), r.slotTime)))}
        ${td("助教", e(r.slotTA))}
        ${td("實際補課", e(r.actualDate || "-"))}
        ${td("點名", e(r.actualDate ? (r.attendance || "-") : (status === "noShow" ? "未到" : "-")))}
        ${td("驗收", e(r.result || "-"))}
        ${td("家長已通知", r.parentNotified ? "是" : "否")}
        ${td("老師查核", r.teacherVerified
              ? e(`${r.verifiedBy || "已簽名"}${r.verifiedAt ? ` ${formatStamp(r.verifiedAt)}` : ""}`)
              : "-")}
        ${td("操作", `<button type="button" class="btn ghost small" data-edit="${e(r.id)}">修改</button>`)}
      </tr>`;
    }).join("");
  }

  // 時段設定總表
  const rw = document.getElementById("rosterEditor");
  const slots = roster.filter(s=>s.ta);
  if(slots.length === 0){ rw.innerHTML = '<div class="empty">尚未設定任何時段</div>'; }
  else {
    const order = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4 };
    const sorted = [...slots].sort((a,b)=>
      (order[a.weekday]??9) - (order[b.weekday]??9) || String(a.time).localeCompare(String(b.time))
    );
    rw.innerHTML = `<div class="table-wrap"><table class="admin-table roster-table">
      <thead><tr><th>星期</th><th>時段</th><th>助教</th><th>備註</th><th>名額</th><th>之後已排</th><th>操作</th></tr></thead>
      <tbody>${sorted.map(s=>{
        const upcoming = upcomingInSlot(s).length;
        return `<tr>
          <td data-label="星期">${e(WEEKDAY_LABEL[s.weekday] || s.weekday)}</td>
          <td data-label="時段">${e(s.time)}</td>
          <td data-label="助教">${e(s.ta)}</td>
          <td data-label="備註"><input class="note-input" data-note="${e(s.id)}" value="${e(s.note || "")}" placeholder="例如：F-B Classroom" aria-label="備註"></td>
          <td data-label="名額"><input type="number" min="1" class="q-input" data-quota="${e(s.id)}" value="${e(s.quota)}" aria-label="名額"></td>
          <td data-label="之後已排">${upcoming ? `${upcoming} 位` : "-"}</td>
          <td data-label="操作"><button type="button" class="btn danger small" data-del-slot="${e(s.id)}">刪除</button></td>
        </tr>`;
      }).join("")}
      </tbody></table></div>`;
  }
}

// ---------------- 管理職：總表「修改」、時段名額修改／刪除 ----------------
document.getElementById("adminTableBody").addEventListener("click", e=>{
  const btn = e.target.closest("[data-edit]");
  if(btn) openEditModal(btn.dataset.edit);
});

const rosterEditor = document.getElementById("rosterEditor");
rosterEditor.addEventListener("change", async e=>{
  const noteInput = e.target.closest("[data-note]");
  if(noteInput){
    const slot = roster.find(s=>s.id===noteInput.dataset.note);
    if(!slot) return;
    const note = noteInput.value.trim();
    if(note === (slot.note || "")) return;
    // 同一位助教的其他時段（助教通常統一用同一間教室）
    const others = roster.filter(x=>x.ta===slot.ta && x.id!==slot.id && (x.note || "") !== note);
    if(!(await saveRosterFields(slot.id, { note }))){ noteInput.value = slot.note || ""; return; }
    if(others.length && confirm(`${slot.ta} 還有 ${others.length} 個時段的備註不一樣，要一起改成「${note || "（空白）"}」嗎？`)){
      for(const o of others){ if(!(await saveRosterFields(o.id, { note }))) return; }
    }
    showToast(note ? `備註已更新：${note}` : "已清除備註");
    return;
  }
  const input = e.target.closest("[data-quota]");
  if(!input) return;
  const slot = roster.find(s=>s.id===input.dataset.quota);
  if(!slot) return;
  const quota = Math.floor(Number(input.value));
  if(!(quota >= 1)){ showToast("名額至少要 1"); input.value = slot.quota; return; }
  if(quota === Number(slot.quota)) return;
  // 名額按天算：找出之後排最多人的那一天，名額改得比它少那天就會超額
  const perDay = {};
  upcomingInSlot(slot).forEach(r=>{ perDay[r.slotDate] = (perDay[r.slotDate] || 0) + 1; });
  const [busiestDay, busiest] = Object.entries(perDay).sort((a,b)=>b[1]-a[1])[0] || [null, 0];
  if(quota < busiest && !confirm(
    `${slotText(busiestDay, slot.time, slot.ta)} 已經排了 ${busiest} 位學生，名額改成 ${quota} 會超額。\n\n` +
    `已經排進來的學生不受影響，只是那天老師就選不到這個時段了。確定要改？`
  )){ input.value = slot.quota; return; }
  if(!(await saveRosterFields(slot.id, { quota }))){ input.value = slot.quota; return; }
  showToast(`名額已改為 ${quota}`);
});
rosterEditor.addEventListener("click", async e=>{
  const btn = e.target.closest("[data-del-slot]");
  if(!btn) return;
  const slot = roster.find(s=>s.id===btn.dataset.delSlot);
  if(!slot) return;
  const used = upcomingInSlot(slot).length;
  const warn = used > 0
    ? `\n\n⚠ 這個時段之後還排了 ${used} 位學生。刪掉時段不會刪掉這些紀錄，但老師之後選不到這個時段；建議先把這幾筆改期。`
    : "";
  if(!confirm(`確定刪除每${WEEKDAY_LABEL[slot.weekday] || slot.weekday} ${slot.time}（${slot.ta}）這個時段？${warn}`)) return;
  if(!(await deleteRosterSlot(slot.id))) return;
  showToast("已刪除時段");
});

// ---------------- 管理職：篩選列 ----------------
let searchTimer = null;
document.getElementById("adminSearch").addEventListener("input", e=>{
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(()=>{ adminFilter.search = v; adminShown = ADMIN_PAGE_SIZE; renderAdmin(); }, 200);
});
document.getElementById("adminStatusFilter").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-status]");
  if(!btn) return;
  adminFilter.status = btn.dataset.status;
  adminShown = ADMIN_PAGE_SIZE;
  document.querySelectorAll("#adminStatusFilter button")
    .forEach(b=>b.classList.toggle("active", b===btn));
  renderAdmin();
});
document.getElementById("adminTaFilter").addEventListener("change", e=>{
  adminFilter.ta = e.target.value;
  adminShown = ADMIN_PAGE_SIZE;
  renderAdmin();
});

// ---------------- 統一渲染入口 ----------------
// 資料變了：三頁都標記為過期，但只重畫當下看得到的那一頁。
// Firestore 每一次推播都會走到這裡，全部重畫等於白花三倍的時間在沒人看的畫面上。
function renderAll(){
  dirty.teacher = dirty.ta = dirty.admin = true;
  renderActiveView();
  if(editState) renderEditSlots();   // 修改視窗開著時，時段剩餘名額也要即時反映別人的變動
}

function renderActiveView(){
  refreshNameField();
  if(state.role === "teacher" && dirty.teacher){
    renderSlotPicker();
    renderTeacherRecords();
    dirty.teacher = false;
  } else if(state.role === "ta" && dirty.ta){
    renderTaLists();
    dirty.ta = false;
  } else if(state.role === "admin" && dirty.admin){
    renderAdmin();
    dirty.admin = false;
  }
}

initFirebase();
