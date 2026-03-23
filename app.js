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
  if (!dsMeta.igretec) dsMeta.igretec = { name: 'Igretec PAE', isBuiltIn: true };
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
  const row = document.querySelector(`tr[data-key="${CSS.escape(getKey(c))}"]`);
  if (!row) { showToast('Entreprise non visible avec les filtres actuels'); return; }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('row-highlight');
  setTimeout(() => row.classList.remove('row-highlight'), 1800);
}

function updateResumeBtn() {
  const btn = document.getElementById('btn-resume');
  if (!btn) return;
  const hasAny = filteredData.some(c => { const s = state[getKey(c)] || {}; return s.status && s.status !== 'pending'; });
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
      applyFilters();
      updateSyncDot('ok');
      return;
    }
    const isOwnEcho = (Date.now() - _lastOwnPush) < 3000;
    const merged = mergeStates(state, remote);
    const changed = JSON.stringify(merged) !== JSON.stringify(state);
    if (changed) {
      state = merged;
      localStorage.setItem(currentStorageKey(), JSON.stringify(state));
      applyFilters();
      if (!isOwnEcho) showToast('Ton ami a mis à jour des entreprises');
    }
    updateSyncDot('ok');
  };
  _fbRef.on('value', _fbListener, () => updateSyncDot('err'));
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

function setupPresence() {
  const myRef = _db.ref('presence/' + MY_UID);
  function heartbeat() { myRef.set({ t: Date.now() }); }
  heartbeat();
  setInterval(heartbeat, 25000);
  window.addEventListener('beforeunload', () => myRef.remove());

  _db.ref('presence').on('value', snap => {
    const data = snap.val() || {};
    const now = Date.now();
    const others = Object.entries(data).filter(([uid, v]) => uid !== MY_UID && v && (now - v.t) < 60000);
    const online = others.length > 0;
    const dot = document.getElementById('presence-indicator');
    if (!dot) return;
    dot.className = 'presence-dot ' + (online ? 'presence-online' : 'presence-offline');
    dot.dataset.tip = online ? 'Ton ami est en ligne' : 'Ami hors ligne';
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
    merged[key] = {
      status: bP > aP ? (b.status || 'pending') : (a.status || 'pending'),
      note: (b.note && (!a.note || b.note.length > a.note.length)) ? b.note : (a.note || ''),
    };
    if ((!merged[key].status || merged[key].status === 'pending') && !merged[key].note) delete merged[key];
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
populateDsSelect();
populatePaeFilter();
applyFilters();
updateResumeBtn();


function populatePaeFilter() {
  const sel = document.getElementById('filter-pae');
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
    document.getElementById('card-' + status).classList.add('active');
  }
  applyFilters();
}

function applyFilters() {
  const q = document.getElementById('search').value.toLowerCase();

  filteredData = ACTIVE_COMPANIES.filter(c => {
    const s = state[getKey(c)] || {};
    const status = s.status || 'pending';
    if (activeCardFilter && status !== activeCardFilter) return false;
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

  renderTable();
  updateStats();
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

  tbody.innerHTML = filteredData.map(c => {
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

function toggleCheck(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  const cur = state[key].status || 'pending';
  state[key].status = (cur === 'pending' || cur === 'skip') ? 'done' : 'pending';
  saveState(key);
  updateRow(key);
}

function setStatus(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = el.value;
  saveState(key);
  updateRow(key);
}

function toggleSkip(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === 'skip' ? 'pending' : 'skip';
  saveState(key);
  updateRow(key);
}

function toggleInterested(el) {
  const key = el.dataset.key;
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === 'interested' ? 'done' : 'interested';
  saveState(key);
  updateRow(key);
}

function updateStats() {
  const total  = ACTIVE_COMPANIES.length;
  const counts = { pending:0, done:0, interested:0, skip:0 };
  ACTIVE_COMPANIES.forEach(c => {
    const s = state[getKey(c)] || {};
    counts[s.status || 'pending']++;
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
}

function exportCSV() {
  const toExport = filteredData.length > 0 ? filteredData : ACTIVE_COMPANIES;
  const cols = ['nom','activite','localite','nom_du_pae','telephone','fax','forme_juridique','tva','adresse','cp','statut'];
  const rows = [cols.join(';')];
  toExport.forEach(c => {
    const key = getKey(c);
    const s   = state[key] || {};
    rows.push([
      c.nom, c.activite, c.localite, c.nom_du_pae, c.telephone, c.fax,
      c.forme_juridique, c.tva, c.adresse, c.cp,
      s.status || 'pending'
    ].map(v => '"' + String(v||'').replace(/"/g,'""') + '"').join(';'));
  });
  const label = activeCardFilter ? `_${activeCardFilter}` : '';
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `igretec_prospection${label}.csv`;
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

  closeImportModal();
  populateDsSelect();
  document.getElementById('ds-select').value = dsId;
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

function renderFocusCard() {
  const c = filteredData[focusIndex];
  if (!c) return;
  const key    = getKey(c);
  const s      = state[key] || {};
  const status = s.status || 'pending';

  document.getElementById('focus-counter').textContent = `${focusIndex + 1} / ${filteredData.length}`;

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

  // Téléphone
  const telEl = document.getElementById('focus-tel');
  if (c.telephone) {
    telEl.style.display = 'inline-flex';
    telEl.href = 'tel:' + c.telephone;
    document.getElementById('focus-tel-text').textContent = c.telephone;
  } else { telEl.style.display = 'none'; }

  // Site web
  const webEl = document.getElementById('focus-web');
  if (c.site_web) {
    webEl.style.display = 'inline-flex';
    const url = c.site_web.startsWith('http') ? c.site_web : 'https://' + c.site_web;
    webEl.href = url;
    document.getElementById('focus-web-text').textContent = c.site_web.replace(/^https?:\/\//, '');
  } else { webEl.style.display = 'none'; }

  // Note

  // Buttons active state
  ['interested', 'done', 'skip'].forEach(st => {
    document.getElementById('fbtn-' + st).classList.toggle('active', status === st);
  });
}

function focusMove(dir) {
  focusIndex = Math.max(0, Math.min(filteredData.length - 1, focusIndex + dir));
  renderFocusCard();
}

function focusAction(action) {
  const c = filteredData[focusIndex];
  if (!c) return;
  const key = getKey(c);
  if (!state[key]) state[key] = {};
  state[key].status = state[key].status === action ? 'pending' : action;
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
