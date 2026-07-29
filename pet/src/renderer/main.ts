import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { io, type Socket } from 'socket.io-client';
import { applyVideoSenderProfile, type VideoRouteProfile } from './video-profile';
import { installPetGlobalDiagnostics, normalizeDiagnosticError, recordPetDiagnostic, type RendererDiagnosticInput } from './diagnostics';
import { attachRtcDiagnostics, type RtcDiagnosticHandle } from './rtc-diagnostics';

declare global {
  interface Window {
    pet?: {
      setClickable: (clickable: boolean) => void;
      drag: (dx: number, dy: number) => void;
      startDrag: () => void;
      stopDrag: () => void;
      relocate: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void;
      resize: (scale: number) => Promise<{ ok: boolean; scale?: number; error?: string }>;
      getScale: () => Promise<number>;
      onScaleChanged: (cb: (scale: number) => void) => () => void;
      onCursor: (cb: (c: { cx: number; cy: number; ww: number; wh: number; inside: boolean }) => void) => void;
      listVoices: () => Promise<string[]>;
      getServerUrl: () => Promise<string>;
      getRoomSecret: () => Promise<string>;
      getPairingConfig: () => Promise<PairingConfig>;
      savePairingConfig: (config: PairingConfig) => Promise<{ ok: boolean; error?: string; config?: PairingConfig }>;
      onPairingChanged: (cb: (config: PairingConfig) => void) => void;
      getDesktopSourceId: () => Promise<string | null>;
      recordDiagnostic: (event: RendererDiagnosticInput) => void;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      isGameMode: () => Promise<boolean>;
      openNoteComposer: () => void;
      onGameModeChanged: (cb: (enabled: boolean) => void) => () => void;
      onNoteWindowClosed: (cb: (frameName: string) => void) => () => void;
      onNoteWindowInteracted: (cb: (frameName: string) => void) => () => void;
    };
  }
}

type PetBridge = NonNullable<Window['pet']>;
type PairingConfig = { serverUrl?: string; roomSecret?: string; deviceId?: string; deviceName?: string; memberId?: 'a' | 'b' };

const browserPetBridge: PetBridge = {
  setClickable: () => {},
  drag: () => {},
  startDrag: () => {},
  stopDrag: () => {},
  relocate: () => {},
  resize: async (scale) => ({ ok: true, scale }),
  getScale: async () => 1,
  onScaleChanged: () => () => {},
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
  recordDiagnostic: () => {},
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return { ok: true };
  },
  isGameMode: async () => false,
  openNoteComposer: () => {},
  onGameModeChanged: () => () => {},
  onNoteWindowClosed: () => () => {},
  onNoteWindowInteracted: () => () => {},
};

const petBridge: PetBridge = window.pet ?? browserPetBridge;
installPetGlobalDiagnostics();

const VRM_URL = './sample.vrm';
const MOTION_MANIFEST_URL = './motions/manifest.json';
const MOTION_BASE_URL = './motions/';
const MOTION_FADE_SECONDS = 0.18;
const DEBUG_UI = new URLSearchParams(window.location.search).has('debug-ui');
const SIZE_STEP = 0.1;
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.5;
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
const pairingMember = document.getElementById('pairing-member') as HTMLSelectElement;
const pairingDevice = document.getElementById('pairing-device') as HTMLInputElement;
const pairingError = document.getElementById('pairing-error')!;
const notesDock = document.getElementById('notes-dock') as HTMLButtonElement;
const notesCount = document.getElementById('notes-count')!;

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

type SpriteState = 'idle' | 'running-right' | 'running-left' | 'joy' | 'jumping' | 'sorrow' | 'waiting';

const SPRITE_BASE_URL = './sprites/screen-dog';
const SPRITE_FRAMES: Record<SpriteState, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  joy: 4,
  jumping: 5,
  sorrow: 8,
  waiting: 6,
};
const SPRITE_FPS: Record<SpriteState, number> = {
  idle: 4,
  'running-right': 10,
  'running-left': 10,
  joy: 7,
  jumping: 8,
  sorrow: 6,
  waiting: 5,
};
const SPRITE_MOTIONS: MotionMeta[] = [
  { id: 'idle', label: '待机', loop: true },
  { id: 'running-right', label: '向右移动', loop: true },
  { id: 'running-left', label: '向左移动', loop: true },
  { id: 'joy', label: '开心', loop: false },
  { id: 'jumping', label: '跳跃', loop: false },
  { id: 'sorrow', label: '委屈', loop: false },
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
  if (/joy|happy|wave|hello|greet|开心|招手|打招呼/.test(key)) return 'joy';
  if (/jump|hop|跳/.test(key)) return 'jumping';
  if (/sorrow|fail|sad|error|委屈|失败|难过|错误/.test(key)) return 'sorrow';
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
    if (name === 'joy') setSpriteState('joy', 1100);
    else if (name === 'sorrow' || name === 'angry') setSpriteState('sorrow', 1800);
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
let dragLastScreenY = 0;
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
  setSpriteState(part === 'tail' ? 'joy' : 'jumping', part === 'tail' ? 1100 : 900);
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
    const oneShotMs = sprite === 'joy' ? 1100 : sprite === 'jumping' ? 900 : sprite === 'sorrow' ? 1800 : 0;
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
  // 能收到事件就说明主进程已经把桌宠窗口切到可交互；不要再依赖异步
  // hit-test 状态拦截，否则一次状态丢失会让点击和拖动同时失效。
  if (e.button !== 0) return;
  if (sizeBox.contains(e.target as Node) || pairingForm.contains(e.target as Node)) return;
  dragging = true;
  dragLastScreenX = e.screenX;
  dragLastScreenY = e.screenY;
  dragDirection = 0;
  rotatingModel = e.shiftKey;
  clickMotionCandidate = false;
  setSpriteState('joy', 1100);
  if (rotatingModel) {
    if (!vrm) rotatingModel = false;
  }
  if (rotatingModel) {
    lastHitPart = 'rotate';
    return;
  }
  petBridge.startDrag();
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
  petBridge.stopDrag();
});
window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  dragDirection = 0;
  rotatingModel = false;
  clickMotionCandidate = false;
  setDragPose(false);
  petBridge.stopDrag();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (rotatingModel) {
    modelRotationY += e.movementX * 0.01;
    applyModelRotation();
    return;
  }
  // movementX/Y 会受到透明窗口自身移动影响，在 Electron/macOS 上可能归零或跳变。
  // 使用屏幕绝对坐标差值，窗口跟随光标移动时仍能得到稳定的拖动距离。
  const screenDeltaX = Math.round(e.screenX - dragLastScreenX);
  const screenDeltaY = Math.round(e.screenY - dragLastScreenY);
  dragLastScreenX = e.screenX;
  dragLastScreenY = e.screenY;
  if (!screenDeltaX && !screenDeltaY) return;
  if (Math.abs(screenDeltaX) >= 1) {
    const nextDirection: -1 | 1 = screenDeltaX < 0 ? -1 : 1;
    if (nextDirection !== dragDirection) {
      dragDirection = nextDirection;
      setSpriteState(nextDirection < 0 ? 'running-right' : 'running-left');
    }
    dragSway = Math.max(-1, Math.min(1, screenDeltaX / 18));
  }
  // 窗口位置由主进程根据系统光标绝对坐标更新；renderer 只负责动画反馈。
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
let DEVICE_ID = '';
let DEVICE_NAME = '';
let MEMBER_ID: 'a' | 'b' | '' = '';
let pairingOpen = false;
const voicesByPart: Record<'head' | 'body' | 'tail' | 'idle', string[]> = {
  head: [], body: [], tail: [], idle: [],
};
let voicesFlat: string[] = []; // 给 A 端 list-voices ack 用

function isPairingReady() {
  return !!SERVER_URL.trim() && !!ROOM_SECRET.trim() && !!DEVICE_ID && !!DEVICE_NAME && !!MEMBER_ID;
}

function normalizeServerUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function showPairing(config?: PairingConfig) {
  pairingOpen = true;
  pairingForm.classList.remove('hidden');
  pairingServer.value = config?.serverUrl || SERVER_URL || '';
  pairingSecret.value = config?.roomSecret || '';
  pairingMember.value = config?.memberId || MEMBER_ID;
  pairingDevice.value = config?.deviceName || DEVICE_NAME;
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
  const memberId = pairingMember.value as 'a' | 'b' | '';
  const deviceName = pairingDevice.value.trim();
  if (!serverUrl || !roomSecret || !memberId || !deviceName) {
    pairingError.textContent = '请填写服务器地址、密钥、身份和设备名称。';
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    pairingError.textContent = '服务器地址需要以 http:// 或 https:// 开头。';
    return;
  }

  pairingError.textContent = '';
  const res = await petBridge.savePairingConfig({ serverUrl, roomSecret, memberId, deviceName });
  if (!res.ok) {
    pairingError.textContent = res.error || '保存失败，请重试。';
    return;
  }
  SERVER_URL = res.config?.serverUrl || serverUrl;
  ROOM_SECRET = res.config?.roomSecret || roomSecret;
  DEVICE_ID = res.config?.deviceId || DEVICE_ID;
  DEVICE_NAME = res.config?.deviceName || deviceName;
  MEMBER_ID = res.config?.memberId || memberId;
  hidePairing();
  connectRemote();
});

(async () => {
  let pairingConfig: PairingConfig = {};
  try { pairingConfig = await petBridge.getPairingConfig(); } catch {}
  SERVER_URL = normalizeServerUrl(pairingConfig.serverUrl || '');
  ROOM_SECRET = (pairingConfig.roomSecret || '').trim();
  DEVICE_ID = (pairingConfig.deviceId || '').trim();
  DEVICE_NAME = (pairingConfig.deviceName || '').trim();
  MEMBER_ID = pairingConfig.memberId || '';
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
  const nextDevice = String(config.deviceId || '').trim();
  if (nextServer === SERVER_URL && nextSecret === ROOM_SECRET && nextDevice === DEVICE_ID && config.memberId === MEMBER_ID && config.deviceName === DEVICE_NAME) return;
  cleanupRtc(false);
  remoteSocket?.removeAllListeners();
  remoteSocket?.disconnect();
  remoteSocket = null;
  remoteConnected = false;
  noteInbox.clear();
  releaseNoteImages();
  for (const child of noteCardWindows.values()) if (!child.closed) child.close();
  noteCardWindows.clear();
  syncNotesDock();
  renderNoteStack();
  SERVER_URL = nextServer;
  ROOM_SECRET = nextSecret;
  DEVICE_ID = nextDevice;
  DEVICE_NAME = String(config.deviceName || '').trim();
  MEMBER_ID = config.memberId || '';
  if (isPairingReady()) connectRemote();
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
  const requestedScale = clampScale(Math.round((currentScale + delta) * 10) / 10);
  void petBridge.resize(requestedScale).then((result) => {
    if (result.ok && typeof result.scale === 'number') currentScale = clampScale(result.scale);
  }).catch((error) => console.warn('[scale] resize failed:', error?.message || error));
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
petBridge.onScaleChanged((scale) => {
  currentScale = clampScale(scale);
});

// === 异步桌面便签 ===
type NoteAttachment = {
  id: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
};
type NoteMedia =
  | { kind: 'image'; attachment: NoteAttachment }
  | { kind: 'song' | 'video'; url: string; source?: string; thumbnailUrl?: string };
type DesktopNote = {
  id: string;
  revision: number;
  senderMemberId: 'a' | 'b';
  recipientMemberId: 'a' | 'b';
  body: string;
  paperColor: 'yellow' | 'pink' | 'blue' | 'sage' | 'lavender';
  media?: NoteMedia | null;
  createdAt: string;
  noticedAt?: string;
  review?: { reviewedAt: string; body?: string; imageAttachment?: NoteAttachment };
  favorite: boolean;
};
type NoteImageInput = { mime: string; data: ArrayBuffer };
type NoteResponse = { ok: boolean; code?: string; note?: DesktopNote; items?: DesktopNote[]; mime?: string; data?: ArrayBuffer };

const noteInbox = new Map<string, DesktopNote>();
const noteCardWindows = new Map<string, Window>();
let noteStackWindow: Window | null = null;
let noteGameMode = false;
const noteImageUrls = new Map<string, string>();
const NOTE_COLLAPSED_STORAGE = 'pet.noteCollapsedIds';
const collapsedNoteIds = new Set<string>((() => {
  try {
    const value = JSON.parse(localStorage.getItem(NOTE_COLLAPSED_STORAGE) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
})());

const NOTE_PAPERS: Record<DesktopNote['paperColor'], string> = {
  yellow: '#F4D77D',
  pink: '#E8B7C8',
  blue: '#AFC9D8',
  sage: '#B8C9A3',
  lavender: '#C8B7D8',
};

const NOTE_WINDOW_CSS = `
  :root{color-scheme:light;font-family:ui-rounded,"SF Pro Rounded",system-ui,sans-serif}
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent}
  .hidden{display:none!important}
  body{padding:8px;color:#302a2c}.sheet{height:100%;overflow:auto;border-radius:18px;padding:18px;
  box-shadow:0 14px 38px rgba(32,24,30,.28);border:1px solid rgba(72,52,55,.12)}
  .bar{display:flex;align-items:center;gap:7px;margin-bottom:12px;-webkit-app-region:drag}
  .bar strong{flex:1;font-size:13px}.bar button,.actions button,.emoji button,.stack-row button{-webkit-app-region:no-drag}
  button{border:0;border-radius:10px;padding:7px 10px;background:rgba(255,255,255,.66);color:#332d30;cursor:pointer}
  button:hover{background:#fff}button.primary{background:#443a42;color:white}
  .body{white-space:pre-wrap;font-size:16px;line-height:1.55;overflow-wrap:anywhere}
  .badge{display:inline-block;border-radius:9px;padding:3px 7px;background:#e85c72;color:white;font-size:10px}
  .media{margin:12px 0;border-radius:13px;overflow:hidden;background:rgba(255,255,255,.42)}
  .media img{display:block;width:100%;max-height:260px;object-fit:contain}
  .link{display:flex;align-items:center;gap:10px;padding:12px;text-align:left;width:100%}
  .link span{overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}
  .reply{margin-top:12px;padding-top:12px;border-top:1px solid rgba(53,43,47,.14)}
  textarea{width:100%;min-height:70px;resize:vertical;border:1px solid rgba(53,43,47,.18);border-radius:10px;
  padding:9px;background:rgba(255,255,255,.66);font:inherit}.emoji{display:flex;gap:5px;margin:7px 0}
  .hint{font-size:11px;opacity:.66;margin:5px 0}.stack{background:#fff9eb}.stack-row{display:flex;align-items:center;gap:8px;
  margin:8px 0;padding:10px;border-radius:12px;background:white}.stack-row .copy{flex:1;min-width:0}
  .stack-row strong,.stack-row small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .stack-row small{opacity:.62;margin-top:3px}.empty{text-align:center;padding:48px 10px;opacity:.6}
  @media(prefers-contrast:more){.sheet{background:#fff!important;color:#000;border:2px solid #000}
  button,textarea{border:1px solid #000}.badge,button.primary{background:#000!important;color:#fff!important}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

function noteRequest(event: string, payload?: unknown): Promise<NoteResponse> {
  return new Promise((resolve) => {
    if (!remoteSocket?.connected) return resolve({ ok: false, code: 'disconnected' });
    remoteSocket.timeout(15_000).emit(event, payload, (error: Error | null, response: NoteResponse) => {
      resolve(error ? { ok: false, code: 'timeout' } : response || { ok: false, code: 'note_request_failed' });
    });
  });
}

function noteError(code?: string) {
  const labels: Record<string, string> = {
    disconnected: '网络暂时断开了',
    timeout: '请求超时，请重试',
    invalid_note: '回复内容不符合要求',
    invalid_image: '请选择 2 MB 内的 JPEG 或 PNG',
    note_already_reviewed: '这张便签已在另一台设备批阅',
    favorite_limit_reached: '收藏数量已满',
    favorite_image_limit: '收藏图片空间已满',
  };
  return labels[code || ''] || '操作失败，请重试';
}

function noteGraphemeLength(value: string) {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length : [...value].length;
}

function syncNotesDock() {
  const notes = [...noteInbox.values()].filter((note) => !note.review);
  const fresh = notes.filter((note) => !note.noticedAt).length;
  notesCount.textContent = fresh ? `${fresh}/${notes.length}` : String(notes.length);
  notesCount.classList.toggle('hidden', notes.length === 0);
  notesDock.classList.toggle('has-new', fresh > 0);
  notesDock.title = notes.length ? `${fresh} 张新便签，${notes.length} 张待批阅` : '便签堆是空的';
}

function releaseNoteImages(noteId?: string) {
  for (const [key, url] of noteImageUrls) {
    if (!noteId || key.startsWith(`${noteId}:`)) {
      URL.revokeObjectURL(url);
      noteImageUrls.delete(key);
    }
  }
}

function persistCollapsedNotes() {
  localStorage.setItem(NOTE_COLLAPSED_STORAGE, JSON.stringify([...collapsedNoteIds]));
}

function makeButton(doc: Document, label: string, onClick: () => void, primary = false) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.addEventListener('click', onClick);
  return button;
}

async function attachmentUrl(note: DesktopNote, attachment: NoteAttachment) {
  const cacheKey = `${note.id}:${attachment.id}`;
  const cached = noteImageUrls.get(cacheKey);
  if (cached) return cached;
  const response = await noteRequest('note:get-attachment', { noteId: note.id, attachmentId: attachment.id });
  if (!response.ok || !response.data) return '';
  const url = URL.createObjectURL(new Blob([response.data], { type: response.mime || attachment.mime }));
  noteImageUrls.set(cacheKey, url);
  return url;
}

async function noteImageInput(file: File): Promise<NoteImageInput> {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('invalid_image');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('invalid_image');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = .9;
  let blob: Blob | null = null;
  do {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    quality -= .12;
  } while (blob && blob.size > 2 * 1024 * 1024 && quality >= .3);
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('invalid_image');
  return { mime: 'image/jpeg', data: await blob.arrayBuffer() };
}

function markNoteNoticed(noteId: string) {
  const note = noteInbox.get(noteId);
  if (!note || note.noticedAt) return;
  void noteRequest('note:mark-noticed', { noteId }).then((result) => {
    if (result.ok && result.note) reconcileNote(result.note, false);
  });
}

async function renderNoteCard(noteId: string, child: Window) {
  const note = noteInbox.get(noteId);
  if (!note || note.review || child.closed) return;
  const doc = child.document;
  doc.title = '桌面便签';
  doc.head.replaceChildren();
  const style = doc.createElement('style');
  style.textContent = NOTE_WINDOW_CSS;
  doc.head.appendChild(style);
  const sheet = doc.createElement('main');
  sheet.className = 'sheet';
  sheet.style.background = NOTE_PAPERS[note.paperColor] || NOTE_PAPERS.yellow;
  sheet.addEventListener('pointerdown', () => markNoteNoticed(note.id), { once: true });

  const bar = doc.createElement('div');
  bar.className = 'bar';
  const title = doc.createElement('strong');
  title.textContent = `来自 ${note.senderMemberId.toUpperCase()}`;
  bar.append(title);
  if (!note.noticedAt) {
    const badge = doc.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'NEW';
    bar.append(badge);
  }
  bar.append(makeButton(doc, note.favorite ? '★' : '☆', () => {
    void noteRequest('note:set-favorite', { noteId, favorite: !note.favorite }).then((result) => {
      if (result.ok && result.note) reconcileNote(result.note, false);
      else showReply(noteError(result.code), 2600);
    });
  }));
  bar.append(makeButton(doc, '收进堆', () => {
    collapsedNoteIds.add(note.id);
    persistCollapsedNotes();
    child.close();
  }));
  sheet.append(bar);

  if (note.body) {
    const body = doc.createElement('div');
    body.className = 'body';
    body.textContent = note.body;
    sheet.append(body);
  }
  if (note.media) {
    const media = doc.createElement('div');
    media.className = 'media';
    if (note.media.kind === 'image') {
      const image = doc.createElement('img');
      image.alt = '便签图片';
      media.append(image);
      void attachmentUrl(note, note.media.attachment).then((url) => { if (url && !child.closed) image.src = url; });
    } else {
      const linkMedia = note.media;
      if (linkMedia.thumbnailUrl) {
        const thumbnail = doc.createElement('img');
        thumbnail.alt = '';
        thumbnail.referrerPolicy = 'no-referrer';
        thumbnail.src = linkMedia.thumbnailUrl;
        media.append(thumbnail);
      }
      const link = makeButton(doc, `${linkMedia.kind === 'song' ? '♫' : '▶'}  ${linkMedia.source || linkMedia.url}`, () => {
        void petBridge.openExternal(linkMedia.url);
      });
      link.className = 'link';
      media.append(link);
    }
    sheet.append(media);
  }

  const actions = doc.createElement('div');
  actions.className = 'actions';
  const replyPanel = doc.createElement('section');
  replyPanel.className = 'reply hidden';
  const replyText = doc.createElement('textarea');
  replyText.placeholder = '可以写回复，也可以只选 emoji 或图片（最多 500 个字）';
  const emoji = doc.createElement('div');
  emoji.className = 'emoji';
  for (const value of ['❤️', '👍', '🥰', '收到', '抱抱']) {
    emoji.append(makeButton(doc, value, () => {
      replyText.value = `${replyText.value}${replyText.value ? ' ' : ''}${value}`;
      replyText.dispatchEvent(new InputEvent('input', { bubbles: true }));
      replyText.focus();
    }));
  }
  const imageInput = doc.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/jpeg,image/png';
  const hint = doc.createElement('div');
  hint.className = 'hint';
  const updateReplyHint = () => {
    hint.textContent = `${noteGraphemeLength(replyText.value)} / 500 · 回复会和“已批阅”一次提交；失败时仍保持未批阅。`;
  };
  replyText.addEventListener('input', updateReplyHint);
  updateReplyHint();
  replyPanel.append(replyText, emoji, imageInput, hint);
  replyPanel.append(makeButton(doc, '发送回复并批阅', () => {
    const body = replyText.value.trim();
    const file = imageInput.files?.[0];
    void (async () => {
      if (noteGraphemeLength(body) > 500) {
        showReply('回复最多 500 个字符', 3000);
        return;
      }
      const reply = body || file ? {
        ...(body ? { body } : {}),
        ...(file ? { image: await noteImageInput(file) } : {}),
      } : undefined;
      const result = await noteRequest('note:review', { noteId, ...(reply ? { reply } : {}) });
      if (!result.ok) {
        showReply(noteError(result.code), 3000);
        return;
      }
      if (result.note) reconcileNote(result.note, false);
    })().catch(() => showReply('回复图片处理失败，请换一张试试', 3000));
  }, true));
  actions.append(makeButton(doc, '批阅', () => {
    void noteRequest('note:review', { noteId }).then((result) => {
      if (result.ok && result.note) reconcileNote(result.note, false);
      else showReply(noteError(result.code), 3000);
    });
  }, true));
  actions.append(makeButton(doc, '批阅并回复', () => {
    replyPanel.classList.toggle('hidden');
    if (!replyPanel.classList.contains('hidden')) replyText.focus();
  }));
  sheet.append(actions, replyPanel);
  doc.body.replaceChildren(sheet);
}

function openNoteCard(noteId: string) {
  if (noteGameMode) return;
  const note = noteInbox.get(noteId);
  if (!note || note.review) return;
  if (collapsedNoteIds.delete(noteId)) persistCollapsedNotes();
  let child = noteCardWindows.get(noteId);
  if (!child || child.closed) {
    const opened = window.open('about:blank', `note-card:${noteId}`, 'popup=yes');
    if (!opened) {
      showReply('系统未能打开便签窗口', 2600);
      return;
    }
    child = opened;
    noteCardWindows.set(noteId, child);
  }
  void renderNoteCard(noteId, child);
}

function renderNoteStack(fitToContent = false) {
  const child = noteStackWindow;
  if (!child || child.closed) return;
  const doc = child.document;
  doc.title = '便签堆';
  doc.head.replaceChildren();
  const style = doc.createElement('style');
  style.textContent = NOTE_WINDOW_CSS;
  doc.head.append(style);
  const sheet = doc.createElement('main');
  sheet.className = 'sheet stack';
  const bar = doc.createElement('div');
  bar.className = 'bar';
  const title = doc.createElement('strong');
  title.textContent = `便签堆 · ${noteInbox.size}`;
  bar.append(title, makeButton(doc, '写一张', () => petBridge.openNoteComposer()), makeButton(doc, '全部展开', () => {
    for (const note of noteInbox.values()) openNoteCard(note.id);
  }));
  sheet.append(bar);
  const notes = [...noteInbox.values()].filter((note) => !note.review);
  if (!notes.length) {
    const empty = doc.createElement('div');
    empty.className = 'empty';
    empty.textContent = '这里暂时没有待批阅的便签';
    sheet.append(empty);
  }
  for (const note of notes) {
    const row = doc.createElement('div');
    row.className = 'stack-row';
    const copy = doc.createElement('div');
    copy.className = 'copy';
    const heading = doc.createElement('strong');
    heading.textContent = `${note.noticedAt ? '' : '● '}${note.body || (note.media?.kind === 'image' ? '一张图片' : '一个链接')}`;
    const date = doc.createElement('small');
    date.textContent = new Date(note.createdAt).toLocaleString();
    copy.append(heading, date);
    row.append(copy, makeButton(doc, '展开', () => openNoteCard(note.id)));
    sheet.append(row);
  }
  doc.body.replaceChildren(sheet);
  if (fitToContent) {
    sheet.style.height = 'auto';
    const contentHeight = Math.ceil(sheet.scrollHeight + 16);
    const maxHeight = Math.max(220, child.screen.availHeight - 40);
    child.resizeTo(
      Math.max(260, child.outerWidth),
      Math.min(maxHeight, Math.max(220, contentHeight)),
    );
    sheet.style.height = '';
  }
}

function toggleNoteStack() {
  if (noteGameMode) return;
  if (noteStackWindow && !noteStackWindow.closed) {
    noteStackWindow.close();
    noteStackWindow = null;
    return;
  }
  noteStackWindow = window.open('about:blank', 'note-stack', 'popup=yes');
  if (!noteStackWindow) return;
  renderNoteStack(true);
}

function reconcileNote(note: DesktopNote, announce: boolean) {
  const previous = noteInbox.get(note.id);
  if (previous && previous.revision > note.revision) return;
  if (note.recipientMemberId !== MEMBER_ID || note.review) {
    noteInbox.delete(note.id);
    if (collapsedNoteIds.delete(note.id)) persistCollapsedNotes();
    releaseNoteImages(note.id);
    const child = noteCardWindows.get(note.id);
    if (child && !child.closed) child.close();
    noteCardWindows.delete(note.id);
  } else {
    noteInbox.set(note.id, note);
    const child = noteCardWindows.get(note.id);
    if (child && !child.closed) void renderNoteCard(note.id, child);
    else if (announce && !noteGameMode) openNoteCard(note.id);
  }
  syncNotesDock();
  renderNoteStack();
  if (announce && !previous && !note.review) {
    setSpriteState('waiting', 4200);
    showReply('收到一张新便签', 2600);
  }
}

async function refreshNoteInbox(openCards = false) {
  const response = await noteRequest('note:list', { view: 'inbox', limit: 500 });
  if (!response.ok) return;
  const ids = new Set((response.items || []).map((note) => note.id));
  for (const id of noteInbox.keys()) {
    if (!ids.has(id)) {
      noteInbox.delete(id);
      if (collapsedNoteIds.delete(id)) persistCollapsedNotes();
      releaseNoteImages(id);
    }
  }
  for (const note of response.items || []) reconcileNote(note, false);
  syncNotesDock();
  renderNoteStack();
  if (openCards && !noteGameMode) {
    for (const note of noteInbox.values()) if (!collapsedNoteIds.has(note.id)) openNoteCard(note.id);
  }
}

notesDock.addEventListener('click', toggleNoteStack);
notesDock.addEventListener('pointerenter', () => petBridge.setClickable(true));
petBridge.isGameMode().then((enabled) => { noteGameMode = enabled; }).catch(() => {});
petBridge.onGameModeChanged((enabled) => {
  noteGameMode = enabled;
  if (!enabled) renderNoteStack();
});
petBridge.onNoteWindowClosed((frameName) => {
  if (frameName === 'note-stack') noteStackWindow = null;
  else if (frameName.startsWith('note-card:')) noteCardWindows.delete(frameName.slice('note-card:'.length));
});
petBridge.onNoteWindowInteracted((frameName) => {
  if (frameName.startsWith('note-card:')) markNoteNoticed(frameName.slice('note-card:'.length));
});
window.addEventListener('beforeunload', () => releaseNoteImages());
syncNotesDock();

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
let rtcDiagnostics: RtcDiagnosticHandle | null = null;
let activeCallId = '';
let rtcScreenStream: MediaStream | null = null;
let rtcMicStream: MediaStream | null = null;
let rtcRemoteAudioStream: MediaStream | null = null;
const rtcPendingCandidates: RTCIceCandidateInit[] = [];
let screenRequestedByController = true;
let screenRouteProfile: VideoRouteProfile = 'unknown';
let rtcScreenSender: RTCRtpSender | null = null;
let screenProfileGeneration = 0;
let screenProfileApplyChain: Promise<void> = Promise.resolve();
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

type RtcConfigResponse = {
  ok?: boolean;
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
};

function requestRtcConfig(): Promise<RTCConfiguration> {
  return new Promise((resolve) => {
    const fallback: RTCConfiguration = { iceServers: [], iceTransportPolicy: 'all' };
    if (!remoteSocket?.connected) return resolve(fallback);
    remoteSocket.timeout(4000).emit('webrtc:get-config', (error: Error | null, response: RtcConfigResponse) => {
      if (error || !response?.ok) return resolve(fallback);
      resolve({
        iceServers: Array.isArray(response.iceServers) ? response.iceServers : [],
        iceTransportPolicy: response.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      });
    });
  });
}

function emitMediaStatus(
  media: 'screen' | 'microphone' | 'system-audio',
  state: 'available' | 'paused' | 'unavailable',
  reason?: 'controller_disabled' | 'capture_failed' | 'track_ended' | 'profile_failed',
  quality?: 'normal' | 'relay-low',
) {
  if (!activeCallId) return;
  remoteSocket?.emit('webrtc:media-status', {
    callId: activeCallId, media, state,
    ...(reason ? { reason } : {}),
    ...(quality ? { quality } : {}),
  });
}

async function applyRequestedScreenState() {
  const generation = ++screenProfileGeneration;
  const screenTrack = rtcScreenStream?.getVideoTracks()[0];
  if (!screenTrack || screenTrack.readyState !== 'live') {
    emitMediaStatus('screen', 'unavailable', 'capture_failed');
    return;
  }
  screenTrack.enabled = false;
  if (!screenRequestedByController) {
    emitMediaStatus('screen', 'paused', 'controller_disabled');
    return;
  }
  if (screenRouteProfile === 'unknown' || screenRouteProfile === 'failed') {
    emitMediaStatus('screen', 'paused');
    return;
  }
  if (!rtcScreenSender) {
    emitMediaStatus('screen', 'unavailable', 'profile_failed');
    return;
  }
  const sender = rtcScreenSender;
  const profile = screenRouteProfile;
  const operation = screenProfileApplyChain.catch(() => {}).then(async () => {
    if (generation !== screenProfileGeneration || !screenRequestedByController) return;
    const applied = await applyVideoSenderProfile(sender, screenTrack, profile, 'screen');
    if (generation !== screenProfileGeneration || !screenRequestedByController) return;
    if (!applied.ok) {
      console.warn('[webrtc] screen video profile unavailable:', applied.error);
      emitMediaStatus('screen', 'unavailable', 'profile_failed');
      return;
    }
    screenTrack.enabled = true;
    emitMediaStatus('screen', 'available', undefined, profile);
  });
  screenProfileApplyChain = operation;
  await operation;
}

async function selectedPairVideoProfile(pc: RTCPeerConnection): Promise<VideoRouteProfile> {
  const stats = await pc.getStats();
  let pair: any;
  stats.forEach((report: any) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((report: any) => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) pair = report;
  });
  if (!pair) return 'unknown';
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local || !remote) return 'unknown';
  return local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay-low' : 'normal';
}

async function capAudioSender(sender: RTCRtpSender) {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    for (const encoding of parameters.encodings) encoding.maxBitrate = 64_000;
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn('[webrtc] audio bitrate cap unavailable:', error);
  }
}

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
  rtcDiagnostics?.close('call-cleanup');
  rtcDiagnostics = null;
  try { rtcPc?.close(); } catch {}
  rtcPc = null;
  rtcScreenSender = null;
  rtcPendingCandidates.length = 0;

  for (const stream of [rtcScreenStream, rtcMicStream]) {
    try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
  }
  rtcScreenStream = null;
  rtcMicStream = null;
  rtcRemoteAudioStream = null;
  rtcAudioEl.srcObject = null;
  screenRequestedByController = true;
  screenRouteProfile = 'unknown';
  screenProfileGeneration += 1;
  screenProfileApplyChain = Promise.resolve();
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
      recordPetDiagnostic({
        event: 'media.screen-capture-failed',
        domain: 'media',
        level: 'warn',
        errorCode: error?.name === 'NotAllowedError' ? 'media_screen_permission_denied' : 'media_screen_capture_failed',
        recoverability: 'user_action',
        correlation: { callId: activeCallId || undefined },
        exception: normalizeDiagnosticError(error),
      });
      console.warn('[webrtc] screen capture unavailable; continuing audio-only:', error);
      emitMediaStatus('screen', 'unavailable', 'capture_failed');
    }
  }

  try {
    rtcMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error: any) {
    recordPetDiagnostic({
      event: 'media.microphone-capture-failed',
      domain: 'media',
      level: 'error',
      errorCode: error?.name === 'NotAllowedError' ? 'media_microphone_permission_denied' : 'media_microphone_capture_failed',
      recoverability: 'user_action',
      correlation: { callId: activeCallId || undefined },
      exception: normalizeDiagnosticError(error),
    });
    throw error;
  }
  console.log('[webrtc] captured microphone');

  const systemTracks = rtcScreenStream?.getAudioTracks() ?? [];
  if (systemTracks.length) {
    console.log('[webrtc] captured separate microphone and system audio tracks');
  } else {
    console.warn('[webrtc] system audio unavailable; sending microphone only');
  }

  const screenTrack = rtcScreenStream?.getVideoTracks()[0];
  if (screenTrack) {
    screenTrack.enabled = false;
    screenTrack.addEventListener('ended', () => {
      emitMediaStatus('screen', 'unavailable', 'track_ended');
      showReply('屏幕共享结束，音频继续', 3000);
    }, { once: true });
  }

  emitMediaStatus('microphone', 'available');
  emitMediaStatus('system-audio', systemTracks.length ? 'available' : 'unavailable');

  return new MediaStream([
    ...(rtcScreenStream?.getVideoTracks() ?? []),
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
      rtcDiagnostics?.candidate('remote', 'added', candidate);
    } catch (e) {
      rtcDiagnostics?.candidate('remote', 'add-failed', candidate, e);
      console.warn('[webrtc] addIceCandidate failed:', e);
    }
  }
}

async function ensurePetPeerConnection(): Promise<RTCPeerConnection> {
  if (rtcPc) return rtcPc;
  const media = await ensurePetMedia();
  const rtcConfig = await requestRtcConfig();
  const pc = new RTCPeerConnection(rtcConfig);
  rtcPc = pc;
  rtcDiagnostics = attachRtcDiagnostics(pc, {
    recorder: recordPetDiagnostic,
    role: 'pet',
    mediaKind: 'main',
    getCallId: () => activeCallId,
    configuration: rtcConfig,
  });

  for (const track of media.getTracks()) {
    const sender = pc.addTrack(track, media);
    if (track.kind === 'audio') void capAudioSender(sender);
    else if (track.kind === 'video') rtcScreenSender = sender;
  }
  console.log('[webrtc] pet added local tracks', media.getTracks().map((t) => ({
    kind: t.kind,
    id: t.id,
    label: t.label,
    state: t.readyState,
  })));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      rtcDiagnostics?.candidate('local', 'generated', event.candidate);
      console.log('[webrtc] pet sent ice candidate');
      remoteSocket?.emit('webrtc:signal', { callId: activeCallId || undefined, candidate: event.candidate.toJSON() });
    } else {
      rtcDiagnostics?.candidate('local', 'gathering-complete');
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
    if (state === 'connected') {
      rtcDiagnostics?.snapshot('route-selected').catch(() => {});
      noteRemote('call on');
      selectedPairVideoProfile(pc).then((profile) => {
        screenRouteProfile = profile;
        void applyRequestedScreenState();
      }).catch((error) => {
        console.warn('[webrtc] route inspection failed:', error);
        screenRouteProfile = 'failed';
        void applyRequestedScreenState();
      });
    }
    if (state === 'failed' || state === 'disconnected') {
      screenRouteProfile = 'failed';
      void applyRequestedScreenState();
      showReply('网络波动，等待通话恢复…', 2500);
    }
    if (state === 'closed') {
      cleanupRtc(false);
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
    rtcDiagnostics?.candidate('remote', 'received', signal.candidate);
    if (!rtcPc?.remoteDescription) {
      rtcPendingCandidates.push(signal.candidate);
      rtcDiagnostics?.candidate('remote', 'queued', signal.candidate);
      return;
    }
    try {
      await rtcPc.addIceCandidate(signal.candidate);
      rtcDiagnostics?.candidate('remote', 'added', signal.candidate);
    } catch (e) {
      rtcDiagnostics?.candidate('remote', 'add-failed', signal.candidate, e);
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
      { protocolVersion: 2, secret: ROOM_SECRET, role: 'pet', memberId: MEMBER_ID, deviceId: DEVICE_ID, deviceName: DEVICE_NAME },
      (res: { ok: boolean; code?: string; error?: string }) => {
        if (res?.ok) {
          remoteConnected = true;
          recordPetDiagnostic({
            event: 'socket.joined',
            domain: 'socket',
            correlation: { deviceId: DEVICE_ID },
            context: { role: 'pet', memberId: MEMBER_ID },
          });
          console.log('[remote] joined as pet');
          void refreshNoteInbox(true);
        } else {
          remoteConnected = false;
          recordPetDiagnostic({
            event: 'socket.join-rejected',
            domain: 'socket',
            level: 'error',
            errorCode: res?.code || 'socket_join_rejected',
            recoverability: 'user_action',
            correlation: { deviceId: DEVICE_ID },
            context: { role: 'pet', memberId: MEMBER_ID, message: res?.error },
          });
          console.warn('[remote] join rejected:', res?.code || res?.error);
        }
      }
    );
  };

  remoteSocket.on('connect', join);
  remoteSocket.on('disconnect', () => {
    remoteConnected = false;
    recordPetDiagnostic({
      event: 'socket.disconnected',
      domain: 'socket',
      level: 'warn',
      errorCode: 'socket_disconnected',
      recoverability: 'automatic',
      correlation: { deviceId: DEVICE_ID, callId: activeCallId || undefined },
    });
    stopTtsPlayback();
    cleanupRtc(false);
    console.log('[remote] disconnected');
  });
  remoteSocket.on('connect_error', (e) => {
    remoteConnected = false;
    recordPetDiagnostic({
      event: 'socket.connect-error',
      domain: 'socket',
      level: 'warn',
      errorCode: 'socket_connect_error',
      recoverability: 'retryable',
      correlation: { deviceId: DEVICE_ID },
      exception: normalizeDiagnosticError(e),
    });
    console.warn('[remote] connect_error:', e.message);
  });
  remoteSocket.on('pet:command', (cmd: RemoteCommand) => {
    console.log('[remote] cmd', cmd);
    handleRemoteCommand(cmd);
  });
  remoteSocket.on('note:changed', (payload: { reason?: string; note?: DesktopNote }) => {
    if (payload?.note) reconcileNote(payload.note, payload.reason === 'created');
  });
  remoteSocket.on('note:removed', (payload: { noteId?: string }) => {
    const noteId = String(payload?.noteId || '');
    if (!noteId) return;
    noteInbox.delete(noteId);
    releaseNoteImages(noteId);
    const child = noteCardWindows.get(noteId);
    if (child && !child.closed) child.close();
    noteCardWindows.delete(noteId);
    syncNotesDock();
    renderNoteStack();
  });
  remoteSocket.on('tts:play', (job: TtsPlay) => {
    void playTtsStream(job);
  });
  remoteSocket.on('audio:play', (clip: { mime: string; data: ArrayBuffer }) => {
    const url = URL.createObjectURL(new Blob([clip.data], { type: clip.mime }));
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    void audio.play();
  });
  remoteSocket.on('webrtc:signal', (signal: WebRtcSignal) => {
    handleRtcSignal(signal).catch((e) => {
      reportRtcError(`信令失败：${e?.message || e}`);
    });
  });
  remoteSocket.on('webrtc:media-control', (control: { callId?: string; media?: string; enabled?: boolean }) => {
    if (!activeCallId || control?.callId !== activeCallId || control.media !== 'screen' || typeof control.enabled !== 'boolean') return;
    screenRequestedByController = control.enabled;
    void applyRequestedScreenState();
    showReply(control.enabled ? '控制端恢复了屏幕共享' : '控制端暂停了屏幕共享', 2200);
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
