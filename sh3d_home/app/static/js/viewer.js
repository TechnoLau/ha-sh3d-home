import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { visualState, entityName, stateLabel, KIND } from './rules.js?v=0.1.3';

const S = 0.01; // Sweet Home 3D centimetres -> Three.js metres
const WARM = '#f2e7d3';
const FALLBACK = {
  light: '#e6bd75', door: '#9a6a43', window: '#b5d3d4', heating: '#d8d0c3',
  speaker: '#353a38', display: '#191d20', computer: '#2a2d2e', furniture: '#c5b79f',
};

function canvasGlow(color = '#ffd39a', inner = 0.95) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(inner * .35, color.replace('rgb', 'rgba').replace(')', ',.42)'));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cssColor(c, fallback = '#ffd39a') {
  if (!c) return new THREE.Color(fallback);
  try { return new THREE.Color(c); } catch { return new THREE.Color(fallback); }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

export class Viewer {
  constructor(canvas, labelsEl, floatingEl, options = {}) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.floatingEl = floatingEl;
    this.options = options;
    this.sceneData = null;
    this.config = {};
    this.mappings = {};
    this.states = {};
    this.modelBase = '';
    this.levelId = null;
    this.mode = 'edit';
    this.scope = { mode: 'home', level: null, room: null, focus: 'dim', allLevels: false };
    this.selectedId = null;
    this.hoveredId = null;
    this.loaded = 0;
    this.total = 0;
    this.cache = new Map();
    this.pending = new Map();
    this.disposed = false;
    this.walking = false;
    this.walkYaw = 0;
    this.walkPitch = 0;
    this.keys = new Set();
    this.movePad = new Set();
    this.pointer = { down: false, x: 0, y: 0, moved: 0, t: 0, objectId: null, longTimer: null };
    this.pointers = new Map();
    this._tween = null;
    this._frame = 0;
    this._clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor('#e7e1d5', 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e7e1d5');
    this.scene.fog = new THREE.Fog('#e7e1d5', 28, 62);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.04, 160);
    this.camera.position.set(10, 10, 12);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.025;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 70;
    this.controls.target.set(0, 1, 0);

    this.labelRenderer = new CSS2DRenderer({ element: labelsEl });
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.inset = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.levelGroups = new Map();
    this.roomMeshes = [];
    this.roomLabels = [];
    this.wallGroups = [];
    this.slabs = [];
    this.objectGroups = new Map();
    this.floatButtons = new Map();
    this.outline = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    this._setupLights();
    this._setupGround();
    this._bindEvents();
    this._resize = this._resize.bind(this);
    this._onResize = new ResizeObserver(() => this._resize());
    this._onResize.observe(canvas.parentElement || canvas);
    window.addEventListener('resize', this._resize);
    this._resize();
    this._animate();
  }

  _setupLights() {
    this.hemi = new THREE.HemisphereLight('#faf4e8', '#74695a', 1.55);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight('#fff3df', 0.38);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight('#fff1d8', 2.25);
    this.sun.position.set(-8, 16, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 50;
    this.sun.shadow.camera.left = -14;
    this.sun.shadow.camera.right = 14;
    this.sun.shadow.camera.top = 14;
    this.sun.shadow.camera.bottom = -14;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun.target);
    this.fill = new THREE.DirectionalLight('#dbe8e8', 0.38);
    this.fill.position.set(9, 7, -9);
    this.scene.add(this.fill);
  }

  _setupGround() {
    const geo = new THREE.PlaneGeometry(90, 90);
    const mat = new THREE.ShadowMaterial({ color: '#4e4030', opacity: 0.14 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.06;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#cbbfa9', transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    this.siteDisc = new THREE.Mesh(new THREE.RingGeometry(10.6, 10.75, 96), ringMat);
    this.siteDisc.rotation.x = -Math.PI / 2;
    this.siteDisc.position.y = -0.05;
    this.scene.add(this.siteDisc);
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', e => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', e => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', e => this._onPointerUp(e));
    this.canvas.addEventListener('pointerleave', () => this._clearHover());
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('dblclick', e => {
      const hit = this._pick(e.clientX, e.clientY);
      if (hit) this.onObjectDoubleClick?.(hit.object, hit.group);
    });
    this.canvas.addEventListener('wheel', () => { if (this.walking) this._exitWalk(false); }, { passive: true });
    window.addEventListener('keydown', e => {
      if (this.walking) {
        this.keys.add(e.code);
        if (e.code === 'Escape') this.exitWalk();
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    document.addEventListener('pointerlockchange', () => {
      if (this.walking && document.pointerLockElement !== this.canvas) {
        // Keep walking mode active, but let the overlay remain usable.
      }
    });
    document.addEventListener('mousemove', e => {
      if (!this.walking) return;
      if (document.pointerLockElement === this.canvas || this._walkDragging) {
        this._look(e.movementX || 0, e.movementY || 0);
      }
    });
  }

  _resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setTheme(night = false) {
    const bg = night ? '#141718' : '#e7e1d5';
    this.scene.background = new THREE.Color(bg);
    this.scene.fog = new THREE.Fog(bg, 28, 62);
    this.renderer.setClearColor(bg, 1);
    this.hemi.intensity = night ? 0.9 : 1.55;
    this.ambient.intensity = night ? 0.22 : 0.38;
    this.sun.intensity = night ? 1.15 : 2.25;
    this.sun.color.set(night ? '#cfd9e3' : '#fff1d8');
    this.fill.intensity = night ? 0.6 : 0.38;
    this.ground.material.opacity = night ? 0.28 : 0.14;
    this.siteDisc.material.opacity = night ? 0.08 : 0.18;
  }

  async load(sceneData, config, modelBase) {
    this._clearScene();
    this.sceneData = sceneData;
    this.config = config || {};
    this.modelBase = modelBase || '';
    this.states = {};
    this.mappings = config?.mappings || {};
    this.sceneData = sceneData;
    this.cx = (sceneData.bounds.minX + sceneData.bounds.maxX) / 2;
    this.cy = (sceneData.bounds.minY + sceneData.bounds.maxY) / 2;
    this.levels = new Map(sceneData.levels.map(l => [l.id, l]));
    this.levelId = sceneData.levels[0]?.id || null;
    this.scope.level = this.levelId;
    this.total = sceneData.objects.length;
    this.loaded = 0;

    this._buildLevels();
    this._buildRooms();
    this._buildWalls();
    this._pendingLoads = [];
    this._buildObjects();
    this._buildOutline();
    this._buildFloatButtons();
    this._applyVisibility();
    await Promise.allSettled(this._pendingLoads);
    if (this.disposed) return;
    this._applyStates();
    this.setView(this.options.initialView || 'iso', false);
    this.setScope({ ...this.scope, mode: 'home', level: this.levelId, focus: 'none', allLevels: false });
    this.loadingDone?.();
  }

  _wx(x) { return (x - this.cx) * S; }
  _wz(y) { return (y - this.cy) * S; }

  _clearScene() {
    for (const group of this.levelGroups.values()) this.root.remove(group);
    for (const label of this.roomLabels) label.remove();
    this.levelGroups.clear();
    this.roomMeshes = [];
    this.roomLabels = [];
    this.wallGroups = [];
    this.slabs = [];
    this.objectGroups.clear();
    for (const btn of this.floatButtons.values()) btn.el.remove();
    this.floatButtons.clear();
    this.outline?.parent && this.outline.parent.remove(this.outline);
    this.outline = null;
    this.selectedId = null;
    this.loaded = 0;
    this.total = 0;
    this.cache.clear();
    this.pending.clear();
  }

  _buildLevels() {
    for (const level of this.sceneData.levels) {
      const group = new THREE.Group();
      group.name = 'level-' + level.id;
      group.userData.level = level;
      this.root.add(group);
      this.levelGroups.set(level.id, group);
    }
  }

  _levelY(id) {
    return (this.levels.get(id)?.elevation || 0) * S;
  }

  _buildRooms() {
    const floorMat = new THREE.MeshStandardMaterial({ color: '#cdbb9d', roughness: 0.88, metalness: 0.02, side: THREE.DoubleSide });
    const slabMat = new THREE.MeshStandardMaterial({ color: '#b9ab94', roughness: 0.95 });
    const ceilMat = new THREE.MeshStandardMaterial({ color: '#f1e8d8', roughness: 0.96, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    for (const level of this.sceneData.levels) {
      const lg = this.levelGroups.get(level.id);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(this.sceneData.bounds.width * S + .4, .08, this.sceneData.bounds.depth * S + .4), slabMat);
      slab.position.set(0, this._levelY(level.id) - 0.055, 0);
      slab.receiveShadow = true;
      slab.userData.level = level.id;
      lg.add(slab);
      this.slabs.push({ mesh: slab, level: level.id });
    }
    for (const room of this.sceneData.rooms) {
      const lg = this.levelGroups.get(room.level);
      if (!lg) continue;
      const pts = room.points.map(p => new THREE.Vector2(this._wx(p[0]), this._wz(p[1])));
      const shape = new THREE.Shape(pts);
      const geom = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geom, floorMat.clone());
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = this._levelY(room.level) - 0.005;
      mesh.receiveShadow = true;
      mesh.userData.room = room.id;
      lg.add(mesh);
      this.roomMeshes.push({ mesh, room, level: room.level });

      const ceil = new THREE.Mesh(geom.clone(), ceilMat.clone());
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = this._levelY(room.level) + (this.levels.get(room.level)?.height || 250) * S;
      ceil.userData.room = room.id;
      ceil.userData.ceiling = true;
      lg.add(ceil);
      this.roomMeshes.push({ mesh: ceil, room, level: room.level, ceiling: true });

      const el = document.createElement('button');
      el.className = 'room-tag';
      el.innerHTML = `<span>${room.name}</span><small>${room.area.toFixed(0)} m²</small>`;
      el.addEventListener('click', ev => { ev.stopPropagation(); this.onRoomClick?.(room); });
      const label = new CSS2DObject(el);
      label.position.set(this._wx(room.center[0]), this._levelY(room.level) + 0.18, this._wz(room.center[1]));
      label.userData.room = room.id;
      lg.add(label);
      this.roomLabels.push({ object: label, el, room });
    }
  }

  _roomAt(x, y, level) {
    const rooms = this.sceneData.rooms.filter(r => r.level === level);
    for (const r of rooms) if (pointInPoly(x, y, r.points)) return r.id;
    let best = null, bestD = 450 * 450;
    for (const r of rooms) {
      const d = (r.center[0] - x) ** 2 + (r.center[1] - y) ** 2;
      if (d < bestD) { best = r.id; bestD = d; }
    }
    return best;
  }

  _buildWalls() {
    const mat = new THREE.MeshStandardMaterial({ color: '#e9e0d1', roughness: 0.93, metalness: 0.01 });
    const matSide = new THREE.MeshStandardMaterial({ color: '#ded3c2', roughness: 0.95 });
    for (const piece of this.sceneData.walls) {
      const lg = this.levelGroups.get(piece.level);
      if (!lg) continue;
      const x1 = this._wx(piece.x1), z1 = this._wz(piece.y1), x2 = this._wx(piece.x2), z2 = this._wz(piece.y2);
      const len = Math.hypot(x2 - x1, z2 - z1);
      const h = Math.max(0.02, (piece.z1 - piece.z0) * S);
      if (len < 0.01 || h < 0.01) continue;
      const geom = new THREE.BoxGeometry(len, h, Math.max(0.025, piece.thickness * S));
      const mesh = new THREE.Mesh(geom, piece.kind === 'lintel' ? matSide : mat);
      mesh.position.set((x1 + x2) / 2, this._levelY(piece.level) + (piece.z0 + piece.z1) / 2 * S, (z1 + z2) / 2);
      mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const midX = (piece.x1 + piece.x2) / 2, midY = (piece.y1 + piece.y2) / 2;
      mesh.userData.kind = 'wall';
      mesh.userData.room = this._roomAt(midX, midY, piece.level);
      mesh.userData.level = piece.level;
      lg.add(mesh);
      this.wallGroups.push({ mesh, room: mesh.userData.room, level: piece.level });
    }
  }

  _buildObjects() {
    for (const obj of this.sceneData.objects) {
      const lg = this.levelGroups.get(obj.level);
      if (!lg) continue;
      const wrapper = new THREE.Group();
      wrapper.position.set(this._wx(obj.x), this._levelY(obj.level) + obj.elevation * S, this._wz(obj.y));
      wrapper.rotation.y = -obj.angle;
      wrapper.userData.object = obj;
      wrapper.userData.room = obj.room;
      wrapper.userData.level = obj.level;
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(.04, obj.width * S), Math.max(.04, obj.height * S), Math.max(.04, obj.depth * S)),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
      );
      hit.position.y = obj.height * S / 2;
      hit.userData.objectId = obj.id;
      wrapper.add(hit);
      lg.add(wrapper);
      this.objectGroups.set(obj.id, wrapper);
      this._decorateObject(obj, wrapper);
      this._pendingLoads.push(this._loadObjectModel(obj, wrapper));
    }
  }

  _decorateObject(obj, wrapper) {
    const kind = obj.kind;
    const mat = new THREE.SpriteMaterial({ map: canvasGlow(kind === 'display' ? '#9ad5ff' : kind === 'heating' ? '#ffb36b' : '#ffd29a'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Sprite(mat);
    const glowSize = Math.max(0.32, Math.min(1.5, obj.width * S * 0.8));
    glow.scale.set(glowSize, glowSize, 1);
    glow.position.y = obj.height * S * (kind === 'light' ? 0.66 : 0.5);
    glow.userData.kind = 'glow';
    wrapper.add(glow);
    wrapper.userData.glow = glow;
    if (kind === 'light') {
      const pl = new THREE.PointLight('#ffd39a', 0, 5.2, 2);
      pl.position.y = obj.height * S * 0.52;
      wrapper.add(pl);
      wrapper.userData.point = pl;
    }
    if (kind === 'display' || kind === 'computer') {
      const screenMat = new THREE.MeshBasicMaterial({ color: '#93ccff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.12, obj.width * S * .8), Math.max(.08, obj.height * S * .44)), screenMat);
      screen.position.set(0, obj.height * S * .56, obj.depth * S * .5 + 0.006);
      screen.userData.kind = 'screen';
      wrapper.add(screen);
      wrapper.userData.screen = screen;
    }
    if (kind === 'speaker') {
      const mat2 = new THREE.SpriteMaterial({ map: canvasGlow('#a9e1cf'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const ring = new THREE.Sprite(mat2);
      const s = Math.max(.28, obj.width * S * .8);
      ring.scale.set(s, s, 1);
      ring.position.y = obj.height * S * .55;
      wrapper.add(ring);
      wrapper.userData.pulse = ring;
    }
    if (kind === 'heating') {
      const mat3 = new THREE.SpriteMaterial({ map: canvasGlow('#ff9d5c'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const warm = new THREE.Sprite(mat3);
      const s = Math.max(.34, obj.width * S * .9);
      warm.scale.set(s, s * .65, 1);
      warm.position.y = obj.height * S * .2;
      wrapper.add(warm);
      wrapper.userData.warm = warm;
    }
    if (kind === 'door' || kind === 'window') {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(.18, obj.width * S * .16), Math.max(.2, obj.width * S * .2), 24, 1, 0, Math.PI * .55),
        new THREE.MeshBasicMaterial({ color: '#f3b57e', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
      );
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.012;
      wrapper.add(arc);
      wrapper.userData.openArc = arc;
    }
  }

  async _loadObjectModel(obj, wrapper) {
    if (!obj.model || !obj.modelKind || obj.modelKind === 'box') {
      this._placeholder(wrapper, obj, 'no-model');
      this._modelProgress();
      return;
    }
    const key = obj.modelKind + ':' + obj.model;
    try {
      const proto = await this._loadPrototype(obj, key);
      if (this.disposed || !wrapper.parent) return;
      const clone = proto.clone(true);
      clone.traverse(n => {
        if (n.isMesh) {
          n.castShadow = n.geometry?.attributes?.position?.count > 30;
          n.receiveShadow = true;
          if (Array.isArray(n.material)) n.material = n.material.map(m => this._cloneMaterial(m, obj));
          else n.material = this._cloneMaterial(n.material, obj);
          n.userData.objectId = obj.id;
        }
      });
      this._fitModel(clone, obj);
      wrapper.add(clone);
      wrapper.userData.model = clone;
    } catch (err) {
      console.warn('Model load failed', obj.name, err);
      this._placeholder(wrapper, obj, 'error');
    } finally {
      this._modelProgress();
    }
  }

  _cloneMaterial(source, obj) {
    const mat = source?.clone ? source.clone() : new THREE.MeshStandardMaterial();
    if (!mat.emissive) mat.emissive = new THREE.Color(0, 0, 0);
    mat.userData = { ...(mat.userData || {}), baseColor: mat.color?.clone(), baseEmissive: mat.emissive?.clone(), baseIntensity: mat.emissiveIntensity ?? 1, baseOpacity: mat.opacity ?? 1, baseTransparent: !!mat.transparent };
    if (!obj.mtl && !obj.model?.includes('/')) {
      mat.color?.set(FALLBACK[obj.kind] || FALLBACK.furniture);
      mat.roughness = obj.kind === 'display' ? 0.54 : 0.72;
      mat.metalness = obj.kind === 'light' ? 0.18 : 0.05;
      mat.side = THREE.DoubleSide;
    }
    if (obj.kind === 'window') {
      mat.transparent = true;
      mat.opacity = Math.min(mat.opacity ?? 1, 0.72);
      mat.side = THREE.DoubleSide;
      mat.depthWrite = false;
    }
    if (obj.kind === 'light') {
      mat.emissive = new THREE.Color(obj.color || '#e8c98f');
      mat.emissiveIntensity = 0.06;
    }
    if (obj.kind === 'display' || obj.kind === 'computer') {
      mat.color?.multiplyScalar(0.8);
      mat.roughness = 0.45;
    }
    return mat;
  }

  _placeholder(wrapper, obj, reason) {
    if (reason === 'no-model') {
      const geom = new THREE.BoxGeometry(Math.max(.04, obj.width * S * .72), Math.max(.04, obj.height * S * .72), Math.max(.04, obj.depth * S * .72));
      const mat = new THREE.MeshStandardMaterial({ color: FALLBACK[obj.kind] || FALLBACK.furniture, roughness: .8, metalness: .04, transparent: true, opacity: .78 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.y = obj.height * S / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.objectId = obj.id;
      wrapper.add(mesh);
      wrapper.userData.model = mesh;
    }
  }

  _fitModel(model, obj) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const sx = (obj.width * S) / Math.max(size.x, 1e-5);
    const sy = (obj.height * S) / Math.max(size.y, 1e-5);
    const sz = (obj.depth * S) / Math.max(size.z, 1e-5);
    model.scale.set(sx, sy, sz);
    model.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(model);
    const center = b2.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= b2.min.y;
  }

  _loadPrototype(obj, key) {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      const base = this.modelBase;
      const path = obj.model.split('/').map(encodeURIComponent).join('/');
      const modelUrl = base + path;
      const onObj = (group) => {
        group.updateMatrixWorld(true);
        // Apply SH3D's optional model rotation before we normalize the size.
        if (obj.modelRotation) {
          const nums = String(obj.modelRotation).trim().split(/\s+/).map(Number);
          if (nums.length === 9 && nums.every(Number.isFinite)) {
            const m = new THREE.Matrix4().set(
              nums[0], nums[1], nums[2], 0,
              nums[3], nums[4], nums[5], 0,
              nums[6], nums[7], nums[8], 0,
              0, 0, 0, 1
            );
            group.applyMatrix4(m);
          } else if (nums.length === 16 && nums.every(Number.isFinite)) {
            const m = new THREE.Matrix4().set(...nums);
            group.applyMatrix4(m);
          }
        }
        if (obj.mirrored) group.scale.x *= -1;
        group.traverse(n => { if (n.isMesh) n.material = this._cloneMaterial(n.material, obj); });
        resolve(group);
      };
      if (obj.mtl) {
        const mtlPath = obj.mtl.split('/').map(encodeURIComponent).join('/');
        const mtlDir = obj.mtl.includes('/') ? obj.mtl.slice(0, obj.mtl.lastIndexOf('/') + 1) : '';
        const mtlFile = obj.mtl.slice(mtlDir.length).split('/').map(encodeURIComponent).join('/');
        const mtlLoader = new MTLLoader();
        mtlLoader.setPath(base + mtlDir.split('/').map(encodeURIComponent).join('/'));
        mtlLoader.load(mtlFile, (materials) => {
          try { materials.preload(); } catch {}
          const objLoader = new OBJLoader();
          objLoader.setMaterials(materials);
          objLoader.setPath(base);
          objLoader.load(path, onObj, undefined, (err) => this._loadObjWithoutMtl(objLoader, modelUrl, onObj, reject, err));
        }, undefined, () => {
          const objLoader = new OBJLoader();
          objLoader.setPath(base);
          objLoader.load(path, onObj, undefined, reject);
        });
      } else {
        const objLoader = new OBJLoader();
        objLoader.setPath(base);
        objLoader.load(path, onObj, undefined, reject);
      }
    }).then(group => { this.cache.set(key, group); this.pending.delete(key); return group; }).catch(err => { this.pending.delete(key); throw err; });
    this.pending.set(key, promise);
    return promise;
  }

  _loadObjWithoutMtl(loader, url, onObj, reject, originalErr) {
    console.warn('MTL failed, trying OBJ only', originalErr);
    loader.load(url, onObj, undefined, reject);
  }

  _modelProgress() {
    this.loaded++;
    this.progress?.(this.loaded, this.total);
  }

  _buildOutline() {
    this.outline = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), 0xc45a3c);
    this.outline.visible = false;
    this.scene.add(this.outline);
  }

  _buildFloatButtons() {
    for (const obj of this.sceneData.objects) {
      const mapping = this.mappings[obj.id];
      if (!mapping?.button) continue;
      const el = document.createElement('button');
      el.className = 'float-btn';
      el.dataset.objectId = obj.id;
      el.addEventListener('click', e => {
        e.stopPropagation();
        if (this._suppressFloatClick) { this._suppressFloatClick = false; return; }
        this.onFloatClick?.(obj);
      });
      el.addEventListener('pointerdown', e => {
        e.stopPropagation();
        const t = setTimeout(() => { this._suppressFloatClick = true; this.onObjectLongPress?.(obj); }, 620);
        const clear = () => { clearTimeout(t); el.removeEventListener('pointerup', clear); el.removeEventListener('pointerleave', clear); };
        el.addEventListener('pointerup', clear, { once: true });
        el.addEventListener('pointerleave', clear, { once: true });
      });
      el.innerHTML = `<svg><use href="#${KIND[obj.kind]?.icon || 'i-cube'}"/></svg><span class="flabel"></span>`;
      this.floatingEl.appendChild(el);
      this.floatButtons.set(obj.id, { el, obj, shown: false });
    }
  }

  setMappings(mappings) {
    this.mappings = mappings || {};
    for (const [id, btn] of this.floatButtons) if (!this.mappings[id]?.button) { btn.el.remove(); this.floatButtons.delete(id); }
    for (const obj of this.sceneData?.objects || []) {
      if (this.mappings[obj.id]?.button && !this.floatButtons.has(obj.id)) {
        // Rebuild only the new button.
        const mapping = this.mappings[obj.id];
        const el = document.createElement('button');
        el.className = 'float-btn';
        el.addEventListener('click', e => { e.stopPropagation(); this.onFloatClick?.(obj); });
        el.innerHTML = `<svg><use href="#${KIND[obj.kind]?.icon || 'i-cube'}"/></svg><span class="flabel"></span>`;
        this.floatingEl.appendChild(el);
        this.floatButtons.set(obj.id, { el, obj, shown: false });
      }
    }
    this._applyStates();
  }

  setStates(states) {
    this.states = states || {};
    this._applyStates();
  }

  _applyStates() {
    if (!this.sceneData) return;
    for (const obj of this.sceneData.objects) {
      const mapping = this.mappings[obj.id];
      const wrapper = this.objectGroups.get(obj.id);
      if (!wrapper) continue;
      const vs = visualState(mapping ? { ...mapping, kind: obj.kind } : { kind: obj.kind }, this.states);
      const mapped = !!mapping?.entity_id;
      this._applyVisual(obj, wrapper, vs, mapped);
      const btn = this.floatButtons.get(obj.id);
      if (btn) this._updateFloat(btn, obj, mapping, vs);
    }
    this._applyVisibility();
  }

  _applyVisual(obj, wrapper, vs, mapped) {
    const glow = wrapper.userData.glow;
    const point = wrapper.userData.point;
    const screen = wrapper.userData.screen;
    const pulse = wrapper.userData.pulse;
    const warm = wrapper.userData.warm;
    const arc = wrapper.userData.openArc;
    const active = mapped && vs.on;
    const c = cssColor(vs.color || obj.color || (obj.kind === 'display' ? '#9bd6ff' : '#ffd39a'));
    if (glow) {
      glow.material.color.set(c);
      glow.material.opacity = active ? Math.min(0.78, 0.36 + 0.32 * (vs.brightness / 255)) * (vs.glow ?? 1) : (obj.kind === 'light' && !mapped ? 0.08 : 0);
      const s = Math.max(.28, Math.min(1.8, obj.width * S * (obj.kind === 'light' ? 1.05 : .8)));
      glow.scale.set(s, s, 1);
    }
    if (point) {
      point.color.set(c);
      point.intensity = active ? 0.65 + 1.15 * ((vs.brightness || 0) / 255) : 0;
      point.distance = Math.max(3.2, obj.height * S * 2.2);
    }
    wrapper.traverse(n => {
      if (!n.isMesh || !n.material || n.material === glow?.material) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mats) {
        if (!m?.userData?.baseEmissive) continue;
        const isLight = obj.kind === 'light';
        if (isLight) {
          m.emissive.copy(c);
          m.emissiveIntensity = vs.on ? 0.28 + 0.75 * (vs.brightness / 255) : 0.03;
        } else if (obj.kind === 'speaker') {
          m.emissive.copy(c);
          m.emissiveIntensity = vs.on ? 0.12 : 0.0;
        } else if (obj.kind === 'heating') {
          m.emissive.set('#ff8a4c');
          m.emissiveIntensity = mapped ? 0.035 : 0.0;
        }
      }
    });
    if (screen) {
      const on = mapped && (vs.screen || (vs.on && (obj.kind === 'display' || obj.kind === 'computer')));
      screen.material.color.set(vs.color || '#93ccff');
      screen.material.opacity = on ? 0.56 : 0;
    }
    if (pulse) {
      pulse.material.opacity = active ? 0.25 : 0;
      pulse.userData.active = active;
    }
    if (warm) {
      warm.material.opacity = mapped && vs.on ? 0.32 : 0;
    }
    if (arc) {
      arc.material.opacity = mapped && vs.open ? 0.42 : 0;
    }
    wrapper.userData.active = active;
    wrapper.userData.vs = vs;
  }

  _updateFloat(btn, obj, mapping, vs) {
    const entity = vs.entity;
    const name = mapping.label || entityName(this.states, mapping.entity_id, obj.name);
    let text = name;
    if (obj.kind === 'light') text = entity?.state === 'on' ? `${Math.round((entity.attributes?.brightness || 255) / 2.55)}%` : 'aus';
    else if (obj.kind === 'heating') { const t = entity?.attributes?.current_temperature ?? entity?.attributes?.temperature; text = t !== undefined ? `${Number(t).toFixed(1)}°` : 'Heizung'; }
    else if (obj.kind === 'display' || obj.kind === 'computer') text = vs.on ? 'an' : 'aus';
    else if (obj.kind === 'speaker') text = entity?.state === 'playing' ? 'spielt' : (entity?.state === 'paused' ? 'Pause' : 'aus');
    else if (obj.kind === 'door' || obj.kind === 'window') text = entity?.state === 'open' ? 'offen' : 'zu';
    else text = entity?.state || '—';
    const icon = KIND[obj.kind]?.icon || 'i-cube';
    btn.el.classList.toggle('is-on', !!vs.on);
    btn.el.classList.toggle('is-heat', obj.kind === 'heating');
    btn.el.innerHTML = `<svg><use href="#${icon}"/></svg><span class="flabel">${mapping.label || obj.name}</span><span class="fstate">${text}</span>`;
  }

  updateFloatPositions() {
    if (!this.floatButtons.size) return;
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const items = [];
    for (const [id, btn] of this.floatButtons) {
      const wrapper = this.objectGroups.get(id);
      if (!wrapper || !btn.el.isConnected) continue;
      const obj = btn.obj;
      v.set(0, obj.height * S + 0.16, 0);
      wrapper.localToWorld(v);
      v.project(this.camera);
      const x = (v.x * .5 + .5) * rect.width;
      const y = (-v.y * .5 + .5) * rect.height;
      const behind = v.z > 1 || v.z < -1;
      const visible = !behind && x > -60 && x < rect.width + 60 && y > 10 && y < rect.height + 60 && wrapper.visible && this._isInScope(obj);
      btn.el.classList.toggle('is-hidden', !visible);
      if (visible) {
        items.push({ btn, x, y, w: 100, h: 34 });
      }
    }
    items.sort((a, b) => a.y - b.y);
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = items[i], b = items[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) {
          a.y = b.y - b.h - 4;
        }
      }
      items[i].btn.el.style.left = items[i].x + 'px';
      items[i].btn.el.style.top = items[i].y + 'px';
    }
  }

  _isInScope(obj) {
    if (!this.levelGroups.get(obj.level)?.visible) return false;
    if ((this.scope.mode === 'room' || this.scope.focus !== 'none') && this.scope.room) {
      if (this.scope.mode === 'room' && obj.room !== this.scope.room) return false;
    }
    return true;
  }

  setScope(scope) {
    this.scope = { ...this.scope, ...scope };
    if (scope.level && scope.level !== this.levelId) {
      const previous = this.levelId;
      this.levelId = scope.level;
      this.options.onLevelChange?.(this.levelId, previous);
    }
    this._applyVisibility();
    if (scope.fit !== false) this.fitScope();
  }

  _applyVisibility() {
    if (!this.sceneData) return;
    const activeLevels = this.scope.allLevels ? new Set(this.sceneData.levels.map(l => l.id)) : new Set([this.levelId || this.sceneData.levels[0].id]);
    for (const [id, group] of this.levelGroups) group.visible = activeLevels.has(id);
    const roomScope = this.scope.mode === 'room' || (this.scope.focus !== 'none' && this.scope.room);
    const targetRoom = this.scope.room;
    for (const { mesh, room, level } of this.roomMeshes) {
      if (!activeLevels.has(level)) continue;
      let visible = true;
      if (roomScope && targetRoom) visible = room.id === targetRoom ? true : this.scope.focus === 'dim';
      if (mesh.userData.ceiling) visible = visible && (this.config?.scene?.showCeilings === true);
      mesh.visible = visible;
      if (!visible) continue;
      const dim = roomScope && targetRoom && room.id !== targetRoom ? 0.22 : 1;
      const isCeil = !!mesh.userData.ceiling;
      if (isCeil) { mesh.material.transparent = true; mesh.material.opacity = 0.12 * dim; }
      else { mesh.material.opacity = dim; mesh.material.transparent = dim < 1; }
    }
    const hideGlobalSlab = roomScope && !!targetRoom;
    for (const s of this.slabs) {
      s.mesh.visible = activeLevels.has(s.level) && !hideGlobalSlab;
    }
    for (const w of this.wallGroups) {
      let visible = activeLevels.has(w.level);
      let dim = 1;
      if (visible && roomScope && targetRoom) {
        if (w.room && w.room !== targetRoom) {
          if (this.scope.focus === 'isolate') visible = false;
          else dim = 0.16;
        }
      }
      w.mesh.visible = visible;
      if (visible) this._dimMesh(w.mesh, dim);
    }
    for (const obj of this.sceneData.objects) {
      const wrapper = this.objectGroups.get(obj.id);
      if (!wrapper) continue;
      let visible = activeLevels.has(obj.level);
      let dim = 1;
      if (visible && roomScope && targetRoom) {
        if (obj.room !== targetRoom) {
          if (this.scope.focus === 'isolate') visible = false;
          else dim = 0.18;
        }
      }
      wrapper.visible = visible;
      if (visible) this._dimGroup(wrapper, dim);
      const btn = this.floatButtons.get(obj.id);
      if (btn && (!visible || (roomScope && targetRoom && obj.room !== targetRoom))) btn.el.classList.add('is-hidden');
    }
    for (const { object, room } of this.roomLabels) {
      object.visible = activeLevels.has(room.level) && (!roomScope || !targetRoom || room.id === targetRoom);
    }
    this._updateOutline();
    this.updateFloatPositions();
  }

  _dimGroup(group, dim) {
    group.traverse(n => {
      if (!n.isMesh || n.userData?.objectId === undefined && n.userData?.kind !== 'wall') return;
      this._dimMesh(n, dim);
    });
  }

  _dimMesh(mesh, dim) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      if (!m.userData.__base) m.userData.__base = { opacity: m.opacity ?? 1, transparent: !!m.transparent };
      if (dim >= 1) { m.opacity = m.userData.__base.opacity; m.transparent = m.userData.__base.transparent; }
      else { m.transparent = true; m.opacity = Math.min(m.userData.__base.opacity, 1) * dim; }
      m.needsUpdate = true;
    }
  }

  fitScope() {
    if (!this.sceneData) return;
    const box = this._scopeBox();
    this._fitBox(box, this._currentView || 'iso');
  }

  _scopeBox() {
    const box = new THREE.Box3();
    const lvl = this.levels.get(this.levelId);
    if (this.scope.mode === 'room' && this.scope.room) {
      const room = this.sceneData.rooms.find(r => r.id === this.scope.room);
      if (room) {
        for (const p of room.points) box.expandByPoint(new THREE.Vector3(this._wx(p[0]), this._levelY(room.level), this._wz(p[1])));
        box.expandByPoint(new THREE.Vector3(this._wx(room.center[0]), this._levelY(room.level) + (lvl?.height || 250) * S, this._wz(room.center[1])));
        return box;
      }
    }
    if (this.scope.allLevels) {
      for (const l of this.sceneData.levels) {
        box.expandByPoint(new THREE.Vector3(this._wx(this.sceneData.bounds.minX), this._levelY(l.id), this._wz(this.sceneData.bounds.minY)));
        box.expandByPoint(new THREE.Vector3(this._wx(this.sceneData.bounds.maxX), this._levelY(l.id) + l.height * S, this._wz(this.sceneData.bounds.maxY)));
      }
    } else {
      box.expandByPoint(new THREE.Vector3(this._wx(this.sceneData.bounds.minX), this._levelY(this.levelId), this._wz(this.sceneData.bounds.minY)));
      box.expandByPoint(new THREE.Vector3(this._wx(this.sceneData.bounds.maxX), this._levelY(this.levelId) + (lvl?.height || 250) * S, this._wz(this.sceneData.bounds.maxY)));
    }
    return box;
  }

  setView(view = 'iso', animate = true) {
    if (view === 'walk') { this.enterWalk(); return; }
    if (this.walking) this.exitWalk();
    this._currentView = view;
    const box = this._scopeBox();
    this._fitBox(box, view, animate);
    this.options.onViewChange?.(view);
  }

  _fitBox(box, view, animate = true) {
    if (!box || box.isEmpty()) box = this._scopeBox();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const max = Math.max(size.x, size.z, 1.2);
    const dist = Math.max(2.4, max * (view === 'top' ? 1.25 : 1.52) + 2.2);
    let dir;
    if (view === 'top') dir = new THREE.Vector3(0.0001, 1, 0.0001);
    else if (view === 'front') dir = new THREE.Vector3(0, 0.24, 1);
    else dir = new THREE.Vector3(1.05, 0.92, 1.25);
    dir.normalize();
    const target = new THREE.Vector3(center.x, box.min.y + size.y * (view === 'top' ? 0.5 : 0.44), center.z);
    this.camera.up.set(0, 1, 0);
    let pos;
    if (view === 'top') {
      this.camera.up.set(0, 0, -1);
      pos = new THREE.Vector3(center.x, box.max.y + dist, center.z + 0.001);
    } else {
      pos = target.clone().add(dir.normalize().multiplyScalar(dist));
    }
    if (animate) this._tweenCamera(pos, target, 620);
    else { this.camera.position.copy(pos); this.controls.target.copy(target); this.controls.update(); }
  }

  _tweenCamera(pos, target, ms = 620) {
    if (this.walking) return;
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const t0 = performance.now();
    this._tween = { startPos, startTarget, pos, target, t0, ms };
  }

  focusObject(id) {
    const wrapper = this.objectGroups.get(id);
    if (!wrapper) return;
    const box = new THREE.Box3().setFromObject(wrapper);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dist = Math.max(1.6, Math.max(size.x, size.y, size.z) * 2.8);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.length() < .1) dir.set(1, .8, 1).normalize();
    const target = center.clone();
    const pos = center.clone().add(dir.multiplyScalar(dist));
    this._tweenCamera(pos, target, 500);
    this.selectObject(id);
  }

  selectObject(id) {
    this.selectedId = id;
    this._updateOutline();
  }

  _updateOutline() {
    if (!this.outline) return;
    const wrapper = this.selectedId ? this.objectGroups.get(this.selectedId) : null;
    if (!wrapper || !wrapper.visible) { this.outline.visible = false; return; }
    const box = new THREE.Box3().setFromObject(wrapper);
    if (box.isEmpty()) { this.outline.visible = false; return; }
    box.expandByScalar(0.025);
    this.outline.box.copy(box);
    this.outline.visible = true;
  }

  _pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const groups = [...this.objectGroups.values()].filter(g => g.visible);
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const h of hits) {
      const id = h.object.userData?.objectId;
      if (id) return { object: this.sceneData.objects.find(o => o.id === id), group: this.objectGroups.get(id), point: h.point };
    }
    return null;
  }

  _onPointerDown(e) {
    this.pointer.down = true;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.moved = 0;
    this.pointer.t = performance.now();
    this._walkDragging = this.walking;
    if (this.walking) {
      if (document.pointerLockElement !== this.canvas && this.canvas.requestPointerLock) this.canvas.requestPointerLock();
      return;
    }
    const hit = this._pick(e.clientX, e.clientY);
    this.pointer.objectId = hit?.object?.id || null;
    if (hit) {
      this.canvas.style.cursor = 'pointer';
      if (this.pointer.longTimer) clearTimeout(this.pointer.longTimer);
      this.pointer.longTimer = setTimeout(() => {
        if (this.pointer.moved < 10) {
          this.pointer.longFired = true;
          this.onObjectLongPress?.(hit.object, hit.group);
        }
      }, 650);
    }
  }

  _onPointerMove(e) {
    if (this.walking) {
      if (this._walkDragging) {
        const dx = e.clientX - this.pointer.x, dy = e.clientY - this.pointer.y;
        this._look(dx, dy);
        this.pointer.x = e.clientX; this.pointer.y = e.clientY;
      }
      return;
    }
    if (this.pointer.down) {
      this.pointer.moved = Math.max(this.pointer.moved, Math.hypot(e.clientX - this.pointer.x, e.clientY - this.pointer.y));
      if (this.pointer.moved > 10 && this.pointer.longTimer) { clearTimeout(this.pointer.longTimer); this.pointer.longTimer = null; }
    } else {
      const hit = this._pick(e.clientX, e.clientY);
      const id = hit?.object?.id || null;
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        this.canvas.style.cursor = id ? 'pointer' : 'grab';
      }
    }
  }

  _onPointerUp(e) {
    if (this.walking) { this._walkDragging = false; this.pointer.down = false; return; }
    this.pointer.down = false;
    if (this.pointer.longTimer) clearTimeout(this.pointer.longTimer);
    this.pointer.longTimer = null;
    if (this.pointer.moved > 8 || this.pointer.longFired) { this.pointer.longFired = false; return; }
    const hit = this._pick(e.clientX, e.clientY);
    if (hit?.object) this.onObjectClick?.(hit.object, hit.group);
    else this.onBackgroundClick?.();
  }

  _clearHover() {
    this.hoveredId = null;
    this.canvas.style.cursor = 'grab';
  }

  _look(dx, dy) {
    this.walkYaw -= dx * 0.0024;
    this.walkPitch -= dy * 0.0022;
    this.walkPitch = Math.max(-1.2, Math.min(1.2, this.walkPitch));
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.walkYaw;
    this.camera.rotation.x = this.walkPitch;
  }

  enterWalk() {
    if (this.walking) return;
    this.walking = true;
    this._currentView = 'walk';
    this._wasPosition = this.camera.position.clone();
    this._wasTarget = this.controls.target.clone();
    this.controls.enabled = false;
    document.body.classList.add('walking');
    const y = this._levelY(this.levelId) + 1.62;
    const level = this.levels.get(this.levelId);
    const center = this.sceneData.rooms.filter(r => r.level === this.levelId).sort((a, b) => b.area - a.area)[0]?.center;
    this.camera.position.set(this._wx(center?.[0] ?? (this.sceneData.bounds.minX + this.sceneData.bounds.maxX) / 2), y, this._wz(center?.[1] ?? (this.sceneData.bounds.minY + this.sceneData.bounds.maxY) / 2));
    this.walkYaw = -Math.PI / 2;
    this.walkPitch = -0.05;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.walkPitch, this.walkYaw, 0);
    this.options.onViewChange?.('walk');
    this.walkHint?.classList.add('is-on');
    this.walkPad?.classList.add('is-on');
    this.canvas.requestPointerLock?.();
  }

  exitWalk(revert = true) {
    if (!this.walking) return;
    this.walking = false;
    this._walkDragging = false;
    document.body.classList.remove('walking');
    this.controls.enabled = true;
    this.walkHint?.classList.remove('is-on');
    this.walkPad?.classList.remove('is-on');
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
    if (revert) {
      this._currentView = 'iso';
      this.setView('iso');
    }
    this.options.onViewChange?.(this._currentView || 'iso');
  }

  setAutoRotate(on) {
    this.autoRotate = !!on;
    this.controls.autoRotate = !!on;
    this.controls.autoRotateSpeed = 0.55;
  }

  setCeilings(on) {
    if (this.config.scene) this.config.scene.showCeilings = !!on;
    this._applyVisibility();
  }

  setLabels(on) {
    this.labelsEl.style.display = on ? '' : 'none';
  }

  progress(fn) { this.progress = fn; }
  loadingDone(fn) { this.loadingDone = fn; }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  _animate() {
    if (this.disposed) return;
    this._frame = requestAnimationFrame(() => this._animate());
    const dt = Math.min(0.05, this._clock.getDelta());
    const now = performance.now();
    if (this._tween) {
      let p = (now - this._tween.t0) / this._tween.ms;
      p = Math.max(0, Math.min(1, p));
      const e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.camera.position.lerpVectors(this._tween.startPos, this._tween.pos, e);
      this.controls.target.lerpVectors(this._tween.startTarget, this._tween.target, e);
      if (p >= 1) this._tween = null;
    }
    if (this.walking) this._walkStep(dt);
    else this.controls.update();
    if (this.autoRotate && !this.walking) this.controls.update();
    for (const [id, btn] of this.floatButtons) {
      const wrapper = this.objectGroups.get(id);
      const pulse = wrapper?.userData?.pulse;
      if (pulse?.userData?.active) {
        const s = 1 + Math.sin(now / 280) * 0.14;
        const base = pulse.userData.baseScale || pulse.scale.x;
        pulse.userData.baseScale = base;
        pulse.scale.set(base * s, base * s, 1);
        pulse.material.opacity = 0.12 + 0.16 * (0.5 + 0.5 * Math.sin(now / 280));
      }
    }
    this.updateFloatPositions();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  _walkStep(dt) {
    const speed = (this.keys.has('ShiftLeft') ? 3.8 : 1.9) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.walkYaw), 0, -Math.cos(this.walkYaw));
    const right = new THREE.Vector3(Math.cos(this.walkYaw), 0, -Math.sin(this.walkYaw));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp') || this.movePad.has('f')) move.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.movePad.has('b')) move.sub(forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight') || this.movePad.has('r')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft') || this.movePad.has('l')) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      this.camera.position.add(move);
    }
    this.camera.position.y = this._levelY(this.levelId) + 1.62;
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this._frame);
    this._onResize?.disconnect();
    window.removeEventListener('resize', this._resize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
