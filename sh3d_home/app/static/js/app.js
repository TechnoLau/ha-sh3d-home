import { Viewer } from './viewer.js?v=0.1.7';
import {
  KIND, OPERATORS, EFFECTS, emptyMapping, normalizeMapping, normalizeRule,
  entityName, domainOf, isOn, stateLabel, visualState, ruleSummary, escapeHtml, domainLabel,
} from './rules.js?v=0.1.7';

const API = new URL('api/', document.baseURI);
const params = new URLSearchParams(location.search);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  models: [],
  model: null,
  scene: null,
  config: null,
  entities: [],
  states: {},
  connected: false,
  haError: null,
  selectedId: null,
  filter: 'all',
  search: '',
  level: null,
  room: null,
  scopeMode: 'home',
  focus: 'dim',
  allLevels: false,
  view: 'iso',
  editMode: true,
  embed: params.get('embed') === '1',
  tab: 'device',
  saveTimer: null,
  saving: false,
  ws: null,
  wsRetry: 0,
  loader: { n: 0, total: 0 },
  dashboard: null,
  offline: false,
};

const els = {
  inspector: $('#inspector'),
  objectList: $('#objectList'),
  floorList: $('#floorList'),
  floorFloat: $('#floorFloat'),
  modelName: $('#modelName'),
  modelMeta: $('#modelMeta'),
  objectCount: $('#objectCount'),
  stageKicker: $('#stageKicker'),
  stageTitle: $('#stageTitle'),
  statusText: $('#statusText'),
  statusDetail: $('#statusDetail'),
  haStatus: $('#haStatus'),
  loader: $('#loader'),
  loaderBar: $('#loaderBar'),
  loaderSub: $('#loaderSub'),
  empty: $('#empty'),
  overlay: $('#overlay'),
  modal: $('#modal'),
  toast: $('#toast'),
  fileInput: $('#fileInput'),
  floating: $('#floating'),
  stage: $('#stage'),
};

let viewer = null;

// ------------------------------------------------------------------ boot
async function init() {
  document.body.classList.toggle('embed', state.embed);
  document.body.classList.toggle('night', params.get('theme') === 'night');
  if (params.get('chrome') === '0') document.body.classList.add('no-chrome');
  state.editMode = !state.embed;
  updateEditButton();
  bindShell();
  await Promise.all([loadEntities(), loadModels()]);
  connectWS();
}

async function api(path, options = {}) {
  const url = new URL(path, API);
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.text()) || message; } catch {}
    throw new Error(message || `HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res;
}

async function loadEntities() {
  try {
    const data = await api('entities');
    state.entities = data.entities || [];
    state.states = Object.fromEntries(state.entities.map(e => [e.entity_id, e]));
    state.connected = !!data.connected;
    state.haError = data.error;
    updateHAStatus();
  } catch (err) {
    state.offline = true;
    state.haError = err.message;
    updateHAStatus();
  }
}

async function loadModels() {
  try {
    const data = await api('models');
    state.models = data.models || [];
  } catch (err) {
    toast('Modelle konnten nicht geladen werden: ' + err.message, true);
    state.models = [];
  }
  if (!state.models.length) {
    setEmpty(true);
    updateProject();
    updateStatus();
    return;
  }
  setEmpty(false);
  const wanted = params.get('model');
  const model = state.models.find(m => m.id === wanted) || state.models[0];
  await openModel(model);
}

async function openModel(model) {
  if (!model) return;
  state.model = model;
  state.selectedId = null;
  closeInspector();
  showLoader(true, 'Modell wird geladen');
  try {
    const [scene, config] = await Promise.all([
      api(`models/${model.id}/scene`),
      api(`models/${model.id}/config`),
    ]);
    state.scene = scene;
    state.config = config;
    state.config.mappings = state.config.mappings || {};
    state.level = scene.levels[0]?.id || null;
    state.room = null;
    updateProject();
    renderFloors();
    renderObjects();
    ensureViewer();
    viewer.setTheme(document.body.classList.contains('night'));
    viewer.modelBase = new URL(`models/${model.id}/assets/`, API).href;
    viewer.progress((n, total) => {
      state.loader = { n, total };
      setLoaderProgress(total ? n / total : 0, `${n} von ${total} Objekten`);
    });
    await viewer.load(scene, state.config, viewer.modelBase);
    hideLoader();
    setEmpty(false);
    applyInitialScope();
    updateStageTitle();
    updateStatus();
    renderObjects();
    if (state.selectedId && !scene.objects.find(o => o.id === state.selectedId)) state.selectedId = null;
    viewer.setStates(state.states);
  } catch (err) {
    hideLoader();
    window.__lastError = String(err?.stack || err);
    console.error('openModel failed', err);
    toast('Modell konnte nicht geöffnet werden: ' + err.message, true);
  }
}

function ensureViewer() {
  if (viewer) return;
  viewer = new Viewer($('#viewport'), $('#labels'), $('#floating'), {
    onViewChange: v => {
      state.view = v;
      $$('.view-tabs button').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
    },
    onLevelChange: (level) => {
      state.level = level;
      renderFloors();
      updateStageTitle();
    },
  });
  window.__sh3dViewer = viewer;
  viewer.walkHint = $('#walkHint');
  viewer.walkPad = $('#walkPad');
  $$('#walkPad [data-move]').forEach(btn => {
    const key = btn.dataset.move;
    const add = e => { e.preventDefault(); viewer.movePad.add(key); };
    const del = e => { e.preventDefault(); viewer.movePad.delete(key); };
    btn.addEventListener('pointerdown', add);
    btn.addEventListener('pointerup', del);
    btn.addEventListener('pointerleave', del);
    btn.addEventListener('pointercancel', del);
  });
  viewer.onObjectClick = onSceneObjectClick;
  viewer.onObjectLongPress = onSceneObjectLongPress;
  viewer.onFloatClick = onFloatClick;
  viewer.onRoomClick = onRoomClick;
  viewer.onBackgroundClick = () => { if (state.embed) closeModal(); else closeInspector(); };
  $('#btnExitWalk').addEventListener('click', () => viewer.exitWalk());
}

function applyInitialScope() {
  if (!state.scene) return;
  const qMode = params.get('mode');
  const qLevel = params.get('level');
  const qRoom = params.get('room');
  const qFocus = params.get('focus');
  const qView = params.get('view');
  const qAll = params.get('all');
  const d = state.config?.dashboard || {};
  state.scopeMode = ['home', 'floor', 'room'].includes(qMode) ? qMode : (d.mode || 'home');
  state.level = state.scene.levels.some(l => l.id === qLevel) ? qLevel : (state.scene.levels.some(l => l.id === d.level) ? d.level : state.scene.levels[0]?.id);
  const levelsRooms = state.scene.rooms.filter(r => r.level === state.level);
  state.room = state.scene.rooms.some(r => r.id === qRoom) ? qRoom : (state.scene.rooms.some(r => r.id === d.room) ? d.room : (state.scopeMode === 'room' ? levelsRooms[0]?.id : null));
  state.focus = ['none', 'dim', 'isolate'].includes(qFocus) ? qFocus : (d.focus || 'dim');
  state.allLevels = qAll === '1' || (qAll !== '0' && !!d.allLevels);
  state.view = ['iso', 'front', 'top', 'walk'].includes(qView) ? qView : (d.view || 'iso');
  if (params.get('walk') === '1') state.view = 'walk';
  viewer.setScope({ mode: state.scopeMode, level: state.level, room: state.room, focus: state.focus, allLevels: state.allLevels, fit: false });
  viewer.setView(state.view);
  viewer.setAutoRotate(params.get('rotate') === '1' || !!d.autoRotate);
  $('#btnRotate').classList.toggle('is-active', !!d.autoRotate || params.get('rotate') === '1');
  renderFloors();
  updateStageTitle();
  updateEditButton();
}

// ------------------------------------------------------------------ shell events
function bindShell() {
  $('#btnUpload').addEventListener('click', pickFile);
  $('#btnEmptyUpload').addEventListener('click', pickFile);
  $('#btnChangeModel').addEventListener('click', openModelPicker);
  $('#btnSidebarOpen').addEventListener('click', () => document.body.classList.add('sidebar-open'));
  $('#btnSidebarClose').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  $('#btnAllLevels').addEventListener('click', () => {
    state.allLevels = !state.allLevels;
    viewer?.setScope({ allLevels: state.allLevels });
    renderFloors();
    toast(state.allLevels ? 'Alle Etagen sichtbar' : 'Etagenansicht');
  });
  $('#search').addEventListener('input', e => { state.search = e.target.value; renderObjects(); });
  $$('.filter').forEach(btn => btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    $$('.filter').forEach(b => b.classList.toggle('is-active', b === btn));
    renderObjects();
  }));
  $$('.view-tabs button').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.view === 'walk') viewer?.setView('walk');
    else viewer?.setView(btn.dataset.view);
  }));
  $('#btnRotate').addEventListener('click', () => {
    const on = !$('#btnRotate').classList.contains('is-active');
    viewer?.setAutoRotate(on);
    $('#btnRotate').classList.toggle('is-active', on);
    toast(on ? 'Sanfte Drehung an' : 'Sanfte Drehung aus');
  });
  $('#btnFullscreen').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await els.stage.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast('Vollbild wird von diesem Browser nicht unterstützt', true); }
  });
  $('#btnEditMode').addEventListener('click', () => {
    state.editMode = !state.editMode;
    updateEditButton();
    toast(state.editMode ? 'Bearbeiten: Objekt antippen zum Auswählen' : 'Live: Objekt antippen schaltet');
  });
  $('#btnDashboard').addEventListener('click', openDashboardModal);
  $('#btnSettings').addEventListener('click', openSettingsModal);
  $('#btnSidebarOpen').addEventListener('click', () => renderObjects());
  $('#fileInput').addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) uploadModel(file);
  });
  els.overlay.addEventListener('click', e => { if (e.target === els.overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (els.overlay.classList.contains('is-open')) closeModal();
      else if (els.inspector.classList.contains('is-open')) closeInspector();
      else document.body.classList.remove('sidebar-open');
    }
  });
  ['dragenter', 'dragover'].forEach(ev => els.stage.addEventListener(ev, e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault(); els.stage.classList.add('is-drop');
  }));
  ['dragleave', 'drop'].forEach(ev => els.stage.addEventListener(ev, e => {
    if (ev === 'drop' && e.dataTransfer?.files?.length) {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.name.toLowerCase().endsWith('.sh3d')) uploadModel(file);
      else toast('Bitte eine .sh3d-Datei ablegen', true);
    }
    els.stage.classList.remove('is-drop');
  }));
  window.addEventListener('beforeunload', () => {
    if (state.saveTimer) { clearTimeout(state.saveTimer); saveConfig(); }
  });
}

function updateEditButton() {
  const btn = $('#btnEditMode');
  if (!btn) return;
  btn.classList.toggle('is-edit', state.editMode);
  btn.classList.toggle('is-live', !state.editMode);
  btn.querySelector('span').textContent = state.editMode ? 'Bearbeiten' : 'Live';
}

// ------------------------------------------------------------------ model UI
function updateProject() {
  if (!state.model) {
    els.modelName.textContent = 'Kein Modell';
    els.modelMeta.textContent = 'Lade eine .sh3d-Datei hoch';
    return;
  }
  const st = state.model.stats || {};
  els.modelName.textContent = state.model.name;
  els.modelMeta.textContent = `${st.levels || 0} Etagen · ${st.rooms || 0} Räume · ${st.lights || 0} Lichter`;
  if (params.get('chrome') !== '0') els.stageTitle.textContent = state.model.name;
}

function renderFloors() {
  if (!state.scene) { els.floorList.innerHTML = ''; els.floorFloat.innerHTML = ''; return; }
  const levels = state.scene.levels;
  els.floorList.innerHTML = levels.map((l, i) => `
    <button class="floor-chip ${l.id === state.level && !state.allLevels ? 'is-active' : ''}" data-level="${escapeHtml(l.id)}">
      <span class="floor-idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="floor-name">${escapeHtml(l.name)}</span>
      <span class="floor-h">${l.elevation ? '+' + (l.elevation / 100).toFixed(1) + 'm' : 'EG'}</span>
    </button>`).join('');
  $$('.floor-chip', els.floorList).forEach(btn => btn.addEventListener('click', () => setLevel(btn.dataset.level)));
  els.floorFloat.innerHTML = levels.map(l => `<button class="${l.id === state.level && !state.allLevels ? 'is-active' : ''}" data-level="${escapeHtml(l.id)}">${escapeHtml(l.name)}</button>`).join('');
  $$('button', els.floorFloat).forEach(btn => btn.addEventListener('click', () => setLevel(btn.dataset.level)));
  els.floorFloat.classList.toggle('is-hidden', state.embed && params.get('chrome') === '0');
}

function setLevel(level) {
  if (!state.scene) return;
  state.level = level;
  state.allLevels = false;
  if (state.scopeMode === 'room') {
    const first = state.scene.rooms.find(r => r.level === level);
    state.room = first?.id || null;
  }
  viewer?.setScope({ level, room: state.room, allLevels: false });
  renderFloors();
  updateStageTitle();
  renderObjects();
}

function updateStageTitle() {
  if (!state.scene) { els.stageKicker.textContent = 'Übersicht'; return; }
  const level = state.scene.levels.find(l => l.id === state.level);
  const room = state.scene.rooms.find(r => r.id === state.room);
  if (state.scopeMode === 'room' && room) {
    els.stageKicker.textContent = level?.name || 'Raum';
    els.stageTitle.textContent = room.name;
  } else {
    els.stageKicker.textContent = state.allLevels ? 'Ganzes Haus' : (level?.name || 'Etage');
    els.stageTitle.textContent = state.model?.name || 'SH3D Home';
  }
}

function categoryMatches(obj) {
  if (state.filter === 'all') return true;
  if (state.filter === 'opening') return obj.kind === 'door' || obj.kind === 'window';
  if (state.filter === 'audio') return obj.kind === 'speaker';
  if (state.filter === 'screen') return obj.kind === 'display' || obj.kind === 'computer';
  return obj.kind === state.filter;
}

function renderObjects() {
  if (!state.scene) { els.objectList.innerHTML = ''; els.objectCount.textContent = '0'; return; }
  const q = state.search.trim().toLowerCase();
  const rooms = new Map(state.scene.rooms.map(r => [r.id, r]));
  const items = state.scene.objects
    .filter(o => (state.allLevels || o.level === state.level) && categoryMatches(o))
    .filter(o => !q || `${o.name} ${o.catalog} ${rooms.get(o.room)?.name || ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const af = a.kind === 'furniture' ? 1 : 0, bf = b.kind === 'furniture' ? 1 : 0;
      if (af !== bf) return af - bf;
      return (a.name || '').localeCompare(b.name || '', 'de');
    });
  els.objectCount.textContent = String(items.length);
  if (!items.length) {
    els.objectList.innerHTML = `<div class="object-empty">Keine Objekte in dieser Auswahl.</div>`;
    return;
  }
  els.objectList.innerHTML = items.map(o => {
    const m = state.config?.mappings?.[o.id];
    const entity = m?.entity_id ? state.states[m.entity_id] : null;
    const mapped = !!m?.entity_id;
    const km = KIND[o.kind] || KIND.furniture;
    const room = rooms.get(o.room)?.name || '';
    const value = entity ? stateLabel(entity, o.kind) : (m ? 'Regel' : 'zuordnen');
    return `<button class="object-item ${state.selectedId === o.id ? 'is-selected' : ''}" data-id="${escapeHtml(o.id)}">
      <span class="object-icon k-${o.kind}"><svg><use href="#${km.icon}"/></svg></span>
      <span class="object-copy"><span class="object-name">${escapeHtml(o.name)}</span><span class="object-sub">${escapeHtml(room || km.label)}${mapped ? ' · ' + escapeHtml(entity?.attributes?.friendly_name || '') : ''}</span></span>
      <span class="object-tail"><span class="mapped-dot ${mapped ? '' : 'off'}"></span><span class="object-state">${escapeHtml(value)}</span></span>
    </button>`;
  }).join('');
  $$('.object-item', els.objectList).forEach(el => el.addEventListener('click', () => {
    const obj = state.scene.objects.find(o => o.id === el.dataset.id);
    if (obj) selectObject(obj, true);
  }));
}

function selectObject(obj, focus = true) {
  state.selectedId = obj.id;
  viewer?.selectObject(obj.id);
  if (focus) viewer?.focusObject(obj.id);
  renderObjects();
  openInspector(obj);
}

// ------------------------------------------------------------------ viewer callbacks
function onSceneObjectClick(obj) {
  const mapping = state.config?.mappings?.[obj.id];
  if (state.editMode) { selectObject(obj); return; }
  if (mapping?.entity_id && mapping.tap !== false) { toggleObject(obj); return; }
  if (mapping) { openSheet(obj); return; }
  selectObject(obj);
}

function onSceneObjectLongPress(obj) {
  if (state.embed) openSheet(obj);
  else { selectObject(obj); state.tab = 'device'; renderInspector(obj); }
}

function onFloatClick(obj) {
  toggleObject(obj);
}

function onRoomClick(room) {
  state.scopeMode = 'room';
  state.room = room.id;
  state.level = room.level;
  state.focus = state.focus === 'none' ? 'dim' : state.focus;
  viewer?.setScope({ mode: 'room', level: room.level, room: room.id, focus: state.focus, allLevels: false });
  renderFloors();
  updateStageTitle();
  renderObjects();
  toast(`Zimmer: ${room.name}`);
}

async function toggleObject(obj) {
  const mapping = state.config?.mappings?.[obj.id];
  if (!mapping?.entity_id) {
    if (state.embed) {
      toast('Diesem Objekt ist noch kein Gerät zugeordnet');
    } else {
      selectObject(obj);
      state.tab = 'device';
      renderInspector(obj);
      toast('Wähle zuerst ein Home-Assistant-Gerät');
    }
    return;
  }
  const domain = domainOf(mapping.entity_id);
  if (domain === 'climate') { openSheet(obj); return; }
  if (domain === 'sensor' || domain === 'binary_sensor' && !['door', 'window', 'display', 'computer'].includes(obj.kind)) {
    toast('Sensor kann nicht geschaltet werden'); return;
  }
  if (domain === 'binary_sensor') {
    if (['display', 'computer'].includes(obj.kind)) { openSheet(obj); return; }
    toast('Öffnungssensor – keine Schaltfläche'); return;
  }
  try {
    await api('service', { method: 'POST', body: { entity_id: mapping.entity_id, action: 'toggle' } });
    toast(`${entityName(state.states, mapping.entity_id, obj.name)} geschaltet`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------ inspector
function openInspector(obj) {
  if (state.embed) { openSheet(obj); return; }
  els.inspector.classList.add('is-open');
  renderInspector(obj);
  if (window.innerWidth < 860) document.body.classList.remove('sidebar-open');
}

function closeInspector() {
  els.inspector.classList.remove('is-open');
  state.selectedId = null;
  viewer?.selectObject(null);
  renderObjects();
}

function renderInspector(obj) {
  if (!obj) return;
  const m = state.config?.mappings?.[obj.id] ? normalizeMapping(state.config.mappings[obj.id]) : null;
  const km = KIND[obj.kind] || KIND.furniture;
  const room = state.scene.rooms.find(r => r.id === obj.room);
  const level = state.scene.levels.find(l => l.id === obj.level);
  const entity = m?.entity_id ? state.states[m.entity_id] : null;
  const tab = state.tab || 'device';
  els.inspector.innerHTML = `
    <div class="inspector-head">
      <div class="object-icon k-${obj.kind}"><svg><use href="#${km.icon}"/></svg></div>
      <div class="inspector-title">
        <h2>${escapeHtml(m?.label || obj.name)}</h2>
        <p>${escapeHtml(km.label)} · ${escapeHtml(room?.name || level?.name || '')}</p>
      </div>
      <button class="icon-btn" id="inspClose" aria-label="Schließen"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="inspector-tabs">
      <button data-tab="device" class="${tab === 'device' ? 'is-active' : ''}">Gerät</button>
      <button data-tab="rules" class="${tab === 'rules' ? 'is-active' : ''}">Regeln ${m?.rules?.length ? `<span class="counter">${m.rules.length}</span>` : ''}</button>
      <button data-tab="look" class="${tab === 'look' ? 'is-active' : ''}">Darstellung</button>
    </div>
    <div class="inspector-body" id="inspBody"></div>`;
  $('#inspClose').addEventListener('click', closeInspector);
  $$('.inspector-tabs button', els.inspector).forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderInspector(obj); }));
  const body = $('#inspBody');
  if (tab === 'rules') renderRulesTab(body, obj, m);
  else if (tab === 'look') renderLookTab(body, obj, m);
  else renderDeviceTab(body, obj, m);
}

function entityOptions(selected, recommended = []) {
  const list = state.entities.filter(e => !e.attributes?._hidden);
  const groups = new Map();
  for (const e of list) {
    const d = domainOf(e.entity_id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(e);
  }
  const rec = new Set(recommended);
  const ordered = [...groups.keys()].sort((a, b) => (rec.has(b) ? 1 : 0) - (rec.has(a) ? 1 : 0) || a.localeCompare(b));
  let html = `<option value="">– nicht zugeordnet –</option>`;
  for (const domain of ordered) {
    html += `<optgroup label="${escapeHtml(domainLabel(domain))}">`;
    for (const e of groups.get(domain)) {
      const name = e.attributes?.friendly_name || e.entity_id;
      html += `<option value="${escapeHtml(e.entity_id)}" ${selected === e.entity_id ? 'selected' : ''}>${escapeHtml(name)} · ${escapeHtml(e.entity_id)}</option>`;
    }
    html += `</optgroup>`;
  }
  return html;
}

function updateMapping(obj, patch, rerender = true) {
  if (!state.config) return;
  const existing = normalizeMapping(state.config.mappings[obj.id] || {});
  const next = { ...existing, ...patch, appearance: { ...existing.appearance, ...(patch.appearance || {}) } };
  next.rules = (patch.rules !== undefined ? patch.rules : existing.rules).map(normalizeRule);
  if (!next.entity_id && !next.rules.length && !next.label) delete state.config.mappings[obj.id];
  else state.config.mappings[obj.id] = next;
  viewer?.setMappings(state.config.mappings);
  scheduleSave();
  if (rerender) { renderObjects(); if (!state.embed && state.selectedId === obj.id) renderInspector(obj); }
}

function renderDeviceTab(body, obj, m) {
  const entity = m?.entity_id ? state.states[m.entity_id] : null;
  const km = KIND[obj.kind] || KIND.furniture;
  const domain = m?.entity_id ? domainOf(m.entity_id) : '';
  body.innerHTML = `
    <div class="section">
      <h3>Home-Assistant-Gerät</h3>
      <div class="entity-card ${m?.entity_id ? '' : 'is-empty'}">
        ${m?.entity_id ? `
          <div class="entity-main">
            <div class="entity-copy" style="min-width:0;flex:1">
              <div class="entity-name">${escapeHtml(entity?.attributes?.friendly_name || m.entity_id)}</div>
              <div class="entity-id">${escapeHtml(m.entity_id)}</div>
            </div>
            <span class="entity-state ${isOn(entity, obj.kind) ? 'on' : (entity?.state === 'unavailable' ? 'unavailable' : 'off')}" data-live-state>${escapeHtml(stateLabel(entity, obj.kind))}</span>
          </div>
          <div class="entity-actions">
            <button class="btn btn-small" data-act="toggle">${domain === 'cover' ? 'Öffnen / Schließen' : domain === 'media_player' ? 'Play / Pause' : 'An / Aus'}</button>
            <button class="btn btn-small btn-ghost" data-act="clear">Entfernen</button>
          </div>
        ` : `<div class="hint">Noch kein Gerät zugewiesen. Wähle unten eine Entität aus.</div>`}
      </div>
      <div class="field" style="margin-top:10px">
        <label for="entitySelect">Entität wählen</label>
        <select class="select" id="entitySelect">${entityOptions(m?.entity_id || '', km.domains)}</select>
      </div>
      ${!m?.entity_id ? `<div class="insight"><svg><use href="#i-link"/></svg><div>Empfohlen: ${km.domains.map(d => domainLabel(d)).join(', ')}. Du kannst jede passende Entität verwenden.</div></div>` : ''}
    </div>

    <div class="section">
      <h3>Interaktion</h3>
      <div class="toggle-row"><div class="toggle-copy"><strong>Tippen auf das Objekt</strong><small>Im Live-Modus direkt schalten</small></div><button class="switch ${m?.tap !== false ? 'is-on' : ''}" data-toggle="tap" aria-label="Tippen"></button></div>
      <div class="toggle-row"><div class="toggle-copy"><strong>Schwebender Knopf</strong><small>Kleiner Knopf über dem Objekt</small></div><button class="switch ${m?.button !== false ? 'is-on' : ''}" data-toggle="button" aria-label="Knopf"></button></div>
      <div class="field" style="margin-top:10px"><label for="labelInput">Eigener Name (optional)</label><input class="input" id="labelInput" value="${escapeHtml(m?.label || '')}" placeholder="${escapeHtml(obj.name)}"></div>
    </div>
    ${renderQuickControls(obj, m, entity)}
    ${renderAssociationInfo(obj, m, entity)}
  `;
  $('#entitySelect').addEventListener('change', e => {
    const id = e.target.value;
    updateMapping(obj, { entity_id: id, tap: true, button: true });
  });
  $$('[data-act]', body).forEach(btn => btn.addEventListener('click', async () => {
    if (btn.dataset.act === 'clear') { updateMapping(obj, { entity_id: '', tap: false, button: false }); return; }
    if (btn.dataset.act === 'toggle' && m?.entity_id) { await toggleEntity(obj, m.entity_id); }
  }));
  $$('[data-toggle]', body).forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.toggle;
    const current = key === 'tap' ? m?.tap !== false : m?.button !== false;
    updateMapping(obj, { [key]: !current });
  }));
  $('#labelInput').addEventListener('change', e => updateMapping(obj, { label: e.target.value.trim() }));
  bindQuickControls(body, obj, m, entity);
}

function renderQuickControls(obj, m, entity) {
  if (!m?.entity_id || !entity) return '';
  const domain = domainOf(m.entity_id);
  if (obj.kind === 'light' || domain === 'light') {
    const rgb = entity.attributes?.rgb_color;
    const hex = rgb ? '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : (m.appearance.color || '#ffbf7a');
    const bright = Math.round((entity.attributes?.brightness ?? 255) / 2.55);
    const effects = entity.attributes?.effect_list || [];
    return `<div class="section"><h3>Licht</h3>
      <div class="field"><label>Farbe</label><div class="color-row">
        ${['#ffb46b', '#ffd78a', '#e8f1d3', '#9bd6ff', '#c4a7ff', '#ff8e9c'].map(c => `<button class="color-dot ${hex.toLowerCase() === c ? 'is-active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></button>`).join('')}
        <input type="color" id="lightColor" value="${hex}" title="Eigene Farbe">
      </div></div>
      <div class="field"><label>Helligkeit</label><div class="slider-row"><input type="range" id="lightBright" min="1" max="100" value="${Math.max(1, bright)}"><output>${bright}%</output></div></div>
      ${entity.attributes?.min_color_temp_kelvin ? `<div class="field"><label>Weißton</label><div class="slider-row"><input type="range" id="lightTemp" min="${entity.attributes.min_color_temp_kelvin}" max="${entity.attributes.max_color_temp_kelvin}" value="${entity.attributes.color_temp_kelvin || 3000}"><output>${entity.attributes.color_temp_kelvin || 3000}K</output></div></div>` : ''}
      ${effects.length ? `<div class="field"><label>Effekt</label><div class="chip-row">${effects.slice(0, 8).map(e => `<button class="chip ${entity.attributes?.effect === e ? 'is-active' : ''}" data-effect="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}</div></div>` : ''}
    </div>`;
  }
  if (obj.kind === 'heating' || domain === 'climate') {
    const cur = entity.attributes?.current_temperature;
    const target = entity.attributes?.temperature ?? 20;
    return `<div class="section"><h3>Heizung</h3>
      <div class="insight"><svg><use href="#i-heat"/></svg><div>Aktuell <b>${cur !== undefined ? Number(cur).toFixed(1) + ' °C' : '–'}</b> · Ziel <b>${Number(target).toFixed(1)} °C</b></div></div>
      <div class="field" style="margin-top:10px"><label>Zieltemperatur</label><div class="slider-row"><input type="range" id="heatTarget" min="5" max="30" step="0.5" value="${target}"><output>${Number(target).toFixed(1)} °C</output></div></div>
      <div class="btn-row"><button class="btn btn-small" data-act="heat-down">− 0,5°</button><button class="btn btn-small" data-act="heat-up">+ 0,5°</button></div>
    </div>`;
  }
  if (obj.kind === 'door' || obj.kind === 'window' || domain === 'cover') {
    const pos = entity.attributes?.current_position;
    const isCover = domain === 'cover';
    return `<div class="section"><h3>${obj.kind === 'window' ? 'Fenster' : 'Öffnung'}</h3>
      ${isCover ? `<div class="field"><label>Position</label><div class="slider-row"><input type="range" id="coverPos" min="0" max="100" value="${pos ?? 0}"><output>${Math.round(pos ?? 0)}%</output></div></div>` : ''}
      <div class="insight"><svg><use href="#i-${obj.kind === 'window' ? 'window' : 'door'}"/></svg><div>${isCover ? 'Rollladen / Antrieb steuerbar' : 'Sensorstatus wird live auf das Modell übertragen.'}</div></div>
    </div>`;
  }
  if (obj.kind === 'speaker' || domain === 'media_player') {
    const vol = Math.round((entity.attributes?.volume_level ?? 0.2) * 100);
    return `<div class="section"><h3>Audio</h3>
      <div class="insight"><svg><use href="#i-speaker"/></svg><div>${escapeHtml(entity.attributes?.media_title || entity.state)}</div></div>
      <div class="field" style="margin-top:10px"><label>Lautstärke</label><div class="slider-row"><input type="range" id="mediaVol" min="0" max="100" value="${vol}"><output>${vol}%</output></div></div>
    </div>`;
  }
  if (obj.kind === 'display' || obj.kind === 'computer') {
    return `<div class="section"><h3>Bildschirm</h3><div class="insight"><svg><use href="#i-screen"/></svg><div>Der Bildschirm leuchtet, wenn die Entität an ist. Für komplexe Szenen kannst du Regeln mit beliebig vielen Bedingungen anlegen.</div></div></div>`;
  }
  return '';
}

function renderAssociationInfo(obj, m, entity) {
  if (!m?.entity_id) return '';
  const domain = domainOf(m.entity_id);
  if (obj.kind === 'display' && domain === 'binary_sensor') {
    return `<div class="insight warn"><svg><use href="#i-bolt"/></svg><div>Dies ist ein Sensor. Damit der Monitor bei PC-An leuchtet, lege unter <b>Regeln</b> eine Bedingung an.</div></div>`;
  }
  return '';
}

function bindQuickControls(body, obj, m, entity) {
  if (!m?.entity_id) return;
  const call = (action, data) => api('service', { method: 'POST', body: { entity_id: m.entity_id, action, data } }).catch(err => toast(err.message, true));
  const color = $('#lightColor', body);
  if (color) {
    color.addEventListener('change', e => call('set_color', { rgb_color: hexToRgb(e.target.value) }));
    $$('[data-color]', body).forEach(btn => btn.addEventListener('click', () => call('set_color', { rgb_color: hexToRgb(btn.dataset.color) })));
    $('#lightBright', body)?.addEventListener('change', e => call('set_brightness', { brightness_pct: Number(e.target.value) }));
    $('#lightTemp', body)?.addEventListener('change', e => call('set_color', { color_temp_kelvin: Number(e.target.value) }));
    $$('[data-effect]', body).forEach(btn => btn.addEventListener('click', () => call('set_color', { effect: btn.dataset.effect })));
  }
  const heat = $('#heatTarget', body);
  if (heat) {
    heat.addEventListener('change', e => call('set_temperature', { temperature: Number(e.target.value) }));
    $('[data-act="heat-down"]', body)?.addEventListener('click', () => call('set_temperature', { temperature: Math.max(5, Number(heat.value) - 0.5) }));
    $('[data-act="heat-up"]', body)?.addEventListener('click', () => call('set_temperature', { temperature: Math.min(30, Number(heat.value) + 0.5) }));
  }
  const cover = $('#coverPos', body);
  if (cover) cover.addEventListener('change', e => call('set_position', { position: Number(e.target.value) }));
  const vol = $('#mediaVol', body);
  if (vol) vol.addEventListener('change', e => call('set_volume', { volume_level: Number(e.target.value) / 100 }));
}

async function toggleEntity(obj, entityId) {
  const domain = domainOf(entityId);
  if (domain === 'climate') { openSheet(obj); return; }
  if (domain === 'sensor' || domain === 'binary_sensor') { toast('Sensor kann nicht geschaltet werden'); return; }
  try {
    await api('service', { method: 'POST', body: { entity_id: entityId, action: 'toggle' } });
    toast('Befehl gesendet');
  } catch (err) { toast(err.message, true); }
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

// ------------------------------------------------------------------ rules tab
function renderRulesTab(body, obj, m) {
  const rules = m?.rules || [];
  body.innerHTML = `
    <div class="section">
      <div class="section-head"><h3>Bedingungen</h3><button class="btn btn-small" id="addRule"><svg><use href="#i-plus"/></svg> Regel</button></div>
      <div class="rule-list">
        ${rules.length ? rules.map((r, i) => `
          <div class="rule-card" data-rule="${i}">
            <div class="rule-head">
              <span class="rule-name">${escapeHtml(r.name || 'Regel')}</span>
              <button class="switch ${r.enabled !== false ? 'is-on' : ''}" data-rule-toggle="${i}" aria-label="Regel aktiv"></button>
              <div class="rule-actions">
                <button class="icon-btn" data-rule-edit="${i}" title="Bearbeiten"><svg><use href="#i-edit"/></svg></button>
                <button class="icon-btn" data-rule-del="${i}" title="Löschen"><svg><use href="#i-trash"/></svg></button>
              </div>
            </div>
            <div class="rule-conditions">${escapeHtml(ruleSummary(r, state.states))}</div>
            <span class="rule-effect"><svg style="width:11px;height:11px"><use href="#i-bolt"/></svg>${escapeHtml(ruleEffectLabel(r.effect))}</span>
          </div>`).join('') : `<div class="rule-empty">Noch keine Regel. Damit kannst du z. B. den Monitor leuchten lassen, wenn der PC an ist.</div>`}
      </div>
    </div>
    <div class="section">
      <h3>So funktioniert es</h3>
      <div class="insight"><svg><use href="#i-bolt"/></svg><div>Regeln werden zusätzlich zum Gerätezustand ausgewertet. <b>UND</b> verknüpft alle Bedingungen, <b>ODER</b> reicht eine. Regeln können Farben, Helligkeit, Bildschirm, Öffnungen und Temperaturen setzen.</div></div>
    </div>
    <div class="section">
      <div class="btn-row"><button class="btn btn-small" id="presetPc">Preset: PC → Monitor</button><button class="btn btn-small" id="presetAvail">Preset: verfügbar</button></div>
    </div>`;
  $('#addRule').addEventListener('click', () => openRuleModal(obj, null));
  $$('[data-rule-edit]', body).forEach(b => b.addEventListener('click', () => openRuleModal(obj, Number(b.dataset.ruleEdit))));
  $$('[data-rule-del]', body).forEach(b => b.addEventListener('click', () => {
    const rules2 = [...(m?.rules || [])]; rules2.splice(Number(b.dataset.ruleDel), 1); updateMapping(obj, { rules: rules2 });
  }));
  $$('[data-rule-toggle]', body).forEach(b => b.addEventListener('click', () => {
    const rules2 = (m?.rules || []).map((r, i) => i === Number(b.dataset.ruleToggle) ? { ...r, enabled: r.enabled === false } : r);
    updateMapping(obj, { rules: rules2 });
  }));
  $('#presetPc').addEventListener('click', () => {
    const pc = Object.values(state.states).find(e => {
      const d = domainOf(e.entity_id);
      return ['binary_sensor', 'switch', 'device_tracker'].includes(d) && /(^|[^a-z])(pc|computer|rechner|desktop)([^a-z]|$)/i.test(`${e.entity_id} ${e.attributes?.friendly_name || ''}`);
    });
    openRuleModal(obj, null, {
      name: 'PC an → Bildschirm',
      match: 'all',
      conditions: [{ entity_id: pc?.entity_id || m?.entity_id || '', attribute: 'state', op: 'is', value: pc ? 'on' : 'on' }],
      effect: { type: 'screen' },
    });
  });
  $('#presetAvail').addEventListener('click', () => openRuleModal(obj, null, {
    name: 'Gerät verfügbar',
    match: 'all',
    conditions: [{ entity_id: m?.entity_id || '', attribute: 'state', op: 'available', value: '' }],
    effect: { type: 'on' },
  }));
}

function ruleEffectLabel(eff) {
  if (!eff) return '';
  const base = EFFECTS.find(e => e[0] === eff.type)?.[1] || eff.type;
  if (eff.type === 'color') return `${base} ${eff.color || ''}`;
  if (eff.type === 'brightness') return `${base} ${eff.brightness ?? 100}%`;
  if (eff.type === 'temp') return `${base} ${eff.value ?? ''} °C`;
  return base;
}

function openRuleModal(obj, index = null, preset = null) {
  const mapping = state.config?.mappings?.[obj.id] ? normalizeMapping(state.config.mappings[obj.id]) : null;
  const existing = index !== null ? mapping?.rules?.[index] : null;
  const rule = normalizeRule(existing || preset || {
    name: 'Neue Bedingung',
    match: 'all',
    conditions: [{ entity_id: mapping?.entity_id || '', attribute: 'state', op: 'is', value: 'on' }],
    effect: { type: obj.kind === 'display' ? 'screen' : 'on' },
  });
  els.modal.className = 'modal rule-editor';
  els.modal.innerHTML = `
    <div class="modal-head">
      <div><h2>${existing ? 'Regel bearbeiten' : 'Neue Regel'}</h2><p>${escapeHtml(obj.name)} · komplexe Bedingungen</p></div>
      <button class="icon-btn" data-close><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="field"><label>Name</label><input class="input" id="ruleName" value="${escapeHtml(rule.name)}" placeholder="z. B. PC an → Monitor"></div>
      <div class="field"><label>Verknüpfung</label><div class="segmented" id="ruleMatch"><button data-match="all" class="${rule.match === 'all' ? 'is-active' : ''}">Alle (UND)</button><button data-match="any" class="${rule.match === 'any' ? 'is-active' : ''}">Eine (ODER)</button></div></div>
      <div class="modal-section"><div class="section-head"><h3>Bedingungen</h3><button class="btn btn-small" id="addCond"><svg><use href="#i-plus"/></svg> Bedingung</button></div><div id="conditions"></div></div>
      <div class="modal-section"><h3>Dann</h3>
        <div class="field"><label>Wirkung</label><select class="select" id="effectType">${EFFECTS.map(([v, l]) => `<option value="${v}" ${rule.effect.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field" id="effectColorWrap"><label>Farbe</label><input type="color" id="effectColor" value="${rule.effect.color || '#ffcf8a'}"></div>
        <div class="field" id="effectBrightWrap"><label>Helligkeit</label><div class="slider-row"><input type="range" id="effectBright" min="0" max="100" value="${rule.effect.brightness ?? 100}"><output>${rule.effect.brightness ?? 100}%</output></div></div>
        <div class="field" id="effectValueWrap"><label>Temperatur / Wert</label><input class="input" id="effectValue" value="${escapeHtml(rule.effect.value ?? '')}" placeholder="z. B. 21.5"></div>
      </div>
      <div class="hint">Tipp: Für „PC an → Monitore leuchten“ eine Bedingung auf <code>binary_sensor.pc</code> = <code>on</code> und die Wirkung „Bildschirm an“ wählen. Mehrere Regeln werden nacheinander angewendet.</div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-close>Abbrechen</button><button class="btn btn-primary" id="saveRule"><svg><use href="#i-check"/></svg> Regel speichern</button></div>`;
  openModal();
  let conditions = rule.conditions.map(c => ({ ...c }));
  let match = rule.match;
  const renderConds = () => {
    $('#conditions').innerHTML = conditions.map((c, i) => `
      <div class="condition-row" data-cond="${i}">
        <select class="select" data-c-entity="${i}">${entityOptions(c.entity_id, [])}</select>
        <input class="input" data-c-attr="${i}" value="${escapeHtml(c.attribute || 'state')}" placeholder="Attribut" title="state oder attributes.name">
        <select class="select" data-c-op="${i}">${OPERATORS.map(([v, l]) => `<option value="${v}" ${c.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="input" data-c-val="${i}" value="${escapeHtml(c.value ?? '')}" placeholder="Wert">
        <button class="icon-btn" data-c-del="${i}" title="Entfernen"><svg><use href="#i-close"/></svg></button>
      </div>`).join('');
    $$('[data-c-entity]', $('#conditions')).forEach(el => el.addEventListener('change', () => { conditions[Number(el.dataset.cEntity)].entity_id = el.value; }));
    $$('[data-c-attr]', $('#conditions')).forEach(el => el.addEventListener('input', () => { conditions[Number(el.dataset.cAttr)].attribute = el.value; }));
    $$('[data-c-op]', $('#conditions')).forEach(el => el.addEventListener('change', () => { conditions[Number(el.dataset.cOp)].op = el.value; }));
    $$('[data-c-val]', $('#conditions')).forEach(el => el.addEventListener('input', () => { conditions[Number(el.dataset.cVal)].value = el.value; }));
    $$('[data-c-del]', $('#conditions')).forEach(el => el.addEventListener('click', () => { conditions.splice(Number(el.dataset.cDel), 1); renderConds(); }));
  };
  renderConds();
  const syncEffect = () => {
    const type = $('#effectType').value;
    $('#effectColorWrap').style.display = type === 'color' ? '' : 'none';
    $('#effectBrightWrap').style.display = type === 'brightness' ? '' : 'none';
    $('#effectValueWrap').style.display = type === 'temp' ? '' : 'none';
  };
  $('#effectType').addEventListener('change', syncEffect); syncEffect();
  $$('[data-match]').forEach(b => b.addEventListener('click', () => { match = b.dataset.match; $$('[data-match]').forEach(x => x.classList.toggle('is-active', x === b)); }));
  $('#addCond').addEventListener('click', () => {
    conditions.push({ entity_id: mapping?.entity_id || state.entities[0]?.entity_id || '', attribute: 'state', op: 'is', value: 'on' });
    renderConds();
  });
  $('#effectBright').addEventListener('input', e => e.target.nextElementSibling.textContent = e.target.value + '%');
  $('#saveRule').addEventListener('click', () => {
    const next = normalizeRule({
      ...rule,
      name: $('#ruleName').value.trim() || 'Regel',
      match,
      conditions: conditions.filter(c => c.entity_id),
      effect: {
        type: $('#effectType').value,
        color: $('#effectColor').value,
        brightness: Number($('#effectBright').value),
        value: $('#effectValue').value,
      },
    });
    const rules = [...(mapping?.rules || [])];
    if (index !== null) rules[index] = next; else rules.push(next);
    updateMapping(obj, { rules });
    closeModal();
    toast('Regel gespeichert');
  });
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}

// ------------------------------------------------------------------ look tab
function renderLookTab(body, obj, m) {
  const a = m?.appearance || {};
  const st = state.scene.stats;
  body.innerHTML = `
    <div class="section">
      <h3>Leuchten</h3>
      <div class="field"><label>Glow-Stärke</label><div class="slider-row"><input type="range" id="glowRange" min="0" max="150" value="${Math.round((a.glow ?? 1) * 100)}"><output>${Math.round((a.glow ?? 1) * 100)}%</output></div></div>
      <div class="field"><label>Akzentfarbe (ohne Farb-Entität)</label><div class="color-row"><input type="color" id="accentColor" value="${a.color || '#ffbf7a'}"><button class="btn btn-small btn-ghost" id="clearAccent">Automatisch</button></div></div>
      <p class="hint">Die Farbe aus Home Assistant (RGB) hat Vorrang; diese Farbe ist der Fallback und für Regeln nützlich.</p>
    </div>
    <div class="section">
      <h3>Objekt</h3>
      <div class="stat-grid">
        <div class="stat"><b>${(obj.width / 100).toFixed(2)}</b><span>Breite m</span></div>
        <div class="stat"><b>${(obj.depth / 100).toFixed(2)}</b><span>Tiefe m</span></div>
        <div class="stat"><b>${(obj.height / 100).toFixed(2)}</b><span>Höhe m</span></div>
      </div>
      <p class="hint" style="margin-top:8px">SH3D-ID: <code>${escapeHtml(obj.id)}</code><br>Raum: ${escapeHtml(state.scene.rooms.find(r => r.id === obj.room)?.name || '–')} · Etage: ${escapeHtml(state.scene.levels.find(l => l.id === obj.level)?.name || '–')}</p>
    </div>
    <div class="section">
      <h3>Modell</h3>
      <div class="stat-grid">
        <div class="stat"><b>${st.lights}</b><span>Lichter</span></div>
        <div class="stat"><b>${st.windows}</b><span>Fenster</span></div>
        <div class="stat"><b>${st.doors}</b><span>Türen</span></div>
      </div>
    </div>
    <button class="btn btn-danger btn-wide" id="deleteMapping"><svg><use href="#i-trash"/></svg> Zuordnung löschen</button>`;
  $('#glowRange').addEventListener('input', e => { e.target.nextElementSibling.textContent = e.target.value + '%'; });
  $('#glowRange').addEventListener('change', e => {
    updateMapping(obj, { appearance: { ...a, glow: Number(e.target.value) / 100 } }, false);
    viewer?.setStates(state.states);
  });
  $('#accentColor').addEventListener('change', e => { updateMapping(obj, { appearance: { ...a, color: e.target.value } }, false); viewer?.setStates(state.states); });
  $('#clearAccent').addEventListener('click', () => { updateMapping(obj, { appearance: { ...a, color: '' } }, false); viewer?.setStates(state.states); });
  $('#deleteMapping').addEventListener('click', () => {
    if (!confirm('Zuordnung und Regeln für dieses Objekt löschen?')) return;
    delete state.config.mappings[obj.id];
    viewer?.setMappings(state.config.mappings);
    scheduleSave(); closeInspector(); renderObjects();
    toast('Zuordnung entfernt');
  });
}

// ------------------------------------------------------------------ modal helpers
function openModal() {
  els.overlay.classList.add('is-open');
}
function closeModal() {
  els.overlay.classList.remove('is-open');
  setTimeout(() => { if (!els.overlay.classList.contains('is-open')) els.modal.innerHTML = ''; }, 200);
}

function openSheet(obj) {
  const m = state.config?.mappings?.[obj.id] ? normalizeMapping(state.config.mappings[obj.id]) : null;
  const km = KIND[obj.kind] || KIND.furniture;
  const entity = m?.entity_id ? state.states[m.entity_id] : null;
  const vs = visualState(m ? { ...m, kind: obj.kind } : { kind: obj.kind }, state.states);
  const domain = m?.entity_id ? domainOf(m.entity_id) : '';
  els.modal.className = 'modal sheet';
  els.modal.innerHTML = `
    <div class="modal-head">
      <div><h2>${escapeHtml(m?.label || obj.name)}</h2><p>${escapeHtml(km.label)} · ${escapeHtml(state.scene.rooms.find(r => r.id === obj.room)?.name || '')}</p></div>
      <button class="icon-btn" data-close><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      ${entity ? `
        <div class="big-state ${vs.on ? 'is-on' : ''}">
          <div class="state-orb"><svg><use href="#${km.icon}"/></svg></div>
          <div class="state-copy"><b data-live-name>${escapeHtml(entity.attributes?.friendly_name || m.entity_id)}</b><span data-live-text>${escapeHtml(stateLabel(entity, obj.kind))}</span></div>
        </div>
        ${renderSheetControls(obj, m, entity)}
      ` : `<div class="insight warn"><svg><use href="#i-link"/></svg><div>Für dieses Objekt ist noch kein Gerät zugeordnet.</div></div>`}
    </div>
    <div class="modal-foot">
      ${!state.embed && entity ? `<button class="btn btn-ghost left" data-edit>Bearbeiten</button>` : ''}
      ${entity ? `<button class="btn btn-primary" data-act="toggle">${domain === 'climate' ? 'Heizung öffnen' : 'Umschalten'}</button>` : ''}
      ${!state.embed && !entity ? `<button class="btn btn-primary" data-edit>Gerät zuordnen</button>` : ''}
    </div>`;
  openModal();
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  $('[data-edit]')?.addEventListener('click', () => { closeModal(); selectObject(obj); });
  $('[data-act="toggle"]')?.addEventListener('click', async () => {
    if (domain === 'climate') { closeModal(); selectObject(obj); state.tab = 'device'; renderInspector(obj); return; }
    await toggleEntity(obj, m.entity_id);
    setTimeout(() => { if (els.overlay.classList.contains('is-open')) openSheet(obj); }, 350);
  });
  bindSheetControls(obj, m, entity);
}

function renderSheetControls(obj, m, entity) {
  const domain = domainOf(m.entity_id);
  if (obj.kind === 'heating' || domain === 'climate') {
    const cur = entity.attributes?.current_temperature;
    const target = entity.attributes?.temperature ?? 20;
    return `<div class="section">
      <div class="thermo"><button data-temp="-0.5">−</button><div class="temp"><span data-target>${Number(target).toFixed(1)}</span><small> °C</small></div><button data-temp="0.5">+</button></div>
      <div class="hint" style="text-align:center">Aktuell ${cur !== undefined ? Number(cur).toFixed(1) + ' °C' : '–'} · ${escapeHtml(entity.state)}</div>
      <div class="slider-row" style="margin-top:12px"><input type="range" id="sheetHeat" min="5" max="30" step="0.5" value="${target}"><output>${Number(target).toFixed(1)} °C</output></div>
      <div class="chip-row" style="margin-top:10px">${(entity.attributes?.hvac_modes || ['off', 'heat']).map(x => `<button class="chip ${entity.state === x ? 'is-active' : ''}" data-hvac="${escapeHtml(x)}">${escapeHtml(hvacLabel(x))}</button>`).join('')}</div>
    </div>`;
  }
  if (domain === 'light' || obj.kind === 'light') {
    const rgb = entity.attributes?.rgb_color;
    const hex = rgb ? '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : (m.appearance.color || '#ffbf7a');
    const bright = Math.round((entity.attributes?.brightness ?? 255) / 2.55);
    const effects = entity.attributes?.effect_list || [];
    return `<div class="section">
      <div class="field"><label>Farbe</label><div class="color-row">${['#ffb46b', '#ffd78a', '#e8f1d3', '#9bd6ff', '#c4a7ff', '#ff8e9c'].map(c => `<button class="color-dot ${hex.toLowerCase() === c ? 'is-active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')}<input type="color" id="sheetColor" value="${hex}"></div></div>
      <div class="field"><label>Helligkeit</label><div class="slider-row"><input type="range" id="sheetBright" min="1" max="100" value="${Math.max(1, bright)}"><output>${bright}%</output></div></div>
      ${entity.attributes?.min_color_temp_kelvin ? `<div class="field"><label>Weißton</label><div class="slider-row"><input type="range" id="sheetTemp" min="${entity.attributes.min_color_temp_kelvin}" max="${entity.attributes.max_color_temp_kelvin}" value="${entity.attributes.color_temp_kelvin || 3000}"><output>${entity.attributes.color_temp_kelvin || 3000}K</output></div></div>` : ''}
      ${effects.length ? `<div class="field"><label>Effekt</label><div class="chip-row">${effects.slice(0, 8).map(e => `<button class="chip ${entity.attributes?.effect === e ? 'is-active' : ''}" data-effect="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}</div></div>` : ''}
    </div>`;
  }
  if (domain === 'media_player' || obj.kind === 'speaker') {
    const vol = Math.round((entity.attributes?.volume_level ?? .2) * 100);
    return `<div class="section"><div class="insight"><svg><use href="#i-speaker"/></svg><div>${escapeHtml(entity.attributes?.media_title || entity.state)}</div></div>
      <div class="field" style="margin-top:10px"><label>Lautstärke</label><div class="slider-row"><input type="range" id="sheetVol" min="0" max="100" value="${vol}"><output>${vol}%</output></div></div></div>`;
  }
  if (domain === 'cover') {
    const pos = entity.attributes?.current_position ?? 0;
    return `<div class="section"><div class="field"><label>Position</label><div class="slider-row"><input type="range" id="sheetCover" min="0" max="100" value="${pos}"><output>${Math.round(pos)}%</output></div></div></div>`;
  }
  return `<div class="section"><div class="insight"><svg><use href="#i-${KIND[obj.kind]?.icon || 'cube'}"/></svg><div>Status: <b>${escapeHtml(stateLabel(entity, obj.kind))}</b></div></div>${obj.kind === 'display' ? `<p class="hint">Der Bildschirm folgt dem Zustand dieser Entität. Für „PC an → Monitor an“ nutze Regeln.</p>` : ''}</div>`;
}

function bindSheetControls(obj, m, entity) {
  if (!entity || !m?.entity_id) return;
  const call = (action, data) => api('service', { method: 'POST', body: { entity_id: m.entity_id, action, data } }).catch(err => toast(err.message, true));
  let target = Number(entity.attributes?.temperature ?? 20);
  $$('[data-temp]').forEach(b => b.addEventListener('click', () => {
    target = Math.max(5, Math.min(30, target + Number(b.dataset.temp)));
    const t = $('[data-target]'); if (t) t.textContent = target.toFixed(1);
    const slider = $('#sheetHeat'); if (slider) { slider.value = target; slider.nextElementSibling.textContent = target.toFixed(1) + ' °C'; }
    call('set_temperature', { temperature: target });
  }));
  $('#sheetHeat')?.addEventListener('change', e => call('set_temperature', { temperature: Number(e.target.value) }));
  $$('[data-hvac]').forEach(b => b.addEventListener('click', () => call('call', { service: 'set_hvac_mode', hvac_mode: b.dataset.hvac, _allow: true })));
  $('#sheetColor')?.addEventListener('change', e => call('set_color', { rgb_color: hexToRgb(e.target.value) }));
  $$('[data-color]').forEach(b => b.addEventListener('click', () => call('set_color', { rgb_color: hexToRgb(b.dataset.color) })));
  $('#sheetBright')?.addEventListener('change', e => call('set_brightness', { brightness_pct: Number(e.target.value) }));
  $('#sheetTemp')?.addEventListener('change', e => call('set_color', { color_temp_kelvin: Number(e.target.value) }));
  $$('[data-effect]').forEach(b => b.addEventListener('click', () => call('set_color', { effect: b.dataset.effect })));
  $('#sheetVol')?.addEventListener('change', e => call('set_volume', { volume_level: Number(e.target.value) / 100 }));
  $('#sheetCover')?.addEventListener('change', e => call('set_position', { position: Number(e.target.value) }));
}

function hvacLabel(v) {
  return ({ off: 'Aus', heat: 'Heizen', cool: 'Kühlen', auto: 'Auto', eco: 'Eco', boost: 'Boost' })[v] || v;
}

// ------------------------------------------------------------------ dashboard
function buildEmbedConfig(overrides = {}) {
  const d = state.config?.dashboard || {};
  return {
    model: state.model?.id || '',
    mode: state.scopeMode || d.mode || 'home',
    level: state.level || d.level || '',
    room: state.room || d.room || '',
    focus: state.focus || d.focus || 'dim',
    view: state.view || d.view || 'iso',
    chrome: true,
    night: document.body.classList.contains('night'),
    allLevels: state.allLevels,
    rotate: false,
    height: 460,
    ...overrides,
  };
}

function embedUrl(opts) {
  const u = new URL(location.origin + location.pathname);
  u.search = '';
  u.hash = '';
  const p = u.searchParams;
  p.set('embed', '1');
  if (opts.model) p.set('model', opts.model);
  p.set('mode', opts.mode || 'home');
  if (opts.level) p.set('level', opts.level);
  if (opts.room && opts.mode === 'room') p.set('room', opts.room);
  p.set('focus', opts.focus || 'dim');
  p.set('view', opts.view || 'iso');
  if (opts.chrome === false) p.set('chrome', '0');
  if (opts.night) p.set('theme', 'night');
  if (opts.allLevels) p.set('all', '1');
  if (opts.rotate) p.set('rotate', '1');
  return u.toString();
}

function dashboardYaml(opts) {
  const lines = [
    'type: custom:sh3d-home-card',
    `model: ${opts.model}`,
    `mode: ${opts.mode}`,
  ];
  if (opts.level) lines.push(`level: ${opts.level}`);
  if (opts.mode === 'room') lines.push(`room: ${opts.room}`);
  lines.push(`focus: ${opts.focus}`);
  lines.push(`view: ${opts.view}`);
  lines.push(`height: ${opts.height}`);
  if (opts.night) lines.push('theme: night');
  if (!opts.chrome) lines.push('chrome: false');
  if (opts.allLevels) lines.push('all_levels: true');
  return lines.join('\n');
}

function openDashboardModal() {
  if (!state.scene) { toast('Bitte zuerst ein Modell öffnen', true); return; }
  const d = state.config?.dashboard || {};
  const opts = {
    ...buildEmbedConfig(),
    mode: d.mode || 'home',
    focus: d.focus || 'dim',
    view: d.view || 'iso',
    allLevels: !!d.allLevels,
    chrome: d.chrome !== false,
    height: d.height || 460,
    night: document.body.classList.contains('night'),
    level: d.level || state.level,
    room: d.room || state.room,
  };
  const update = () => {
    const code = dashboardYaml(opts);
    const url = embedUrl(opts);
    const preview = $('#dashPreview iframe');
    if (preview) preview.src = url;
    const open = $('#dashOpen'); if (open) open.href = url;
    const box = $('#dashCode'); if (box) box.textContent = code;
  };
  const roomsForLevel = () => state.scene.rooms.filter(r => r.level === opts.level);
  els.modal.className = 'modal dashboard-modal';
  els.modal.innerHTML = `
    <div class="modal-head"><div><h2>In ein Dashboard</h2><p>Ganzes Haus, Etage oder Zimmer — mit den richtigen Kameraeinstellungen.</p></div><button class="icon-btn" data-close><svg><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="modal-section"><h3>Was soll auf die Karte?</h3>
        <div class="option-grid" id="dashMode">
          <button class="option-card ${opts.mode === 'home' ? 'is-active' : ''}" data-mode="home"><strong>Ganzes Haus</strong><small>Etagen wechseln &amp; laufen</small></button>
          <button class="option-card ${opts.mode === 'floor' ? 'is-active' : ''}" data-mode="floor"><strong>Eine Etage</strong><small>Nur ein Geschoss</small></button>
          <button class="option-card ${opts.mode === 'room' ? 'is-active' : ''}" data-mode="room"><strong>Ein Zimmer</strong><small>Scharf gestellt</small></button>
        </div>
      </div>
      <div class="modal-section" id="dashLevelWrap"><label class="field label">Etage</label><select class="select" id="dashLevel">${state.scene.levels.map(l => `<option value="${l.id}" ${l.id === opts.level ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select></div>
      <div class="modal-section" id="dashRoomWrap"><label class="field label">Zimmer</label><select class="select" id="dashRoom">${state.scene.rooms.map(r => `<option value="${r.id}" ${r.id === opts.room ? 'selected' : ''}>${escapeHtml(r.name)} · ${escapeHtml(state.scene.levels.find(l => l.id === r.level)?.name || '')}</option>`).join('')}</select></div>
      <div class="modal-section"><h3>Fokus</h3>
        <div class="option-grid" id="dashFocus">
          <button class="option-card ${opts.focus === 'none' ? 'is-active' : ''}" data-focus="none"><strong>Alles zeigen</strong><small>Kein Ausblenden</small></button>
          <button class="option-card ${opts.focus === 'dim' ? 'is-active' : ''}" data-focus="dim"><strong>Sanft dimmen</strong><small>Andere Räume blass</small></button>
          <button class="option-card ${opts.focus === 'isolate' ? 'is-active' : ''}" data-focus="isolate"><strong>Nur Zimmer</strong><small>Andere ausblenden</small></button>
        </div>
      </div>
      <div class="modal-section"><h3>Ansicht</h3>
        <div class="segmented" id="dashView">
          <button data-view="iso" class="${opts.view === 'iso' ? 'is-active' : ''}">3D</button>
          <button data-view="front" class="${opts.view === 'front' ? 'is-active' : ''}">Vorne</button>
          <button data-view="top" class="${opts.view === 'top' ? 'is-active' : ''}">Oben</button>
        </div>
        <div class="toggle-row" style="margin-top:10px"><div class="toggle-copy"><strong>Etagen-Leiste</strong><small>Im Dashboard sichtbar</small></div><button class="switch ${opts.chrome ? 'is-on' : ''}" id="dashChrome"></button></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Dunkles Ambiente</strong><small>Warmer Night-Modus</small></div><button class="switch ${opts.night ? 'is-on' : ''}" id="dashNight"></button></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Alle Etagen stapeln</strong><small>Für die Gesamtansicht</small></div><button class="switch ${opts.allLevels ? 'is-on' : ''}" id="dashAll"></button></div>
      </div>
      <div class="modal-section"><h3>Vorschau</h3><div class="preview-frame" id="dashPreview"><iframe title="Vorschau" loading="lazy"></iframe></div><div class="preview-note">Die Vorschau läuft in der echten Add-on-Ansicht.</div></div>
      <div class="modal-section"><h3>Karte für Lovelace</h3><div class="code-box" id="dashCode"></div>
        <div class="btn-row" style="margin-top:8px"><button class="btn btn-small" id="dashCopy"><svg><use href="#i-copy"/></svg> YAML kopieren</button><a class="btn btn-small" id="dashOpen" target="_blank" rel="noopener">Vorschau öffnen</a></div>
      </div>
      <div class="modal-section"><h3>So einbauen</h3><div class="step-list"><div class="step">Dashboard öffnen → Bearbeiten → Karte hinzufügen.</div><div class="step">„Manuell“ wählen und den YAML-Code einfügen.</div><div class="step">Die Ressource <code>/local/sh3d-home/sh3d-home-card.js</code> wird beim Start automatisch registriert.</div></div></div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-close>Schließen</button><button class="btn btn-primary" id="dashSave"><svg><use href="#i-check"/></svg> Als Standard speichern</button></div>`;
  openModal();
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  const refreshMode = () => {
    $$('#dashMode .option-card').forEach(b => b.classList.toggle('is-active', b.dataset.mode === opts.mode));
    $('#dashRoomWrap').style.display = opts.mode === 'room' ? '' : 'none';
    $('#dashLevelWrap').style.display = opts.mode === 'home' && opts.allLevels ? 'none' : '';
    $('#dashAll').classList.toggle('is-on', !!opts.allLevels);
    if (opts.mode === 'room' && !opts.room) opts.room = roomsForLevel()[0]?.id || '';
    update();
  };
  $$('#dashMode [data-mode]').forEach(b => b.addEventListener('click', () => { opts.mode = b.dataset.mode; refreshMode(); }));
  $('#dashLevel').addEventListener('change', e => { opts.level = e.target.value; opts.room = roomsForLevel()[0]?.id || ''; update(); });
  $('#dashRoom').addEventListener('change', e => { opts.room = e.target.value; update(); });
  $$('#dashFocus [data-focus]').forEach(b => b.addEventListener('click', () => { opts.focus = b.dataset.focus; $$('#dashFocus .option-card').forEach(x => x.classList.toggle('is-active', x === b)); update(); }));
  $$('#dashView [data-view]').forEach(b => b.addEventListener('click', () => { opts.view = b.dataset.view; $$('#dashView button').forEach(x => x.classList.toggle('is-active', x === b)); update(); }));
  $('#dashChrome').addEventListener('click', e => { opts.chrome = !opts.chrome; e.currentTarget.classList.toggle('is-on', opts.chrome); update(); });
  $('#dashNight').addEventListener('click', e => { opts.night = !opts.night; e.currentTarget.classList.toggle('is-on', opts.night); update(); });
  $('#dashAll').addEventListener('click', e => { opts.allLevels = !opts.allLevels; e.currentTarget.classList.toggle('is-on', opts.allLevels); refreshMode(); });
  $('#dashCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(dashboardYaml(opts)); toast('YAML kopiert'); } catch { toast('Kopieren nicht möglich – bitte manuell markieren', true); }
  });
  $('#dashOpen').href = embedUrl(opts);
  $('#dashSave').addEventListener('click', () => {
    state.config.dashboard = { ...opts };
    scheduleSave(true);
    toast('Dashboard-Standard gespeichert');
  });
  refreshMode();
}

// ------------------------------------------------------------------ settings & upload
function openSettingsModal() {
  if (!state.scene) return;
  const s = state.config?.scene || {};
  const stats = state.model?.stats || {};
  els.modal.className = 'modal';
  els.modal.innerHTML = `
    <div class="modal-head"><div><h2>Szene &amp; Modell</h2><p>${escapeHtml(state.model.name)} · ${stats.rooms || 0} Räume · ${stats.objects || 0} Objekte</p></div><button class="icon-btn" data-close><svg><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="modal-section"><h3>Darstellung</h3>
        <div class="toggle-row"><div class="toggle-copy"><strong>Raumlabels</strong><small>Namen und Flächen im Modell</small></div><button class="switch ${s.showLabels !== false ? 'is-on' : ''}" id="setLabels"></button></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Decken</strong><small>Halbtransparente Decken anzeigen</small></div><button class="switch ${s.showCeilings ? 'is-on' : ''}" id="setCeilings"></button></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Sanfte Drehung</strong><small>Kamera langsam kreisen lassen</small></div><button class="switch ${s.autoRotate ? 'is-on' : ''}" id="setRotate"></button></div>
      </div>
      <div class="modal-section"><h3>Modell</h3>
        <div class="stat-grid"><div class="stat"><b>${stats.lights || 0}</b><span>Lichter</span></div><div class="stat"><b>${stats.rooms || 0}</b><span>Räume</span></div><div class="stat"><b>${stats.levels || 0}</b><span>Etagen</span></div></div>
        <div class="btn-row" style="margin-top:9px"><button class="btn btn-small" id="setUpload"><svg><use href="#i-upload"/></svg> Neues Modell</button><a class="btn btn-small" href="models/${state.model.id}/source" download><svg><use href="#i-copy"/></svg> .sh3d</a></div>
        <div class="btn-row" style="margin-top:6px"><button class="btn btn-small" id="setScan">Ordner scannen</button><button class="btn btn-small btn-danger" id="setDelete"><svg><use href="#i-trash"/></svg> Modell löschen</button></div>
        <p class="hint">Beim Start werden .sh3d-Dateien aus <code>/share/sh3d-home</code>, <code>/share</code> und <code>/media</code> automatisch importiert.</p>
      </div>
      <div class="modal-section"><h3>Verbindung</h3>
        <div class="insight"><svg><use href="#i-cloud"/></svg><div>Home Assistant: <b>${state.connected ? 'verbunden' : 'nicht verbunden'}</b> · ${state.entities.length} Entitäten<br>Add-on: SH3D Home ${state.model ? '' : ''}<br>Diese Instanz: <code>${escapeHtml(location.host)}</code></div></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-close>Schließen</button><button class="btn btn-primary" id="setSave"><svg><use href="#i-check"/></svg> Übernehmen</button></div>`;
  openModal();
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  let next = { showLabels: s.showLabels !== false, showCeilings: !!s.showCeilings, autoRotate: !!s.autoRotate };
  const toggle = (id, key) => {
    const btn = $('#' + id);
    btn.addEventListener('click', () => { next[key] = !next[key]; btn.classList.toggle('is-on', next[key]); });
  };
  toggle('setLabels', 'showLabels');
  toggle('setCeilings', 'showCeilings');
  toggle('setRotate', 'autoRotate');
  $('#setUpload').addEventListener('click', () => { closeModal(); pickFile(); });
  $('#setScan').addEventListener('click', async () => {
    try { const r = await api('import/scan', { method: 'POST', body: {} }); toast(r.imported?.length ? `${r.imported.length} Modell(e) importiert` : 'Keine neuen Dateien gefunden'); if (r.imported?.length) { const data = await api('models'); state.models = data.models || []; openModelPicker(); } } catch (err) { toast(err.message, true); }
  });
  $('#setDelete').addEventListener('click', async () => {
    if (!confirm(`Modell „${state.model.name}“ wirklich löschen?`)) return;
    try { await api(`models/${state.model.id}`, { method: 'DELETE' }); state.models = state.models.filter(m => m.id !== state.model.id); closeModal(); if (state.models.length) await openModel(state.models[0]); else { state.model = null; state.scene = null; setEmpty(true); } toast('Modell gelöscht'); } catch (err) { toast(err.message, true); }
  });
  $('#setSave').addEventListener('click', () => {
    state.config.scene = { ...state.config.scene, ...next };
    viewer?.setCeilings(next.showCeilings);
    viewer?.setLabels(next.showLabels !== false);
    viewer?.setAutoRotate(!!next.autoRotate);
    $('#btnRotate').classList.toggle('is-active', !!next.autoRotate);
    scheduleSave(true);
    closeModal();
    toast('Darstellung gespeichert');
  });
}

function openModelPicker() {
  els.modal.className = 'modal';
  const models = state.models || [];
  els.modal.innerHTML = `
    <div class="modal-head"><div><h2>Modell wählen</h2><p>Sweet-Home-3D-Dateien bleiben lokal auf deinem Server.</p></div><button class="icon-btn" data-close><svg><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      ${models.length ? `<div class="model-list">${models.map(m => `<button class="model-item ${m.id === state.model?.id ? 'is-active' : ''}" data-model="${m.id}"><span class="model-thumb">${m.thumbnail ? `<img src="${escapeHtml(m.thumbnail)}" alt="">` : `<svg><use href="#i-cube"/></svg>`}</span><span class="model-copy"><b>${escapeHtml(m.name)}</b><small>${m.stats?.levels || 0} Etagen · ${m.stats?.lights || 0} Lichter · ${(m.size / 1048576).toFixed(1)} MB</small></span><svg class="chev"><use href="#i-chevron"/></svg></button>`).join('')}</div>` : `<div class="rule-empty">Noch kein Modell importiert.</div>`}
      <div class="btn-row" style="margin-top:12px"><button class="btn btn-primary" id="pickUpload"><svg><use href="#i-upload"/></svg> .sh3d hochladen</button><button class="btn btn-ghost" id="pickScan">Ordner scannen</button></div>
    </div>`;
  openModal();
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  $$('[data-model]').forEach(b => b.addEventListener('click', async () => { closeModal(); const m = models.find(x => x.id === b.dataset.model); if (m) await openModel(m); }));
  $('#pickUpload').addEventListener('click', () => { closeModal(); pickFile(); });
  $('#pickScan').addEventListener('click', async () => {
    try { const r = await api('import/scan', { method: 'POST', body: {} }); const data = await api('models'); state.models = data.models || []; closeModal(); if (r.imported?.length) await openModel(r.imported[0]); else toast('Keine neuen Dateien'); } catch (err) { toast(err.message, true); }
  });
}

function pickFile() { els.fileInput.click(); }

function uploadModel(file) {
  if (!file.name.toLowerCase().endsWith('.sh3d')) { toast('Bitte eine .sh3d-Datei auswählen', true); return; }
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('name', file.name.replace(/\.sh3d$/i, '').replace(/[_-]+/g, ' '));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', new URL('models', API));
  showLoader(true, `${file.name} wird importiert`);
  setLoaderProgress(0, 'Datei wird gelesen');
  xhr.upload.onprogress = e => { if (e.lengthComputable) setLoaderProgress(e.loaded / e.total * .8, `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`); };
  xhr.onload = async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText);
        setLoaderProgress(.9, 'Modell wird analysiert');
        const list = await api('models');
        state.models = list.models || [];
        await openModel(data.model);
        toast('Modell importiert');
      } catch (err) { hideLoader(); toast(err.message, true); }
    } else {
      hideLoader();
      let msg = xhr.responseText || xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
      toast('Import fehlgeschlagen: ' + msg, true);
    }
  };
  xhr.onerror = () => { hideLoader(); toast('Netzwerkfehler beim Upload', true); };
  xhr.send(fd);
}

// ------------------------------------------------------------------ save / ws / status
function scheduleSave(immediate = false) {
  if (!state.model || !state.config) return;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveConfig, immediate ? 0 : 450);
}

async function saveConfig() {
  if (!state.model || !state.config) return;
  state.saveTimer = null;
  if (state.saving) { state.pendingSave = true; return; }
  state.saving = true;
  const payload = JSON.parse(JSON.stringify(state.config));
  try {
    await api(`models/${state.model.id}/config`, { method: 'PUT', body: payload });
    setStatus('Gespeichert', `${state.entities.length} Entitäten`);
  } catch (err) {
    toast('Speichern fehlgeschlagen: ' + err.message, true);
  } finally {
    state.saving = false;
    if (state.pendingSave) { state.pendingSave = false; scheduleSave(true); }
  }
}

function connectWS() {
  if (state.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.ws.readyState)) return;
  const url = new URL('ws', API);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  state.ws = ws;
  ws.onopen = () => { state.wsRetry = 0; };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') {
      state.states = msg.states || {};
      state.connected = !!msg.connected;
      state.haError = msg.error;
      updateHAStatus();
      viewer?.setStates(state.states);
      refreshVisibleStates();
    } else if (msg.type === 'state' && msg.entity) {
      state.states[msg.entity.entity_id] = msg.entity;
      viewer?.setStates(state.states);
      refreshVisibleStates(msg.entity.entity_id);
    } else if (msg.type === 'state_removed') {
      delete state.states[msg.entity_id];
      viewer?.setStates(state.states);
    } else if (msg.type === 'connection') {
      state.connected = !!msg.connected;
      if (msg.error) state.haError = msg.error;
      updateHAStatus();
      if (msg.connected) loadEntities().then(() => viewer?.setStates(state.states));
    }
  };
  ws.onclose = () => {
    state.connected = false;
    updateHAStatus();
    state.ws = null;
    const delay = Math.min(15000, 1000 * Math.pow(1.7, Math.min(5, state.wsRetry++)));
    setTimeout(connectWS, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

let refreshTimer = null;
function refreshVisibleStates(entityId) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    updateObjectStates();
    if (state.selectedId && els.inspector.classList.contains('is-open')) {
      const obj = state.scene?.objects.find(o => o.id === state.selectedId);
      if (obj) {
        const m = state.config?.mappings?.[obj.id];
        const entity = m?.entity_id ? state.states[m.entity_id] : null;
        const live = $('[data-live-state]', els.inspector);
        if (live) { live.textContent = stateLabel(entity, obj.kind); live.className = 'entity-state ' + (isOn(entity, obj.kind) ? 'on' : (entity?.state === 'unavailable' ? 'unavailable' : 'off')); }
      }
    }
    if (els.overlay.classList.contains('is-open') && els.modal.classList.contains('sheet')) {
      // Keep the open live sheet fresh without losing slider state.
      const obj = state.selectedId ? state.scene?.objects.find(o => o.id === state.selectedId) : null;
      // The sheet has no selected object binding; leave open state to the next user action.
    }
    updateStatus();
  }, 220);
}

function updateObjectStates() {
  if (!state.scene) return;
  const rooms = new Map(state.scene.rooms.map(r => [r.id, r]));
  $$('.object-item', els.objectList).forEach(el => {
    const obj = state.scene.objects.find(o => o.id === el.dataset.id);
    if (!obj) return;
    const m = state.config?.mappings?.[obj.id];
    const entity = m?.entity_id ? state.states[m.entity_id] : null;
    const valueEl = el.querySelector('.object-state');
    const dot = el.querySelector('.mapped-dot');
    if (valueEl) valueEl.textContent = entity ? stateLabel(entity, obj.kind) : (m ? 'Regel' : 'zuordnen');
    if (dot) dot.classList.toggle('off', !m?.entity_id);
    const sub = el.querySelector('.object-sub');
    if (sub) sub.textContent = `${rooms.get(obj.room)?.name || KIND[obj.kind]?.label || ''}${m?.entity_id ? ' · ' + (entity?.attributes?.friendly_name || '') : ''}`;
  });
}

function updateHAStatus() {
  if (!els.haStatus) return;
  els.haStatus.classList.toggle('is-on', state.connected);
  els.haStatus.classList.toggle('is-off', !state.connected && !!state.haError);
  els.haStatus.querySelector('span').textContent = state.connected ? 'Home Assistant verbunden' : (state.haError ? 'HA nicht erreichbar' : 'Verbinde …');
}

function updateStatus() {
  if (!state.scene) { setStatus('Bereit', 'Kein Modell'); return; }
  const count = state.entities.length;
  setStatus(state.connected ? 'Live' : 'Offline', `${count} Entitäten · ${state.scene.stats.objects} Objekte`);
}

function setStatus(text, detail = '') {
  if (els.statusText) els.statusText.textContent = text;
  if (els.statusDetail) els.statusDetail.textContent = detail;
}

function showLoader(show, title = '') {
  if (!els.loader) return;
  els.loader.classList.toggle('is-done', !show);
  if (show) {
    els.loader.classList.remove('is-done');
    if (title) els.loaderSub.textContent = title;
  }
}

function hideLoader() {
  if (!els.loader) return;
  els.loader.classList.add('is-done');
}

function setLoaderProgress(p, text) {
  if (els.loaderBar) els.loaderBar.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
  if (text && els.loaderSub) els.loaderSub.textContent = text;
}

function setEmpty(show) {
  els.empty.classList.toggle('hidden', !show);
  if (show) {
    els.stageTitle.textContent = 'SH3D Home';
    els.stageKicker.textContent = 'Willkommen';
    hideLoader();
  }
}

let toastTimer = null;
function toast(message, error = false) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', !!error);
  els.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-show'), 3600);
}

// kick off
init().catch(err => {
  console.error(err);
  setEmpty(true);
  toast('Startfehler: ' + err.message, true);
});
