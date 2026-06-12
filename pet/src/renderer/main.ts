import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { io, type Socket } from 'socket.io-client';

declare global {
  interface Window {
    pet?: {
      setClickable: (clickable: boolean) => void;
      drag: (dx: number, dy: number) => void;
      relocate: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void;
      resize: (scale: number) => void;
      getScale: () => Promise<number>;
      onCursor: (cb: (c: { cx: number; cy: number; ww: number; wh: number; inside: boolean }) => void) => void;
      onHotkey: (cb: (name: string) => void) => void;
      listVoices: () => Promise<string[]>;
      getServerUrl: () => Promise<string>;
      getRoomSecret: () => Promise<string>;
      getDesktopSourceId: () => Promise<string | null>;
    };
  }
}

type PetBridge = NonNullable<Window['pet']>;

const browserPetBridge: PetBridge = {
  setClickable: () => {},
  drag: () => {},
  relocate: () => {},
  resize: () => {},
  getScale: async () => 1,
  onCursor: (cb) => {
    const emit = (cx: number, cy: number, inside: boolean) => {
      cb({ cx, cy, ww: window.innerWidth, wh: window.innerHeight, inside });
    };
    window.addEventListener('mousemove', (e) => emit(e.clientX, e.clientY, true));
    window.addEventListener('mouseenter', (e) => emit(e.clientX, e.clientY, true));
    window.addEventListener('mouseleave', (e) => emit(e.clientX, e.clientY, false));
  },
  onHotkey: () => {},
  listVoices: async () => [],
  getServerUrl: async () => 'http://localhost:3030',
  getRoomSecret: async () => 'change-me',
  getDesktopSourceId: async () => null,
};

const petBridge: PetBridge = window.pet ?? browserPetBridge;

const VRM_URL = '/sample.vrm';
const MOTION_MANIFEST_URL = '/motions/manifest.json';
const MOTION_BASE_URL = '/motions/';
const MOTION_FADE_SECONDS = 0.18;

// 模型整体 Y 轴旋转：当前模型符合 VRM +Z 规范（背对相机），转 PI 面向用户。
// 若换的模型原生已朝用户，改为 0。
const MODEL_SCENE_ROT_Y = Math.PI;
// 头骨跟随光标的 yaw 符号：随 MODEL_SCENE_ROT_Y 翻转。
// rot=0（朝 -Z）时 θ = atan2(-dx,-dz)；rot=PI（朝 +Z）时 θ = atan2(dx,dz)。
const MODEL_YAW_SIGN = MODEL_SCENE_ROT_Y === 0 ? -1 : 1;

const app = document.getElementById('app')!;
const fallback = document.getElementById('fallback')!;
const hud = document.getElementById('hud')!;
const flash = document.getElementById('flash')!;
const replyEl = document.getElementById('reply')!;
const chatBox = document.getElementById('chat')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const sizeBox = document.getElementById('size')!;
const sizeRange = document.getElementById('size-range') as HTMLInputElement;
const sizeVal = document.getElementById('size-val')!;

type MotionFallbackPart = 'head' | 'body' | 'tail';

type MotionManifestEntry = {
  id: string;
  label: string;
  file: string;
  loop: boolean;
  fallback?: MotionFallbackPart;
};

type MotionMeta = {
  id: string;
  label: string;
  loop: boolean;
};

// === Three.js scene ===
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, premultipliedAlpha: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.3, 3);
camera.lookAt(0, 1.3, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

const lookTarget = new THREE.Object3D();
lookTarget.position.set(0, 1.3, 2);
scene.add(lookTarget);

const lookMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.025, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xff66cc, transparent: true, opacity: 0.85, depthTest: false }),
);
lookMarker.renderOrder = 999;
scene.add(lookMarker);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// === VRM load + auto-frame ===
let vrm: VRM | null = null;
let modelBaseY = 0;
let headY = 1.5;
let modelMinY = 0;
let modelCenter = new THREE.Vector3(0, 1.3, 0);
let availableExpressions: Set<string> = new Set();
const motionManifest = new Map<string, MotionManifestEntry>();
// 缓存绑定到当前 vrm 的最终 AnimationClip（由 .vrma 经 createVRMAnimationClip 生成）。
const motionClipCache = new Map<string, Promise<THREE.AnimationClip | null>>();
let motionList: MotionMeta[] = [];
let motionMixer: THREE.AnimationMixer | null = null;
let currentMotionAction: THREE.AnimationAction | null = null;
let currentMotionId = '';
let currentMotionStopTimer = 0;

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  VRM_URL,
  (gltf) => {
    const v: VRM = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    v.scene.traverse((obj: any) => { if (obj.isMesh) obj.frustumCulled = false; });
    // 模型朝向：VRM 规范模型默认面朝 +Z（背对相机），需转 PI 面向用户。
    // 但本模型导出时已面朝 -Z（朝用户），故不旋转。换模型若背对屏幕，把这里改回 Math.PI，
    // 并同步翻转下方头骨跟随的 yaw 符号（见 tick 里 MODEL_YAW_SIGN 说明）。
    if (v.scene) v.scene.rotation.y = MODEL_SCENE_ROT_Y;
    scene.add(v.scene);
    if (v.lookAt) v.lookAt.target = lookTarget;
    vrm = v;
    modelBaseY = v.scene.position.y;
    motionMixer = new THREE.AnimationMixer(v.scene);
    motionMixer.addEventListener('finished', ((event: THREE.Event) => {
      const action = (event as THREE.Event & { action?: THREE.AnimationAction }).action;
      if (action && action === currentMotionAction) {
        action.stop();
        currentMotionAction = null;
        currentMotionId = '';
      }
    }) as THREE.EventListener);

    try {
      const exps: any[] = (v.expressionManager as any)?.expressions ?? [];
      for (const e of exps) if (e?.expressionName) availableExpressions.add(e.expressionName);
    } catch {}
    console.log('[VRM] expressions:', Array.from(availableExpressions));

    try {
      const headBone = v.humanoid?.getNormalizedBoneNode('head');
      if (headBone) headY = headBone.getWorldPosition(new THREE.Vector3()).y;
    } catch {}

    try {
      const box = new THREE.Box3().setFromObject(v.scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      modelMinY = box.min.y;
      modelCenter.copy(center);

      const fovV = (camera.fov * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
      const distV = (size.y / 2) / Math.tan(fovV / 2);
      const distH = (size.x / 2) / Math.tan(fovH / 2);
      const dist = Math.max(distV, distH) * 1.15 + 0.2;

      camera.position.set(center.x, center.y, center.z + dist);
      camera.lookAt(center.x, center.y, center.z);
    } catch (e) {
      console.warn('[VRM] auto-frame failed:', e);
    }

    fallback.classList.add('hidden');
  },
  undefined,
  (err) => console.warn('VRM load failed:', err)
);

// === Expression system ===
type ExpName = 'neutral' | 'joy' | 'sorrow' | 'angry' | 'surprised' | 'blink' | 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

// 一个逻辑表情映射到多个可能的 blendShape/expression 名，逐个 setValue，命中哪个算哪个
// （不存在的名字被 expressionManager 静默忽略）。同时覆盖：
//   - VRM 1.0 标准 preset（小写：happy/angry/sad/relaxed/surprised/neutral，口型 aa/ih/ou/ee/oh）
//   - VRM 0.x 旧 preset / 大写自定义名（Joy/Angry/A/E/...）
// 这样换不同版本/不同作者的模型时，情绪表情都能尽量命中。
const EXP_ALIASES: Record<string, string[]> = {
  joy:       ['happy', 'joy', 'Joy', 'Happy', 'fun', 'Fun'],
  sorrow:    ['sad', 'sorrow', 'Sorrow', 'Sad'],
  angry:     ['angry', 'Angry'],
  surprised: ['surprised', 'Surprised'],
  neutral:   ['neutral', 'Neutral', 'relaxed', 'Relaxed'],
  blink:     ['blink', 'Blink'],
  aa: ['aa', 'a', 'A'],
  ih: ['ih', 'i', 'I'],
  ou: ['ou', 'u', 'U'],
  ee: ['ee', 'e', 'E'],
  oh: ['oh', 'o', 'O'],
};

type ExpSlot = { current: number; target: number; durationLeft: number };
const expState = new Map<string, ExpSlot>();

function setExpression(name: ExpName, target: number, fadeMs = 300) {
  const aliases = EXP_ALIASES[name] ?? [name];
  for (const n of aliases) {
    const prev = expState.get(n);
    expState.set(n, {
      current: prev?.current ?? 0,
      target,
      durationLeft: Math.max(1, fadeMs) / 1000,
    });
  }
}

function updateExpressions(dt: number) {
  if (!vrm?.expressionManager) return;
  for (const [name, s] of expState) {
    if (Math.abs(s.current - s.target) < 0.001) { s.current = s.target; continue; }
    const step = (s.target - s.current) * Math.min(1, dt / s.durationLeft);
    s.current += step;
    s.durationLeft = Math.max(0.01, s.durationLeft - dt);
    try { vrm.expressionManager.setValue(name, s.current); } catch {}
  }
}

// === Cursor stream ===
const ndc = new THREE.Vector2(-2, -2);
let cursorInside = false;
let cursorPx = { x: -1, y: -1 };
petBridge.onCursor((c) => {
  cursorInside = c.inside;
  cursorPx = { x: c.cx, y: c.cy };
  const rx = (c.cx / c.ww) * 2 - 1;
  const ry = -(c.cy / c.wh) * 2 + 1;
  ndc.x = Math.max(-2.5, Math.min(2.5, rx));
  ndc.y = Math.max(-2.5, Math.min(2.5, ry));
});

// 光标是否在滑块控件上（用屏幕坐标命中，因为透明窗穿透时 DOM pointer 事件不会触发）。
function cursorOverSlider(): boolean {
  const r = sizeBox.getBoundingClientRect();
  const { x, y } = cursorPx;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// === Drag + click reactions ===
let dragging = false;
let lastClickable = false;
let lastHitPart: string = '-';
let lastReactionMsg = '';
let lastReactionAt = 0;
const cooldownUntil: Record<'head' | 'body' | 'tail', number> = { head: 0, body: 0, tail: 0 };

function classifyHit(point: THREE.Vector3): 'head' | 'body' | 'tail' {
  const tailThreshold = modelMinY + (headY - modelMinY) * 0.30;
  if (point.y > headY - 0.10) return 'head';
  if (point.y < tailThreshold) return 'tail';
  return 'body';
}

const PART_EXPRESSION: Record<'head' | 'body' | 'tail', ExpName> = {
  head: 'joy',
  body: 'surprised',
  tail: 'angry',
};

function triggerReaction(part: 'head' | 'body' | 'tail') {
  const now = performance.now();
  if (now < cooldownUntil[part]) return;
  cooldownUntil[part] = now + 1500;

  const exp = PART_EXPRESSION[part];
  setExpression(exp, 1.0, 120);
  setTimeout(() => setExpression(exp, 0, 350), 650);

  lastReactionMsg = `${part.toUpperCase()}!`;
  lastReactionAt = now;
  flash.textContent = lastReactionMsg;
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 500);

  // 优先播预录台词；没有则只表情
  playVoiceFor(part).catch(() => {});
  console.log('[reaction]', part, '→', exp);
}

function fadeOutAction(action: THREE.AnimationAction | null, immediate = false) {
  if (!action) return;
  if (immediate) {
    action.stop();
    return;
  }
  action.fadeOut(MOTION_FADE_SECONDS);
  window.setTimeout(() => action.stop(), Math.ceil(MOTION_FADE_SECONDS * 1000) + 60);
}

function stopCurrentMotion(immediate = false) {
  if (currentMotionStopTimer) {
    window.clearTimeout(currentMotionStopTimer);
    currentMotionStopTimer = 0;
  }
  const action = currentMotionAction;
  currentMotionAction = null;
  currentMotionId = '';
  if (!action) return;
  if (immediate) {
    action.stop();
    return;
  }
  action.fadeOut(MOTION_FADE_SECONDS);
  currentMotionStopTimer = window.setTimeout(() => {
    action.stop();
    currentMotionStopTimer = 0;
  }, Math.ceil(MOTION_FADE_SECONDS * 1000) + 60);
}

async function loadMotionManifest() {
  motionManifest.clear();
  motionClipCache.clear();
  motionList = [];
  try {
    const r = await fetch(MOTION_MANIFEST_URL, { cache: 'no-store' });
    if (r.status === 404) {
      console.log('[motions] manifest missing');
      return;
    }
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('manifest must be an array');

    for (const raw of data) {
      const id = String(raw?.id ?? '').trim();
      const label = String(raw?.label ?? '').trim();
      const file = String(raw?.file ?? '').trim();
      const fallback = raw?.fallback;
      if (!id || !label || !file) continue;
      const entry: MotionManifestEntry = {
        id,
        label,
        file,
        loop: !!raw?.loop,
      };
      if (fallback === 'head' || fallback === 'body' || fallback === 'tail') {
        entry.fallback = fallback;
      }
      motionManifest.set(id, entry);
      motionList.push({ id, label, loop: entry.loop });
    }
    console.log('[motions] loaded:', motionList.map((m) => m.id));
  } catch (e) {
    console.warn('[motions] load failed:', e);
  }
}

// 加载 .vrma 并经 createVRMAnimationClip 绑定到当前 vrm，得到可直接喂 mixer 的 AnimationClip。
// VRMA 按 VRM 标准 humanoid 骨骼定义，库负责归一化，换模型无需任何重定向/缩放。
// 要求 vrm 已加载（调用点 playMotion 已有守卫）。
async function loadVrmaMotion(id: string): Promise<THREE.AnimationClip | null> {
  const existing = motionClipCache.get(id);
  if (existing) return existing;

  const entry = motionManifest.get(id);
  if (!entry || !vrm) return null;
  const targetVrm = vrm;

  const pending = new Promise<THREE.AnimationClip | null>((resolve) => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    loader.load(
      `${MOTION_BASE_URL}${entry.file}`,
      (gltf) => {
        const vrmAnim = gltf.userData?.vrmAnimations?.[0] ?? null;
        if (!vrmAnim) {
          console.warn('[motions] no vrmAnimation in file:', id, entry.file);
          resolve(null);
          return;
        }
        try {
          const clip = createVRMAnimationClip(vrmAnim, targetVrm);
          if (!clip || !clip.tracks?.length) {
            console.warn('[motions] empty clip for', id, 'tracks=', clip?.tracks?.length);
            resolve(null);
            return;
          }
          resolve(clip);
        } catch (e) {
          console.warn('[motions] createVRMAnimationClip failed:', id, e);
          resolve(null);
        }
      },
      undefined,
      (err) => {
        console.warn('[motions] vrma load failed:', id, err);
        resolve(null);
      }
    );
  });

  // 失败（null）时把缓存清掉，避免一次加载失败被永久缓存、补上文件后也不再重试。
  pending.then((clip) => {
    if (!clip && motionClipCache.get(id) === pending) motionClipCache.delete(id);
  }).catch(() => {
    if (motionClipCache.get(id) === pending) motionClipCache.delete(id);
  });

  motionClipCache.set(id, pending);
  return pending;
}

async function playMotion(id: string): Promise<boolean> {
  const entry = motionManifest.get(id);

  if (!entry) {
    console.warn('[motions] unknown motion:', id);
    return false;
  }

  if (!vrm || !motionMixer) {
    console.warn('[motions] motion system not ready:', id);
    if (entry.fallback) triggerReaction(entry.fallback);
    return false;
  }

  const clip = await loadVrmaMotion(id);
  if (!clip) {
    stopCurrentMotion();
    if (entry.fallback) triggerReaction(entry.fallback);
    return false;
  }

  if (currentMotionStopTimer) {
    window.clearTimeout(currentMotionStopTimer);
    currentMotionStopTimer = 0;
  }

  const nextAction = motionMixer.clipAction(clip, vrm.scene);
  if (currentMotionAction && currentMotionAction !== nextAction) {
    fadeOutAction(currentMotionAction);
  }

  nextAction.reset();
  nextAction.enabled = true;
  nextAction.clampWhenFinished = !entry.loop;
  nextAction.setEffectiveTimeScale(1);
  nextAction.setEffectiveWeight(1);
  nextAction.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, entry.loop ? Infinity : 1);
  nextAction.fadeIn(MOTION_FADE_SECONDS);
  nextAction.play();

  currentMotionAction = nextAction;
  currentMotionId = id;
  return true;
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !lastClickable || !vrm) return;
  // 输入框正在用，不当作戳模型
  if (document.activeElement === chatInput) return;
  dragging = true;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(vrm.scene, true);
  if (hits.length > 0) {
    const part = classifyHit(hits[0].point);
    lastHitPart = `${part} y=${hits[0].point.y.toFixed(2)}`;
    triggerReaction(part);
  } else {
    lastHitPart = 'miss';
  }
});
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (e.movementX || e.movementY) petBridge.drag(e.movementX, e.movementY);
});

// === Idle behaviors ===
function scheduleBlink() {
  const delay = 3000 + Math.random() * 3000;
  setTimeout(() => {
    setExpression('blink', 1.0, 40);
    setTimeout(() => setExpression('blink', 0, 120), 80);
    scheduleBlink();
  }, delay);
}
scheduleBlink();

function scheduleIdleExpression() {
  const delay = 8000 + Math.random() * 12000;
  setTimeout(() => {
    const choices: ExpName[] = ['joy', 'surprised', 'sorrow'];
    const pick = choices[Math.floor(Math.random() * choices.length)];
    setExpression(pick, 0.55, 400);
    setTimeout(() => setExpression(pick, 0, 700), 1600);
    scheduleIdleExpression();
  }, delay);
}
scheduleIdleExpression();

// === 服务器地址 + 预录台词清单 ===
let SERVER_URL = 'http://localhost:3030';
let ROOM_SECRET = 'change-me';
const voicesByPart: Record<'head' | 'body' | 'tail' | 'idle', string[]> = {
  head: [], body: [], tail: [], idle: [],
};
let voicesFlat: string[] = []; // 给 A 端 list-voices ack 用

(async () => {
  try { SERVER_URL = await petBridge.getServerUrl(); } catch {}
  try { ROOM_SECRET = await petBridge.getRoomSecret(); } catch {}
  await loadMotionManifest();
  try {
    const files = await petBridge.listVoices();
    for (const f of files) {
      const url = `/voices/${f}`;
      voicesFlat.push(url);
      const m = f.match(/^(head|body|tail|idle)_/i);
      if (m) voicesByPart[m[1].toLowerCase() as 'head' | 'body' | 'tail' | 'idle'].push(url);
    }
    console.log('[voices] loaded:', voicesByPart);
  } catch (e) {
    console.warn('[voices] load failed:', e);
  }
  // motions / voices 加载完之后再连远程，ack 才有内容
  connectRemote();
})();

// === Web Audio：播放音频 + 实时口型同步 ===
let audioCtx: AudioContext | null = null;
let currentAnalyser: AnalyserNode | null = null;
const lipBuf = new Uint8Array(128);

function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

async function playAudioBuffer(arrayBuffer: ArrayBuffer) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    console.warn('[audio] decode failed:', e);
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  analyser.connect(ctx.destination);
  currentAnalyser = analyser;
  src.start();
  await new Promise<void>((resolve) => {
    src.addEventListener('ended', () => resolve(), { once: true });
  });
  currentAnalyser = null;
}

async function playUrl(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn('[audio] fetch', r.status, url);
      return false;
    }
    await playAudioBuffer(await r.arrayBuffer());
    return true;
  } catch (e) {
    console.warn('[audio] play failed:', url, e);
    return false;
  }
}

async function playVoiceFor(part: 'head' | 'body' | 'tail' | 'idle'): Promise<boolean> {
  const list = voicesByPart[part];
  if (!list.length) return false;
  const url = list[Math.floor(Math.random() * list.length)];
  return playUrl(url);
}

// === Chat overlay ===
let chatOpen = false;
let chatBusy = false;
let replyTimer = 0;

function openChat() {
  if (chatBusy) return;
  chatOpen = true;
  chatBox.classList.remove('hidden');
  setTimeout(() => chatInput.focus(), 30);
}
function closeChat() {
  chatOpen = false;
  chatBox.classList.add('hidden');
  chatBox.classList.remove('loading');
  chatInput.value = '';
  chatInput.placeholder = '跟我说点什么…  (Enter 发送 / Esc 取消)';
  chatInput.blur();
}
function showReply(text: string, ms = 6000) {
  replyEl.textContent = text;
  replyEl.classList.add('on');
  if (replyTimer) window.clearTimeout(replyTimer);
  replyTimer = window.setTimeout(() => replyEl.classList.remove('on'), ms);
}

async function chatAndSpeak(text: string) {
  let reply = '';
  try {
    const r = await fetch(`${SERVER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn('[chat] http', r.status, err);
      showReply(r.status === 503 ? '呜...服务器还没接 DeepSeek key' : '说不出话了…', 3000);
      return;
    }
    const j = await r.json();
    reply = (j.reply || '').trim();
  } catch (e) {
    console.warn('[chat] failed:', e);
    showReply('网炸了…', 3000);
    return;
  }
  if (!reply) { showReply('？', 2500); return; }
  showReply(reply, 7000);
  // M3 决定：AI 回复只显示文字气泡，不播声音。
  // 声音留给：戳模型（预录）+ M4 A 端实时人声推过来。
}

chatInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeChat(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  chatBox.classList.add('loading');
  chatInput.value = '';
  chatInput.placeholder = '...';
  try {
    await chatAndSpeak(text);
  } finally {
    chatBusy = false;
    closeChat();
  }
});

petBridge.onHotkey((name) => {
  if (name === 'toggle-chat') {
    if (chatOpen) closeChat();
    else openChat();
  }
});

// === 大小调节滑块 ===
// 拖动 thumb 时光标可能短暂滑出控件边界，保持可点直到松手。
let sliderDragging = false;
sizeRange.addEventListener('pointerdown', () => { sliderDragging = true; });
window.addEventListener('pointerup', () => { sliderDragging = false; });
function updateSizeLabel(pct: number) {
  sizeVal.textContent = `${pct}%`;
}
sizeRange.addEventListener('input', () => {
  const pct = Number(sizeRange.value);
  updateSizeLabel(pct);
  petBridge.resize(pct / 100);
});
// 初始化滑块到已保存的 scale。
petBridge.getScale().then((scale) => {
  const pct = Math.round(scale * 100);
  sizeRange.value = String(pct);
  updateSizeLabel(pct);
}).catch(() => {});

// === 远程控制（M4a）===
// A 端（controller）通过 Socket.IO 发指令，B 端（pet）路由到现有动作函数 / FBX 动作。
type RemoteCommand =
  | { type: 'expression'; name: ExpName; strength?: number; holdMs?: number }
  | { type: 'animation'; name: string }
  | { type: 'say_audio'; url: string }
  | { type: 'say_tts'; text: string }
  | { type: 'relocate'; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };

let remoteSocket: Socket | null = null;
let remoteConnected = false;
let lastRemoteMsg = '';
let lastRemoteAt = 0;
let rtcPc: RTCPeerConnection | null = null;
let rtcScreenStream: MediaStream | null = null;
let rtcMicStream: MediaStream | null = null;
let rtcRemoteAudioStream: MediaStream | null = null;
const rtcPendingCandidates: RTCIceCandidateInit[] = [];
const rtcAudioEl = new Audio();
rtcAudioEl.autoplay = true;
rtcAudioEl.volume = 1;

type WebRtcSignal = {
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function noteRemote(msg: string) {
  lastRemoteMsg = msg;
  lastRemoteAt = performance.now();
  flash.textContent = `📡 ${msg}`;
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 500);
}

function handleRemoteCommand(cmd: RemoteCommand) {
  if (!cmd || typeof cmd !== 'object') return;
  switch (cmd.type) {
    case 'expression': {
      const strength = Math.max(0, Math.min(1, cmd.strength ?? 1));
      const hold = Math.max(150, Math.min(5000, cmd.holdMs ?? 800));
      setExpression(cmd.name, strength, 120);
      setTimeout(() => setExpression(cmd.name, 0, 400), hold);
      noteRemote(`expr ${cmd.name}`);
      break;
    }
    case 'animation': {
      void playMotion(cmd.name)
        .then((played) => {
          noteRemote(played ? `anim ${cmd.name}` : `anim ${cmd.name} fallback`);
        })
        .catch((e) => {
          console.warn('[motions] remote play failed:', cmd.name, e);
          noteRemote(`anim ${cmd.name} err`);
        });
      break;
    }
    case 'say_audio': {
      if (typeof cmd.url !== 'string' || !cmd.url) return;
      playUrl(cmd.url).catch(() => {});
      noteRemote(`audio ${cmd.url.split('/').pop()}`);
      break;
    }
    case 'say_tts': {
      const text = String(cmd.text ?? '').slice(0, 1000).trim();
      if (!text) return;
      const url = `${SERVER_URL}/api/tts?text=${encodeURIComponent(text)}`;
      playUrl(url).catch(() => {});
      showReply(text, 6000);
      noteRemote(`tts "${text.slice(0, 16)}${text.length > 16 ? '…' : ''}"`);
      break;
    }
    case 'relocate': {
      petBridge.relocate(cmd.corner);
      noteRemote(`relocate ${cmd.corner}`);
      break;
    }
    default:
      console.warn('[remote] unknown cmd', cmd);
  }
}

function reportRtcError(message: string) {
  console.warn('[webrtc]', message);
  showReply(message, 4000);
  noteRemote(`call err`);
  remoteSocket?.emit('webrtc:error', { message });
}

function cleanupRtc(sendHangup = false) {
  if (sendHangup) remoteSocket?.emit('webrtc:hangup');
  try { rtcPc?.close(); } catch {}
  rtcPc = null;
  rtcPendingCandidates.length = 0;

  for (const stream of [rtcScreenStream, rtcMicStream]) {
    try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
  }
  rtcScreenStream = null;
  rtcMicStream = null;
  rtcRemoteAudioStream = null;
  rtcAudioEl.srcObject = null;
}

async function ensurePetMedia(): Promise<MediaStream> {
  const aliveScreen = rtcScreenStream?.getVideoTracks().some((track) => track.readyState === 'live');
  const aliveMic = rtcMicStream?.getAudioTracks().some((track) => track.readyState === 'live');
  if (rtcScreenStream && rtcMicStream && aliveScreen && aliveMic) {
    console.log('[webrtc] reusing existing media', {
      screenTracks: rtcScreenStream.getTracks().map((t) => `${t.kind}:${t.readyState}`),
      micTracks: rtcMicStream.getTracks().map((t) => `${t.kind}:${t.readyState}`),
    });
    return new MediaStream([
      ...rtcScreenStream.getVideoTracks(),
      ...rtcMicStream.getAudioTracks(),
    ]);
  }

  const sourceId = await petBridge.getDesktopSourceId();

  if (sourceId) {
    const screenConstraints: any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          minHeight: 720,
          maxWidth: 2560,
          maxHeight: 1440,
        },
      },
    };

    try {
      rtcScreenStream = await navigator.mediaDevices.getUserMedia(screenConstraints);
      console.log('[webrtc] captured screen via desktop source', sourceId);
    } catch (error) {
      console.warn('[webrtc] desktop source capture failed, falling back to getDisplayMedia:', error);
    }
  }

  if (!rtcScreenStream) {
    try {
      rtcScreenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 15,
          width: { ideal: 1600 },
          height: { ideal: 900 },
        },
        audio: false,
      });
      console.log('[webrtc] captured screen via getDisplayMedia');
    } catch (error: any) {
      throw new Error(`屏幕采集失败：${error?.message || error}`);
    }
  }

  rtcMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  console.log('[webrtc] captured microphone');

  const screenTrack = rtcScreenStream.getVideoTracks()[0];
  if (screenTrack) {
    screenTrack.addEventListener('ended', () => {
      reportRtcError('屏幕共享结束了');
      cleanupRtc(true);
    }, { once: true });
  }

  return new MediaStream([
    ...rtcScreenStream.getVideoTracks(),
    ...rtcMicStream.getAudioTracks(),
  ]);
}

async function flushRtcCandidates() {
  if (!rtcPc?.remoteDescription) return;
  while (rtcPendingCandidates.length) {
    const candidate = rtcPendingCandidates.shift();
    if (!candidate) continue;
    try {
      await rtcPc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('[webrtc] addIceCandidate failed:', e);
    }
  }
}

async function ensurePetPeerConnection(): Promise<RTCPeerConnection> {
  if (rtcPc) return rtcPc;
  const media = await ensurePetMedia();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  rtcPc = pc;

  for (const track of media.getTracks()) pc.addTrack(track, media);
  console.log('[webrtc] pet added local tracks', media.getTracks().map((t) => ({
    kind: t.kind,
    id: t.id,
    label: t.label,
    state: t.readyState,
  })));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[webrtc] pet sent ice candidate');
      remoteSocket?.emit('webrtc:signal', { candidate: event.candidate.toJSON() });
    }
  };
  pc.ontrack = async (event) => {
    if (!rtcRemoteAudioStream) rtcRemoteAudioStream = new MediaStream();
    for (const track of event.streams[0]?.getTracks?.() ?? []) {
      if (!rtcRemoteAudioStream.getTracks().some((t) => t.id === track.id)) {
        rtcRemoteAudioStream.addTrack(track);
      }
    }
    rtcAudioEl.srcObject = rtcRemoteAudioStream;
    try {
      await rtcAudioEl.play();
    } catch (e) {
      console.warn('[webrtc] remote audio play failed:', e);
    }
    console.log('[webrtc] pet received remote track', {
      kind: event.track.kind,
      id: event.track.id,
      streams: event.streams.map((s) => ({ id: s.id, tracks: s.getTracks().map((t) => t.kind) })),
    });
    noteRemote('call audio');
  };
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log('[webrtc] pet connection state:', state);
    if (state === 'connected') noteRemote('call on');
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      cleanupRtc(false);
      if (state !== 'closed') showReply('通话断开了', 2500);
    }
  };

  return pc;
}

async function handleRtcSignal(signal: WebRtcSignal) {
  if (!signal) return;
  if (signal.description) {
    const desc = signal.description;
    console.log('[webrtc] pet got description:', desc.type);
    if (desc.type === 'offer') {
      try {
        const pc = await ensurePetPeerConnection();
        await pc.setRemoteDescription(desc);
        console.log('[webrtc] pet set remote offer');
        await flushRtcCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('[webrtc] pet created answer');
        remoteSocket?.emit('webrtc:signal', { description: pc.localDescription });
      } catch (e: any) {
        reportRtcError(`接通失败：${e?.message || e}`);
        cleanupRtc(false);
      }
      return;
    }
    if (desc.type === 'answer' && rtcPc) {
      try {
        await rtcPc.setRemoteDescription(desc);
        console.log('[webrtc] pet set remote answer');
        await flushRtcCandidates();
      } catch (e) {
        console.warn('[webrtc] setRemoteDescription(answer) failed:', e);
      }
    }
  }

  if (signal.candidate) {
    console.log('[webrtc] pet got ice candidate');
    if (!rtcPc?.remoteDescription) {
      rtcPendingCandidates.push(signal.candidate);
      return;
    }
    try {
      await rtcPc.addIceCandidate(signal.candidate);
    } catch (e) {
      console.warn('[webrtc] addIceCandidate failed:', e);
    }
  }
}

function connectRemote() {
  if (remoteSocket) return;
  try {
    remoteSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  } catch (e) {
    console.warn('[remote] io() failed:', e);
    return;
  }

  const join = () => {
    remoteSocket!.emit(
      'pet:join',
      { secret: ROOM_SECRET, role: 'pet' },
      (res: { ok: boolean; error?: string }) => {
        if (res?.ok) {
          remoteConnected = true;
          console.log('[remote] joined as pet');
        } else {
          remoteConnected = false;
          console.warn('[remote] join rejected:', res?.error);
        }
      }
    );
  };

  remoteSocket.on('connect', join);
  remoteSocket.on('disconnect', () => {
    remoteConnected = false;
    cleanupRtc(false);
    console.log('[remote] disconnected');
  });
  remoteSocket.on('connect_error', (e) => {
    remoteConnected = false;
    console.warn('[remote] connect_error:', e.message);
  });
  remoteSocket.on('pet:command', (cmd: RemoteCommand) => {
    console.log('[remote] cmd', cmd);
    handleRemoteCommand(cmd);
  });
  remoteSocket.on('webrtc:signal', (signal: WebRtcSignal) => {
    handleRtcSignal(signal).catch((e) => {
      reportRtcError(`信令失败：${e?.message || e}`);
    });
  });
  remoteSocket.on('webrtc:hangup', () => {
    cleanupRtc(false);
    showReply('通话结束了', 2200);
  });
  remoteSocket.on('webrtc:error', (payload: { message?: string }) => {
    const message = payload?.message || '对端通话失败';
    showReply(message, 3500);
  });
  remoteSocket.on('pet:list-voices', (ack: (files: string[]) => void) => {
    if (typeof ack === 'function') ack(voicesFlat.slice());
  });
  remoteSocket.on('pet:list-motions', (ack: (motions: MotionMeta[]) => void) => {
    if (typeof ack === 'function') ack(motionList.slice());
  });
  remoteSocket.on('room:peers', (peers: { controller: boolean; pet: boolean }) => {
    console.log('[remote] peers', peers);
  });
  remoteSocket.on('room:kicked', (r: { reason: string }) => {
    console.warn('[remote] kicked:', r?.reason);
  });
}

// === Main loop ===
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
let frame = 0;
// 头骨的偏移量（不是绝对 rotation，而是在 VRM lookAt 已经把眼/头处理完之后，再叠加这点点头转）
// 累积量限死在 ±0.2 rad (~11°)，slerp 一定能归零；不会再因为累加越界翻到背后
let headOffsetYaw = 0;
let headOffsetPitch = 0;
const HEAD_OFFSET_LIMIT = 0.2;
const HEAD_OFFSET_SLERP = 0.15;

function tick() {
  const dt = clock.getDelta();
  const t = performance.now() / 1000;
  frame++;

  if (vrm) vrm.scene.position.y = modelBaseY + Math.sin(t * 1.2) * 0.015;

  // 先更新主动作，再让 VRM 自己更新（含 SpringBone、lookAt 眼睛）
  if (motionMixer) motionMixer.update(dt);
  if (vrm) vrm.update(dt);

  // 再叠加头骨偏移（在 VRM 处理后做，否则被覆盖；同时只追加 yaw/pitch 不动 roll）
  // 动作播放期间不抢头骨：否则会逐帧覆盖 FBX 动作里的点头/转头。此时让偏移平滑归零，
  // 并把头骨交还给动作（不再写 rotation），动作结束后自动恢复跟随光标。
  if (vrm) {
    const headBone = vrm.humanoid?.getNormalizedBoneNode('head');
    if (headBone) {
      const motionActive = !!currentMotionId;
      if (motionActive) {
        // 偏移归零；不写 headBone.rotation，保留 mixer 写入的动作姿态。
        headOffsetYaw += (0 - headOffsetYaw) * HEAD_OFFSET_SLERP;
        headOffsetPitch += (0 - headOffsetPitch) * HEAD_OFFSET_SLERP;
      } else {
        // 用世界坐标算 lookTarget 相对头部的方向
        const headWorld = headBone.getWorldPosition(new THREE.Vector3());
        const dx = lookTarget.position.x - headWorld.x;
        const dy = lookTarget.position.y - headWorld.y;
        const dz = lookTarget.position.z - headWorld.z;
        // headBone 是 normalized 骨骼，静止前向 = -Z；rotation.y=+θ 把前向绕 Y 转。
        // 当 scene 不翻转（朝 -Z）时 θ = atan2(-dx,-dz)；翻转 PI（朝 +Z）时 θ = atan2(dx,dz)。
        // 用 MODEL_YAW_SIGN 统一两种情况（见上方常量）。
        const targetYaw = Math.atan2(MODEL_YAW_SIGN * dx, MODEL_YAW_SIGN * dz) * 0.35;
        const targetPitch = Math.atan2(dy, Math.hypot(dx, dz)) * 0.35;
        const clampedYaw = Math.max(-HEAD_OFFSET_LIMIT, Math.min(HEAD_OFFSET_LIMIT, targetYaw));
        const clampedPitch = Math.max(-HEAD_OFFSET_LIMIT, Math.min(HEAD_OFFSET_LIMIT, targetPitch));
        // 防御 NaN：一旦 headOffset 被污染就永远卡在 NaN（slerp 无法自愈），头会消失
        if (!Number.isFinite(clampedYaw) || !Number.isFinite(clampedPitch)) {
          headOffsetYaw = 0;
          headOffsetPitch = 0;
        } else {
          headOffsetYaw += (clampedYaw - headOffsetYaw) * HEAD_OFFSET_SLERP;
          headOffsetPitch += (clampedPitch - headOffsetPitch) * HEAD_OFFSET_SLERP;
        }
        // 直接赋值（headOffsetYaw/Pitch 已经做了限位+slerp），不要 +=，否则每帧累加会转飞
        headBone.rotation.y = headOffsetYaw;
        headBone.rotation.x = headOffsetPitch;
      }
    }
  }

  // 口型同步：在播音频时驱动 aa
  if (currentAnalyser) {
    currentAnalyser.getByteFrequencyData(lipBuf);
    let sum = 0;
    for (let i = 2; i < 32; i++) sum += lipBuf[i];
    const energy = (sum / 30) / 255;
    setExpression('aa', Math.min(1, energy * 1.8), 30);
  } else {
    const aa = expState.get('aa');
    if (aa && aa.target !== 0) setExpression('aa', 0, 120);
  }

  updateExpressions(dt);
  lookMarker.position.copy(lookTarget.position);

  if (vrm && cursorInside && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1) {
    raycaster.setFromCamera(ndc, camera);
    const ray = raycaster.ray;
    // ray.direction.y 接近 0 时 ty 会爆炸成 ±Infinity，再乘 direction 会产生 0*Inf=NaN，毒化 lookTarget
    const dy = ray.direction.y;
    if (Math.abs(dy) > 1e-4) {
      const ty = (headY - ray.origin.y) / dy;
      const dist = Math.min(10, Math.max(0.3, Math.abs(ty) || 2));
      const tgt = ray.origin.clone().add(ray.direction.clone().multiplyScalar(dist));
      if (Number.isFinite(tgt.x) && Number.isFinite(tgt.y)) {
        lookTarget.position.set(tgt.x, tgt.y, modelCenter.z + 1.5);
      }
    }
  }

  // clickable：chat 打开时强制开启（要能打字/点击）；否则按 hit-test
  let clickable = false;
  if (chatOpen || sliderDragging || (cursorInside && cursorOverSlider())) clickable = true;
  else if (vrm && cursorInside && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1) {
    const hits = raycaster.intersectObject(vrm.scene, true);
    clickable = hits.length > 0;
  }
  if (dragging) clickable = true;
  if (clickable !== lastClickable) {
    lastClickable = clickable;
    petBridge.setClickable(clickable);
  }

  if (frame % 6 === 0) {
    const since = lastReactionAt ? ((performance.now() - lastReactionAt) / 1000).toFixed(1) : '-';
    const sinceRemote = lastRemoteAt ? ((performance.now() - lastRemoteAt) / 1000).toFixed(1) : '-';
    const lookMode = vrm?.lookAt
      ? ((vrm.lookAt.applier as any)?.constructor?.name ?? 'on')
      : 'none';
    hud.textContent =
      `vrm:${vrm ? 'ok' : '...'} inside:${cursorInside ? 'Y' : 'N'} click:${lastClickable ? 'Y' : 'N'}\n` +
      `look:${lookMode} chat:${chatOpen ? 'Y' : 'N'} audio:${currentAnalyser ? 'Y' : 'N'} remote:${remoteConnected ? 'Y' : 'N'}\n` +
      `hit:${lastHitPart}\n` +
      `voices: h=${voicesByPart.head.length} b=${voicesByPart.body.length} t=${voicesByPart.tail.length}  motions:${motionList.length} active:${currentMotionId || '-'}\n` +
      `last:${lastReactionMsg || '-'} (${since}s)  remote:${lastRemoteMsg || '-'} (${sinceRemote}s)`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
