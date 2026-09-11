// ============================================================
// 國小英語 補課派工與進度追蹤系統
// ------------------------------------------------------------
// 設定方式：請看 README.md「第一步」，照著做完後把 firebaseConfig 貼到
// 下面的 FIREBASE_CONFIG，並依 README「第三步」建立共用帳號、貼上 Firestore 規則。
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, updateDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp, setDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
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
      renderAll();
    }, err => { connStatus.textContent = "連線錯誤：" + err.message; })
  );

  unsubscribers.push(
    onSnapshot(collection(db,"roster"), async snap => {
      roster = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      if(roster.length === 0){ await seedDefaultRoster(); }
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

async function seedDefaultRoster(){
  // 對應原本 Excel「補課時段及師資」表的預設值
  const defaults = [
    { weekday:"Mon", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
    { weekday:"Wed", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
    { weekday:"Thu", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
    { weekday:"Fri", time:"1:00-2:00", ta:"Jocelyn", quota:4 },
    { weekday:"Mon", time:"3:30-4:00", ta:"Jocelyn", quota:4 },
    { weekday:"Wed", time:"3:30-4:00", ta:"Jocelyn", quota:4 },
    { weekday:"Thu", time:"3:30-4:00", ta:"Jocelyn", quota:4 },
    { weekday:"Fri", time:"3:30-4:00", ta:"Jocelyn", quota:4 },
    { weekday:"Mon", time:"6:30-7:00", ta:"Jocelyn", quota:4 },
    { weekday:"Tue", time:"6:30-7:00", ta:"Jocelyn", quota:4 },
    { weekday:"Wed", time:"6:30-7:00", ta:"Jocelyn", quota:4 },
    { weekday:"Thu", time:"6:30-7:00", ta:"Jocelyn", quota:4 },
    { weekday:"Fri", time:"6:30-7:00", ta:"Jocelyn", quota:4 },
  ];
  for(const d of defaults){
    await addDoc(collection(db,"roster"), d);
  }
}

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
function todayStr(){ return new Date().toISOString().slice(0,10); }
function daysSince(dateStr){
  if(!dateStr) return 0;
  const d1 = new Date(dateStr), d2 = new Date(todayStr());
  return Math.floor((d2-d1)/86400000);
}
// 一筆紀錄的生命週期：
//   待補課 →（助教填完成果）→ 待老師查核 →（老師簽名）→ 已完成
// 老師簽名這一步對應規則說明裡教師須預備的第 4 項「補課追蹤：查看助教
// 填寫的補課紀錄並簽名」。沒簽名就不算結案。
function computeStatus(r){
  if(r.actualDate) return r.teacherVerified ? "done" : "toVerify";
  if(daysSince(r.absenceDate) > OVERDUE_DAYS) return "overdue";
  return "pending";
}
function statusLabel(s){
  return { pending:"待補課", overdue:"逾期未補", toVerify:"待老師查核", done:"已完成" }[s];
}
function formatStamp(ms){
  if(!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 2000);
}
function remainingForSlot(weekday, time, ta){
  const slot = roster.find(s=>s.weekday===weekday && s.time===time && s.ta===ta);
  if(!slot || !slot.ta) return 0;
  const used = records.filter(r=>
    r.slotWeekday===weekday && r.slotTime===time && r.slotTA===ta && !r.actualDate
  ).length;
  return slot.quota - used;
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

// 提示條裡的「規則說明」連結
document.querySelectorAll("[data-goto]").forEach(a=>{
  a.addEventListener("click", ()=>switchRole(a.dataset.goto));
});

const nameInput = document.getElementById("myName");
const nameLabel = document.getElementById("nameLabel");

// 這一欄決定你看得到誰的紀錄，沒填等於整個系統是空的，所以空白時要醒目
const NAME_HINT = {
  teacher: { label:"填表老師", placeholder:"填表老師名字" },
  ta:      { label:"助教",     placeholder:"助教名字" },
  admin:   { label:"管理職",   placeholder:"你的名字" },
  rules:   { label:"填表老師", placeholder:"填表老師名字" },
};

function refreshNameField(){
  const hint = NAME_HINT[state.role] || NAME_HINT.teacher;
  nameLabel.textContent = hint.label;
  nameInput.placeholder = hint.placeholder;
  nameInput.classList.toggle("empty", !state.name);
}

nameInput.value = localStorage.getItem("makeup_name") || "";
state.name = nameInput.value;
let nameTimer = null;
nameInput.addEventListener("input", ()=>{
  state.name = nameInput.value.trim();
  localStorage.setItem("makeup_name", state.name);
  refreshNameField();
  // 每打一個字就重畫整頁太浪費，等使用者停下來再畫
  clearTimeout(nameTimer);
  nameTimer = setTimeout(renderAll, 250);
});
(function restoreRole(){
  const saved = localStorage.getItem("makeup_role");
  if(saved){
    state.role = saved;
    document.querySelectorAll("#roleTabs button").forEach(b=>b.classList.toggle("active", b.dataset.role===saved));
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById("view-"+saved).classList.add("active");
  }
})();

// ---------------- 老師：時段選擇器 ----------------
function renderSlotPicker(){
  const wrap = document.getElementById("slotPicker");
  const weekdays = ["Mon","Tue","Wed","Thu","Fri"];
  const times = [...new Set(roster.map(s=>s.time))].sort();

  if(times.length === 0){
    wrap.innerHTML = '<div class="empty">管理職還沒設定任何補課時段</div>';
    return;
  }

  let html = '<table class="slot-table"><thead><tr><th></th>';
  weekdays.forEach(w=> html += `<th>${WEEKDAY_LABEL[w]}</th>`);
  html += '</tr></thead><tbody>';

  times.forEach(t=>{
    html += `<tr><th>${escapeHtml(t)}</th>`;
    weekdays.forEach(w=>{
      const slots = slotsAt(w,t);
      if(slots.length === 0){
        html += `<td><div class="slot-cell unavailable">無</div></td>`;
        return;
      }
      // 一格裡可能有多位助教，每位各一顆按鈕
      const buttons = slots.map(slot=>{
        const remain = remainingForSlot(w,t,slot.ta);
        const isSel = selectedSlot && selectedSlot.weekday===w
                   && selectedSlot.time===t && selectedSlot.ta===slot.ta;
        const cls = remain<=0 ? "slot-cell full" : (isSel ? "slot-cell selected" : "slot-cell");
        return `<button type="button" class="${cls}" ${remain<=0?"disabled":""}
          data-w="${escapeHtml(w)}" data-t="${escapeHtml(t)}" data-ta="${escapeHtml(slot.ta)}"
        >${escapeHtml(slot.ta)}<small>剩 ${Math.max(remain,0)} 名</small></button>`;
      }).join("");
      html += `<td><div class="slot-multi">${buttons}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  wrap.querySelectorAll("button.slot-cell").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      selectedSlot = { weekday:btn.dataset.w, time:btn.dataset.t, ta:btn.dataset.ta };
      document.querySelector('[name="slotWeekday"]').value = selectedSlot.weekday;
      document.querySelector('[name="slotTime"]').value = selectedSlot.time;
      document.querySelector('[name="slotTA"]').value = selectedSlot.ta;
      renderSlotPicker();
      document.getElementById("teacherFormHint").textContent =
        `已選：${WEEKDAY_LABEL[selectedSlot.weekday]} ${selectedSlot.time}（${selectedSlot.ta}）`;
    });
  });
}

// ---------------- 老師：送出新紀錄 ----------------
document.getElementById("teacherForm").addEventListener("submit", async e=>{
  e.preventDefault();
  if(!state.name){ showToast("請先在右上角輸入妳的姓名"); return; }
  if(!selectedSlot){ showToast("請選擇補課時段"); return; }
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  data.teacherName = state.name;
  data.actualDate = "";
  data.method = ""; data.result = ""; data.homeworkStatus = ""; data.taNote = "";
  data.parentNotified = false;
  data.createdAt = Date.now();

  if(db){
    await addDoc(collection(db,"records"), data);
  } else {
    records.push({ id:uid(), ...data });
    renderAll();
  }
  e.target.reset();
  selectedSlot = null;
  document.getElementById("teacherFormHint").textContent = "";
  renderSlotPicker();
  showToast("已送出補課紀錄");
});

// ---------------- 管理職：時段設定 ----------------
document.getElementById("rosterAddForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  data.quota = Number(data.quota);
  const existing = roster.find(s=>s.weekday===data.weekday && s.time===data.time && s.ta===data.ta);
  if(db){
    if(existing){ await updateDoc(doc(db,"roster",existing.id), data); }
    else { await addDoc(collection(db,"roster"), data); }
  } else {
    if(existing) Object.assign(existing, data);
    else roster.push({ id:uid(), ...data });
    renderAll();
  }
  e.target.reset();
  showToast("已更新時段設定");
});

// ---------------- 更新紀錄（助教填寫 / 管理職編輯共用）----------------
async function saveRecordFields(id, fields){
  if(db){ await updateDoc(doc(db,"records",id), fields); }
  else {
    const r = records.find(x=>x.id===id);
    Object.assign(r, fields);
    renderAll();
  }
}

// ---------------- 訊息範本 ----------------
function buildParentMessage(r){
  const name = r.studentNameCh || r.studentNameEn || "";
  return `Hello ${name}'s parents\n${name} 於 ${r.absenceDate} 請假（原因：${r.leaveReason}），已於 ${r.actualDate} 完成補課囉！\n\n補課內容：${r.assignedContent}\n補課方式：${r.method}\n驗收成果：${r.result}\n作業狀況：${r.homeworkStatus}\n\n如有任何問題歡迎與我們聯繫，謝謝您的配合！`;
}
function buildDeptRequestMessage(r){
  const bookLine = [r.book, r.unit].filter(Boolean).join(" ");
  return `${r.studentNameCh} 學生補課申請時段：\n\n學生：${r.studentNameCh}（${r.className||""}／${r.homeroomTeacher||""}）\n缺課日期：${r.absenceDate}，原因：${r.leaveReason}\n申請時段：${WEEKDAY_LABEL[r.slotWeekday]||r.slotWeekday} ${r.slotTime}\n負責助教：${r.slotTA}\n需攜帶：${bookLine || "（請見指派內容）"}\n\n請協助提醒學生準時並攜帶課本哦`;
}
function buildDeptUpdateMessage(r, statusChoice, newSlot){
  const box = (label) => statusChoice===label ? "☑" : "☐";
  return `教學部您好，\n${r.studentNameCh}同學（${r.teacherName}老師）補課狀況更新：\n\n原訂時段：${WEEKDAY_LABEL[r.slotWeekday]||r.slotWeekday} ${r.slotTime}\n狀態：${box("已完成")}已完成 ${box("改期")}改期 ${box("取消")}取消\n（若改期）新時段：${statusChoice==="改期" ? (newSlot||"___________") : "___________"}\n\n如需協助請告知，謝謝！`;
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
        await saveRecordFields(r.id, { parentNotified:true, parentNotifiedAt: Date.now() });
        showToast("已標記通知家長");
      }
    });
  }
}
function openDeptRequestModal(r){
  openModal("傳給教學部：申請補課時段", buildDeptRequestMessage(r));
}
function openDeptUpdateModal(r){
  let statusChoice = "已完成";
  const extra = `
    <div class="status-radio">
      <label><input type="radio" name="deptStatus" value="已完成" checked> 已完成</label>
      <label><input type="radio" name="deptStatus" value="改期"> 改期</label>
      <label><input type="radio" name="deptStatus" value="取消"> 取消</label>
    </div>
    <div class="field" id="newSlotField" style="display:none; margin-bottom:8px;">
      <label>新時段</label><input id="newSlotInput" placeholder="例如：週三 3:30-4:00">
    </div>`;
  openModal("傳給教學部：異動通知", buildDeptUpdateMessage(r, statusChoice), extra);
  document.querySelectorAll('input[name="deptStatus"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{
      statusChoice = radio.value;
      document.getElementById("newSlotField").style.display = statusChoice==="改期" ? "block" : "none";
      modalText.value = buildDeptUpdateMessage(r, statusChoice, document.getElementById("newSlotInput").value);
    });
  });
  document.getElementById("newSlotInput").addEventListener("input", e=>{
    modalText.value = buildDeptUpdateMessage(r, statusChoice, e.target.value);
  });
}

// ---------------- 渲染：老師的紀錄列表 ----------------
function renderTeacherRecords(){
  const wrap = document.getElementById("teacherRecordList");
  const badge = document.getElementById("teacherCount");
  const mine = records.filter(r=>r.teacherName===state.name);

  if(!state.name){
    badge.textContent = "";
    wrap.innerHTML = '<div class="empty">請先在右上角輸入姓名，才能看到你登記的紀錄</div>';
    return;
  }

  // 待查核的筆數要一眼看到，這是老師該處理的事
  const toVerify = mine.filter(r=>computeStatus(r)==="toVerify").length;
  badge.textContent = toVerify > 0 ? `${mine.length} 筆・${toVerify} 筆待查核` : `${mine.length} 筆`;

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
      actualDate: form.querySelector(".f-actualDate")?.value,
      method:     form.querySelector(".f-method")?.value,
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
    set(".f-method", s.method);
    set(".f-result", s.result);
    set(".f-hw", s.hw);
    set(".f-note", s.note);
  });
}

function renderTaLists(){
  const pendingWrap = document.getElementById("taPendingList");
  const doneWrap = document.getElementById("taDoneList");
  const pendingBadge = document.getElementById("taPendingCount");
  const doneBadge = document.getElementById("taDoneCount");

  if(!state.name){
    pendingWrap.innerHTML = '<div class="empty">請先在右上角輸入姓名（需與管理職在「時段設定」填的助教姓名完全一致）</div>';
    doneWrap.innerHTML = "";
    pendingBadge.textContent = "";
    doneBadge.textContent = "";
    return;
  }

  const formState = captureTaFormState();

  const mine = records.filter(r=>r.slotTA===state.name);
  const pending = mine.filter(r=>!r.actualDate);
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
      ${kv("時段/負責人", `${WEEKDAY_LABEL[r.slotWeekday]||""} ${r.slotTime||""}（${r.slotTA||"-"}）`)}
      ${r.actualDate ? `
      ${kv("實際補課日期", r.actualDate)}
      ${kv("補課方式", r.method)}
      ${kv("驗收成果", r.result)}
      ${kv("作業狀況", r.homeworkStatus)}
      ${kv("助教備註", r.taNote)}
      ${kv("家長已通知", r.parentNotified ? "是" : "否")}
      ${kv("老師查核", r.teacherVerified
            ? `${r.verifiedBy || ""} 已簽名${r.verifiedAt ? `（${formatStamp(r.verifiedAt)}）` : ""}`
            : "尚未查核")}` : ``}
    </div>

    <div class="rc-actions">
      ${mode==="teacher" ? `
        <button class="btn secondary small act-dept-request">傳給教學部：申請時段</button>
        <button class="btn secondary small act-dept-update">傳給教學部：異動通知</button>
      ` : ``}
      ${mode==="teacher" && r.actualDate && !r.teacherVerified
        ? `<button class="btn small act-verify">查核並簽名</button>` : ``}
      ${mode==="ta" && !r.actualDate ? `<button class="btn small act-fill">填寫補課成果</button>` : ``}
      ${mode==="ta" && r.actualDate ? `<button class="btn secondary small act-parent-msg">產生家長通知訊息</button>` : ``}
    </div>

    ${mode==="ta" && !r.actualDate ? `
    <div class="ta-form" id="taform-${r.id}">
      <div class="grid">
        <div class="field"><label>實際補課日期</label><input type="date" class="f-actualDate" value="${todayStr()}"></div>
        <div class="field"><label>補課方式</label>
          <select class="f-method">
            <option>1對1實體補課</option><option>錄影/音檔自學+TA驗收</option>
            <option>線上補課 (Zoom)</option><option>課前/課後快跑驗收</option>
          </select>
        </div>
        <div class="field wide"><label>驗收成果</label><input class="f-result" placeholder="例如：單字補考 90分 (已過關)"></div>
        <div class="field">
          <label>作業補交狀況</label>
          <select class="f-hw">
            <option>已補交並批改</option><option>部分補交(待追蹤)</option>
            <option>尚未補交</option><option>無需補交</option>
          </select>
        </div>
        <div class="field wide"><label>助教備註與交接</label><textarea class="f-note"></textarea></div>
      </div>
      <button class="btn small act-save-ta" style="margin-top:10px;">儲存補課成果</button>
    </div>` : ``}
  </div>`;
}

function bindRecordActions(container, list){
  container.querySelectorAll(".record-card").forEach(card=>{
    const r = list.find(x=>x.id===card.dataset.id);
    if(!r) return;
    card.querySelector(".act-dept-request")?.addEventListener("click", ()=>openDeptRequestModal(r));
    card.querySelector(".act-dept-update")?.addEventListener("click", ()=>openDeptUpdateModal(r));
    card.querySelector(".act-parent-msg")?.addEventListener("click", ()=>openParentMessageModal(r));
    card.querySelector(".act-verify")?.addEventListener("click", async ()=>{
      if(!state.name){ showToast("請先在右上角輸入你的姓名才能簽名"); return; }
      const ok = confirm(
        `確認 ${r.studentNameCh} 的補課紀錄已查核無誤？\n\n` +
        `實際補課：${r.actualDate}\n驗收成果：${r.result || "（未填）"}\n作業狀況：${r.homeworkStatus || "（未填）"}\n\n` +
        `簽名後會記錄為「${state.name}」查核，並把這筆結案。`
      );
      if(!ok) return;
      await saveRecordFields(r.id, {
        teacherVerified: true,
        verifiedBy: state.name,
        verifiedAt: Date.now(),
      });
      showToast("已查核並簽名");
    });
    card.querySelector(".act-fill")?.addEventListener("click", ()=>{
      document.getElementById("taform-"+r.id).classList.toggle("open");
    });
    card.querySelector(".act-save-ta")?.addEventListener("click", async ()=>{
      const form = document.getElementById("taform-"+r.id);
      const fields = {
        actualDate: form.querySelector(".f-actualDate").value,
        method: form.querySelector(".f-method").value,
        result: form.querySelector(".f-result").value,
        homeworkStatus: form.querySelector(".f-hw").value,
        taNote: form.querySelector(".f-note").value,
      };
      if(!fields.actualDate){ showToast("請填實際補課日期"); return; }
      await saveRecordFields(r.id, fields);
      showToast("已儲存補課成果");
    });
  });
}

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
    <div class="stat toVerify"><div class="num">${count("toVerify")}</div><div class="label">待老師查核</div></div>
    <div class="stat done"><div class="num">${count("done")}</div><div class="label">已完成</div></div>
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
    tbody.innerHTML = `<tr><td colspan="12" class="empty">目前沒有紀錄</td></tr>`;
  } else if(shown.length === 0){
    tbody.innerHTML = `<tr><td colspan="12" class="empty">沒有符合篩選條件的紀錄</td></tr>`;
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
        ${td("時段", e(`${WEEKDAY_LABEL[r.slotWeekday]||""} ${r.slotTime||""}`))}
        ${td("助教", e(r.slotTA))}
        ${td("實際補課", e(r.actualDate || "-"))}
        ${td("驗收", e(r.result || "-"))}
        ${td("家長已通知", r.parentNotified ? "是" : "否")}
        ${td("老師查核", r.teacherVerified
              ? e(`${r.verifiedBy || "已簽名"}${r.verifiedAt ? ` ${formatStamp(r.verifiedAt)}` : ""}`)
              : "-")}
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
      <thead><tr><th>星期</th><th>時段</th><th>助教</th><th>名額</th><th>剩餘</th></tr></thead>
      <tbody>${sorted.map(s=>{
        const remain = remainingForSlot(s.weekday, s.time, s.ta);
        return `<tr>
          <td data-label="星期">${e(WEEKDAY_LABEL[s.weekday] || s.weekday)}</td>
          <td data-label="時段">${e(s.time)}</td>
          <td data-label="助教">${e(s.ta)}</td>
          <td data-label="名額">${e(s.quota)}</td>
          <td data-label="剩餘">${remain <= 0 ? '<span class="tag overdue">額滿</span>' : e(remain)}</td>
        </tr>`;
      }).join("")}
      </tbody></table></div>`;
  }
}

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
