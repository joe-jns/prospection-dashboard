// ── Dataset management ───────────────────────────────────────────────────────
const DS_META_KEY   = 'igretec_ds_meta_v1';
const DS_DATA_PFX   = 'igretec_ds_data_';
const DS_STATE_PFX  = 'igretec_ds_state_';
const LEGACY_KEY    = 'igretec_prospection_v1'; // clé existante igretec

let dsMeta = {};          // { id: { name, isBuiltIn } }
let currentDsId = 'igretec';
let ACTIVE_COMPANIES = COMPANIES; // tableau actif — COMPANIES vient de data.js

function currentStorageKey() {
  return currentDsId === 'igretec' ? LEGACY_KEY : DS_STATE_PFX + currentDsId;
}
function loadDsMeta() {
  try { dsMeta = JSON.parse(localStorage.getItem(DS_META_KEY) || '{}'); } catch(e) { dsMeta = {}; }
  if (!dsMeta.igretec) dsMeta.igretec = { name: 'Dataset par défaut', isBuiltIn: true };
}
function saveDsMeta() { localStorage.setItem(DS_META_KEY, JSON.stringify(dsMeta)); }
// ─────────────────────────────────────────────────────────────────────────────

let state = {};
let sortCol = 'nom';
let sortDir = 1;
let filteredData = [];
let activeCardFilter = '';
let _csvParsed = null;
let focusMode  = false;
let focusIndex = 0;
let lastModifiedKey = null;
let _confettiDone = false;
const PAGE_SIZE = 50;
let currentPage = 1;
function loadLastModified() {
  lastModifiedKey = localStorage.getItem('last_modified_' + currentDsId) || null;
}
function saveLastModified(key) {
  lastModifiedKey = key;
  localStorage.setItem('last_modified_' + currentDsId, key);
}

const BADGE_CONFIG = {
  pending:    { label: 'À traiter',       dot: true },
  done:       { label: 'Vu',              dot: true },
  interested: { label: 'Intéressant',     dot: true },
  skip:       { label: 'Pas pertinent',   dot: true },
};

function getKey(c) { return c.tva || c.nom; }
function loadState() { try { state = JSON.parse(localStorage.getItem(currentStorageKey()) || '{}'); } catch(e) { state = {}; } }

// Firebase n'accepte pas . # $ / [ ] dans les clés → on encode/décode
function fbEncode(k) { return k.replace(/\./g,'__d__').replace(/#/g,'__h__').replace(/\$/g,'__s__').replace(/\//g,'__sl__').replace(/\[/g,'__lb__').replace(/\]/g,'__rb__'); }
function fbDecode(k) { return k.replace(/__d__/g,'.').replace(/__h__/g,'#').replace(/__s__/g,'$').replace(/__sl__/g,'/').replace(/__lb__/g,'[').replace(/__rb__/g,']'); }
function stateToFb(s) { const o={}; for(const [k,v] of Object.entries(s)) o[fbEncode(k)]=v; return o; }
function fbToState(o) { const s={}; for(const [k,v] of Object.entries(o)) s[fbDecode(k)]=v; return s; }

// ── Firebase Realtime Sync ──────────────────────────────────────────────────
const _fbConfig = {
  apiKey: "AIzaSyBg6jOokg-mlQot4rMRakbB2YqWVzqr-kA",
  authDomain: "prospection-dashboard.firebaseapp.com",
  databaseURL: "https://prospection-dashboard-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "prospection-dashboard",
  storageBucket: "prospection-dashboard.firebasestorage.app",
  messagingSenderId: "686505352594",
  appId: "1:686505352594:web:1c40bf7db740934327754b"
};
firebase.initializeApp(_fbConfig);
const _db = firebase.database();

let _fbRef         = null;
let _fbListener    = null;
let _fbInitDone    = false;
let _lastOwnPush   = 0;

function saveState(key) {
  if (key) saveLastModified(key);
  localStorage.setItem(currentStorageKey(), JSON.stringify(state));
  _lastOwnPush = Date.now();
  if (_fbRef) _fbRef.set(stateToFb(state)).catch(e => console.warn('Firebase save:', e));
  updateSyncDot('saving');
  updateResumeBtn();
  // Refresh stats page if open
  const sp = document.getElementById('stats-page');
  if (sp && sp.style.display !== 'none') renderStatsPage();
}

// Trouve le premier index non traité après le dernier traité dans filteredData
function findResumeIndex() {
  let lastProcessed = -1;
  for (let i = 0; i < filteredData.length; i++) {
    const s = state[getKey(filteredData[i])] || {};
    if (s.status && s.status !== 'pending') lastProcessed = i;
  }
  if (lastProcessed === -1) return 0;
  return Math.min(lastProcessed + 1, filteredData.length - 1);
}

function scrollToLast() {
  const idx = findResumeIndex();
  const c = filteredData[idx];
  if (!c) return;
  const targetPage = Math.floor(idx / PAGE_SIZE) + 1;
  if (currentPage !== targetPage) {
    currentPage = targetPage;
    renderTable();
    renderPagination();
  }
  setTimeout(() => {
    const row = document.querySelector(`tr[data-key="${CSS.escape(getKey(c))}"]`);
    if (!row) { showToast('Entreprise non visible avec les filtres actuels'); return; }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row-highlight');
    setTimeout(() => row.classList.remove('row-highlight'), 1800);
  }, 50);
}

function renderPagination() {
  const el = document.getElementById('pagination');
  if (!el) return;
  const total = Math.ceil(filteredData.length / PAGE_SIZE);
  if (total <= 1) { el.innerHTML = ''; return; }

  const pages = new Set([1, total]);
  for (let i = Math.max(2, currentPage - 2); i <= Math.min(total - 1, currentPage + 2); i++) pages.add(i);
  const sorted = [...pages].sort((a, b) => a - b);

  let html = `<button class="page-btn page-nav" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn page-nav" onclick="goToPage(${currentPage + 1})" ${currentPage === total ? 'disabled' : ''}>›</button>`;
  el.innerHTML = html;
}

function goToPage(p) {
  const total = Math.ceil(filteredData.length / PAGE_SIZE);
  currentPage = Math.max(1, Math.min(total, p));
  renderTable();
  renderPagination();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateResumeBtn() {
  const btn = document.getElementById('btn-resume');
  if (!btn) return;
  const hasAny = Object.values(state).some(s => s && s.status && s.status !== 'pending' && !s.deleted);
  btn.style.display = hasAny ? 'inline-flex' : 'none';
}

function setupFirebaseSync(dsId) {
  // Détache l'ancien listener
  if (_fbRef && _fbListener) _fbRef.off('value', _fbListener);
  _fbInitDone = false;
  _fbRef = _db.ref('datasets/' + dsId + '/state');

  _fbListener = snapshot => {
    const remote = fbToState(snapshot.val() || {});
    if (!_fbInitDone) {
      _fbInitDone = true;
      const merged = mergeStates(state, remote);
      state = merged;
      localStorage.setItem(currentStorageKey(), JSON.stringify(state));
      _lastOwnPush = Date.now();
      _fbRef.set(stateToFb(state)).catch(() => {});
      applyFilters(true);
      updateSyncDot('ok');
      return;
    }
    const isOwnEcho = (Date.now() - _lastOwnPush) < 3000;
    const merged = mergeStates(state, remote);
    const changed = JSON.stringify(merged) !== JSON.stringify(state);
    if (changed) {
      state = merged;
      localStorage.setItem(currentStorageKey(), JSON.stringify(state));
      applyFilters(true);
      if (!isOwnEcho) showToast('Ton ami a mis à jour des entreprises');
    }
    updateSyncDot('ok');
  };
  _fbRef.on('value', _fbListener, () => updateSyncDot('err'));
}

function syncSharedDatasets() {
  // Écoute tous les datasets Firebase — même nœud que le state (règles déjà permissives)
  _db.ref('datasets').on('child_added', snap => {
    const id = snap.key;
    if (!id || id === 'igretec' || dsMeta[id]) return; // déjà connu
    const val = snap.val() || {};
    if (!val.meta || !val.meta.name || !val.data) return;
    dsMeta[id] = { name: val.meta.name, isBuiltIn: false };
    localStorage.setItem(DS_DATA_PFX + id, JSON.stringify(val.data));
    saveDsMeta();
    populateDsSelect();
    showToast(`Nouveau dataset reçu : "${val.meta.name}"`);
  });

  _db.ref('datasets').on('child_removed', snap => {
    const id = snap.key;
    if (!id || id === 'igretec' || !dsMeta[id] || dsMeta[id].isBuiltIn) return;
    const dsName = dsMeta[id].name;
    delete dsMeta[id];
    saveDsMeta();
    localStorage.removeItem(DS_DATA_PFX + id);
    localStorage.removeItem(DS_STATE_PFX + id);
    localStorage.removeItem('last_modified_' + id);
    if (currentDsId === id) {
      currentDsId = 'igretec';
      ACTIVE_COMPANIES = COMPANIES;
      state = {};
      loadState();
      setupFirebaseSync('igretec');
      activeCardFilter = '';
      document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
    }
    populateDsSelect();
    populatePaeFilter();
    applyFilters();
    showToast(`Dataset "${dsName}" supprimé par ton ami`);
  });
}

function updateSyncDot(status) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.dataset.tip = status === 'ok' ? 'Synchronisé avec Firebase' : status === 'saving' ? 'Sauvegarde en cours…' : 'Erreur de connexion Firebase';
  dot.style.background = status === 'ok' ? '#22c55e' : status === 'saving' ? '#f59e0b' : '#ef4444';
}
// ────────────────────────────────────────────────────────────────────────────

// ── Presence temps réel ───────────────────────────────────────────────────────
const MY_UID = (() => {
  let uid = localStorage.getItem('prospection_uid');
  if (!uid) { uid = 'u_' + Math.random().toString(36).slice(2, 9); localStorage.setItem('prospection_uid', uid); }
  return uid;
})();

let MY_NAME = localStorage.getItem('prospection_name') || '';
let _usersMap = {}; // uid → name

const CURSOR_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];
function uidColor(uid) { let h=0; for(const c of uid) h=(h*31+c.charCodeAt(0))>>>0; return CURSOR_COLORS[h % CURSOR_COLORS.length]; }

function setupPresence() {
  const myRef = _db.ref('presence/' + MY_UID);
  myRef.set({ t: Date.now() });
  setInterval(() => myRef.update({ t: Date.now() }), 25000);
  window.addEventListener('beforeunload', () => myRef.remove());

  // Envoi position curseur (throttlé 80ms)
  let _lastCursor = 0;
  document.addEventListener('mousemove', e => {
    const now = Date.now();
    if (now - _lastCursor < 80) return;
    _lastCursor = now;
    myRef.update({ cursor: { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, t: now });
  });

  _db.ref('presence').on('value', snap => {
    const data = snap.val() || {};
    const now = Date.now();
    const others = Object.entries(data).filter(([uid, v]) => uid !== MY_UID && v && (now - v.t) < 60000);
    const online = others.length > 0;

    // Indicateur présence
    const dot = document.getElementById('presence-indicator');
    if (dot) {
      dot.className = 'presence-dot ' + (online ? 'presence-online' : 'presence-offline');
      dot.dataset.tip = online ? 'Ton ami est en ligne' : 'Ami hors ligne';
    }

    // Curseurs distants
    const container = document.getElementById('remote-cursors');
    if (!container) return;
    container.innerHTML = '';
    others.forEach(([uid, v]) => {
      if (!v.cursor) return;
      const color = uidColor(uid);
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.style.cssText = `left:${v.cursor.x * 100}%;top:${v.cursor.y * 100}%`;
      el.innerHTML = `
        <svg width="16" height="20" viewBox="0 0 16 20" fill="${color}" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">
          <path d="M0 0 L0 16 L4 12 L7 19 L9 18 L6 11 L11 11 Z"/>
        </svg>
        <span class="remote-cursor-label" style="background:${color}">Ami</span>`;
      container.appendChild(el);
    });
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// Fusionne deux états : garde le plus "avancé" pour chaque entreprise
function mergeStates(base, incoming) {
  const priority = { interested: 3, skip: 2, done: 1, pending: 0 };
  const merged = Object.assign({}, base);
  for (const key of Object.keys(incoming)) {
    const a = base[key] || {};
    const b = incoming[key] || {};
    const aP = priority[a.status] ?? -1;
    const bP = priority[b.status] ?? -1;
    const winner = bP > aP ? b : a;
    const enrich    = b.enrich    || a.enrich    || undefined;
    const enrich_by = b.enrich_by || a.enrich_by || undefined;
    merged[key] = {
      status: winner.status || 'pending',
      note: (b.note && (!a.note || b.note.length > a.note.length)) ? b.note : (a.note || ''),
    };
    if (winner.by)  merged[key].by       = winner.by;
    if (enrich)     merged[key].enrich    = enrich;
    if (enrich_by)  merged[key].enrich_by = enrich_by;
    if ((!merged[key].status || merged[key].status === 'pending') && !merged[key].note && !merged[key].enrich) delete merged[key];
  }
  return merged;
}

// Export de l'état complet en state.json → à commiter sur GitHub
function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'state.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// Import depuis un fichier state.json (fusion avec localStorage)
function importState(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const incoming = JSON.parse(e.target.result);
      const before = Object.keys(state).length;
      state = mergeStates(state, incoming);
      saveState();
      applyFilters();
      const after = Object.keys(state).length;
      showToast(`Fusion OK — ${after} entrées (avant: ${before})`);
    } catch(err) {
      showToast('Erreur : fichier JSON invalide');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:10px 20px;border-radius:10px;font-size:0.82rem;font-weight:600;z-index:9999;opacity:0;transition:opacity 0.2s;pointer-events:none;font-family:var(--font-ui)';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

loadDsMeta();
loadState();
loadLastModified();
setupFirebaseSync(currentDsId);
setupPresence();
syncSharedDatasets();
setupUsersSync();
populateDsSelect();
populatePaeFilter();
applyFilters();
updateResumeBtn();
if (!MY_NAME) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showProfileSetup);
  } else {
    showProfileSetup();
  }
}


function populatePaeFilter() {
  const sel = document.getElementById('filter-pae');
  if (!sel) return;
  sel.innerHTML = '<option value="">Tous les groupes</option>';
  const paes = [...new Set(ACTIVE_COMPANIES.map(c => c.nom_du_pae).filter(Boolean))].sort();
  paes.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
}

function filterByCard(status) {
  if (activeCardFilter === status) {
    activeCardFilter = '';
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  } else {
    activeCardFilter = status;
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
    const card = document.getElementById('card-' + status);
    if (card) card.classList.add('active');
  }
  applyFilters();
}

function applyFilters(keepPage = false) {
  const q = document.getElementById('search').value.toLowerCase();

  filteredData = ACTIVE_COMPANIES.filter(c => {
    const s = state[getKey(c)] || {};
    if (s.deleted) return false;
    const status = s.status || 'pending';
    if (activeCardFilter === 'enrich') {
      if (!s.enrich || !Object.values(s.enrich).some(v => v)) return false;
    } else if (activeCardFilter && status !== activeCardFilter) return false;
    if (q) {
      const hay = [c.nom, c.activite, c.localite, c.nom_du_pae, c.telephone].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filteredData.sort((a, b) => {
    const av = (a[sortCol] || '').toString().toLowerCase();
    const bv = (b[sortCol] || '').toString().toLowerCase();
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });

  if (!keepPage) currentPage = 1;
  renderTable();
  renderPagination();
  updateStats();
  updateResumeBtn();
}

function sortBy(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = 1; }
  document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted-asc','sorted-desc'));
  const th = document.getElementById('th-' + col);
  if (th) th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
  applyFilters();
}

function renderTable() {
  const tbody = document.getElementById('table-body');
  const empty = document.getElementById('empty-state');
  const info  = document.getElementById('results-info');

  info.innerHTML = `<b>${filteredData.length}</b> résultats — <b>${ACTIVE_COMPANIES.length}</b> entreprises au total`;

  if (filteredData.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const pageData = filteredData.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  tbody.innerHTML = pageData.map(c => {
    const key    = getKey(c);
    const s      = state[key] || {};
    const status = s.status || 'pending';
    const isDone = status === 'done' || status === 'interested';

    const statusLabels = {
      pending: 'À traiter', done: 'Vu', interested: 'Intéressant', skip: 'Pas pertinent'
    };

    return `<tr class="row-${status}" data-key="${esc(key)}">
      <td class="col-check">
        <div class="chk-wrap ${isDone ? 'checked' : ''}" data-key="${esc(key)}" onclick="toggleCheck(this)">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="2,6 5,9 10,3"/>
          </svg>
        </div>
      </td>
      <td class="col-nom">
        <span class="nom-text" onclick="searchCompany(this, '${esc(key)}')" title="Rechercher sur Google">${esc(c.nom || '—')}</span>
        ${(s.enrich && (s.enrich.prenom || s.enrich.nom)) ? `<span class="contact-sub">${esc([s.enrich.prenom, s.enrich.nom].filter(Boolean).join(' '))}</span>` : ''}
        ${(s.enrich && s.enrich.site) ? `<a href="${esc(s.enrich.site)}" target="_blank" class="enrich-row-link" data-tip="Ouvrir le site"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></a>` : ''}
        ${(s.enrich && s.enrich.linkedin) ? `<a href="${esc(s.enrich.linkedin)}" target="_blank" class="enrich-row-link enrich-row-link-li" data-tip="Ouvrir LinkedIn"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg></a>` : ''}
      </td>
      <td class="col-activite">${esc(c.activite || '—')}</td>
      <td class="col-localite">${esc(c.localite || '—')}</td>
      <td class="col-tel">${c.telephone ? `<a href="tel:${esc(c.telephone)}">${esc(c.telephone)}</a>` : '<span style="color:var(--border-med)">—</span>'}</td>
      <td class="status-cell">
        <span class="badge ${status}">
          <span class="badge-dot"></span>${statusLabels[status]}
        </span>
        <select class="status-select-hidden" data-key="${esc(key)}" onchange="setStatus(this)">
          <option value="pending"    ${status==='pending'    ?'selected':''}>À traiter</option>
          <option value="done"       ${status==='done'       ?'selected':''}>Vu</option>
          <option value="interested" ${status==='interested' ?'selected':''}>Intéressant</option>
          <option value="skip"       ${status==='skip'       ?'selected':''}>Pas pertinent</option>
        </select>
      </td>
      <td>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="star-btn ${status === 'interested' ? 'starred' : ''}" data-key="${esc(key)}" onclick="toggleInterested(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${status === 'interested' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>
            </svg>
            ${status === 'interested' ? 'Intéressant' : 'Intéressant'}
          </button>
          <button class="skip-btn ${status === 'skip' ? 'skipped' : ''}" data-key="${esc(key)}" onclick="toggleSkip(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Pas pertinent
          </button>
          <button class="enrich-btn ${s.enrich ? 'enriched' : ''}" data-key="${esc(key)}" onclick="openEnrichModal('${esc(key)}')" data-tip="Enrichir les données de contact">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              <line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>
            </svg>
            Enrichir
          </button>
        </div>
      </td>
      <td class="col-menu">
        <div class="row-menu-wrap">
          <button class="menu-dots-btn" onclick="toggleRowMenu(event, this)" data-tip="Plus d'options">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
          <div class="row-dropdown">
            <button class="row-dropdown-item danger" data-key="${esc(key)}" onclick="deleteCompany(this)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg>
              Supprimer
            </button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function searchCompany(el, key) {
  const nomText = el.textContent.trim();
  window.open('https://www.google.com/search?q=' + encodeURIComponent(nomText), '_blank');
  if (!state[key]) state[key] = {};
  if (!state[key].status || state[key].status === 'pending') {
    state[key].status = 'done';
    saveState();
    updateRow(key);
  }
}

function updateRow(key) {
  const tr = document.querySelector(`tr[data-key="${key.replace(/"/g, '\\"')}"]`);
  if (!tr) return;
  const s = state[key] || {};
  const status = s.status || 'pending';
  const isDone = status === 'done' || status === 'interested';
  const statusLabels = { pending: 'À traiter', done: 'Vu', interested: 'Intéressant', skip: 'Pas pertinent' };

  // Si filtre actif et le nouveau statut ne correspond plus, retirer la ligne
  if (activeCardFilter && status !== activeCardFilter) {
    filteredData = filteredData.filter(c => getKey(c) !== key);
    document.getElementById('results-info').innerHTML = `<b>${filteredData.length}</b> résultats — <b>${ACTIVE_COMPANIES.length}</b> entreprises au total`;
    if (filteredData.length === 0) document.getElementById('empty-state').style.display = 'block';
    tr.remove();
    updateStats();
    return;
  }

  tr.className = `row-${status}`;

  const chk = tr.querySelector('.chk-wrap');
  isDone ? chk.classList.add('checked') : chk.classList.remove('checked');

  const badge = tr.querySelector('.badge');
  badge.className = `badge ${status}`;
  badge.innerHTML = `<span class="badge-dot"></span>${statusLabels[status]}`;

  const sel = tr.querySelector('.status-select-hidden');
  sel.value = status;

  const star = tr.querySelector('.star-btn');
  star.className = `star-btn ${status === 'interested' ? 'starred' : ''}`;
  star.querySelector('svg').setAttribute('fill', status === 'interested' ? 'currentColor' : 'none');

  const skip = tr.querySelector('.skip-btn');
  skip.className = `skip-btn ${status === 'skip' ? 'skipped' : ''}`;

  updateStats();
}

function setBy(key, status) {
  if (status && status !== 'pending') state[key].by = MY_UID;
  else delete state[key].by;
}

function toggleCheck(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  const cur = state[key].status || 'pending';
  state[key].status = (cur === 'pending' || cur === 'skip') ? 'done' : 'pending';
  setBy(key, state[key].status);
  saveState(key);
  updateRow(key);
}

function setStatus(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = el.value;
  setBy(key, state[key].status);
  saveState(key);
  updateRow(key);
}

function toggleSkip(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === 'skip' ? 'pending' : 'skip';
  setBy(key, state[key].status);
  saveState(key);
  updateRow(key);
}

function toggleRowMenu(e, btn) {
  e.stopPropagation();
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains('open');
  document.querySelectorAll('.row-dropdown.open').forEach(m => m.classList.remove('open'));
  if (!isOpen) menu.classList.add('open');
}

function deleteCompany(btn) {
  const key = btn.dataset.key;
  if (!confirm('Supprimer cette entreprise de la liste ?')) return;
  if (!state[key]) state[key] = {};
  state[key].deleted = true;
  saveState();
  applyFilters();
}

document.addEventListener('click', () => {
  document.querySelectorAll('.row-dropdown.open').forEach(m => m.classList.remove('open'));
});

function toggleInterested(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === 'interested' ? 'done' : 'interested';
  setBy(key, state[key].status);
  saveState(key);
  updateRow(key);
}

function updateStats() {
  const total  = ACTIVE_COMPANIES.filter(c => !(state[getKey(c)] || {}).deleted).length;
  const counts = { pending:0, done:0, interested:0, skip:0 };
  let myCount = 0, amiCount = 0, enrichCount = 0;
  ACTIVE_COMPANIES.forEach(c => {
    const s = state[getKey(c)] || {};
    if (s.deleted) return;
    const st = s.status || 'pending';
    counts[st]++;
    if (st !== 'pending') {
      if (s.by === MY_UID) myCount++;
      else if (s.by) amiCount++;
    }
    if (s.enrich && Object.values(s.enrich).some(v => v)) enrichCount++;
  });
  const treated = counts.done + counts.interested + counts.skip;
  const pct     = Math.round(treated / total * 100);

  document.getElementById('header-ds-name').textContent = dsMeta[currentDsId]?.name || 'Prospection';
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('header-pct').textContent = pct + '%';
  document.getElementById('progress-label-right').textContent = `${treated} / ${total}`;
  document.getElementById('cnt-pending').textContent    = counts.pending;
  document.getElementById('cnt-done').textContent       = counts.done;
  document.getElementById('cnt-interested').textContent = counts.interested;
  document.getElementById('cnt-skip').textContent       = counts.skip;
  document.getElementById('cnt-enrich').textContent     = enrichCount;

  // Duo stats
  const duoEl = document.getElementById('duo-stats');
  const hasAny = myCount > 0 || amiCount > 0;
  duoEl.style.display = hasAny ? 'flex' : 'none';
  if (hasAny) {
    document.getElementById('duo-cnt-me').textContent  = myCount;
    document.getElementById('duo-cnt-ami').textContent = amiCount;
    const total2 = myCount + amiCount || 1;
    document.getElementById('duo-bar-me').style.width  = (myCount  / total2 * 100) + '%';
    document.getElementById('duo-bar-ami').style.width = (amiCount / total2 * 100) + '%';
  }

  // Confetti si tout est traité
  if (total > 0 && counts.pending === 0 && !_confettiDone) {
    _confettiDone = true;
    launchConfetti();
  }
  if (counts.pending > 0) _confettiDone = false;
}

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  const cols = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#c2410c','#06b6d4'];
  const particles = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width, y: -20 - Math.random() * 100,
    w: Math.random() * 10 + 5, h: Math.random() * 5 + 3,
    color: cols[Math.floor(Math.random() * cols.length)],
    vx: Math.random() * 4 - 2, vy: Math.random() * 4 + 2,
    rot: Math.random() * 360, rotV: Math.random() * 8 - 4,
    op: 1,
  }));
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.rotV;
      if (p.y > canvas.height * 0.6) p.op -= 0.018;
      if (p.op <= 0) return;
      alive = true;
      ctx.save();
      ctx.globalAlpha = p.op;
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (alive) requestAnimationFrame(draw);
    else canvas.style.display = 'none';
  }
  draw();
}

function exportCSV() {
  const toExport = filteredData.length > 0 ? filteredData : ACTIVE_COMPANIES;
  const cols = ['nom','activite','localite','nom_du_pae','telephone','fax','forme_juridique','tva','adresse','cp','statut','site_web','linkedin','prenom_contact','nom_contact','tel_contact','email_contact','notes'];
  const rows = [cols.join(';')];
  toExport.forEach(c => {
    const key = getKey(c);
    const s   = state[key] || {};
    const e   = s.enrich || {};
    rows.push([
      c.nom, c.activite, c.localite, c.nom_du_pae, c.telephone, c.fax,
      c.forme_juridique, c.tva, c.adresse, c.cp,
      s.status || 'pending',
      e.site || '', e.linkedin || '', e.prenom || '', e.nom || '', e.tel || '', e.email || '', e.notes || ''
    ].map(v => '"' + String(v||'').replace(/"/g,'""') + '"').join(';'));
  });
  const label = activeCardFilter ? `_${activeCardFilter}` : '';
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prospection${label}.csv`;
  a.click();
}

function confirmReset() {
  const dsName = dsMeta[currentDsId]?.name || 'ce dataset';
  showConfirm(
    'Réinitialiser la progression',
    `Toute la progression de <b>${dsName}</b> sera effacée pour toi et ton ami. Cette action est irréversible.`,
    'Réinitialiser',
    resetAll
  );
}

function showConfirm(title, body, confirmLabel, onConfirm) {
  let overlay = document.getElementById('confirm-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'confirm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:14px;padding:28px 32px;width:400px;max-width:90vw;border:1px solid var(--border);box-shadow:0 20px 60px rgba(0,0,0,0.12)">
        <p id="confirm-title" style="margin:0 0 8px;font-family:var(--font-ui);font-size:1rem;font-weight:800;color:var(--text)"></p>
        <p id="confirm-body" style="margin:0 0 24px;font-size:0.83rem;color:var(--muted);line-height:1.5"></p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button onclick="document.getElementById('confirm-overlay').style.display='none'" style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:var(--font-ui);font-size:0.82rem;font-weight:600;cursor:pointer">Annuler</button>
          <button id="confirm-ok" style="padding:8px 18px;border-radius:8px;border:none;background:var(--red);color:#fff;font-family:var(--font-ui);font-size:0.82rem;font-weight:700;cursor:pointer"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').innerHTML = body;
  document.getElementById('confirm-ok').textContent = confirmLabel;
  document.getElementById('confirm-ok').onclick = () => {
    overlay.style.display = 'none';
    onConfirm();
  };
  overlay.style.display = 'flex';
}

function resetAll() {
  state = {};
  saveState();
  activeCardFilter = '';
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  applyFilters();
}

// ══════════════════════════════════════════════════════════════════════════════
// DATASET MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function populateDsSelect() {
  const sel = document.getElementById('ds-select');
  sel.innerHTML = '';
  Object.entries(dsMeta).forEach(([id, meta]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = meta.name;
    if (id === currentDsId) opt.selected = true;
    sel.appendChild(opt);
  });
  updateDeleteDsBtn();
}

function updateDeleteDsBtn() {
  const btn = document.getElementById('btn-del-ds');
  if (!btn) return;
  const isBuiltIn = dsMeta[currentDsId]?.isBuiltIn;
  btn.disabled = !!isBuiltIn;
  btn.style.opacity = isBuiltIn ? '0.3' : '';
  btn.dataset.tip = isBuiltIn ? 'Le dataset par défaut ne peut pas être supprimé' : 'Supprimer ce dataset';
}

function confirmDeleteDataset() {
  if (dsMeta[currentDsId]?.isBuiltIn) return;
  const name = dsMeta[currentDsId]?.name || 'ce dataset';
  showConfirm(
    'Supprimer le dataset',
    `Le dataset <b>${name}</b> sera supprimé pour toi et ton ami. Cette action est irréversible.`,
    'Supprimer',
    deleteCurrentDataset
  );
}

function deleteCurrentDataset() {
  const dsId = currentDsId;
  if (dsMeta[dsId]?.isBuiltIn) return;
  const dsName = dsMeta[dsId]?.name || dsId;

  // Nettoyage local
  delete dsMeta[dsId];
  saveDsMeta();
  localStorage.removeItem(DS_DATA_PFX + dsId);
  localStorage.removeItem(DS_STATE_PFX + dsId);
  localStorage.removeItem('last_modified_' + dsId);

  // Nettoyage Firebase
  _db.ref('datasets/' + dsId).remove().catch(() => {});

  // Bascule sur igretec
  currentDsId = 'igretec';
  ACTIVE_COMPANIES = COMPANIES;
  state = {};
  loadState();
  setupFirebaseSync('igretec');
  activeCardFilter = '';
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  populateDsSelect();
  populatePaeFilter();
  applyFilters();
  showToast(`"${dsName}" supprimé`);
}

function switchDataset(dsId) {
  if (dsId === currentDsId) return;
  currentDsId = dsId;

  // Charge les données du dataset
  if (dsId === 'igretec') {
    ACTIVE_COMPANIES = COMPANIES;
  } else {
    try {
      const raw = localStorage.getItem(DS_DATA_PFX + dsId);
      ACTIVE_COMPANIES = raw ? JSON.parse(raw) : [];
    } catch(e) { ACTIVE_COMPANIES = []; }
  }

  // Recharge état + Firebase
  state = {};
  loadState();
  setupFirebaseSync(dsId);

  // Reset UI
  activeCardFilter = '';
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  document.getElementById('search').value = '';
  updateDeleteDsBtn();
  populatePaeFilter();
  applyFilters();
  showToast('Dataset : ' + dsMeta[dsId].name);
}

// ──────────────────────────────────────────────────────────────────────────────
// CSV IMPORT
// ──────────────────────────────────────────────────────────────────────────────


const COL_HINTS = {
  nom:       ['nom', 'name', 'entreprise', 'company', 'raison', 'société', 'societe', 'dénomination'],
  activite:  ['activite', 'activité', 'activity', 'secteur', 'sector', 'catégorie', 'categorie', 'type'],
  localite:  ['localite', 'localité', 'ville', 'city', 'commune', 'location', 'adresse', 'address'],
  telephone: ['telephone', 'téléphone', 'tel', 'phone', 'mobile', 'gsm', 'tél'],
  tva:       ['tva', 'vat', 'bce', 'siret', 'siren', 'numéro', 'numero', 'n°', 'id'],
  site_web:  ['site', 'web', 'url', 'website', 'homepage', 'www'],
};

function detectCol(headers, field) {
  const hints = COL_HINTS[field];
  const h = headers.map(s => s.toLowerCase().trim());
  for (const hint of hints) {
    const idx = h.findIndex(col => col.includes(hint));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const sep = lines[0].includes(';') ? ';' : ',';
  const parseRow = line => {
    const result = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    result.push(cur.trim());
    return result;
  };
  const headers = parseRow(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = parseRow(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function handleCSVFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _csvParsed = parseCSV(e.target.result);
    if (!_csvParsed || _csvParsed.rows.length === 0) {
      showToast('Fichier CSV invalide ou vide');
      return;
    }
    document.getElementById('drop-label').textContent = file.name + ' — ' + _csvParsed.rows.length + ' lignes';
    document.getElementById('modal-drop').classList.add('has-file');
    renderColMap(_csvParsed.headers);
    renderPreview(_csvParsed);
    document.getElementById('col-map-section').style.display = 'block';
    document.getElementById('btn-confirm-import').disabled = false;
  };
  reader.readAsText(file, 'UTF-8');
}

function renderColMap(headers) {
  const grid = document.getElementById('col-map-grid');
  const fields = [
    { key: 'nom',       label: 'Nom entreprise *' },
    { key: 'activite',  label: 'Activité' },
    { key: 'localite',  label: 'Localité / Ville' },
    { key: 'telephone', label: 'Téléphone' },
    { key: 'tva',       label: 'N° TVA / BCE' },
    { key: 'site_web',  label: 'Site web' },
  ];
  grid.innerHTML = fields.map(f => {
    const detected = detectCol(headers, f.key);
    const opts = ['<option value="">— ignorer —</option>',
      ...headers.map(h => `<option value="${h}" ${h === detected ? 'selected' : ''}>${h}</option>`)
    ].join('');
    return `<div class="col-map-item"><label>${f.label}</label><select id="map-${f.key}">${opts}</select></div>`;
  }).join('');
}

function renderPreview(parsed) {
  const table = document.getElementById('preview-table');
  const sample = parsed.rows.slice(0, 3);
  table.innerHTML = `<thead><tr>${parsed.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${sample.map(r => `<tr>${parsed.headers.map(h => `<td>${r[h] || ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function confirmImport() {
  if (!_csvParsed) return;
  const name = document.getElementById('ds-name-input').value.trim() || ('Import ' + new Date().toLocaleDateString('fr'));
  const mapField = f => document.getElementById('map-' + f)?.value || '';

  const companies = _csvParsed.rows.map(row => ({
    nom:        row[mapField('nom')]       || '',
    activite:   row[mapField('activite')]  || '',
    localite:   row[mapField('localite')]  || '',
    telephone:  row[mapField('telephone')] || '',
    tva:        row[mapField('tva')]       || '',
    site_web:   row[mapField('site_web')]  || '',
  })).filter(c => c.nom);

  if (companies.length === 0) { showToast('Aucune ligne avec un nom valide trouvée'); return; }

  const dsId = 'ds_' + Date.now();
  dsMeta[dsId] = { name, isBuiltIn: false };
  saveDsMeta();
  localStorage.setItem(DS_DATA_PFX + dsId, JSON.stringify(companies));

  // Partage le dataset avec l'ami via Firebase (même nœud que le state)
  _db.ref('datasets/' + dsId + '/meta').set({ name })
    .catch(e => console.warn('Firebase meta sync:', e));
  _db.ref('datasets/' + dsId + '/data').set(companies)
    .catch(e => console.warn('Firebase data sync:', e));

  closeImportModal();
  populateDsSelect();
  document.getElementById('ds-select').value = dsId;
  updateDeleteDsBtn();
  switchDataset(dsId);
  showToast(`"${name}" importé — ${companies.length} entreprises`);
}

function openImportModal() {
  _csvParsed = null;
  document.getElementById('ds-name-input').value = '';
  document.getElementById('drop-label').textContent = 'Clique pour choisir un fichier .csv';
  document.getElementById('modal-drop').classList.remove('has-file');
  document.getElementById('col-map-section').style.display = 'none';
  document.getElementById('btn-confirm-import').disabled = true;
  document.getElementById('csv-file-input').value = '';
  document.getElementById('import-modal').style.display = 'flex';
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
// USERS / PROFILE / STATS
// ══════════════════════════════════════════════════════════════════════════════

function setupUsersSync() {
  // Pousse mon nom dès qu'il est défini
  if (MY_NAME) _db.ref('users/' + MY_UID).set({ name: MY_NAME });
  // Écoute tous les profils
  _db.ref('users').on('value', snap => {
    _usersMap = {};
    const data = snap.val() || {};
    for (const [uid, v] of Object.entries(data)) {
      if (v && v.name) _usersMap[uid] = v.name;
    }
  });
}

function showProfileSetup() {
  document.getElementById('profile-setup-modal').style.display = 'flex';
  document.getElementById('profile-name-input').focus();
}

function closeProfileSetup() {
  document.getElementById('profile-setup-modal').style.display = 'none';
}

function saveProfile() {
  const input = document.getElementById('profile-name-input');
  const name = input.value.trim();
  if (!name) { input.classList.add('input-error'); return; }
  input.classList.remove('input-error');
  MY_NAME = name;
  localStorage.setItem('prospection_name', name);
  _db.ref('users/' + MY_UID).set({ name });
  document.getElementById('profile-setup-modal').style.display = 'none';
  showToast(`Bienvenue, ${name} !`);
}

function openStatsModal() {
  renderStatsPage();
  switchStatsTab('vue-ensemble');
  document.getElementById('stats-page').style.display = 'flex';
  document.addEventListener('keydown', _statsEscHandler);
}

const RANKS = [
  { name: 'Master',   min: 1000, color: '#dc2626', bg: '#fef2f2', border: 'rgba(220,38,38,0.25)',  icon: '♾️' },
  { name: 'Diamond',  min: 800,  color: '#0ea5e9', bg: '#f0f9ff', border: 'rgba(14,165,233,0.25)', icon: '💎' },
  { name: 'Platine',  min: 600,  color: '#7c3aed', bg: '#f5f3ff', border: 'rgba(124,58,237,0.25)', icon: '⚜️' },
  { name: 'Gold',     min: 400,  color: '#d97706', bg: '#fffbeb', border: 'rgba(217,119,6,0.25)',  icon: '🥇' },
  { name: 'Silver',   min: 200,  color: '#64748b', bg: '#f8fafc', border: 'rgba(100,116,139,0.25)',icon: '🥈' },
  { name: 'Bronze',   min: 0,    color: '#92400e', bg: '#fff7ed', border: 'rgba(146,64,14,0.25)',  icon: '🥉' },
];

function getRank(treated) {
  return RANKS.find(r => treated >= r.min) || RANKS[RANKS.length - 1];
}

function getNextRank(treated) {
  const thresholds = [200, 400, 600, 800, 1000];
  return thresholds.find(t => t > treated) || null;
}

function switchStatsTab(tab) {
  ['vue-ensemble','prospection','enrichissement','leaderboard'].forEach(t => {
    const el = document.getElementById('stats-tab-' + t);
    el.style.display = t === tab ? 'flex' : 'none';
    if (t === tab) {
      el.querySelectorAll('*').forEach(c => { c.style.animation = 'none'; c.offsetHeight; c.style.animation = ''; });
    }
    document.getElementById('stab-' + t).classList.toggle('active', t === tab);
  });
}

function closeStatsModal() {
  document.getElementById('stats-page').style.display = 'none';
  document.removeEventListener('keydown', _statsEscHandler);
}

function _statsEscHandler(e) { if (e.key === 'Escape') closeStatsModal(); }

// Count-up animation
function countUp(el, target, duration = 700) {
  if (target === 0) { el.textContent = '0'; return; }
  const start = performance.now();
  const update = now => {
    const p = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(ease * target);
    if (p < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function renderStatsPage() {
  const avatarColors = ['#c2410c','#1d4ed8','#15803d','#b91c1c','#7c3aed','#0369a1'];
  const getColor = uid => { let h=0; for(const c of uid) h=(h*31+c.charCodeAt(0))>>>0; return avatarColors[h % avatarColors.length]; };
  const getName  = uid => _usersMap[uid] || (uid === MY_UID ? (MY_NAME || 'Moi') : 'Utilisateur');
  const getInit  = uid => (getName(uid)[0] || '?').toUpperCase();

  // ── Collecte UIDs ─────────────────────────────────────────────────
  const uids = new Set([MY_UID]);
  for (const s of Object.values(state)) {
    if (s.by) uids.add(s.by);
    if (s.enrich_by) uids.add(s.enrich_by);
  }
  for (const uid of Object.keys(_usersMap)) uids.add(uid);
  const uidList = [...uids];

  // ── Calcul stats ──────────────────────────────────────────────────
  const blank = () => ({ treated:0, done:0, interested:0, skip:0, enriched:0, emails:0, tels:0, contacts:0, sites:0, linkedins:0, notes:0 });
  const us = {};
  uidList.forEach(uid => us[uid] = blank());

  const total = ACTIVE_COMPANIES.filter(c => !(state[getKey(c)] || {}).deleted).length;

  for (const s of Object.values(state)) {
    if (s.deleted) continue;
    const st = s.status || 'pending';
    if (s.by && us[s.by] && st !== 'pending') {
      us[s.by].treated++;
      us[s.by][st]++;
    }
    if (s.enrich && s.enrich_by && us[s.enrich_by]) {
      const e = s.enrich;
      us[s.enrich_by].enriched++;
      if (e.email)           us[s.enrich_by].emails++;
      if (e.tel)             us[s.enrich_by].tels++;
      if (e.prenom || e.nom) us[s.enrich_by].contacts++;
      if (e.site)            us[s.enrich_by].sites++;
      if (e.linkedin)        us[s.enrich_by].linkedins++;
      if (e.notes)           us[s.enrich_by].notes++;
    }
  }

  const totalTreated    = uidList.reduce((a, u) => a + us[u].treated, 0);
  const totalInterested = uidList.reduce((a, u) => a + us[u].interested, 0);
  const totalEnriched   = uidList.reduce((a, u) => a + us[u].enriched, 0);
  const globalPct       = total > 0 ? Math.round(totalTreated / total * 100) : 0;

  // ── Dataset badge ─────────────────────────────────────────────────
  document.getElementById('stats-dataset-badge').textContent = dsMeta[currentDsId]?.name || 'Dataset';

  // ── KPI bar ───────────────────────────────────────────────────────
  const kpis = [
    { label: 'Entreprises total',   val: total,          color: 'var(--border-med)' },
    { label: 'Traitées',            val: totalTreated,   color: 'var(--blue)' },
    { label: 'Progression',         val: globalPct + '%',color: 'var(--green)', raw: globalPct },
    { label: 'Intéressantes',       val: totalInterested,color: 'var(--amber)' },
    { label: 'Fiches enrichies',    val: totalEnriched,  color: '#7c3aed' },
  ];
  document.getElementById('stats-kpi-bar').innerHTML = kpis.map(k =>
    `<div class="stats-kpi">
      <div class="stats-kpi-dot" style="background:${k.color}"></div>
      <div class="stats-kpi-val" data-val="${k.raw ?? k.val}">${k.val}</div>
      <div class="stats-kpi-label">${k.label}</div>
    </div>`
  ).join('');

  // ── User cards ────────────────────────────────────────────────────
  document.getElementById('stats-user-cards').innerHTML = uidList.map(uid => {
    const s = us[uid];
    const isMe = uid === MY_UID;
    const color = getColor(uid);
    const pct = total > 0 ? Math.round(s.treated / total * 100) : 0;
    return `<div class="stats-user-card" style="--card-color:${color}">
      <div class="stats-avatar" style="background:${color}">${getInit(uid)}</div>
      <div class="stats-user-name">${getName(uid)}${isMe ? '<span class="stats-you-badge">toi</span>' : ''}</div>
      <div class="stats-user-big" data-val="${s.treated}">0</div>
      <div class="stats-user-sub">entreprises traitées</div>
      <div class="stats-user-bar-wrap"><div class="stats-user-bar-fill" style="width:0%;background:${color}" data-pct="${pct}"></div></div>
      <div class="stats-user-pct">${pct}% du total</div>
    </div>`;
  }).join('');

  // ── Helper: section rows ──────────────────────────────────────────
  const svgIcon = (path, extra='') =>
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;

  const headerRow = () =>
    `<div class="stats-row stats-row-header">
      <div class="stats-row-icon"></div>
      <div class="stats-row-label"></div>
      <div class="stats-row-vals">${uidList.map(u => `<div class="stats-row-val v-head" style="color:${getColor(u)}">${getName(u)}</div>`).join('')}</div>
    </div>`;

  const row = (label, icon, key, cls = '') =>
    `<div class="stats-row">
      <div class="stats-row-icon">${svgIcon(icon)}</div>
      <div class="stats-row-label">${label}</div>
      <div class="stats-row-vals">${uidList.map(u => {
        const v = us[u][key];
        return `<div class="stats-row-val ${cls} ${v === 0 ? 'v-zero' : ''}" data-val="${v}">0</div>`;
      }).join('')}</div>
    </div>`;

  // ── Section Prospection ───────────────────────────────────────────
  document.getElementById('stats-prospection').innerHTML =
    headerRow() +
    row('Traités au total',  '<polyline points="20,6 9,17 4,12"/>',                                                     'treated') +
    row('Intéressants',      '<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>', 'interested', 'v-blue') +
    row('Pas pertinents',    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',             'skip',       'v-red') +
    row('Vus sans avis',     '<circle cx="12" cy="12" r="10"/><polyline points="12,8 12,12 14,14"/>',                   'done',       'v-green');

  // ── Section Enrichissement ────────────────────────────────────────
  document.getElementById('stats-enrichissement').innerHTML =
    headerRow() +
    row('Fiches enrichies',  '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>', 'enriched', 'v-purple') +
    row('Emails',            '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',  'emails') +
    row('Téléphones',        '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>', 'tels') +
    row('Contacts (prénom/nom)', '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>',              'contacts') +
    row('Sites web',         '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>', 'sites') +
    row('LinkedIn',          '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>', 'linkedins');

  // ── Leaderboard ───────────────────────────────────────────────────
  renderLeaderboard(uidList, us, getColor, getName);

  // ── Count-up animations ───────────────────────────────────────────
  requestAnimationFrame(() => {
    document.querySelectorAll('#stats-page [data-val]').forEach(el => {
      const v = parseFloat(el.dataset.val);
      if (!isNaN(v) && !el.dataset.val.includes('%')) countUp(el, v);
    });
    document.querySelectorAll('.stats-user-bar-fill').forEach(el => {
      const pct = el.dataset.pct;
      setTimeout(() => el.style.width = pct + '%', 50);
    });
    // Animate leaderboard rank bars
    document.querySelectorAll('.lb-rank-fill').forEach(el => {
      const pct = el.dataset.pct;
      setTimeout(() => el.style.width = pct + '%', 80);
    });
  });
}

// ── Leaderboard delete user ───────────────────────────────────────────────────
function lbDeleteUser(uid, name) {
  if (!confirm(`Supprimer définitivement "${name}" du leaderboard ?\n\nToutes ses contributions (prospection + enrichissement) seront effacées.`)) return;
  for (const key of Object.keys(state)) {
    const s = state[key];
    if (!s) continue;
    if (s.by === uid) { delete s.by; s.status = 'pending'; }
    if (s.enrich_by === uid) { delete s.enrich_by; delete s.enrich; }
  }
  saveState(null);
  renderStatsPage();
}

function renderLeaderboard(uidList, us, getColor, getName) {
  const container = document.getElementById('stats-leaderboard');
  if (!container) return;

  // Sort by treated desc
  const sorted = [...uidList].sort((a, b) => (us[b].treated - us[a].treated));

  const posLabels = ['🥇', '🥈', '🥉'];
  const isMe = uid => uid === MY_UID;

  const cardHtml = (uid, idx) => {
    const s = us[uid];
    const rank = getRank(s.treated);
    const next = getNextRank(s.treated);
    const color = getColor(uid);
    const name = getName(uid);
    const init = (name[0] || '?').toUpperCase();

    const prevMin = rank.min;
    const nextMin = next || prevMin;
    const progress = next
      ? Math.round(Math.min(((s.treated - prevMin) / (nextMin - prevMin)) * 100, 100))
      : 100;
    const remaining = next ? Math.max(next - s.treated, 0) : 0;
    const nextRankObj = next ? getRank(next) : null;

    const posLabel = idx < 3 ? `<span class="lb-pos-emoji">${posLabels[idx]}</span>` : `<span class="lb-pos-num">#${idx + 1}</span>`;
    const deleteBtn = !isMe(uid)
      ? `<button class="lb-delete-btn" onclick="lbDeleteUser('${uid}', '${name.replace(/'/g, "\\'")}')" title="Supprimer définitivement">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14a2,2,0,0,1-2,2H8a2,2,0,0,1-2-2L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4a1,1,0,0,1,1-1h4a1,1,0,0,1,1,1V6"/></svg>
         </button>`
      : '';

    return `<div class="lb-card${isMe(uid) ? ' lb-card-me' : ''}" style="--lb-color:${color};--rank-color:${rank.color};--rank-bg:${rank.bg};--rank-border:${rank.border}">
      <div class="lb-pos">${posLabel}</div>
      <div class="lb-avatar" style="background:${color}">${init}</div>
      <div class="lb-info">
        <div class="lb-name">${name}${isMe(uid) ? '<span class="stats-you-badge">toi</span>' : ''}</div>
        <div class="lb-rank-badge" style="color:${rank.color};background:${rank.bg};border-color:${rank.border}">
          <span class="lb-rank-icon">${rank.icon}</span> ${rank.name}
        </div>
        <div class="lb-progress-wrap">
          <div class="lb-rank-fill" style="background:${rank.color};width:0%" data-pct="${progress}"></div>
        </div>
        ${next
          ? `<div class="lb-progress-label">${remaining} de plus pour <strong style="color:${nextRankObj.color}">${nextRankObj.icon} ${nextRankObj.name}</strong></div>`
          : `<div class="lb-progress-label" style="color:${rank.color}">Rang maximum atteint !</div>`
        }
      </div>
      <div class="lb-stats">
        <div class="lb-stat"><span class="lb-stat-val" data-val="${s.treated}">0</span><span class="lb-stat-label">traitées</span></div>
        <div class="lb-stat"><span class="lb-stat-val v-blue" data-val="${s.interested}">0</span><span class="lb-stat-label">intéressantes</span></div>
        <div class="lb-stat"><span class="lb-stat-val v-purple" data-val="${s.enriched}">0</span><span class="lb-stat-label">enrichies</span></div>
      </div>
      ${deleteBtn}
    </div>`;
  };

  const mainList = sorted.map((uid, idx) => cardHtml(uid, idx)).join('');

  container.innerHTML = `<div class="lb-list">${mainList}</div>`;
}

// ENRICH MODAL
// ══════════════════════════════════════════════════════════════════════════════

let _enrichCurrentKey = null;

function openEnrichModal(key) {
  _enrichCurrentKey = key;
  const s = state[key] || {};
  const e = s.enrich || {};

  // Find company name for the modal title
  const company = ACTIVE_COMPANIES.find(c => getKey(c) === key);
  document.getElementById('enrich-company-name').textContent = company ? company.nom : key;

  document.getElementById('enrich-site').value     = e.site     || '';
  document.getElementById('enrich-linkedin').value = e.linkedin || '';
  document.getElementById('enrich-prenom').value   = e.prenom   || '';
  document.getElementById('enrich-nom').value      = e.nom      || '';
  document.getElementById('enrich-tel').value      = e.tel      || '';
  document.getElementById('enrich-email').value    = e.email    || '';
  document.getElementById('enrich-notes').value    = e.notes    || '';

  // TVA (lecture seule — donnée brute)
  const tvaRow = document.getElementById('enrich-tva-row');
  if (company && company.tva) {
    document.getElementById('enrich-tva-display').textContent = company.tva;
    tvaRow.style.display = '';
  } else {
    tvaRow.style.display = 'none';
  }

  document.getElementById('enrich-modal').style.display = 'flex';
  document.getElementById('enrich-site').focus();
}

function saveEnrich() {
  const key = _enrichCurrentKey;
  if (!key) return;
  if (!state[key]) state[key] = {};

  const enrich = {
    site:     document.getElementById('enrich-site').value.trim(),
    linkedin: document.getElementById('enrich-linkedin').value.trim(),
    prenom:   document.getElementById('enrich-prenom').value.trim(),
    nom:      document.getElementById('enrich-nom').value.trim(),
    tel:      document.getElementById('enrich-tel').value.trim(),
    email:    document.getElementById('enrich-email').value.trim(),
    notes:    document.getElementById('enrich-notes').value.trim(),
  };

  // Remove empty enrich object
  const hasData = Object.values(enrich).some(v => v);
  if (hasData) {
    state[key].enrich = enrich;
    state[key].enrich_by = MY_UID;
  } else {
    delete state[key].enrich;
    delete state[key].enrich_by;
  }

  saveState(key);

  // Update enrich button style in row
  const btn = document.querySelector(`.enrich-btn[data-key="${key.replace(/"/g, '\\"')}"]`);
  if (btn) btn.classList.toggle('enriched', hasData);

  closeEnrichModal();
  if (focusMode) renderFocusCard();
  showToast(hasData ? 'Données enregistrées' : 'Données effacées');
}

function closeEnrichModal() {
  document.getElementById('enrich-modal').style.display = 'none';
  _enrichCurrentKey = null;
}

function copyEnrichField(id) {
  const val = document.getElementById(id)?.value?.trim();
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => showToast('Copié !'));
}

// ══════════════════════════════════════════════════════════════════════════════
// FOCUS MODE
// ══════════════════════════════════════════════════════════════════════════════
function toggleFocusMode() {
  focusMode = !focusMode;
  const overlay = document.getElementById('focus-overlay');
  const btn = document.getElementById('btn-focus');
  overlay.style.display = focusMode ? 'flex' : 'none';
  btn.classList.toggle('active', focusMode);
  if (focusMode) {
    focusIndex = findResumeIndex();
    renderFocusCard();
  }
}

function renderFocusCard(dir) {
  const c = filteredData[focusIndex];
  if (!c) return;
  const key    = getKey(c);
  const s      = state[key] || {};
  const status = s.status || 'pending';

  document.getElementById('focus-counter').textContent = `${focusIndex + 1} / ${filteredData.length}`;

  if (dir) {
    const card = document.getElementById('focus-card');
    card.classList.remove('slide-next', 'slide-prev');
    void card.offsetWidth; // reflow pour relancer l'animation
    card.classList.add(dir === 'next' ? 'slide-next' : 'slide-prev');
  }

  // Badge
  const badge = document.getElementById('focus-status-badge');
  const cfg = { pending:'À traiter', done:'Vu', interested:'Intéressant', skip:'Pas pertinent' };
  const colors = {
    pending:    'background:var(--surface2);color:var(--muted)',
    done:       'background:#dcfce7;color:#15803d',
    interested: 'background:var(--blue-bg);color:var(--blue)',
    skip:       'background:var(--red-bg);color:var(--red)',
  };
  badge.textContent = cfg[status] || '';
  badge.style.cssText = colors[status] || '';

  document.getElementById('focus-nom').textContent      = c.nom || '—';
  document.getElementById('focus-activite').textContent = c.activite || '';
  document.getElementById('focus-localite').textContent = c.localite || '';
  document.getElementById('focus-sep').style.display    = (c.activite && c.localite) ? '' : 'none';

  // Téléphone (brut ou enrichi)
  const telEl = document.getElementById('focus-tel');
  const telVal = c.telephone || (s.enrich && s.enrich.tel) || '';
  if (telVal) {
    telEl.style.display = 'inline-flex';
    telEl.href = 'tel:' + telVal;
    document.getElementById('focus-tel-text').textContent = telVal;
  } else { telEl.style.display = 'none'; }

  // Site web
  const webEl = document.getElementById('focus-web');
  if (c.site_web) {
    webEl.style.display = 'inline-flex';
    const url = c.site_web.startsWith('http') ? c.site_web : 'https://' + c.site_web;
    webEl.href = url;
    document.getElementById('focus-web-text').textContent = c.site_web.replace(/^https?:\/\//, '');
  } else { webEl.style.display = 'none'; }

  // Données enrichies
  const enrichData = s.enrich || {};

  // LinkedIn (enrichi)
  const linkedinEl = document.getElementById('focus-linkedin');
  if (enrichData.linkedin) {
    linkedinEl.style.display = 'inline-flex';
    const liUrl = enrichData.linkedin.startsWith('http') ? enrichData.linkedin : 'https://' + enrichData.linkedin;
    linkedinEl.href = liUrl;
  } else { linkedinEl.style.display = 'none'; }

  // Site enrichi (si pas de site_web brut)
  if (!c.site_web && enrichData.site) {
    webEl.style.display = 'inline-flex';
    const url = enrichData.site.startsWith('http') ? enrichData.site : 'https://' + enrichData.site;
    webEl.href = url;
    document.getElementById('focus-web-text').textContent = enrichData.site.replace(/^https?:\/\//, '');
  }

  // TVA
  const tvaEl = document.getElementById('focus-tva');
  if (c.tva) {
    tvaEl.style.display = '';
    tvaEl.textContent = c.tva;
  } else { tvaEl.style.display = 'none'; }

  // Contact enrichi (prénom/nom + email)
  const contactEl = document.getElementById('focus-enrich-contact');
  const contactName = [enrichData.prenom, enrichData.nom].filter(Boolean).join(' ');
  const contactEmail = enrichData.email || '';
  if (contactName || contactEmail) {
    contactEl.style.display = '';
    document.getElementById('focus-contact-name').textContent = contactName;
    const sepEl = document.getElementById('focus-contact-email-sep');
    sepEl.style.display = (contactName && contactEmail) ? '' : 'none';
    document.getElementById('focus-contact-email').textContent = contactEmail;
  } else { contactEl.style.display = 'none'; }

  // Notes enrichies
  const notesEl = document.getElementById('focus-enrich-notes');
  if (enrichData.notes) {
    notesEl.style.display = '';
    notesEl.textContent = enrichData.notes;
  } else { notesEl.style.display = 'none'; }

  // Buttons active state
  ['interested', 'done', 'skip'].forEach(st => {
    document.getElementById('fbtn-' + st).classList.toggle('active', status === st);
  });
  const hasEnrich = Object.values(enrichData).some(v => v);
  document.getElementById('fbtn-enrich').classList.toggle('enriched', hasEnrich);
}

function focusMove(dir) {
  focusIndex = Math.max(0, Math.min(filteredData.length - 1, focusIndex + dir));
  renderFocusCard(dir > 0 ? 'next' : 'prev');
}

function focusAction(action) {
  const c = filteredData[focusIndex];
  if (!c) return;
  const key = getKey(c);
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === action ? 'pending' : action;
  setBy(key, state[key].status);
  saveState();
  renderFocusCard();
  // Auto-avance sur pas pertinent
  if (action === 'skip' && focusIndex < filteredData.length - 1) {
    setTimeout(() => focusMove(1), 300);
  }
}

function focusSearchCompany() {
  const c = filteredData[focusIndex];
  if (!c) return;
  window.open('https://www.google.com/search?q=' + encodeURIComponent(c.nom), '_blank');
}

function focusOpenEnrich() {
  const c = filteredData[focusIndex];
  if (!c) return;
  openEnrichModal(getKey(c));
}

// Raccourcis clavier focus mode
document.addEventListener('keydown', e => {
  if (!focusMode) {
    if (e.key === 'f' || e.key === 'F') { if (!e.target.matches('input,textarea')) toggleFocusMode(); }
    return;
  }
  if (e.target.matches('textarea,input')) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusMove(1); }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); focusMove(-1); }
  if (e.key === 'i' || e.key === 'I') focusAction('interested');
  if (e.key === 'x' || e.key === 'X') focusAction('skip');
  if (e.key === ' ')  { e.preventDefault(); focusAction('done'); }
  if (e.key === 'Escape') toggleFocusMode();
});
