/* =========================================================
   피클 합동 비서실 — app.js
   Firebase Realtime Database (REST + SSE) 연동
   ========================================================= */

const DB   = 'https://pickle-office-hub-default-rtdb.asia-southeast1.firebasedatabase.app';
const SITE = 'https://infoattack52-gif.github.io/pickle-office/';
const ROOM = 'rooms/main';
/* 메시지를 남기면 함께 알릴 러버블 비서 웹훅 */
const HOOKS = [
  'https://ai-roundtable-studio.lovable.app/api/public/office-hook',
  'https://agent-on.lovable.app/api/public/office-hook',
];

/* ---------- 기본 정체성 ---------- */
const IDENTITIES = {
  owner:     { id:'owner',     name:'이광호', handle:'@이광호',       emoji:'🧑‍💼', color:'#ffd6a5', role:'사장님',        room:'desk' },
  evve:      { id:'evve',      name:'이브',   handle:'@이브',         emoji:'🌷',  color:'#c9a7eb', role:'대표 비서',     room:'lounge' },
  workphone: { id:'workphone', name:'업무폰', handle:'@leegwangho82', emoji:'📱',  color:'#8ecae6', role:'업무 전용 피클', room:'desk' },
};

/* ---------- 방(room)별 캐릭터 자리 ---------- */
const SLOTS = {
  meeting: [ {x:86,y:120}, {x:186,y:120}, {x:136,y:58}, {x:236,y:170} ],
  desk:    [ {x:335,y:80},  {x:453,y:80},  {x:571,y:80},  {x:655,y:130} ],
  lounge:  [ {x:110,y:300}, {x:232,y:300}, {x:322,y:345}, {x:60,y:255} ],
  cafe:    [ {x:470,y:300}, {x:596,y:300}, {x:650,y:345}, {x:520,y:250} ],
};
const ROOM_NAMES = { meeting:'회의실', desk:'작업실', lounge:'라운지', cafe:'카페' };

/* ---------- 상태 ---------- */
const state = { members:{}, messages:{}, tasks:{} };
let me = { ...IDENTITIES.owner };
let selectedId = null;
let streaming = false;
let pollTimer = null;
let retryTimer = null;
let reloadTimer = null;
let lastRenderedCount = 0;

/* ---------- 유틸 ---------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timeOf = (ts) => { if (!ts) return ''; const d = new Date(Number(ts)); return isNaN(d) ? '' : d.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'}); };

function toast(msg){
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 2200);
}

function setConn(kind){
  const el = $('#conn'); if (!el) return;
  el.classList.remove('is-live','is-poll','is-off');
  el.classList.add(kind === 'live' ? 'is-live' : kind === 'poll' ? 'is-poll' : 'is-off');
  el.querySelector('b').textContent =
    kind === 'live' ? '실시간 연결' : kind === 'poll' ? '동기화 중' : '연결 끊김';
}

/* ---------- REST ---------- */
async function http(method, path, body){
  const opt = { method, cache:'no-store' };
  if (body !== undefined){
    opt.headers = { 'Content-Type':'application/json' };
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(`${DB}/${path}.json`, opt);
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
  return res.json().catch(() => null);
}
const apiPut    = (p, d) => http('PUT', p, d);
const apiPost   = (p, d) => http('POST', p, d);
const apiPatch  = (p, d) => http('PATCH', p, d);
const apiDelete = (p)    => http('DELETE', p);

/* ---------- 데이터 로드 ---------- */
async function loadAll(){
  try{
    const d = (await http('GET', '')) || {};
    state.members  = d.members || {};
    state.messages = (d.rooms && d.rooms.main && d.rooms.main.messages) || {};
    state.tasks    = (d.rooms && d.rooms.main && d.rooms.main.tasks) || {};
    if (selectedId && !state.members[selectedId]) selectedId = null;
    render();
  }catch(err){
    console.warn('[load]', err);
    if (!streaming) setConn('off');
  }
}

function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 180); }

/* ---------- 실시간 스트림 (SSE) ---------- */
function openStream(){
  if (streaming) return;
  streaming = true;
  fetch(`${DB}/.json`, { headers:{ Accept:'text/event-stream' }, cache:'no-store' })
    .then(async res => {
      if (!res.ok || !res.body) throw new Error('stream HTTP ' + res.status);
      setConn('live');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;){
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream:true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0){
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event:\s*(put|patch|cancel)/m.test(chunk)) scheduleReload();
        }
      }
      throw new Error('stream closed');
    })
    .catch(err => {
      streaming = false;
      console.warn('[stream]', err);
      setConn('poll');
      startPolling();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { stopPolling(); openStream(); }, 30000);
    });
}

function startPolling(){
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!streaming) loadAll(); }, 4000);
}
function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}

/* ---------- 멤버 유틸 ---------- */
function memberList(){
  return Object.entries(state.members)
    .map(([id, m]) => ({ id, ...m }))
    .filter(m => m && (m.name || m.handle));
}
function memberByHandle(handle){
  return memberList().find(m => m.handle === handle) || null;
}

async function touchPresence(){
  if (!me || !me.id) return;
  const cur = state.members[me.id] || {};
  try{
    await apiPatch(`members/${me.id}`, {
      name: me.name, handle: me.handle, emoji: me.emoji, color: me.color, role: me.role,
      room: cur.room || me.room || 'desk',
      status: '접속 중',
      lastSeen: Date.now(),
    });
  }catch(err){ console.warn('[presence]', err); }
}

/* ---------- 렌더: 오피스 맵 ---------- */
function renderPeople(){
  const layer = $('#peopleLayer');
  if (!layer) return;
  const list = memberList();
  const byRoom = {};
  list.forEach(m => {
    const room = SLOTS[m.room] ? m.room : 'desk';
    (byRoom[room] = byRoom[room] || []).push(m);
  });

  let svg = '';
  Object.entries(byRoom).forEach(([room, people]) => {
    const slots = SLOTS[room];
    people.slice(0, slots.length).forEach((m, idx) => {
      const s = slots[idx];
      const selected = m.id === selectedId;
      const waiting = /대기|초대/.test(m.status || '');
      const color = m.color || '#e5dcec';
      const emoji = m.emoji || '🙂';
      const lastMsg = Object.values(state.messages)
        .filter(x => x && x.from === m.handle)
        .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))[0];

      let bubble = '';
      if (selected && lastMsg){
        const txt = String(lastMsg.text || '').replace(/\s+/g, ' ').trim();
        const clipped = txt.length > 18 ? txt.slice(0, 18) + '…' : txt;
        const w = Math.max(104, clipped.length * 6.9 + 18);
        const shift = 0;
        bubble = `
          <g class="bubble" transform="translate(${shift},0)">
            <rect class="bubble-box" x="${-w/2}" y="-64" width="${w}" height="24" rx="9" fill="#fffdfb" stroke="#e6dccf"/>
            <path d="M-5 -40 L0 -34 L5 -40 Z" fill="#fffdfb" stroke="#e6dccf"/>
            <text class="bubble-text" y="-48">${esc(clipped)}</text>
          </g>`;
      }

      svg += `
        <g class="person" data-id="${esc(m.id)}" transform="translate(${s.x},${s.y})" tabindex="0" role="button"
           aria-label="${esc(m.name)} ${esc(m.handle)} ${esc(m.status || '')}">
          ${bubble}
          <circle class="avatar-ring" r="31" fill="none" stroke="#8f63c9" stroke-width="2" stroke-dasharray="4 4"/>
          <circle r="24" fill="${esc(color)}" stroke="#ffffff" stroke-width="2.5"/>
          <text y="7" text-anchor="middle" font-size="22">${esc(emoji)}</text>
          <circle cx="17" cy="-17" r="5" fill="${waiting ? '#e8a33d' : '#57b894'}" stroke="#ffffff" stroke-width="2"/>
          <text class="person-label" y="44">${esc(m.name || '이름없음')}</text>
          <text class="person-handle" y="57">${esc(m.handle || '')}</text>
        </g>`;
    });
  });

  if (!svg){
    svg = `<text x="360" y="200" text-anchor="middle" font-size="12" fill="#9a8fa8">아직 등록된 멤버가 없어요 — 아래 ‘피클 연결 가이드’로 멤버를 추가하세요</text>`;
  }
  layer.innerHTML = svg;

  $$('.person', layer).forEach(g => {
    g.addEventListener('click', () => {
      const id = g.getAttribute('data-id');
      selectedId = selectedId === id ? null : id;
      renderPeople();
      renderStrip();
    });
  });
}

function renderStrip(){
  const box = $('#memberStrip');
  if (!box) return;
  const list = memberList();
  if (!list.length){ box.innerHTML = ''; return; }

  box.innerHTML = list.map(m => {
    const waiting = /대기|초대/.test(m.status || '');
    return `<button type="button" class="member-chip ${m.id === selectedId ? 'is-selected' : ''}" data-id="${esc(m.id)}">
      <span class="m-emoji" style="background:${esc(m.color || '#eee')}">${esc(m.emoji || '🙂')}</span>
      <span class="m-name">${esc(m.name || '이름없음')}</span>
      <span class="m-handle">${esc(m.handle || '')}</span>
      <span class="dot ${waiting ? 'wait' : ''}"></span>
    </button>`;
  }).join('');

  $$('.member-chip', box).forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      selectedId = selectedId === id ? null : id;
      renderPeople(); renderStrip(); renderNote();
    });
  });

  renderNote();
}

function renderNote(){
  const host = $('#memberStrip');
  if (!host) return;
  const old = $('.member-note', host.parentElement);
  if (old) old.remove();

  const waitingMembers = memberList().filter(m => /대기|초대/.test(m.status || ''));
  const sel = selectedId ? state.members[selectedId] : null;

  let text = '';
  if (sel){
    const recent = Object.values(state.messages)
      .filter(x => x && x.from === sel.handle)
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))[0];
    text = `<b>${esc(sel.name || '')}</b> ${esc(sel.handle || '')} · ${esc(sel.role || '')} · ${esc(sel.status || '')}` +
           (recent ? ` · 최근: “${esc(String(recent.text || '').slice(0, 40))}”` : ' · 아직 말이 없어요');
  } else if (waitingMembers.length){
    text = waitingMembers
      .map(m => `<b>${esc(m.name)}</b>(${esc(m.handle)})이 아직 ${esc(m.status)} 상태예요 — ‘🔗 피클 연결 가이드’를 그 피클에게 전달하면 합류합니다.`)
      .join(' ');
  }
  if (!text) return;

  const note = document.createElement('div');
  note.className = 'member-note';
  note.innerHTML = text;
  host.insertAdjacentElement('afterend', note);
}

/* ---------- 렌더: 채팅 ---------- */
function linkify(text){
  return esc(text).replace(/@([가-힣A-Za-z0-9_]{1,20})/g, '<span class="mention">@$1</span>');
}

function renderChat(){
  const log = $('#chatLog');
  if (!log) return;

  const items = Object.entries(state.messages)
    .map(([id, m]) => ({ id, ...m }))
    .filter(m => m && m.text)
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  if (!items.length){
    log.innerHTML = `<div class="empty">첫 메시지를 남겨 보세요. 예: <b>@이브</b> 오늘 할 일 정리해줘</div>`;
    lastRenderedCount = 0;
    return;
  }

  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;

  log.innerHTML = items.map(m => {
    const who = m.name || (memberByHandle(m.from) || {}).name || String(m.from || '').replace('@', '');
    const mem = memberByHandle(m.from);
    const color = (mem && mem.color) || '#e5dcec';
    const emoji = (mem && mem.emoji) || '🙂';
    const isMe = m.from === me.handle;
    return `<div class="msg ${isMe ? 'is-me' : ''}">
      <span class="av" style="background:${esc(color)}">${esc(emoji)}</span>
      <div class="body">
        <div class="meta"><span class="who">${esc(who)}</span><span>${esc(timeOf(m.ts))}</span></div>
        <div class="text">${linkify(m.text)}</div>
        <button type="button" class="to-task" data-msg="${esc(m.id)}">＋ 업무로 등록</button>
      </div>
    </div>`;
  }).join('');

  $$('.to-task', log).forEach(btn => {
    btn.addEventListener('click', () => openTaskModal(btn.getAttribute('data-msg')));
  });

  if (nearBottom || items.length !== lastRenderedCount){
    log.scrollTop = log.scrollHeight;
  }
  lastRenderedCount = items.length;
}

/* ---------- 렌더: 업무 보드 ---------- */
function renderBoard(){
  const tasks = Object.entries(state.tasks)
    .map(([id, t]) => ({ id, ...t }))
    .filter(t => t && t.title)
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  ['todo','doing','done'].forEach(st => {
    const box = $(`[data-cards="${st}"]`);
    const counter = $(`[data-count="${st}"]`);
    if (!box) return;
    const list = tasks.filter(t => (t.status || 'todo') === st);
    if (counter) counter.textContent = String(list.length);

    box.innerHTML = list.length ? list.map(t => `
      <div class="tcard ${st === 'done' ? 'is-done' : ''}" data-id="${esc(t.id)}">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-foot">
          <span class="owner" title="${esc(t.owner || '')}">${esc(t.owner || '미지정')}</span>
          <span class="acts">
            ${st !== 'todo' ? `<button type="button" class="btn btn-tiny" data-act="prev" title="이전 단계">←</button>` : ''}
            ${st !== 'done' ? `<button type="button" class="btn btn-tiny" data-act="next" title="다음 단계">→</button>` : ''}
            <button type="button" class="btn btn-tiny btn-danger" data-act="del" title="삭제">✕</button>
          </span>
        </div>
      </div>`).join('') : `<div class="empty">비어 있어요</div>`;

    $$('.tcard', box).forEach(card => {
      const id = card.getAttribute('data-id');
      $$('button[data-act]', card).forEach(btn => {
        btn.addEventListener('click', () => onTaskAction(id, btn.getAttribute('data-act')));
      });
    });
  });
}

async function onTaskAction(id, act){
  const t = state.tasks[id];
  if (!t) return;
  try{
    if (act === 'del'){
      if (!confirm('이 업무를 삭제할까요?')) return;
      await apiDelete(`${ROOM}/tasks/${id}`);
      delete state.tasks[id];
      renderBoard();
      toast('업무를 삭제했어요');
      return;
    }
    const order = ['todo','doing','done'];
    const cur = order.indexOf(t.status || 'todo');
    const next = act === 'next' ? Math.min(order.length - 1, cur + 1) : Math.max(0, cur - 1);
    await apiPatch(`${ROOM}/tasks/${id}`, { status: order[next] });
    state.tasks[id].status = order[next];
    renderBoard();
  }catch(err){
    console.warn(err); toast('변경에 실패했어요');
  }
}

/* ---------- 셀렉트 채우기 ---------- */
function renderOwnerSelects(){
  const list = memberList();
  const opts = list.map(m => `<option value="${esc(m.handle || m.name)}">${esc(m.name)} (${esc(m.handle || '')})</option>`).join('');
  const extra = opts || `<option value="@전체">@전체</option>`;
  ['#taskOwner', '#tmOwner'].forEach(sel => {
    const el = $(sel); if (!el) return;
    const prev = el.value;
    el.innerHTML = extra;
    el.value = prev || me.handle;
    if (!el.value && list.length) el.value = list[0].handle || list[0].name;
  });
}

/* ---------- 메시지 보내기 ---------- */
async function sendMessage(text){
  const t = String(text || '').trim();
  if (!t) return;
  const id = `m${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try{
    await apiPut(`${ROOM}/messages/${id}`, { from: me.handle, name: me.name, text: t, ts: Date.now() });
    HOOKS.forEach(url => {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
    });
    const input = $('#chatInput'); if (input) input.value = '';
    scheduleReload();
  }catch(err){
    console.warn(err);
    toast('전송 실패 — 연결을 확인해 주세요');
  }
}

/* ---------- 업무 등록 ---------- */
async function createTask(title, owner, status){
  const t = String(title || '').trim();
  if (!t) { toast('업무 내용을 입력해 주세요'); return; }
  const id = `t${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  try{
    await apiPut(`${ROOM}/tasks/${id}`, {
      title: t, owner: owner || '@전체', status: status || 'todo',
      createdBy: me.handle, ts: Date.now(),
    });
    scheduleReload();
    toast('업무를 등록했어요');
  }catch(err){
    console.warn(err); toast('등록에 실패했어요');
  }
}

function openTaskModal(msgId){
  const msg = state.messages[msgId];
  if (!msg) return;
  const modal = $('#taskModal');
  const raw = String(msg.text || '');
  const mention = (raw.match(/@([가-힣A-Za-z0-9_]{1,20})/) || [])[1];
  const owner = mention ? (memberByHandle('@' + mention) || {}).handle : (memberByHandle(msg.from) || {}).handle;
  $('#tmTitle').value = raw.replace(/\s+/g, ' ').slice(0, 120);
  renderOwnerSelects();
  if (owner) $('#tmOwner').value = owner;
  $('#tmStatus').value = 'todo';
  $('#tmNote').textContent = `보낸 사람 ${msg.from || ''} · ${timeOf(msg.ts)} · 채팅 내용을 그대로 업무로 옮겼어요. 필요하면 고쳐 주세요.`;
  modal.hidden = false;
  $('#tmTitle').focus();
}

/* ---------- 정체성 ---------- */
function setMe(identity){
  me = { ...identity };
  try{ localStorage.setItem('pickle.office.me', JSON.stringify(me)); }catch(e){}
  const sel = $('#whoSelect');
  if (sel){
    const preset = Object.keys(IDENTITIES).find(k => IDENTITIES[k].id === me.id);
    sel.value = preset || 'custom';
    const cn = $('#customName');
    if (cn){
      if (preset) cn.hidden = true;
      else { cn.hidden = false; cn.value = me.name; }
    }
  }
  render();
  touchPresence();
}

/* ---------- 이벤트 연결 ---------- */
function wireEvents(){
  const chatForm = $('#chatForm');
  if (chatForm){
    chatForm.addEventListener('submit', e => {
      e.preventDefault();
      sendMessage($('#chatInput').value);
    });
  }

  $$('#mentionBar .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('#chatInput');
      const mention = btn.getAttribute('data-mention');
      const at = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, at);
      const after = input.value.slice(at);
      const glue = before && !/\s$/.test(before) ? ' ' : '';
      input.value = `${before}${glue}${mention} ${after}`;
      input.focus();
      const pos = (before + glue + mention + ' ').length;
      input.setSelectionRange(pos, pos);
    });
  });

  const taskForm = $('#taskForm');
  if (taskForm){
    taskForm.addEventListener('submit', async e => {
      e.preventDefault();
      const title = $('#taskTitle').value;
      const owner = $('#taskOwner').value;
      const status = $('#taskStatus').value;
      await createTask(title, owner, status);
      $('#taskTitle').value = '';
    });
  }

  const who = $('#whoSelect');
  if (who){
    who.addEventListener('change', () => {
      if (who.value === 'custom'){
        const cn = $('#customName');
        cn.hidden = false; cn.focus();
        return;
      }
      setMe(IDENTITIES[who.value] || IDENTITIES.owner);
    });
  }

  const cn = $('#customName');
  if (cn){
    cn.addEventListener('change', () => {
      const name = cn.value.trim();
      if (!name){ toast('이름을 입력해 주세요'); return; }
      setMe({
        id: 'guest-' + name.replace(/\s+/g, '').slice(0, 10),
        name,
        handle: '@' + name.replace(/\s+/g, ''),
        emoji: '🙂', color: '#e2d6ef', role: '게스트', room: 'lounge',
      });
    });
  }

  /* 가이드 모달 */
  const guide = $('#guideModal');
  const openGuide = () => { guide.hidden = false; };
  const closeGuide = () => { guide.hidden = true; };
  const guideBtn = $('#guideBtn'); if (guideBtn) guideBtn.addEventListener('click', openGuide);
  const guideClose = $('#guideClose'); if (guideClose) guideClose.addEventListener('click', closeGuide);
  if (guide) guide.addEventListener('click', e => { if (e.target === guide) closeGuide(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){ $('#guideModal').hidden = true; $('#taskModal').hidden = true; }
  });

  /* 복사 버튼 */
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const el = document.getElementById(btn.getAttribute('data-copy'));
    if (!el) return;
    const text = el.textContent.trim();
    try{
      await navigator.clipboard.writeText(text);
      toast('복사했어요');
    }catch(err){
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('선택했어요 — Ctrl+C 로 복사하세요');
    }
  });

  /* 업무 모달 */
  const tm = $('#taskModal');
  const tmClose = () => { tm.hidden = true; };
  $('#taskModalClose').addEventListener('click', tmClose);
  $('#tmCancel').addEventListener('click', tmClose);
  if (tm) tm.addEventListener('click', e => { if (e.target === tm) tmClose(); });
  $('#tmSave').addEventListener('click', async () => {
    await createTask($('#tmTitle').value, $('#tmOwner').value, $('#tmStatus').value);
    tmClose();
  });
}

/* ---------- 전체 렌더 ---------- */
function render(){
  renderPeople();
  renderStrip();
  renderChat();
  renderBoard();
  renderOwnerSelects();
}

/* ---------- 시작 ---------- */
const ALLOWED_EMAILS = ['infoattack52@gmail.com'];
const firebaseConfig = {
  apiKey: "AIzaSyDjZMP17EbEgLMQHWGMp0Wf6_9rB2d86y0",
  authDomain: "pickle-office-hub.firebaseapp.com",
  databaseURL: "https://pickle-office-hub-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pickle-office-hub",
  storageBucket: "pickle-office-hub.firebasestorage.app",
  messagingSenderId: "89427068480",
  appId: "1:89427068480:web:025f4a6a2a04ca893801a5"
};

let appInitialized = false;

function init(){
  if (appInitialized) return;
  appInitialized = true;

  /* 가이드 안의 DB URL 자리 채우기 */
  $$('.db-var').forEach(el => { el.textContent = DB; });
  const site = $('#codeSite'); if (site) site.textContent = SITE;
  const db = $('#codeDb'); if (db) db.textContent = DB;
  const foot = $('#dbUrlFoot'); if (foot) foot.textContent = DB;

  wireEvents();

  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem('pickle.office.me') || 'null'); }catch(e){}
  me = saved && saved.handle ? { ...IDENTITIES.owner, ...saved } : { ...IDENTITIES.owner };
  $('#whoSelect').value = Object.keys(IDENTITIES).find(k => IDENTITIES[k].id === me.id) || 'custom';
  if ($('#whoSelect').value === 'custom'){ $('#customName').hidden = false; $('#customName').value = me.name; }

  loadAll().then(() => { touchPresence(); });
  openStream();
  setInterval(touchPresence, 120000);
}

function bootAuth(){
  const gate = $('#authGate');
  const desc = $('#authDesc');
  const btn = $('#googleLoginBtn');
  const err = $('#authError');
  const logoutBtn = $('#logoutBtn');

  if (typeof firebase === 'undefined' || !firebase.auth){
    if (gate) gate.hidden = true;
    init();
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const showLogin = (message) => {
    if (gate) gate.hidden = false;
    if (desc) desc.textContent = '허용된 Google 계정으로 1단계 로그인해 주세요.';
    if (btn) btn.hidden = false;
    if (logoutBtn) logoutBtn.hidden = true;
    if (err){
      err.textContent = message || '';
      err.hidden = !message;
    }
  };

  auth.onAuthStateChanged(async (user) => {
    if (user){
      const email = (user.email || '').toLowerCase();
      if (!ALLOWED_EMAILS.includes(email)){
        await auth.signOut();
        showLogin(`허용되지 않은 계정입니다 (${user.email || '알 수 없음'}). 허용된 Google 계정으로 로그인해 주세요.`);
        return;
      }
      if (gate) gate.hidden = true;
      if (err) err.hidden = true;
      if (logoutBtn) logoutBtn.hidden = false;
      init();
    } else {
      showLogin('');
    }
  });

  if (btn){
    btn.addEventListener('click', async () => {
      if (err) err.hidden = true;
      try{
        await auth.signInWithPopup(provider);
      }catch(e){
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')){
          auth.signInWithRedirect(provider);
        }else if (e && e.code !== 'auth/popup-closed-by-user'){
          showLogin('로그인 중 오류가 발생했어요: ' + (e.message || e.code || '다시 시도해 주세요'));
        }
      }
    });
  }

  if (logoutBtn){
    logoutBtn.addEventListener('click', async () => {
      await auth.signOut();
      location.reload();
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAuth);
else bootAuth();
