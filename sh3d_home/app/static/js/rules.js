export const KIND = {
  light: { label: 'Licht', icon: 'i-light', domains: ['light', 'switch', 'input_boolean'] },
  door: { label: 'Tür', icon: 'i-door', domains: ['binary_sensor', 'cover', 'switch', 'input_boolean'] },
  window: { label: 'Fenster', icon: 'i-window', domains: ['binary_sensor', 'cover', 'switch', 'input_boolean'] },
  heating: { label: 'Heizung', icon: 'i-heat', domains: ['climate', 'sensor', 'switch'] },
  speaker: { label: 'Lautsprecher', icon: 'i-speaker', domains: ['media_player', 'switch'] },
  display: { label: 'Bildschirm', icon: 'i-screen', domains: ['media_player', 'switch', 'binary_sensor', 'light'] },
  computer: { label: 'Computer', icon: 'i-pc', domains: ['binary_sensor', 'switch', 'sensor'] },
  furniture: { label: 'Möbel', icon: 'i-sofa', domains: ['light', 'switch', 'binary_sensor', 'media_player', 'climate'] },
};

export const OPERATORS = [
  ['is', 'ist'],
  ['not', 'ist nicht'],
  ['gt', 'größer als'],
  ['lt', 'kleiner als'],
  ['gte', 'mindestens'],
  ['lte', 'höchstens'],
  ['contains', 'enthält'],
  ['available', 'verfügbar'],
  ['unavailable', 'nicht verfügbar'],
];

export const EFFECTS = [
  ['on', 'an / leuchtet'],
  ['off', 'aus'],
  ['color', 'Farbe'],
  ['brightness', 'Helligkeit'],
  ['screen', 'Bildschirm an'],
  ['open', 'offen'],
  ['temp', 'Temperatur'],
];

export function emptyMapping() {
  return {
    entity_id: '',
    tap: true,
    button: true,
    tap_action: 'toggle',
    label: '',
    rules: [],
    appearance: { glow: 1, color: '', brightness: 100, screenColor: '#86c5ff' },
  };
}

export function normalizeMapping(m = {}) {
  const base = emptyMapping();
  return {
    ...base,
    ...m,
    appearance: { ...base.appearance, ...(m.appearance || {}) },
    rules: Array.isArray(m.rules) ? m.rules.map(normalizeRule) : [],
  };
}

export function normalizeRule(r = {}) {
  return {
    id: r.id || ('r-' + Math.random().toString(36).slice(2, 8)),
    name: r.name || 'Neue Bedingung',
    enabled: r.enabled !== false,
    match: r.match === 'any' ? 'any' : 'all',
    conditions: Array.isArray(r.conditions) ? r.conditions.map(c => ({
      entity_id: c.entity_id || '',
      attribute: c.attribute || 'state',
      op: c.op || 'is',
      value: c.value === undefined ? 'on' : String(c.value),
    })) : [],
    effect: {
      type: r.effect?.type || 'on',
      color: r.effect?.color || '#ffcf8a',
      brightness: Number(r.effect?.brightness ?? 100),
      value: r.effect?.value ?? '',
    },
  };
}

export function getEntity(states, id) {
  if (!states || !id) return null;
  return states[id] || null;
}

export function entityName(states, id, fallback = '') {
  const e = getEntity(states, id);
  return e?.attributes?.friendly_name || fallback || id || 'Keine Entität';
}

export function domainOf(id) { return (id || '').split('.')[0]; }

export function isUnavailable(entity) {
  return !entity || ['unavailable', 'unknown'].includes(entity.state);
}

export function isOn(entity, kind = '') {
  if (!entity) return false;
  const s = String(entity.state).toLowerCase();
  if (kind === 'heating') return s !== 'off' && s !== 'unavailable' && s !== 'unknown';
  if (kind === 'door' || kind === 'window') {
    if (entity.attributes?.current_position !== undefined) return Number(entity.attributes.current_position) > 0;
    return ['on', 'open', 'opening', 'true'].includes(s);
  }
  if (domainOf(entity.entity_id) === 'media_player') return ['playing', 'on', 'paused', 'buffering'].includes(s);
  return ['on', 'open', 'playing', 'heat', 'heating', 'cool', 'true', 'home', 'active'].includes(s);
}

export function stateLabel(entity, kind) {
  if (!entity) return 'nicht zugeordnet';
  const s = String(entity.state);
  if (kind === 'heating') {
    const cur = entity.attributes?.current_temperature;
    if (cur !== undefined) return `${Number(cur).toFixed(1)} °C`;
    return s === 'off' ? 'aus' : s;
  }
  if (domainOf(entity.entity_id) === 'light') {
    if (s !== 'on') return 'aus';
    const b = entity.attributes?.brightness;
    return b ? `${Math.round(b / 2.55)}%` : 'an';
  }
  if (domainOf(entity.entity_id) === 'cover') {
    const p = entity.attributes?.current_position;
    return p !== undefined ? `${Math.round(p)}%` : s;
  }
  if (domainOf(entity.entity_id) === 'climate') {
    const t = entity.attributes?.temperature;
    return t !== undefined ? `${Number(t).toFixed(1)} °C` : s;
  }
  return ({ on: 'an', off: 'aus', open: 'offen', closed: 'zu', playing: 'spielt', paused: 'pausiert', unavailable: 'nicht verfügbar', heat: 'heizt', idle: 'bereit' })[s] || s;
}

function attrValue(entity, attr) {
  if (!entity) return undefined;
  if (!attr || attr === 'state') return entity.state;
  return attr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), entity);
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function evalCondition(cond, states) {
  const entity = getEntity(states, cond.entity_id);
  if (!entity) return cond.op === 'unavailable';
  if (cond.op === 'available') return !isUnavailable(entity);
  if (cond.op === 'unavailable') return isUnavailable(entity);
  const actual = attrValue(entity, cond.attribute);
  const target = cond.value;
  if (cond.op === 'is') {
    if (typeof actual === 'boolean') return String(actual) === String(target).toLowerCase();
    if (actual === undefined) return false;
    return String(actual).toLowerCase() === String(target).toLowerCase();
  }
  if (cond.op === 'not') return String(actual).toLowerCase() !== String(target).toLowerCase();
  if (cond.op === 'contains') return String(actual ?? '').toLowerCase().includes(String(target).toLowerCase());
  const a = asNumber(actual), b = asNumber(target);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (cond.op === 'gt') return a > b;
  if (cond.op === 'lt') return a < b;
  if (cond.op === 'gte') return a >= b;
  if (cond.op === 'lte') return a <= b;
  return false;
}

export function evalRule(rule, states) {
  if (!rule || rule.enabled === false || !rule.conditions?.length) return null;
  const results = rule.conditions.map(c => evalCondition(c, states));
  const hit = rule.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  return hit ? rule.effect : null;
}

/** Base visual state from the primary entity, then rule effects in order. */
export function visualState(mapping, states) {
  const entity = getEntity(states, mapping?.entity_id);
  const kind = mapping?.kind || '';
  const on = isOn(entity, kind);
  const out = {
    on,
    entity,
    color: null,
    brightness: entity?.attributes?.brightness ?? (on ? 220 : 0),
    screen: on && ['display', 'computer'].includes(kind),
    open: on && ['door', 'window'].includes(kind),
    temp: entity?.attributes?.current_temperature ?? null,
    target: entity?.attributes?.temperature ?? null,
    glow: mapping?.appearance?.glow ?? 1,
    triggered: false,
    effects: [],
  };
  if (kind === 'light' && on) {
    const rgb = entity?.attributes?.rgb_color;
    if (Array.isArray(rgb) && rgb.length === 3) out.color = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    if (mapping?.appearance?.color) out.color = mapping.appearance.color;
  }
  for (const rule of mapping?.rules || []) {
    const eff = evalRule(rule, states);
    if (!eff) continue;
    out.triggered = true;
    out.effects.push(eff);
    if (eff.type === 'on') out.on = true;
    if (eff.type === 'off') out.on = false;
    if (eff.type === 'color') { out.on = true; out.color = eff.color; }
    if (eff.type === 'brightness') { out.on = Number(eff.brightness) > 0; out.brightness = Number(eff.brightness); }
    if (eff.type === 'screen') out.screen = true;
    if (eff.type === 'open') out.open = true;
    if (eff.type === 'temp' && eff.value !== '') out.temp = Number(eff.value);
  }
  return out;
}

export function kindOfObject(obj) {
  return obj?.kind && KIND[obj.kind] ? obj.kind : 'furniture';
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function domainLabel(domain) {
  return ({
    light: 'Lichter', switch: 'Schalter', binary_sensor: 'Sensoren', sensor: 'Sensoren',
    cover: 'Rollläden / Türen', climate: 'Klima / Heizung', media_player: 'Medien',
    input_boolean: 'Helfer', fan: 'Lüfter', lock: 'Schlösser', button: 'Taster',
    scene: 'Szenen', script: 'Skripte', automation: 'Automationen',
  })[domain] || domain;
}

export function ruleSummary(rule, states) {
  const parts = (rule.conditions || []).map(c => {
    const name = entityName(states, c.entity_id, c.entity_id);
    const op = OPERATORS.find(o => o[0] === c.op)?.[1] || c.op;
    const attr = c.attribute === 'state' ? '' : ` · ${c.attribute.replace('attributes.', '')}`;
    return `${name}${attr} ${op}${['available', 'unavailable'].includes(c.op) ? '' : ' ' + c.value}`;
  });
  return (rule.match === 'any' ? 'ODER: ' : 'UND: ') + (parts.join(' · ') || 'keine Bedingungen');
}
