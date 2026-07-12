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
      listVoices: () => Promise<string[]>;
      getServerUrl: () => Promise<string>;
      getRoomSecret: () => Promise<string>;
      getPairingConfig: () => Promise<{ serverUrl?: string; roomSecret?: string; participantId?: string }>;
      savePairingConfig: (config: { serverUrl: string; roomSecret: string }) => Promise<{ ok: boolean; error?: string; config?: { serverUrl: string; roomSecret: string; participantId?: string } }>;
      onPairingChanged: (cb: (config: { serverUrl?: string; roomSecret?: string; participantId?: string }) => void) => void;
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
  listVoices: async () => [],
  getServerUrl: async () => 'http://localhost:3030',
  getRoomSecret: async () => 'change-me',
  getPairingConfig: async () => ({ serverUrl: 'http://localhost:3030', roomSecret: 'change-me' }),
  savePairingConfig: async (config) => ({ ok: true, config }),
  onPairingChanged: () => {},
  getDesktopSourceId: async () => null,
};

const petBridge: PetBridge = window.pet ?? browserPetBridge;

const VRM_URL = './sample.vrm';
const MOTION_MANIFEST_URL = './motions/manifest.json';
const MOTION_BASE_URL = './motions/';
const MOTION_FADE_SECONDS = 0.18;
const DEBUG_UI = new URLSearchParams(window.location.search).has('debug-ui');
const SIZE_STEP = 0.1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const DRAG_POSE_SPEED = 12;
const EAR_RAISE_SECONDS = 1.2;
const EAR_HIT_RADIUS = 0.14;
const EAR_POSE_SPEED = 14;

// 模型整体 Y 轴旋转：当前模型符合 VRM +Z 规范（背对相机），转 PI 面向用户。
// 若换的模型原生已朝用户，改为 0。
const MODEL_SCENE_ROT_Y = Math.PI;

const app = document.getElementById('app')!;
const fallback = document.getElementById('fallback')!;
const replyEl = document.getElementById('reply')!;
const sizeBox = document.getElementById('size')!;
const sizeDown = document.getElementById('size-down') as HTMLButtonElement;
const sizeUp = document.getElementById('size-up') as HTMLButtonElement;
const pairingForm = document.getElementById('pairing') as HTMLFormElement;
const pairingServer = document.getElementById('pairing-server') as HTMLInputElement;
const pairingSecret = document.getElementById('pairing-secret') as HTMLInputElement;
const pairingError = document.getElementById('pairing-error')!;

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

type SpriteState = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting';

const SPRITE_BASE_URL = './sprites/screen-dog';
const SPRITE_FRAMES: Record<SpriteState, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
};
const SPRITE_FPS: Record<SpriteState, number> = {
  idle: 4,
  'running-right': 10,
  'running-left': 10,
  waving: 7,
  jumping: 8,
  failed: 6,
  waiting: 5,
};
const SPRITE_MOTIONS: MotionMeta[] = [
  { id: 'idle', label: '待机', loop: true },
  { id: 'running-right', label: '向右移动', loop: true },
  { id: 'running-left', label: '向左移动', loop: true },
  { id: 'waving', label: '招手', loop: false },
  { id: 'jumping', label: '跳跃', loop: false },
  { id: 'failed', label: '失败', loop: false },
  { id: 'waiting', label: '等待', loop: true },
];

const spritePet = document.createElement('img');
spritePet.id = 'sprite-pet';
spritePet.alt = '';
spritePet.draggable = false;
app.appendChild(spritePet);

let spriteState: SpriteState = 'idle';
let spriteFrame = -1;
let spriteStartedAt = performance.now();
let spriteReturnTimer = 0;

function spriteFrameUrl(state: SpriteState, frameIndex: number) {
  const assetState = state === 'running-left' ? 'running-right' : state;
  return `${SPRITE_BASE_URL}/${assetState}/${String(frameIndex).padStart(2, '0')}.png`;
}

function setSpriteState(state: SpriteState, returnToIdleMs = 0) {
  if (state === spriteState && returnToIdleMs === 0 && spriteReturnTimer === 0) return;
  if (spriteReturnTimer) window.clearTimeout(spriteReturnTimer);
  spriteReturnTimer = 0;
  spriteState = state;
  spriteFrame = -1;
  spriteStartedAt = performance.now();
  currentMotionId = state === 'idle' ? '' : state;
  if (returnToIdleMs > 0) {
    spriteReturnTimer = window.setTimeout(() => setSpriteState('idle'), returnToIdleMs);
  }
}

function updateSprite(now: number) {
  const frameCount = SPRITE_FRAMES[spriteState];
  const elapsed = Math.max(0, now - spriteStartedAt);
  const nextFrame = Math.floor(elapsed * SPRITE_FPS[spriteState] / 1000) % frameCount;
  if (nextFrame === spriteFrame) return;
  spriteFrame = nextFrame;
  spritePet.style.transform = spriteState === 'running-left' ? 'scaleX(-1)' : '';
  spritePet.src = spriteFrameUrl(spriteState, nextFrame);
}

function spriteStateForCommand(id: string): SpriteState | null {
  const key = id.toLowerCase();
  if (/left|左/.test(key)) return 'running-left';
  if (/right|右/.test(key)) return 'running-right';
  if (/wave|hello|greet|招手|打招呼/.test(key)) return 'waving';
  if (/jump|hop|跳/.test(key)) return 'jumping';
  if (/fail|sad|error|失败|难过|错误/.test(key)) return 'failed';
  if (/wait|ask|等待|询问/.test(key)) return 'waiting';
  if (/idle|stand|待机|静止/.test(key)) return 'idle';
  return null;
}

for (const state of Object.keys(SPRITE_FRAMES) as SpriteState[]) {
  for (let i = 0; i < SPRITE_FRAMES[state]; i++) {
    const preload = new Image();
    preload.src = spriteFrameUrl(state, i);
  }
}
updateSprite(performance.now());
fallback.classList.add('hidden');

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

const lookMarker = DEBUG_UI
  ? new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xff66cc, transparent: true, opacity: 0.85, depthTest: false }),
    )
  : null;
if (lookMarker) {
  lookMarker.renderOrder = 999;
  scene.add(lookMarker);
}

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
let modelRotationY = MODEL_SCENE_ROT_Y;

type TailBoneBinding = {
  node: THREE.Object3D;
  rest: THREE.Quaternion;
  restPosition: THREE.Vector3;
  phase: number;
  weight: number;
};

type EarSide = 'left' | 'right';

type EarBoneBinding = {
  node: THREE.Object3D;
  rest: THREE.Quaternion;
  restPosition: THREE.Vector3;
  phase: number;
  weight: number;
};

let tailBones: TailBoneBinding[] = [];
let tailReactionUntil = 0;
let lastTailWagAt = 0;
let tailDebugNextLogAt = 0;
const tailEuler = new THREE.Euler();
const tailQuat = new THREE.Quaternion();
let earBones: Record<EarSide, EarBoneBinding[]> = { left: [], right: [] };
const earRaiseUntil: Record<EarSide, number> = { left: 0, right: 0 };
const earRaiseBlend: Record<EarSide, number> = { left: 0, right: 0 };
const earEuler = new THREE.Euler();
const earQuat = new THREE.Quaternion();

// 最终 sample.vrm 的尾巴链：h1 spring bone 加末端 child；球体.014 的主要权重在 骨骼.079。
const FINAL_TAIL_BONE_NAMES = ['骨骼.075', '骨骼.076', '骨骼.077', '骨骼.078', '骨骼.079'];
const FINAL_TAIL_MESH_NAMES = new Set(['球体.014']);
// 最终 sample.vrm 的两只耳朵 spring bone 链：左侧 x < 0，右侧 x > 0。
const FINAL_EAR_BONE_NAMES: Record<EarSide, string[]> = {
  left: ['骨骼.072', '骨骼.073', '骨骼.074'],
  right: ['骨骼.080', '骨骼.081', '骨骼.082'],
};
const TAIL_HIT_RADIUS = 0.22;
const tailHitA = new THREE.Vector3();
const tailHitB = new THREE.Vector3();
const tailHitC = new THREE.Vector3();
const tailHitD = new THREE.Vector3();
const earHitA = new THREE.Vector3();
const earHitB = new THREE.Vector3();
const earHitC = new THREE.Vector3();
const earHitD = new THREE.Vector3();
const earHitHeadLocal = new THREE.Vector3();

function bindTailBones(target: VRM) {
  const named = new Map<string, THREE.Object3D>();
  target.scene.traverse((obj) => {
    if (!obj.name) return;
    named.set(obj.name, obj);
  });

  tailBones = FINAL_TAIL_BONE_NAMES
    .map((name) => named.get(name))
    .filter((obj): obj is THREE.Object3D => !!obj)
    .map((node, i) => ({
      node,
      rest: node.quaternion.clone(),
      restPosition: node.position.clone(),
      phase: i * 0.42,
      weight: 1 + i * 0.18,
    }));

  if (DEBUG_UI) console.log('[tail] bound bones:', tailBones.map((b) => b.node.name));
}

function bindEarBones(target: VRM) {
  const named = new Map<string, THREE.Object3D>();
  target.scene.traverse((obj) => {
    if (!obj.name) return;
    named.set(obj.name, obj);
  });

  for (const side of ['left', 'right'] as const) {
    earBones[side] = FINAL_EAR_BONE_NAMES[side]
      .map((name) => named.get(name))
      .filter((obj): obj is THREE.Object3D => !!obj)
      .map((node, i) => ({
        node,
        rest: node.quaternion.clone(),
        restPosition: node.position.clone(),
        phase: i * 0.55,
        weight: 1 + i * 0.22,
      }));
  }

  if (DEBUG_UI) {
    console.log('[ears] bound bones:', {
      left: earBones.left.map((b) => b.node.name),
      right: earBones.right.map((b) => b.node.name),
    });
  }
}

function applyModelRotation() {
  if (vrm?.scene) vrm.scene.rotation.y = modelRotationY;
}

function triggerTailWag() {
  lastTailWagAt = performance.now();
  tailReactionUntil = performance.now() / 1000 + 1.6;
  tailDebugNextLogAt = 0;
  if (DEBUG_UI) {
    console.log('[tail] wag triggered', {
      bones: tailBones.map((b) => b.node.name),
      until: tailReactionUntil.toFixed(2),
    });
  }
}

function updateTailWag(t: number) {
  if (!tailBones.length) return;
  const boost = Math.max(0, Math.min(1, (tailReactionUntil - t) / 0.8));
  const amp = 0.14 + boost * 0.62;
  const shiftAmp = 0.012 + boost * 0.065;
  const speed = 3.1 + boost * 9.5;

  for (let i = 0; i < tailBones.length; i++) {
    const bone = tailBones[i];
    const side = Math.sin(t * speed + bone.phase) * amp * bone.weight;
    const curl = Math.sin(t * speed * 0.63 + bone.phase) * amp * 0.45 * bone.weight;
    const twist = Math.sin(t * speed * 0.78 + bone.phase) * amp * 0.22 * bone.weight;
    const shift = Math.sin(t * speed + bone.phase) * shiftAmp * (1 + i * 0.35);
    bone.node.position.copy(bone.restPosition);
    bone.node.position.x += shift;
    bone.node.position.y += Math.abs(shift) * 0.18;
    tailEuler.set(curl, side, twist + side * 0.35, 'XYZ');
    tailQuat.setFromEuler(tailEuler);
    bone.node.quaternion.copy(bone.rest).multiply(tailQuat);
  }
  tailBones[0]?.node.updateMatrixWorld(true);

  if (DEBUG_UI && boost > 0 && t >= tailDebugNextLogAt) {
    const root = tailBones[0];
    console.log('[tail] wag frame', {
      boost: boost.toFixed(2),
      amp: amp.toFixed(2),
      root: root?.node.name,
      rootPos: root ? root.node.position.toArray().map((v) => Number(v.toFixed(3))) : [],
      rootRot: root ? [root.node.rotation.x, root.node.rotation.y, root.node.rotation.z].map((v) => Number(v.toFixed(3))) : [],
    });
    tailDebugNextLogAt = t + 0.25;
  }
}

function triggerEarRaise(side: EarSide) {
  earRaiseUntil[side] = performance.now() / 1000 + EAR_RAISE_SECONDS;
  setExpression('joy', 0.7, 120);
  window.setTimeout(() => setExpression('joy', 0, 320), 520);
  if (DEBUG_UI) console.log('[ears] raise', side);
}

function updateEarRaise(dt: number, t: number) {
  for (const side of ['left', 'right'] as const) {
    const target = t < earRaiseUntil[side] ? 1 : 0;
    earRaiseBlend[side] += (target - earRaiseBlend[side]) * Math.min(1, dt * EAR_POSE_SPEED);
    const blend = earRaiseBlend[side];
    if (blend < 0.001 && target === 0) {
      earRaiseBlend[side] = 0;
      for (const bone of earBones[side]) {
        bone.node.position.copy(bone.restPosition);
        bone.node.quaternion.copy(bone.rest);
      }
      continue;
    }

    const sideSign = side === 'left' ? -1 : 1;
    const lift = 0.72 * blend;
    const perk = Math.sin(t * 16) * 0.035 * blend;
    const bones = earBones[side];

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      bone.node.position.copy(bone.restPosition);
      earEuler.set(
        -lift * (0.72 + i * 0.12) + perk,
        sideSign * lift * 0.16,
        -sideSign * lift * (0.45 + i * 0.08),
        'XYZ',
      );
      earQuat.setFromEuler(earEuler);
      bone.node.quaternion.copy(bone.rest).multiply(earQuat);
    }
  }
}

function isHappyMotion(entry: MotionManifestEntry) {
  const text = `${entry.id} ${entry.label}`.toLowerCase();
  return /happy|joy|fun|开心|高兴|愉快|快乐/.test(text);
}

function isNearTail(point: THREE.Vector3) {
  if (!tailBones.length) return false;
  let closest = Infinity;

  for (const bone of tailBones) {
    bone.node.getWorldPosition(tailHitA);
    closest = Math.min(closest, point.distanceTo(tailHitA));
  }

  for (let i = 0; i < tailBones.length - 1; i++) {
    tailBones[i].node.getWorldPosition(tailHitA);
    tailBones[i + 1].node.getWorldPosition(tailHitB);
    tailHitC.subVectors(tailHitB, tailHitA);
    const lenSq = tailHitC.lengthSq();
    if (lenSq < 1e-6) continue;
    const u = Math.max(0, Math.min(1, tailHitD.copy(point).sub(tailHitA).dot(tailHitC) / lenSq));
    tailHitC.multiplyScalar(u).add(tailHitA);
    closest = Math.min(closest, point.distanceTo(tailHitC));
  }

  return closest <= TAIL_HIT_RADIUS;
}

function distanceToBoneChain(point: THREE.Vector3, bones: EarBoneBinding[]) {
  if (!bones.length) return Infinity;
  let closest = Infinity;

  for (const bone of bones) {
    bone.node.getWorldPosition(earHitA);
    closest = Math.min(closest, point.distanceTo(earHitA));
  }

  for (let i = 0; i < bones.length - 1; i++) {
    bones[i].node.getWorldPosition(earHitA);
    bones[i + 1].node.getWorldPosition(earHitB);
    earHitC.subVectors(earHitB, earHitA);
    const lenSq = earHitC.lengthSq();
    if (lenSq < 1e-6) continue;
    const u = Math.max(0, Math.min(1, earHitD.copy(point).sub(earHitA).dot(earHitC) / lenSq));
    earHitC.multiplyScalar(u).add(earHitA);
    closest = Math.min(closest, point.distanceTo(earHitC));
  }

  return closest;
}

function classifyEarHit(point: THREE.Vector3): EarSide | null {
  if (!vrm) return null;
  const headBone = vrm.humanoid?.getNormalizedBoneNode('head');
  if (!headBone) return null;

  earHitHeadLocal.copy(point);
  headBone.worldToLocal(earHitHeadLocal);
  if (earHitHeadLocal.y < 0.16) return null;

  const leftDistance = distanceToBoneChain(point, earBones.left);
  const rightDistance = distanceToBoneChain(point, earBones.right);
  const side: EarSide = leftDistance <= rightDistance ? 'left' : 'right';
  const distance = Math.min(leftDistance, rightDistance);
  if (distance > EAR_HIT_RADIUS) return null;

  // Guard against face/top clicks that happen to be near both roots: require the chosen side to match head-local x.
  if (side === 'left' && earHitHeadLocal.x > -0.04) return null;
  if (side === 'right' && earHitHeadLocal.x < 0.04) return null;
  return side;
}

function isTailObject(obj: THREE.Object3D | null) {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (FINAL_TAIL_MESH_NAMES.has(cur.name)) return true;
    cur = cur.parent;
  }
  return false;
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const ENABLE_LEGACY_VRM = false;
if (ENABLE_LEGACY_VRM) loader.load(
  VRM_URL,
  (gltf) => {
    const v: VRM = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    v.scene.traverse((obj: any) => { if (obj.isMesh) obj.frustumCulled = false; });
    if (v.scene) v.scene.rotation.y = modelRotationY;
    scene.add(v.scene);
    if (v.lookAt) v.lookAt.target = lookTarget;
    vrm = v;
    modelBaseY = v.scene.position.y;
    bindTailBones(v);
    bindEarBones(v);
    motionMixer = new THREE.AnimationMixer(v.scene);
    motionMixer.addEventListener('finished', (event) => {
      const action = event.action;
      if (action && action === currentMotionAction) {
        action.stop();
        currentMotionAction = null;
        currentMotionId = '';
      }
    });

    try {
      const exps: any[] = (v.expressionManager as any)?.expressions ?? [];
      for (const e of exps) if (e?.expressionName) availableExpressions.add(e.expressionName);
    } catch {}
    if (DEBUG_UI) console.log('[VRM] expressions:', Array.from(availableExpressions));

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
  if (target > 0.2) {
    if (name === 'joy') setSpriteState('waving', 1100);
    else if (name === 'sorrow' || name === 'angry') setSpriteState('failed', 1800);
    else if (name === 'surprised') setSpriteState('jumping', 900);
  }
  if (name === 'joy' && target > 0.2) triggerTailWag();
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

// 光标是否在缩放控件上（用屏幕坐标命中，因为透明窗穿透时 DOM pointer 事件不会触发）。
function cursorOverSizeControls(): boolean {
  const r = sizeBox.getBoundingClientRect();
  const { x, y } = cursorPx;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// === Drag + click reactions ===
let dragging = false;
let rotatingModel = false;
let lastClickable = false;
let lastHitPart: string = '-';
let clickMotionCandidate = false;
let dragPoseTarget = 0;
let dragPoseBlend = 0;
let dragSway = 0;
let dragLastScreenX = 0;
let dragDirection: -1 | 0 | 1 = 0;
const cooldownUntil: Record<'head' | 'body' | 'tail', number> = { head: 0, body: 0, tail: 0 };

function classifyHit(hit: THREE.Intersection): 'head' | 'body' | 'tail' {
  if (isTailObject(hit.object) || isNearTail(hit.point)) return 'tail';
  const tailThreshold = modelMinY + (headY - modelMinY) * 0.30;
  if (hit.point.y > headY - 0.10) return 'head';
  if (hit.point.y < tailThreshold) return 'tail';
  return 'body';
}

const PART_EXPRESSION: Record<'head' | 'body' | 'tail', ExpName> = {
  head: 'joy',
  body: 'surprised',
  tail: 'angry',
};

function triggerReaction(part: 'head' | 'body' | 'tail') {
  const now = performance.now();
  if (part === 'tail') triggerTailWag();
  if (now < cooldownUntil[part]) return;
  cooldownUntil[part] = now + 1500;

  const exp = PART_EXPRESSION[part];
  setSpriteState(part === 'tail' ? 'waving' : 'jumping', part === 'tail' ? 1100 : 900);
  setExpression(exp, 1.0, 120);
  setTimeout(() => setExpression(exp, 0, 350), 650);

  // 优先播预录台词；没有则只表情
  playVoiceFor(part).catch(() => {});
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
  motionList = SPRITE_MOTIONS.slice();
  return;
  // The VRMA loader remains below temporarily for v1.1 compatibility.
  try {
    const r = await fetch(MOTION_MANIFEST_URL, { cache: 'no-store' });
    if (r.status === 404) {
      if (DEBUG_UI) console.log('[motions] manifest missing');
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
    if (DEBUG_UI) console.log('[motions] loaded:', motionList.map((m) => m.id));
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
  const sprite = spriteStateForCommand(id);
  if (sprite) {
    const oneShotMs = sprite === 'waving' ? 1100 : sprite === 'jumping' ? 900 : sprite === 'failed' ? 1800 : 0;
    setSpriteState(sprite, oneShotMs);
    return true;
  }
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
  if (isHappyMotion(entry)) triggerTailWag();
  return true;
}

function normalizedBone(name: string): THREE.Object3D | null {
  try {
    return ((vrm?.humanoid as any)?.getNormalizedBoneNode(name) as THREE.Object3D | null) ?? null;
  } catch {
    return null;
  }
}

function setDragPose(active: boolean) {
  dragPoseTarget = active ? 1 : 0;
  if (active) {
    stopCurrentMotion();
    setExpression('surprised', 0.65, 120);
    triggerTailWag();
  } else {
    setSpriteState('idle');
    setExpression('surprised', 0, 320);
  }
}

function applyBonePose(name: string, x: number, y: number, z: number, blend: number) {
  const bone = normalizedBone(name);
  if (!bone) return;
  bone.rotation.x = x * blend;
  bone.rotation.y = y * blend;
  bone.rotation.z = z * blend;
}

function updateDragPose(dt: number, t: number) {
  dragPoseBlend += (dragPoseTarget - dragPoseBlend) * Math.min(1, dt * DRAG_POSE_SPEED);
  if (dragPoseBlend < 0.001 && dragPoseTarget === 0) {
    dragPoseBlend = 0;
    return;
  }

  const sway = Math.sin(t * 8) * 0.08 + dragSway * 0.18;
  const b = dragPoseBlend;

  applyBonePose('spine', -0.18, 0, sway * 0.35, b);
  applyBonePose('chest', -0.28, 0, sway, b);
  applyBonePose('neck', 0.18, 0, -sway * 0.4, b);
  applyBonePose('leftUpperArm', -0.72, 0.2, -1.28, b);
  applyBonePose('rightUpperArm', -0.72, -0.2, 1.28, b);
  applyBonePose('leftLowerArm', -0.28, 0, -0.62, b);
  applyBonePose('rightLowerArm', -0.28, 0, 0.62, b);
  applyBonePose('leftHand', 0.08, 0, -0.2, b);
  applyBonePose('rightHand', 0.08, 0, 0.2, b);
  applyBonePose('leftUpperLeg', 0.34, 0.06, -0.08, b);
  applyBonePose('rightUpperLeg', 0.34, -0.06, 0.08, b);
  applyBonePose('leftLowerLeg', -0.38, 0, 0.04, b);
  applyBonePose('rightLowerLeg', -0.38, 0, -0.04, b);

  dragSway += (0 - dragSway) * Math.min(1, dt * 8);
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !lastClickable) return;
  // 输入框正在用，不当作戳模型
  if (document.activeElement === chatInput) return;
  if (sizeBox.contains(e.target as Node) || chatBox.contains(e.target as Node) || pairingForm.contains(e.target as Node)) return;
  dragging = true;
  dragLastScreenX = e.screenX;
  dragDirection = 0;
  rotatingModel = e.shiftKey;
  clickMotionCandidate = false;
  setSpriteState('waving', 1100);
  if (rotatingModel) {
    if (!vrm) rotatingModel = false;
  }
  if (rotatingModel) {
    lastHitPart = 'rotate';
    return;
  }
  if (!vrm) {
    clickMotionCandidate = true;
    lastHitPart = 'sprite';
    setDragPose(true);
    return;
  }
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(vrm.scene, true);
  if (hits.length > 0) {
    const earSide = classifyEarHit(hits[0].point);
    clickMotionCandidate = true;
    setDragPose(true);
    if (earSide) {
      lastHitPart = `${earSide}-ear ${hits[0].object.name || '-'} y=${hits[0].point.y.toFixed(2)}`;
      triggerEarRaise(earSide);
    } else {
      const part = classifyHit(hits[0]);
      lastHitPart = `${part} ${hits[0].object.name || '-'} y=${hits[0].point.y.toFixed(2)}`;
      triggerReaction(part);
    }
  } else {
    lastHitPart = 'miss';
  }
});
window.addEventListener('mouseup', () => {
  if (clickMotionCandidate) setDragPose(false);
  dragging = false;
  dragDirection = 0;
  rotatingModel = false;
  clickMotionCandidate = false;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (rotatingModel) {
    modelRotationY += e.movementX * 0.01;
    applyModelRotation();
    return;
  }
  if (e.movementX || e.movementY) {
    const screenDeltaX = e.screenX - dragLastScreenX;
    dragLastScreenX = e.screenX;
    if (Math.abs(screenDeltaX) >= 1) {
      const nextDirection: -1 | 1 = screenDeltaX < 0 ? -1 : 1;
      if (nextDirection !== dragDirection) {
        dragDirection = nextDirection;
        setSpriteState(nextDirection < 0 ? 'running-right' : 'running-left');
      }
      dragSway = Math.max(-1, Math.min(1, screenDeltaX / 18));
    }
    petBridge.drag(e.movementX, e.movementY);
  }
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

// === 服务器地址 + 预录台词清单 ===
let SERVER_URL = '';
let ROOM_SECRET = '';
let PARTICIPANT_ID = '';
let pairingOpen = false;
const voicesByPart: Record<'head' | 'body' | 'tail' | 'idle', string[]> = {
  head: [], body: [], tail: [], idle: [],
};
let voicesFlat: string[] = []; // 给 A 端 list-voices ack 用

function isPairingReady() {
  return !!SERVER_URL.trim() && !!ROOM_SECRET.trim();
}

function normalizeServerUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function showPairing(config?: { serverUrl?: string; roomSecret?: string }) {
  pairingOpen = true;
  pairingForm.classList.remove('hidden');
  pairingServer.value = config?.serverUrl || SERVER_URL || '';
  pairingSecret.value = config?.roomSecret || '';
  pairingError.textContent = '';
  petBridge.setClickable(true);
  setTimeout(() => (pairingServer.value ? pairingSecret : pairingServer).focus(), 0);
}

function hidePairing() {
  pairingOpen = false;
  pairingForm.classList.add('hidden');
  pairingError.textContent = '';
}

pairingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const serverUrl = normalizeServerUrl(pairingServer.value);
  const roomSecret = pairingSecret.value.trim();
  if (!serverUrl || !roomSecret) {
    pairingError.textContent = '请填写服务器地址和房间密钥。';
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    pairingError.textContent = '服务器地址需要以 http:// 或 https:// 开头。';
    return;
  }

  pairingError.textContent = '';
  const res = await petBridge.savePairingConfig({ serverUrl, roomSecret });
  if (!res.ok) {
    pairingError.textContent = res.error || '保存失败，请重试。';
    return;
  }
  SERVER_URL = res.config?.serverUrl || serverUrl;
  ROOM_SECRET = res.config?.roomSecret || roomSecret;
  PARTICIPANT_ID = res.config?.participantId || PARTICIPANT_ID;
  hidePairing();
  connectRemote();
});

(async () => {
  let pairingConfig: { serverUrl?: string; roomSecret?: string; participantId?: string } = {};
  try { pairingConfig = await petBridge.getPairingConfig(); } catch {}
  SERVER_URL = normalizeServerUrl(pairingConfig.serverUrl || '');
  ROOM_SECRET = (pairingConfig.roomSecret || '').trim();
  PARTICIPANT_ID = (pairingConfig.participantId || '').trim();
  await loadMotionManifest();
  try {
    const files = await petBridge.listVoices();
    for (const f of files) {
      const url = `./voices/${f}`;
      voicesFlat.push(url);
      const m = f.match(/^(head|body|tail|idle)_/i);
      if (m) voicesByPart[m[1].toLowerCase() as 'head' | 'body' | 'tail' | 'idle'].push(url);
    }
    console.log('[voices] loaded:', voicesByPart);
  } catch (e) {
    console.warn('[voices] load failed:', e);
  }
  // motions / voices 加载完之后再连远程，ack 才有内容
  if (isPairingReady()) connectRemote();
  // 缺少配置时由 Electron 主进程自动打开统一控制面板。
})();

petBridge.onPairingChanged((config) => {
  const nextServer = normalizeServerUrl(config.serverUrl || '');
  const nextSecret = String(config.roomSecret || '').trim();
  const nextParticipant = String(config.participantId || '').trim();
  if (nextServer === SERVER_URL && nextSecret === ROOM_SECRET && nextParticipant === PARTICIPANT_ID) return;
  cleanupRtc(false);
  remoteSocket?.removeAllListeners();
  remoteSocket?.disconnect();
  remoteSocket = null;
  remoteConnected = false;
  SERVER_URL = nextServer;
  ROOM_SECRET = nextSecret;
  PARTICIPANT_ID = nextParticipant;
  if (isPairingReady() && PARTICIPANT_ID) connectRemote();
});

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

// === 远程文本气泡 ===
let replyTimer = 0;
function showReply(text: string, ms = 6000) {
  replyEl.textContent = text;
  replyEl.classList.add('on');
  if (replyTimer) window.clearTimeout(replyTimer);
  replyTimer = window.setTimeout(() => replyEl.classList.remove('on'), ms);
}

// === 大小调节按钮 ===
let currentScale = 1;
let sizeControlsActive = false;
let sizeControlsVisibleTimer = 0;

function clampScale(scale: number) {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

function showSizeControls() {
  sizeBox.classList.add('visible');
  if (sizeControlsVisibleTimer) window.clearTimeout(sizeControlsVisibleTimer);
  sizeControlsVisibleTimer = window.setTimeout(() => {
    if (!cursorOverSizeControls()) sizeBox.classList.remove('visible');
  }, 1200);
}

function resizeBy(delta: number) {
  currentScale = clampScale(Math.round((currentScale + delta) * 10) / 10);
  petBridge.resize(currentScale);
  showSizeControls();
}

sizeBox.addEventListener('pointerdown', () => { sizeControlsActive = true; });
window.addEventListener('pointerup', () => { sizeControlsActive = false; });
sizeBox.addEventListener('mouseenter', showSizeControls);
sizeBox.addEventListener('mouseleave', () => {
  if (!sizeControlsActive) sizeControlsVisibleTimer = window.setTimeout(() => sizeBox.classList.remove('visible'), 500);
});
sizeDown.addEventListener('click', (e) => {
  e.stopPropagation();
  resizeBy(-SIZE_STEP);
});
sizeUp.addEventListener('click', (e) => {
  e.stopPropagation();
  resizeBy(SIZE_STEP);
});

// 初始化到已保存的 scale。
petBridge.getScale().then((scale) => {
  currentScale = clampScale(scale);
}).catch(() => {});

// === 远程控制（M4a）===
// A 端（controller）通过 Socket.IO 发指令，B 端（pet）路由到现有动作函数 / FBX 动作。
type RemoteCommand =
  | { type: 'expression'; name: ExpName; strength?: number; holdMs?: number }
  | { type: 'animation'; name: string }
  | { type: 'say_audio'; url: string }
  | { type: 'relocate'; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };

let remoteSocket: Socket | null = null;
let remoteConnected = false;
let lastRemoteMsg = '';
let lastRemoteAt = 0;
let rtcPc: RTCPeerConnection | null = null;
let activeCallId = '';
let rtcScreenStream: MediaStream | null = null;
let rtcMicStream: MediaStream | null = null;
let rtcRemoteAudioStream: MediaStream | null = null;
const rtcPendingCandidates: RTCIceCandidateInit[] = [];
const rtcAudioEl = new Audio();
rtcAudioEl.autoplay = true;
rtcAudioEl.volume = 1;

type TtsPlay = { jobId: string; text: string; streamUrl: string };
const ttsAudioEl = new Audio();
ttsAudioEl.autoplay = true;
ttsAudioEl.preload = 'none';
ttsAudioEl.crossOrigin = 'anonymous';
let ttsAudioContext: AudioContext | null = null;
let ttsMediaSource: MediaElementAudioSourceNode | null = null;
let activeTtsJobId = '';

function stopTtsPlayback() {
  ttsAudioEl.pause();
  ttsAudioEl.removeAttribute('src');
  ttsAudioEl.load();
  activeTtsJobId = '';
  currentAnalyser = null;
}

async function playTtsStream(job: TtsPlay) {
  if (!job?.jobId || !job.streamUrl) return;
  stopTtsPlayback();
  activeTtsJobId = job.jobId;
  showReply(String(job.text || '').slice(0, 200), 7000);
  try {
    ttsAudioContext ||= new AudioContext();
    await ttsAudioContext.resume();
    ttsMediaSource ||= ttsAudioContext.createMediaElementSource(ttsAudioEl);
    const analyser = ttsAudioContext.createAnalyser();
    analyser.fftSize = 256;
    ttsMediaSource.disconnect();
    ttsMediaSource.connect(analyser);
    analyser.connect(ttsAudioContext.destination);
    currentAnalyser = analyser;
    ttsAudioEl.src = `${SERVER_URL}${job.streamUrl}`;
    await ttsAudioEl.play();
    if (activeTtsJobId === job.jobId) remoteSocket?.emit('tts:status', { jobId: job.jobId, state: 'playing' });
  } catch (error) {
    console.warn('[tts] playback failed:', error);
    remoteSocket?.emit('tts:status', { jobId: job.jobId, state: 'error', error: 'tts_playback_failed' });
    showReply('语音播放失败', 3500);
    stopTtsPlayback();
  }
}

ttsAudioEl.addEventListener('ended', () => {
  const jobId = activeTtsJobId;
  if (jobId) remoteSocket?.emit('tts:status', { jobId, state: 'completed' });
  stopTtsPlayback();
});
ttsAudioEl.addEventListener('error', () => {
  const jobId = activeTtsJobId;
  if (jobId) remoteSocket?.emit('tts:status', { jobId, state: 'error', error: 'tts_stream_failed' });
  if (jobId) showReply('语音流中断', 3500);
  stopTtsPlayback();
});

type WebRtcSignal = {
  callId?: string;
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function noteRemote(msg: string) {
  lastRemoteMsg = msg;
  lastRemoteAt = performance.now();
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
  if (sendHangup) remoteSocket?.emit('call:end', { callId: activeCallId || undefined });
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
  activeCallId = '';
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
      ...rtcScreenStream.getAudioTracks(),
    ]);
  }

  const sourceId = await petBridge.getDesktopSourceId();

  if (sourceId) {
    const screenConstraints: any = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
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
      console.log('[webrtc] captured screen and system audio via desktop source', sourceId);
    } catch (error) {
      console.warn('[webrtc] desktop audio capture failed, retrying video-only desktop capture:', error);
      try {
        rtcScreenStream = await navigator.mediaDevices.getUserMedia({
          ...screenConstraints,
          audio: false,
        });
      } catch (videoOnlyError) {
        console.warn('[webrtc] desktop source capture failed, falling back to getDisplayMedia:', videoOnlyError);
      }
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
        audio: true,
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

  const systemTracks = rtcScreenStream.getAudioTracks();
  if (systemTracks.length) {
    console.log('[webrtc] captured separate microphone and system audio tracks');
  } else {
    console.warn('[webrtc] system audio unavailable; sending microphone only');
  }

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
    ...systemTracks,
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
      remoteSocket?.emit('webrtc:signal', { callId: activeCallId || undefined, candidate: event.candidate.toJSON() });
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
      cleanupRtc(state !== 'closed');
      if (state !== 'closed') showReply('通话断开了', 2500);
    }
  };

  return pc;
}

async function handleRtcSignal(signal: WebRtcSignal) {
  if (!signal) return;
  if (signal.callId) {
    if (activeCallId && signal.callId !== activeCallId) return;
    activeCallId = signal.callId;
  }
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
        remoteSocket?.emit('webrtc:signal', { callId: activeCallId || undefined, description: pc.localDescription });
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
  if (!isPairingReady()) {
    console.warn('[remote] pairing incomplete; open the control panel to configure it');
    return;
  }
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
      { secret: ROOM_SECRET, role: 'pet', participantId: PARTICIPANT_ID },
      (res: { ok: boolean; code?: string; error?: string }) => {
        if (res?.ok) {
          remoteConnected = true;
          console.log('[remote] joined as pet');
        } else {
          remoteConnected = false;
          console.warn('[remote] join rejected:', res?.code || res?.error);
        }
      }
    );
  };

  remoteSocket.on('connect', join);
  remoteSocket.on('disconnect', () => {
    remoteConnected = false;
    stopTtsPlayback();
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
  remoteSocket.on('tts:play', (job: TtsPlay) => {
    void playTtsStream(job);
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
  remoteSocket.on('call:end', () => {
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
  updateSprite(performance.now());

  if (vrm) vrm.scene.position.y = modelBaseY + Math.sin(t * 1.2) * 0.015;

  // 先更新主动作，再让 VRM 自己更新（含 SpringBone、lookAt 眼睛）
  if (motionMixer) motionMixer.update(dt);
  if (vrm) vrm.update(dt);
  updateTailWag(t);
  updateEarRaise(dt, t);
  updateDragPose(dt, t);

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
        const headWorld = headBone.getWorldPosition(new THREE.Vector3());
        const parent = headBone.parent;
        const headLocal = parent ? parent.worldToLocal(headWorld.clone()) : headWorld;
        const targetLocal = parent ? parent.worldToLocal(lookTarget.position.clone()) : lookTarget.position.clone();
        const dx = targetLocal.x - headLocal.x;
        const dy = targetLocal.y - headLocal.y;
        const dz = targetLocal.z - headLocal.z;
        // 在头骨父节点的局部坐标里计算方向，模型被手动旋转后也能继续看向光标。
        const targetYaw = Math.atan2(-dx, -dz) * 0.35;
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
  if (lookMarker) lookMarker.position.copy(lookTarget.position);

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

  if (cursorInside && cursorOverSizeControls()) showSizeControls();

  // clickable：配对/缩放控件打开时强制开启；否则按 hit-test
  let clickable = false;
  if (pairingOpen || sizeControlsActive || (cursorInside && cursorOverSizeControls())) clickable = true;
  else if (cursorInside && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1) {
    clickable = vrm ? raycaster.intersectObject(vrm.scene, true).length > 0 : true;
  }
  if (dragging) clickable = true;
  if (clickable !== lastClickable) {
    lastClickable = clickable;
    petBridge.setClickable(clickable);
  }

  if (DEBUG_UI && frame % 6 === 0) {
    const sinceRemote = lastRemoteAt ? ((performance.now() - lastRemoteAt) / 1000).toFixed(1) : '-';
    const sinceTail = lastTailWagAt ? ((performance.now() - lastTailWagAt) / 1000).toFixed(1) : '-';
    const lookMode = vrm?.lookAt
      ? ((vrm.lookAt.applier as any)?.constructor?.name ?? 'on')
      : 'none';
    console.info(
      `vrm:${vrm ? 'ok' : '...'} inside:${cursorInside ? 'Y' : 'N'} click:${lastClickable ? 'Y' : 'N'}\n` +
      `look:${lookMode} audio:${currentAnalyser ? 'Y' : 'N'} remote:${remoteConnected ? 'Y' : 'N'}\n` +
      `hit:${lastHitPart}\n` +
      `voices: h=${voicesByPart.head.length} b=${voicesByPart.body.length} t=${voicesByPart.tail.length}  motions:${motionList.length} tail:${tailBones.length} ears:${earBones.left.length}/${earBones.right.length} wag:${sinceTail}s active:${currentMotionId || '-'}\n` +
      `remote:${lastRemoteMsg || '-'} (${sinceRemote}s)`
    );
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
