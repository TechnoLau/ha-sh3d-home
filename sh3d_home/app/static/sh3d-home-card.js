/**
 * SH3D Home – Lovelace card
 * Loads the add-on panel in an iframe and passes the dashboard configuration
 * as URL parameters. The ingress URL is resolved via the Supervisor API so no
 * secret has to be stored in the dashboard YAML.
 */
class Sh3dHomeCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._rendered = false;
    this._resizeHandler = () => this._applyHeight();
  }

  static getStubConfig() {
    return { mode: 'home', focus: 'dim', view: 'iso', height: 460 };
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('SH3D Home: ungültige Kartenkonfiguration');
    this._config = { ...config };
    if (this._rendered) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered && hass) this._render();
  }

  connectedCallback() { window.addEventListener('resize', this._resizeHandler); }
  disconnectedCallback() { window.removeEventListener('resize', this._resizeHandler); }

  getCardSize() { return Math.max(4, Math.ceil((this._config.height || 460) / 50)); }

  _height() {
    const h = Number(this._config.height || 460);
    return Number.isFinite(h) ? Math.max(220, Math.min(1400, h)) : 460;
  }

  _applyHeight() {
    const frame = this.shadowRoot.querySelector('.frame');
    if (frame) frame.style.height = this._height() + 'px';
  }

  _params(base) {
    const c = this._config;
    const url = new URL(base, window.location.origin);
    url.search = '';
    url.searchParams.set('embed', '1');
    if (c.model) url.searchParams.set('model', c.model);
    url.searchParams.set('mode', c.mode || 'home');
    if (c.level) url.searchParams.set('level', c.level);
    if (c.room) url.searchParams.set('room', c.room);
    url.searchParams.set('focus', c.focus || 'dim');
    url.searchParams.set('view', c.view || 'iso');
    if (c.chrome === false) url.searchParams.set('chrome', '0');
    if (c.theme === 'night') url.searchParams.set('theme', 'night');
    if (c.all_levels) url.searchParams.set('all', '1');
    if (c.rotate) url.searchParams.set('rotate', '1');
    return url.toString();
  }

  async _render() {
    this._rendered = true;
    const height = this._height();
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap { position: relative; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; background: #e7e1d5; }
        .frame { width: 100%; height: ${height}px; border: 0; display: block; background: #e7e1d5; }
        .loading, .error { height: ${height}px; display: grid; place-items: center; color: #6f685c; font: 13px/1.5 system-ui, sans-serif; text-align: center; padding: 20px; box-sizing: border-box; }
        .error a { color: #c45a3c; }
        .open { position: absolute; right: 10px; top: 10px; background: rgba(250,247,240,.9); border: 1px solid rgba(100,88,70,.25); color: #3b352c; border-radius: 7px; padding: 4px 8px; font: 10px/1.4 system-ui, sans-serif; text-decoration: none; backdrop-filter: blur(5px); }
        .open:hover { background: #fffdf8; }
      </style>
      <div class="wrap"><div class="loading">SH3D Home wird geladen …</div></div>`;
    if (!this._hass) return;
    try {
      if (typeof this._hass.callWS !== 'function') throw new Error('Home Assistant API nicht verfügbar');
      const list = await this._hass.callWS({
        type: 'supervisor/api',
        endpoint: '/addons',
        method: 'get',
      });
      const app = (list?.addons || []).find(a =>
        a.name === 'SH3D Home' || String(a.slug || '').endsWith('_sh3d_home') || String(a.slug || '') === 'sh3d_home'
      );
      if (!app) throw new Error('SH3D Home Add-on nicht gefunden');
      const info = await this._hass.callWS({
        type: 'supervisor/api',
        endpoint: `/addons/${app.slug}/info`,
        method: 'get',
      });
      const ingress = info?.ingress_url || info?.ingress_entry;
      if (!ingress) throw new Error('Kein Ingress-Pfad für SH3D Home gefunden');
      const src = this._params(ingress.endsWith('/') ? ingress : ingress + '/');
      const full = this._params((ingress.endsWith('/') ? ingress : ingress + '/'));
      full.searchParams.delete('embed');
      const wrap = this.shadowRoot.querySelector('.wrap');
      if (!wrap) return;
      wrap.innerHTML = `<iframe class="frame" title="SH3D Home 3D-Modell" src="${src}" allow="fullscreen" loading="lazy"></iframe><a class="open" href="${full}" target="_blank" rel="noopener">Öffnen ↗</a>`;
      const frame = wrap.querySelector('iframe');
      frame.addEventListener('load', () => { try { frame.contentWindow.focus(); } catch {} });
    } catch (err) {
      const wrap = this.shadowRoot.querySelector('.wrap');
      if (!wrap) return;
      wrap.innerHTML = `<div class="error"><div><b>SH3D Home konnte nicht eingebettet werden.</b><br>${String(err.message || err).replace(/[<>&]/g, '')}<br><br>Öffne das Add-on direkt in der Seitenleiste.</div></div>`;
    }
  }
}

customElements.define('sh3d-home-card', Sh3dHomeCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'sh3d-home-card',
  name: 'SH3D Home',
  description: 'Live-3D-Modell aus Sweet Home 3D mit Etagen, Zimmern und Gerätezuordnung.',
  preview: false,
});
