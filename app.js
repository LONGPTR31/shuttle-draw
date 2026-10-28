import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, doc, collection, onSnapshot, runTransaction, writeBatch, setDoc, getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { firebaseConfig, adminEmail } from './firebase-config.js';

/* ---------- seat model ---------- */
const BLOCK = {'7-1':'值班','7-3':'值班','8-1':'值班','8-3':'值班','1-4':'車長','1-2':'空'};
const COLORDER = ['1','3','4','2'];            // 駕駛員側靠窗、靠走道，車門側靠走道、靠窗
const COLPOS = {'1':1,'3':2,'4':4,'2':5};
const SEATS = [];
for (let r = 1; r <= 10; r++) {
  COLORDER.forEach(c => {
    if ((c === '1' || c === '3') && r > 8) return;
    const id = r + '-' + c;
    SEATS.push({id, row:r, col:c, side:(c === '1' || c === '3') ? '駕駛員側' : '車門側',
      block:BLOCK[id] || null, order:r * 10 + COLORDER.indexOf(c)});
  });
}
const SEATMAP = {};
SEATS.forEach(s => { SEATMAP[s.id] = s; });
const DRAWABLE = SEATS.filter(s => !s.block);

/* ---------- state ---------- */
const S = {
  status:'idle', roster:[], next:1, draws:[], captainId:'', captainName:'',
  admin:false, focusSeat:null, hiddenSeat:null, flashSeat:null, busy:false,
  rosterDirty:false, myId:null, rosterSig:'', capSig:'', capSelSig:''
};
let REDUCED = false;
try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
function el(tag, props, kids) {
  const n = document.createElement(tag);
  if (props) Object.keys(props).forEach(k => {
    if (k === 'text') n.textContent = props[k];
    else if (k === 'className') n.className = props[k];
    else n.setAttribute(k, props[k]);
  });
  (kids || []).forEach(k => n.appendChild(k));
  return n;
}
function place(n, row, col) { if (row) n.style.gridRow = row; if (col) n.style.gridColumn = col; return n; }
function norm(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function randInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return Math.floor(a[0] / 4294967296 * n); }
function fmtTime(ts) {
  try { return new Date(ts).toLocaleString('zh-TW', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}); }
  catch (e) { return ''; }
}
function say(id, text, kind) { const n = $(id); n.textContent = text || ''; n.className = 'msg' + (kind ? ' ' + kind : ''); }
function notice(text) { const n = $('notice'); n.textContent = text || ''; n.hidden = !text; }
function seatOrder(d) { const s = SEATMAP[d.seat]; return s ? s.order : 999; }
function sortedDraws() { return S.draws.slice().sort((a, b) => seatOrder(a) - seatOrder(b)); }
function errText(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return '沒有權限。可能是抽籤尚未開放、已截止、姓名不在名單內，或安全規則還沒設定。';
  if (c === 'aborted' || c === 'failed-precondition' || c === 'already-exists') return '現在有很多人同時抽籤，請再按一次。';
  if (c === 'resource-exhausted') return '今日資料庫用量已達上限，請明天再試或通知管理員。';
  if (c === 'unavailable' || c === 'deadline-exceeded') return '連線發生問題，請檢查網路後再試。';
  return '發生問題，請稍後再試。';
}
function captainName() {
  if (!S.captainId) return '';
  const m = S.roster.find(x => x.id === S.captainId);
  return m ? m.name : (S.captainName || '');
}

/* ---------- Firebase ---------- */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* ---------- map ---------- */
function renderMap() {
  const host = $('plan'); host.textContent = '';
  const bySeat = {};
  S.draws.forEach(d => { if (d.seat !== S.hiddenSeat) bySeat[d.seat] = d; });

  host.appendChild(place(el('div', {className:'head', text:'駕駛員'}), 1, '1 / 3'));
  host.appendChild(place(el('div', {className:'head', text:'車門'}), 1, '4 / 6'));
  host.appendChild(place(el('div', {className:'aisle', text:'走道'}), '2 / span 10', '3'));
  host.appendChild(place(el('div', {className:'exit', role:'img', 'aria-label':'安全門，不開放抽籤', text:'安全門'}), '10 / span 2', '1 / 3'));

  SEATS.forEach(s => {
    if (s.id === '1-2') return;
    if (s.id === '1-4') {
      const capName = captainName();
      let cap;
      if (capName) {
        cap = el('div', {className:'seat taken captain', role:'img', 'aria-label':'車長座，' + capName}, [
          el('span', {className:'no', text:'車長'}), el('span', {className:'who', text:capName, title:capName})]);
      } else {
        cap = el('div', {className:'seat block', role:'img', 'aria-label':'車長座，不開放抽籤'}, [el('span', {className:'who', text:'車長'})]);
      }
      cap.style.justifyContent = 'center'; cap.style.minHeight = '44px'; cap.style.gap = '2px';
      host.appendChild(place(cap, '2', '4 / 6'));
      return;
    }
    const d = bySeat[s.id];
    let cls = 'seat';
    const kids = [el('span', {className:'no', text:s.id})];
    let label = s.id + ' ';
    if (s.block) {
      cls += ' block'; kids.push(el('span', {className:'who', text:s.block})); label += s.block + '，不開放抽籤';
    } else if (d) {
      cls += ' taken'; if (S.focusSeat === s.id) cls += ' mine';
      kids.push(el('span', {className:'who', text:d.name, title:d.name}));
      if (d.station === '東湖宿舍站') kids.push(el('span', {className:'tag', 'aria-hidden':'true', text:'東'}));
      label += d.name + '，' + d.station;
    } else {
      cls += ' free'; label += '可抽';
    }
    if (S.flashSeat === s.id && !s.block) cls += ' flash';
    host.appendChild(place(el('div', {className:cls, role:'img', 'aria-label':label}, kids), s.row + 1, String(COLPOS[s.col])));
  });

  const rear = el('div', {className:'seat rear', role:'img', 'aria-label':'最後一排自由座，不開放抽籤'}, [
    el('span', {className:'who', text:'自由座'})]);
  rear.style.marginTop = '10px'; rear.style.justifyContent = 'center'; rear.style.minHeight = '44px';
  host.appendChild(place(rear, 12, '1 / 6'));
}

/* ---------- status, form state ---------- */
function renderStatus() {
  const pill = $('status-pill');
  const label = {idle:'尚未開放', open:'抽籤開放中', closed:'已截止'}[S.status] || '尚未開放';
  pill.textContent = label;
  pill.className = 'pill ' + (S.status === 'open' ? 'open' : S.status === 'closed' ? 'closed' : '');
  let note = '';
  if (S.status === 'idle') note = '抽籤尚未開放，管理員開啟後才能抽。';
  else if (S.status === 'closed') note = '抽籤已截止，座位圖和下方清單可以查看結果。';
  else if (!S.roster.length) note = '姓名名單還沒建立，請通知管理員。';
  else note = '輸入姓名、選擇上車站後按「抽座位」。每人只能抽一次。';
  $('state-note').textContent = note;
  $('draw-btn').disabled = !(S.status === 'open' && !S.busy && S.roster.length > 0);
  $('admin-status-text').textContent = '目前狀態：' + label;
}

/* ---------- results ---------- */
function renderResults() {
  const body = $('result-body'); body.textContent = '';
  const rows = sortedDraws();
  document.querySelectorAll('.admin-col').forEach(n => { n.hidden = !S.admin; });
  rows.forEach(d => {
    const tr = el('tr', {className:d.id === S.myId ? 'mine' : ''});
    tr.appendChild(el('td', {className:'seatno', text:d.seat}));
    tr.appendChild(el('td', {text:d.name + (d.test ? '（測試）' : '')}));
    tr.appendChild(el('td', {text:d.station || ''}));
    tr.appendChild(el('td', {text:fmtTime(d.ts)}));
    if (S.admin) {
      const td = el('td');
      const b = el('button', {type:'button', className:'warn small', text:'清除'});
      armButton(b, '再按一次確認', () => clearOne(d), 'clear-' + d.id);
      td.appendChild(b); tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  $('result-empty').hidden = rows.length > 0;

  const drawers = S.roster.filter(m => m.id !== S.captainId);
  const total = drawers.length;
  const drawnIds = {}; S.draws.forEach(d => { drawnIds[d.id] = true; });
  const pending = drawers.filter(m => !drawnIds[m.id]);
  const dh = S.draws.filter(d => d.station === '東湖宿舍站').length;
  const ot = S.draws.filter(d => d.station === '其他站').length;
  const pr = $('progress'); pr.textContent = '';
  const stat = (k, v) => { const s = el('span', {text:k + ' '}); s.appendChild(el('strong', {text:String(v)})); return s; };
  pr.appendChild(stat('已抽', total ? S.draws.length + '／' + total + ' 人' : S.draws.length + ' 人'));
  pr.appendChild(stat('剩餘座位', Math.max(0, DRAWABLE.length - S.draws.length)));
  pr.appendChild(stat('東湖宿舍站', dh + ' 人'));
  pr.appendChild(stat('其他站', ot + ' 人'));

  const pw = $('pending');
  if (pending.length && total) {
    pw.hidden = false;
    $('pending-h').textContent = '尚未抽籤（' + pending.length + ' 人）';
    const chips = $('pending-chips'); chips.textContent = '';
    pending.forEach(m => chips.appendChild(el('span', {className:'chip', text:m.name})));
  } else pw.hidden = true;
  $('roster-count').textContent = S.roster.length ? '目前名單 ' + S.roster.length + ' 人' : '';
}

function showResult(d, existing) {
  const s = SEATMAP[d.seat];
  $('result-seat').textContent = d.seat;
  $('result-who').textContent = d.name + (d.station ? '・' + d.station : '');
  $('result-where').textContent = s ? s.side + '・第 ' + s.row + ' 排' + (existing ? '（你先前已抽過）' : '') : '';
  $('result').hidden = false;
}

/* ---------- seat picking ---------- */
/* 每一排（同一側的同一排）先有一個人坐靠窗，每排都有人之後才同排。
   其他站放在前面的排，東湖宿舍站放在後面的排，前後各佔幾排依兩站人數而定。 */
const POS_POWER = 2;
function isWindow(s) { return s.col === '1' || s.col === '2'; }
function benchOf(s) { return s.row + ((s.col === '1' || s.col === '3') ? 'L' : 'R'); }
function seatWeight(s, station) {
  const p = station === '東湖宿舍站' ? s.row : (11 - s.row);
  return Math.pow(p, POS_POWER);
}
const BENCHES = [];
for (let br = 1; br <= 10; br++) {
  ['L', 'R'].forEach(sd => {
    const k = br + sd;
    if (DRAWABLE.some(s => benchOf(s) === k)) BENCHES.push(k);
  });
}
function frontBenches() {
  let no = 0, nd = 0;
  S.roster.forEach(m => {
    if (m.id === S.captainId) return;
    if (m.station === '其他站') no++; else if (m.station === '東湖宿舍站') nd++;
  });
  if (!no || !nd) return null;
  const nf = Math.max(1, Math.min(BENCHES.length - 1, Math.round(BENCHES.length * no / (no + nd))));
  const set = {};
  BENCHES.slice(0, nf).forEach(k => { set[k] = true; });
  return set;
}
function pickSeat(free, station, taken) {
  const occ = {};
  DRAWABLE.forEach(s => { if (taken[s.id]) { const b = benchOf(s); occ[b] = (occ[b] || 0) + 1; } });
  const front = frontBenches();
  if (front) {
    const wantFront = (station === '其他站');
    const zone = free.filter(s => !!front[benchOf(s)] === wantFront);
    if (zone.length) free = zone;
  }
  const solo = free.filter(s => !occ[benchOf(s)] && isWindow(s));
  const pool = solo.length ? solo : free.filter(s => occ[benchOf(s)] === 1);
  if (pool.length) free = pool;
  let total = 0;
  const w = free.map(s => { const x = seatWeight(s, station); total += x; return x; });
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  let t = a[0] / 4294967296 * total;
  for (let i = 0; i < free.length; i++) { t -= w[i]; if (t < 0) return free[i]; }
  return free[free.length - 1];
}

/* 以資料庫交易抽籤：座位鎖文件 seats/<座位> 只能被建立一次，不會有兩人抽到同一個座位 */
async function claimSeat(member, station, isTest) {
  const stateRef = doc(db, 'config', 'state');
  const drawRef = doc(db, 'draws', member.id);
  const seatRefs = DRAWABLE.map(s => doc(db, 'seats', s.id));
  return runTransaction(db, async tx => {
    const snaps = await Promise.all([tx.get(stateRef), tx.get(drawRef), ...seatRefs.map(r => tx.get(r))]);
    const st = snaps[0], mine = snaps[1], seatSnaps = snaps.slice(2);
    const status = st.exists() ? st.data().status : 'idle';
    if (!isTest && status !== 'open') return {error:status === 'closed' ? 'closed' : 'idle'};
    if (mine.exists()) return {existing:Object.assign({}, mine.data(), {id:member.id})};
    const taken = {};
    seatSnaps.forEach((sn, i) => { if (sn.exists()) taken[DRAWABLE[i].id] = true; });
    const free = DRAWABLE.filter(s => !taken[s.id]);
    if (!free.length) return {error:'full'};
    const seat = pickSeat(free, station, taken);
    const ts = Date.now();
    const rec = {memberId:member.id, name:member.name, seat:seat.id, station, ts};
    const lock = {memberId:member.id, name:member.name, station, ts};
    if (isTest) { rec.test = true; lock.test = true; }
    tx.set(doc(db, 'seats', seat.id), lock);
    tx.set(drawRef, rec);
    return {draw:Object.assign({}, rec, {id:member.id})};
  }, {maxAttempts:30});   // 很多人同時抽會互相衝突，多重試幾次
}

function upsertDraw(rec) {
  S.draws = S.draws.filter(d => d.id !== rec.id).concat([rec]);
}

async function reveal(draw) {
  S.hiddenSeat = draw.seat; S.myId = draw.id; renderMap();
  if (!REDUCED) {
    const taken = {}; S.draws.forEach(d => { if (d.id !== draw.id) taken[d.seat] = true; });
    const pool = DRAWABLE.filter(s => !taken[s.id]).map(s => s.id);
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      S.flashSeat = (i === steps - 1) ? draw.seat : pool[randInt(pool.length)];
      renderMap();
      await sleep(70 + i * 9);
    }
  }
  S.flashSeat = null; S.hiddenSeat = null; S.focusSeat = draw.seat;
  renderMap(); renderResults(); showResult(draw, false);
}

async function onDraw(e) {
  e.preventDefault();
  say('draw-msg', '');
  if (S.busy) return;
  const raw = $('name-input').value;
  const key = norm(raw);
  if (!key) { say('draw-msg', '請輸入姓名。', 'err'); return; }
  if (!S.roster.length) { say('draw-msg', '姓名名單還沒建立，請通知管理員。', 'err'); return; }
  const member = S.roster.find(m => norm(m.name) === key);
  if (!member) { say('draw-msg', '名單中找不到「' + raw.trim() + '」。請確認有沒有打錯字，名字沒錯的話請通知管理員。', 'err'); return; }
  if (member.id === S.captainId) { say('draw-msg', '「' + member.name + '」是車長，座位固定是 1-4，不用抽籤。', 'err'); return; }
  try { localStorage.setItem('bus-draw-name', raw.trim()); } catch (e2) {}
  const existing = S.draws.find(d => d.id === member.id);
  if (existing) {
    S.focusSeat = existing.seat; S.myId = existing.id; renderMap(); renderResults(); showResult(existing, true);
    say('draw-msg', '「' + member.name + '」已經抽過了，每人只能抽一次。', 'err'); return;
  }
  const stEl = document.querySelector('input[name=station]:checked');
  const station = member.station || (stEl ? stEl.value : '');
  if (!station) { say('draw-msg', '請選擇上車站。', 'err'); return; }
  S.busy = true; renderStatus(); say('draw-msg', '抽籤中…');
  try {
    const out = await claimSeat(member, station, false);
    if (out.draw) { say('draw-msg', ''); upsertDraw(out.draw); await reveal(out.draw); say('draw-msg', '抽籤完成，結果已公開。', 'ok'); }
    else if (out.existing) {
      S.focusSeat = out.existing.seat; S.myId = out.existing.id; renderMap(); renderResults(); showResult(out.existing, true);
      say('draw-msg', '「' + member.name + '」已經抽過了。', 'err');
    }
    else if (out.error === 'full') say('draw-msg', '座位已經抽完了，請通知管理員。', 'err');
    else if (out.error === 'closed') say('draw-msg', '抽籤已截止。', 'err');
    else say('draw-msg', '抽籤尚未開放。', 'err');
  } catch (err) {
    say('draw-msg', errText(err), 'err');
  } finally {
    S.busy = false; S.flashSeat = null; S.hiddenSeat = null; renderMap(); renderStatus();
  }
}

/* ---------- station lock ---------- */
function syncStation() {
  const k = norm($('name-input').value);
  const m = k ? S.roster.find(x => norm(x.name) === k) : null;
  const fixed = m && m.station ? m.station : '';
  document.querySelectorAll('input[name=station]').forEach(r => {
    if (fixed) r.checked = (r.value === fixed);
    r.disabled = !!fixed;
  });
  $('station-hint').textContent = fixed ? '名單已設定你的上車站：' + fixed : '';
}

/* ---------- admin ---------- */
/* 要按兩次才執行。key 用來在表格重畫後保留「再按一次確認」的狀態 */
const ARMED = {};
function armButton(btn, armedLabel, run, key) {
  const orig = btn.textContent;
  const k = key || btn.id;
  const show = on => { btn.classList.toggle('armed', on); btn.textContent = on ? armedLabel : orig; };
  const disarmLater = () => setTimeout(() => {
    if (!(ARMED[k] > Date.now())) { delete ARMED[k]; show(false); }
  }, ARMED[k] - Date.now() + 50);
  if (ARMED[k] > Date.now()) { show(true); disarmLater(); }
  btn.addEventListener('click', () => {
    if (!(ARMED[k] > Date.now())) {
      ARMED[k] = Date.now() + 4000; show(true); disarmLater();
    } else {
      delete ARMED[k]; show(false); run();
    }
  });
}
async function onAdminLogin(e) {
  e.preventDefault();
  const pw = $('admin-pw').value;
  if (!pw) { say('admin-msg', '請輸入密碼。', 'err'); return; }
  try {
    await setPersistence(auth, browserSessionPersistence);
    await signInWithEmailAndPassword(auth, adminEmail, pw);
    $('admin-pw').value = ''; say('admin-msg', '');
  } catch (err) {
    const c = err && err.code;
    say('admin-msg', c === 'auth/too-many-requests' ? '嘗試次數太多，請稍後再試。'
      : c === 'auth/network-request-failed' ? '連線失敗，請檢查網路。' : '密碼不正確。', 'err');
  }
}
function onAuth(user) {
  S.admin = !!user;
  $('admin-form').hidden = S.admin;
  $('admin-tools').hidden = !S.admin;
  if (S.admin) { fillRoster(true); fillCaptainSelect(); }
  renderResults();
}
async function guard(msgId, fn, okText) {
  try { await fn(); if (okText) say(msgId, okText, 'ok'); }
  catch (err) { say(msgId, errText(err), 'err'); }
}
function setStatus(st) {
  return guard('tools-msg', () => setDoc(doc(db, 'config', 'state'), {status:st, updatedAt:Date.now()}),
    st === 'open' ? '已開始抽籤。' : '已結束抽籤。');
}
function normStation(x) {
  x = norm(x);
  if (!x) return '';
  if (x.indexOf('東湖') === 0) return '東湖宿舍站';
  if (x.indexOf('其他') === 0) return '其他站';
  return null;
}
function fillRoster(force) {
  if (!S.admin && !force) return;
  if (S.rosterDirty && !force) return;
  $('roster-input').value = S.roster.map(m => m.name + (m.station ? ',' + m.station : '')).join('\n');
  if (force) S.rosterDirty = false;
}
function saveRoster() {
  const lines = $('roster-input').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) { say('roster-msg', '名單是空的。', 'err'); return; }
  const parsed = [], bad = [];
  lines.forEach(line => {
    const parts = line.split(/[,，\t]/);
    const name = parts[0].trim();
    const st = normStation(parts[1]);
    if (!name || st === null) { bad.push(line); return; }
    parsed.push({name, station:st});
  });
  if (bad.length) { say('roster-msg', '站點只能填「東湖宿舍站」或「其他站」，這幾行有問題：' + bad.join('、'), 'err'); return; }
  const seen = {}, dups = [];
  parsed.forEach(p => { const k = norm(p.name); if (seen[k]) dups.push(p.name); seen[k] = true; });
  if (dups.length) { say('roster-msg', '有重複的姓名：' + dups.join('、') + '。請加上區分再儲存。', 'err'); return; }
  const byName = {}; S.roster.forEach(m => { byName[norm(m.name)] = m; });
  let next = S.next || 1;
  const members = parsed.map(p => {
    const old = byName[norm(p.name)];
    const m = {id:old ? old.id : 'm' + (next++), name:p.name};
    if (p.station) m.station = p.station;
    return m;
  });
  const drawers = members.filter(m => m.id !== S.captainId).length;
  const over = drawers > DRAWABLE.length
    ? '注意：要抽籤的有 ' + drawers + ' 人，但只有 ' + DRAWABLE.length + ' 個座位，最後 ' + (drawers - DRAWABLE.length) + ' 人會抽不到。' : '';
  return guard('roster-msg', async () => {
    const b = writeBatch(db);
    b.set(doc(db, 'config', 'roster'), {members, next});
    const idx = {}, names = {};
    members.forEach(m => { idx[m.id] = m.station || ''; names[m.id] = m.name; });
    b.set(doc(db, 'config', 'rosterIndex'), {m:idx, n:names});
    await b.commit();
    S.rosterDirty = false;
  }, '已儲存 ' + members.length + ' 位。' + over);
}

function fillCaptainSelect() {
  const sel = $('captain-select');
  const name = captainName();
  $('captain-now').textContent = name ? '目前車長：' + name : '目前沒有指定車長。';
  const sig = S.captainId + '|' + JSON.stringify(S.roster.map(m => m.id + m.name));
  if (sig === S.capSelSig) return;
  S.capSelSig = sig;
  sel.textContent = '';
  const o = document.createElement('option'); o.value = ''; o.textContent = '（不指定車長）'; sel.appendChild(o);
  S.roster.forEach(m => {
    const op = document.createElement('option'); op.value = m.id; op.textContent = m.name; sel.appendChild(op);
  });
  sel.value = S.roster.some(m => m.id === S.captainId) ? S.captainId : '';
}
function saveCaptain() {
  const id = $('captain-select').value;
  if (!id) {
    return guard('captain-msg', () => setDoc(doc(db, 'config', 'captain'), {memberId:'', name:'', updatedAt:Date.now()}), '已取消車長。');
  }
  const m = S.roster.find(x => x.id === id);
  if (!m) { say('captain-msg', '名單中找不到這個人。', 'err'); return; }
  const drew = S.draws.find(d => d.id === id);
  if (drew) { say('captain-msg', m.name + ' 已經抽到 ' + drew.seat + '。請先在「抽籤結果」按他那一列的「清除」，再設為車長。', 'err'); return; }
  return guard('captain-msg', () => setDoc(doc(db, 'config', 'captain'), {memberId:id, name:m.name, updatedAt:Date.now()}),
    '已設定 ' + m.name + ' 為車長，座位 1-4。');
}

function clearOne(d) {
  return guard('tools-msg', async () => {
    const b = writeBatch(db);
    b.delete(doc(db, 'draws', d.id));
    b.delete(doc(db, 'seats', d.seat));
    await b.commit();
  }, '已清除 ' + d.name + ' 的結果，他可以重新抽。');
}
async function deleteDocs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach(r => b.delete(r));
    await b.commit();
  }
}
function resetAll() {
  return guard('tools-msg', async () => {
    const [d, s] = await Promise.all([getDocs(collection(db, 'draws')), getDocs(collection(db, 'seats'))]);
    await deleteDocs(d.docs.map(x => x.ref).concat(s.docs.map(x => x.ref)));
    S.focusSeat = null; S.myId = null; $('result').hidden = true;
  }, '已清空所有結果。');
}
async function testDrawAll() {
  if (!S.admin) { say('test-msg', '請先登入管理員。', 'err'); return; }
  if (S.busy) return;
  const todo = S.roster.filter(m => m.id !== S.captainId && !S.draws.some(d => d.id === m.id));
  if (!todo.length) { say('test-msg', '名單裡的人都已經抽過了。', 'err'); return; }
  for (let i = todo.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = todo[i]; todo[i] = todo[j]; todo[j] = t; }
  S.busy = true; renderStatus(); say('test-msg', '測試抽籤中…');
  let ok = 0, stop = '';
  try {
    for (const m of todo) {
      const station = m.station || (randInt(2) ? '東湖宿舍站' : '其他站');
      const out = await claimSeat(m, station, true);
      if (out.draw) { upsertDraw(out.draw); ok++; renderMap(); renderResults(); }
      else if (out.existing) upsertDraw(out.existing);
      else { stop = out.error === 'full' ? '座位已經抽完。' : '無法繼續。'; break; }
    }
    say('test-msg', '已幫 ' + ok + ' 位抽籤。' + stop, stop ? 'err' : 'ok');
  } catch (err) {
    say('test-msg', errText(err), 'err');
  } finally {
    S.busy = false; renderStatus(); renderMap(); renderResults();
  }
}
function clearTest() {
  return guard('test-msg', async () => {
    const snap = await getDocs(collection(db, 'draws'));
    const refs = [];
    snap.docs.forEach(x => {
      const d = x.data();
      if (d.test) { refs.push(x.ref); if (d.seat) refs.push(doc(db, 'seats', d.seat)); }
    });
    await deleteDocs(refs);
    S.focusSeat = null; S.myId = null; $('result').hidden = true;
  }, '已清除測試結果。');
}
function changePw() {
  const v = $('new-pw').value;
  if (v.length < 6) { say('pw-msg', '密碼至少 6 個字。', 'err'); return; }
  const user = auth.currentUser;
  if (!user) { say('pw-msg', '請先登入管理員。', 'err'); return; }
  updatePassword(user, v).then(() => {
    $('new-pw').value = ''; say('pw-msg', '密碼已變更，下次登入請用新密碼。', 'ok');
  }, err => {
    const c = err && err.code;
    say('pw-msg', c === 'auth/requires-recent-login' ? '請先登出，重新登入後再變更密碼。'
      : c === 'auth/weak-password' ? '密碼太簡單，至少要 6 個字。' : '無法變更密碼，請稍後再試。', 'err');
  });
}

/* ---------- export ---------- */
async function saveBlob(blob, filename) {
  const file = new File([blob], filename, {type:blob.type});
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (mobile && navigator.canShare && navigator.canShare({files:[file]})) {
    try { await navigator.share({files:[file], title:filename}); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'saved';
}
function exportRows() {
  const rows = [['座位', '姓名', '上車站', '抽籤時間']];
  sortedDraws().forEach(d => rows.push([d.seat, d.name + (d.test ? '（測試）' : ''), d.station || '', fmtTime(d.ts)]));
  const ids = {}; S.draws.forEach(d => { ids[d.id] = true; });
  const cn = captainName();
  if (cn) rows.push(['1-4（車長）', cn, '', '']);
  S.roster.forEach(m => { if (!ids[m.id] && m.id !== S.captainId) rows.push(['', m.name, '', '未抽籤']); });
  return rows;
}
async function exportCsv() {
  const csv = exportRows().map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  try {
    await saveBlob(new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'}), '交通車座位抽籤結果.csv');
    say('tools-msg', '已匯出。', 'ok');
  } catch (e) { say('tools-msg', '無法下載，請改用「複製結果」。', 'err'); }
}
function copyResults() {
  const text = exportRows().map(r => r.join('\t')).join('\n');
  try {
    navigator.clipboard.writeText(text).then(() => say('tools-msg', '已複製，可以貼到 Excel。', 'ok'),
      () => say('tools-msg', '此環境無法複製，請改用「匯出 CSV」。', 'err'));
  } catch (e) { say('tools-msg', '此環境無法複製，請改用「匯出 CSV」。', 'err'); }
}

/* ---------- seat chart image ---------- */
async function makeImage() {
  const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
  const NUM = '"Barlow Condensed","Noto Sans TC",sans-serif';
  const sample = S.draws.map(d => d.name).join('') + captainName() + '交通車座位表駕駛員車門走道安全門自由座值班車長已抽可抽人東湖宿舍站其他站不開放抽籤更新時間、（）＝';
  try {
    await Promise.all([
      document.fonts.load('700 26px "Noto Sans TC"', sample),
      document.fonts.load('500 20px "Noto Sans TC"', sample),
      document.fonts.load('600 22px "Barlow Condensed"', '0123456789-')
    ]);
  } catch (e) {}

  const SC = 2, M = 50, P = 20, sw = 158, sh = 86, gx = 10, gy = 10, aw = 62, headH = 44;
  const busW = 4 * sw + aw + 4 * gx + 2 * P, W = busW + 2 * M;
  const titleH = 120, busY = titleH, rowsY = busY + P + headH + 12;
  const rowsH = 10 * (sh + gy) - gy;
  const freeY = rowsY + rowsH + gy + 10, freeH = 74;
  const busH = freeY + freeH + P - busY;
  const legendY = busY + busH + 36, H = legendY + 56;
  const x0 = M + P;
  const colX = {1:x0, 2:x0 + sw + gx};
  colX[4] = x0 + 2 * (sw + gx) + aw + gx; colX[5] = colX[4] + sw + gx;
  const rowY = r => rowsY + (r - 1) * (sh + gy);

  const c = document.createElement('canvas');
  c.width = W * SC; c.height = H * SC;
  const ctx = c.getContext('2d');
  ctx.scale(SC, SC);
  const INK = '#14231B', MUTED = '#56675D', LINE = '#9FB0A5', ACC = '#0B6E4F', ACCSOFT = '#D3EADF';

  const pc = document.createElement('canvas'); pc.width = 16; pc.height = 16;
  const pctx = pc.getContext('2d');
  pctx.fillStyle = '#EDF1EE'; pctx.fillRect(0, 0, 16, 16);
  pctx.strokeStyle = '#D5DDD8'; pctx.lineWidth = 4;
  pctx.beginPath(); pctx.moveTo(-4, 12); pctx.lineTo(12, -4); pctx.moveTo(4, 20); pctx.lineTo(20, 4); pctx.stroke();
  const hatch = ctx.createPattern(pc, 'repeat');

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function box(x, y, w, h, fill, stroke, dash, lw) {
    rr(x, y, w, h, 9); ctx.fillStyle = fill; ctx.fill();
    ctx.setLineDash(dash ? [6, 5] : []); ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.stroke(); ctx.setLineDash([]);
  }
  function fit(text, maxW, px, weight, family) {
    let size = px;
    ctx.font = weight + ' ' + size + 'px ' + family;
    while (size > 13 && ctx.measureText(text).width > maxW) { size -= 1; ctx.font = weight + ' ' + size + 'px ' + family; }
  }

  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);

  const drawers = S.roster.filter(m => m.id !== S.captainId);
  const dh = S.draws.filter(d => d.station === '東湖宿舍站').length;
  const ot = S.draws.filter(d => d.station === '其他站').length;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = INK; ctx.font = '700 38px ' + FONT; ctx.fillText('交通車座位表', M, 62);
  ctx.fillStyle = MUTED; ctx.font = '400 18px ' + FONT;
  ctx.fillText('已抽 ' + S.draws.length + (drawers.length ? '／' + drawers.length : '') + ' 人　東湖宿舍站 ' + dh + ' 人　其他站 ' + ot + ' 人', M, 94);
  ctx.textAlign = 'right'; ctx.font = '400 16px ' + FONT;
  let stamp = '';
  try { stamp = new Date().toLocaleString('zh-TW', {year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}); } catch (e) {}
  ctx.fillText('更新時間 ' + stamp, W - M, 62);

  box(M, busY, busW, busH, '#F7FAF8', LINE, false, 3);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = MUTED; ctx.font = '700 20px ' + FONT;
  ctx.fillText('駕駛員', (colX[1] + colX[2] + sw) / 2, busY + P + headH / 2 - 4);
  ctx.fillText('車門', (colX[4] + colX[5] + sw) / 2, busY + P + headH / 2 - 4);
  ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(colX[1], busY + P + headH - 4); ctx.lineTo(colX[2] + sw, busY + P + headH - 4);
  ctx.moveTo(colX[4], busY + P + headH - 4); ctx.lineTo(colX[5] + sw, busY + P + headH - 4);
  ctx.stroke(); ctx.setLineDash([]);

  const ax = x0 + 2 * (sw + gx);
  ctx.strokeStyle = '#C9D3CD'; ctx.setLineDash([5, 5]); ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(ax, rowsY); ctx.lineTo(ax, rowsY + rowsH);
  ctx.moveTo(ax + aw, rowsY); ctx.lineTo(ax + aw, rowsY + rowsH);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; ctx.font = '500 20px ' + FONT;
  const amid = rowsY + rowsH / 2;
  ctx.fillText('走', ax + aw / 2, amid - 16); ctx.fillText('道', ax + aw / 2, amid + 16);

  const bySeat = {}; S.draws.forEach(d => { bySeat[d.seat] = d; });
  SEATS.forEach(s => {
    if (s.id === '1-2') return;
    const pos = COLPOS[s.col], x = colX[pos], y = rowY(s.row);
    if (s.id === '1-4') {
      const cn = captainName(), w2 = 2 * sw + gx;
      if (cn) {
        box(x, y, w2, sh, ACCSOFT, ACC, false, 2);
        ctx.fillStyle = MUTED; ctx.font = '500 18px ' + FONT; ctx.fillText('車長', x + w2 / 2, y + sh / 2 - 16);
        fit(cn, w2 - 24, 26, '700', FONT); ctx.fillStyle = ACC; ctx.fillText(cn, x + w2 / 2, y + sh / 2 + 14);
      } else {
        box(x, y, w2, sh, hatch, LINE, true);
        ctx.fillStyle = MUTED; ctx.font = '500 22px ' + FONT; ctx.fillText('車長', x + w2 / 2, y + sh / 2);
      }
      return;
    }
    const d = bySeat[s.id];
    if (s.block) {
      box(x, y, sw, sh, hatch, LINE, true);
      ctx.textAlign = 'left'; ctx.fillStyle = MUTED; ctx.font = '400 16px ' + NUM; ctx.fillText(s.id, x + 10, y + 18);
      ctx.textAlign = 'center'; ctx.font = '500 22px ' + FONT; ctx.fillText(s.block, x + sw / 2, y + sh - 26);
    } else if (d) {
      box(x, y, sw, sh, ACCSOFT, ACC, false, 2);
      ctx.textAlign = 'left'; ctx.fillStyle = INK; ctx.font = '600 22px ' + NUM; ctx.fillText(s.id, x + 10, y + 20);
      if (d.station === '東湖宿舍站') { ctx.textAlign = 'right'; ctx.fillStyle = ACC; ctx.font = '700 16px ' + FONT; ctx.fillText('東', x + sw - 10, y + 20); }
      ctx.textAlign = 'center'; fit(d.name, sw - 20, 28, '700', FONT); ctx.fillStyle = ACC; ctx.fillText(d.name, x + sw / 2, y + sh - 26);
    } else {
      box(x, y, sw, sh, '#FFFFFF', LINE, false, 1.5);
      ctx.textAlign = 'center'; ctx.fillStyle = INK; ctx.font = '600 36px ' + NUM; ctx.fillText(s.id, x + sw / 2, y + sh / 2);
    }
  });

  const ex = colX[1], ey = rowY(9), ew = 2 * sw + gx, eh = 2 * sh + gy;
  box(ex, ey, ew, eh, hatch, LINE, true);
  ctx.textAlign = 'center'; ctx.fillStyle = MUTED; ctx.font = '700 24px ' + FONT; ctx.fillText('安全門', ex + ew / 2, ey + eh / 2);

  const fw = colX[5] + sw - colX[1];
  box(colX[1], freeY, fw, freeH, hatch, LINE, true);
  ctx.fillStyle = MUTED; ctx.font = '500 24px ' + FONT; ctx.fillText('自由座', colX[1] + fw / 2, freeY + freeH / 2);

  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '400 16px ' + FONT;
  let lx = M; const ly = legendY;
  [['free', '可抽'], ['taken', '已抽、車長（東＝東湖宿舍站）'], ['block', '不開放抽籤（值班、安全門、自由座）']].forEach(it => {
    const kind = it[0], label = it[1];
    box(lx, ly - 11, 22, 22, kind === 'free' ? '#FFFFFF' : kind === 'taken' ? ACCSOFT : hatch, kind === 'taken' ? ACC : LINE, kind === 'block', 1.5);
    ctx.fillStyle = MUTED; ctx.fillText(label, lx + 30, ly);
    lx += 30 + ctx.measureText(label).width + 26;
  });

  return new Promise((resolve, reject) => {
    c.toBlob(b => { b ? resolve(b) : reject(new Error('toBlob')); }, 'image/png');
  });
}
async function downloadImage() {
  say('img-msg', '產生圖片中…');
  let blob;
  try { blob = await makeImage(); }
  catch (e) { say('img-msg', '圖片產生失敗，請重新整理後再試。', 'err'); return; }
  try {
    const r = await saveBlob(blob, '交通車座位表.png');
    say('img-msg', r === 'cancel' ? '' : r === 'shared' ? '已開啟分享選單，可以選「儲存影像」。' : '已下載。', r === 'cancel' ? '' : 'ok');
  } catch (e) { say('img-msg', '無法下載圖片。', 'err'); }
}

/* ---------- live data ---------- */
function drawSig(list) { return JSON.stringify(list.map(d => [d.id, d.seat, d.name, d.station, !!d.test]).sort()); }
function applyState(d) {
  const st = d && d.status ? d.status : 'idle';
  if (st === S.status) return;
  S.status = st; renderStatus();
}
function applyRoster(d) {
  const m = Array.isArray(d && d.members) ? d.members : [];
  S.next = (d && d.next) || 1;
  const sig = JSON.stringify(m);
  if (sig === S.rosterSig) return;
  S.rosterSig = sig; S.roster = m;
  renderStatus(); renderResults(); fillRoster(false); syncStation(); fillCaptainSelect(); renderMap();
}
function applyCaptain(d) {
  const id = (d && d.memberId) || '', nm = (d && d.name) || '';
  const sig = id + '|' + nm;
  if (sig === S.capSig) return;
  S.capSig = sig; S.captainId = id; S.captainName = nm;
  renderMap(); renderResults(); renderStatus(); fillCaptainSelect();
}
function applyDraws(docs) {
  const list = docs.map(x => Object.assign({}, x.data(), {id:x.id}));
  if (drawSig(list) === drawSig(S.draws)) return;
  S.draws = list;
  if (!S.busy) renderMap();
  renderResults(); renderStatus();
}

/* ---------- boot ---------- */
function init() {
  renderMap(); renderStatus(); renderResults();
  try { const nm = localStorage.getItem('bus-draw-name'); if (nm) $('name-input').value = nm; } catch (e) {}

  $('draw-form').addEventListener('submit', onDraw);
  $('name-input').addEventListener('input', syncStation);
  $('admin-form').addEventListener('submit', onAdminLogin);
  $('btn-logout').addEventListener('click', () => { signOut(auth); });
  $('btn-open').addEventListener('click', () => setStatus('open'));
  $('btn-close').addEventListener('click', () => setStatus('closed'));
  $('btn-roster').addEventListener('click', saveRoster);
  $('roster-input').addEventListener('input', () => { S.rosterDirty = true; });
  $('btn-export').addEventListener('click', exportCsv);
  $('btn-copy').addEventListener('click', copyResults);
  $('btn-pw').addEventListener('click', changePw);
  $('btn-captain').addEventListener('click', saveCaptain);
  $('btn-image').addEventListener('click', downloadImage);
  armButton($('btn-reset'), '確定清空？再按一次', resetAll);
  armButton($('btn-test'), '確定？再按一次', testDrawAll);
  armButton($('btn-test-clear'), '確定清除？再按一次', clearTest);

  const onErr = e => notice('資料連線失敗：' + errText(e));
  onAuthStateChanged(auth, onAuth);
  onSnapshot(doc(db, 'config', 'state'), s => applyState(s.exists() ? s.data() : null), onErr);
  onSnapshot(doc(db, 'config', 'roster'), s => applyRoster(s.exists() ? s.data() : null), onErr);
  onSnapshot(doc(db, 'config', 'captain'), s => applyCaptain(s.exists() ? s.data() : null), onErr);
  onSnapshot(collection(db, 'draws'), q => { notice(''); applyDraws(q.docs); }, onErr);
}
init();
