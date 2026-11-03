// 엔진 공개 API: createGame — 장면 조립, 포인터 입력, 무기 발사, 프레임 루프, 되돌리기
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Game, GameCallbacks, GameStats, HospitalData, WeaponId } from './types.ts';
import { BLOCK_HP, World, heightAt, isLabeled } from './world.ts';
import { ROD_AIM, THERMO_FIRE, WEAPON_PARAMS } from './weapons.ts';
import { blockMaterials, makeBlocks, rubbleMaterial, makeLights, makeTerrain, makeTrees } from './scene.ts';
import { Debris, Fireballs, Flyers, Particles, ShockDomes, Shockwaves, Sparks, Tracers, puffTexture, spring } from './fx.ts';
import { Sound } from './sound.ts';
import { Evacuees, type Dead } from './crowd.ts';

export { WEAPONS } from './weapons.ts';
export { RANK_THRESHOLDS, rankTier } from './world.ts';
export type { HospitalData } from './types.ts';
export type { Game, GameCallbacks, GameError, GameStats, Rank, WeaponId, WeaponInfo } from './types.ts';

// 에러 진단 로그 한 줄 (ERROR.md 형식)
function logError(code: string, operation: string, err: unknown, input?: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    console.error('APP_ERROR_DIAGNOSTIC ' + JSON.stringify({
      code, operation, layer: 'game-engine', message: e.message, error_message: e.message, errormessage: e.message,
      stacktrace: e.stack, input: input ?? null, output: null, upstream: null,
    }));
  } catch {
    console.error('APP_ERROR_DIAGNOSTIC', code, operation, e.message);
  }
}

const NOOP_GAME: Game = {
  setWeapon() {}, undo() {}, restoreAll() {}, setLabels() {}, setSound() {}, setMusic() {}, setVolume() {}, setTopView() {},
  capture: () => Promise.reject(new Error('RENDER_WEBGL_UNAVAILABLE')), dispose() {},
};

// 누르고 있으면 연사되는 무기(다연장·열압력탄·벙커버스터·집속탄·중성자탄·신의 지팡이는 한 번에 한 발. 다연장은 한 번에 일제 사격 한 번). 날아가는 무기는 한 발마다 launch()가 되돌리기 기록을 따로 연다
const AUTO: Partial<Record<WeaponId, true>> = { rifle: true, grenade: true, mortar: true, artillery: true, bomb: true };

// k = 출발점 거리 배율(출발점이 화면 밖으로 나가도록 커짐)
// T = 착탄까지 초(없으면 무기 delay), sub = 집속탄 자탄·벙커버스터 바닥 폭발처럼 한 발이 낳은 뒤따르는 탄, bld = 벙커버스터·열압력탄·신의 지팡이가 맞힌 건물 번호
// trail = 연기·플라스마 꼬리를 마지막으로 남긴 뒤 지나온 거리(m). 처음 보인 프레임 전에는 없다
interface Shot { w: WeaponId; act: number; target: THREE.Vector3; from: THREE.Vector3; age: number; mesh: THREE.Mesh; k: number; shadow?: THREE.Mesh; warn?: THREE.Object3D; T?: number; sub?: boolean; bld?: number; trail?: number; aim?: THREE.Vector3 }
// 폭발 뒤 이어지는 연출: 중성자탄 충격파 링·버섯구름, 열압력탄 점화·긴 폭풍·진공 (w로 나눈다)
// acc = 입자 뿌리기 누적, bld = 열압력탄이 맞힌 건물 번호(닫힌 공간 증폭)
interface Blast { w: WeaponId; act: number; c: THREE.Vector3; age: number; acc: number; ring?: THREE.Mesh; bld?: number }
// 기울며 넘어가는 덩어리: 축 위치에 둔 그룹을 돌리며 블록을 하나씩 떼어 낸다
// ids = 블록 번호, left = 아직 붙은 인스턴스 번호, ax = 회전축, th·om = 각도·각속도, H = 덩어리 높이
// near = 덮칠 수 있는 옆 건물 번호 (첫 stepTip에서 채운다)
// p0 = 처음 축 위치(블록 원래 좌표를 그룹 기준으로 바꿀 때 쓴다), th = 기운 각, om = 가라앉는 속도
interface Tip { act: number; grp: THREE.Group; mesh: THREE.InstancedMesh; ids: number[]; left: number[]; ax: THREE.Vector3; th: number; om: number; H: number; p0: THREE.Vector3; near?: number[] }

const FLASH_MS = 1200;  // 중성자탄 흰 섬광 길이. 눈부심 상한이라 늘리지 않는다
const RING_T = 1.4;     // 충격파 링이 R × 2.2까지 퍼지는 시간(초)
const CLUSTER_OPEN = 0.32;   // 집속탄 운반탄이 열리는 자리: 목표에서 출발점(위 250m) 쪽으로 32% = 목표 위 약 80m
const CLOUD_T = 2.4;    // 버섯구름 입자를 뿌리는 시간(초). 입자는 6~8초 산다
const MLRS_GAP = 0.15;  // 다연장 로켓 발사 간격(초). 실제는 0.5초 이상이지만 게임에 맞게 줄였다
const THERMO_END = 1.6; // 열압력탄 연출이 끝나는 시각(착탄 뒤 초): 점화 0.35 + 불덩이 1.2
const BUNKER_FUSE = 0.9;   // 벙커버스터가 뚫고 들어간 뒤 땅속에서 터지기까지(초). 조용히 떨리다 "펑"
const QUAKE_T = 0.9;       // 벙커버스터 땅속 폭발 뒤 흙먼지 띠가 바깥으로 번지는 시간(초)

// container 안에 게임을 만든다
export function createGame(container: HTMLElement, data: HospitalData, cb: GameCallbacks): Game {
  const touch = matchMedia('(pointer: coarse)').matches;
  const CLUSTER_N = touch ? 16 : 24;   // 집속탄 자탄 수
  const MLRS_N = touch ? 8 : 12;       // 다연장 로켓 일제 사격 한 번의 발수
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !touch, powerPreference: 'high-performance' });
  } catch (e) {
    logError('RENDER_WEBGL_UNAVAILABLE', 'createGame', e, { userAgent: navigator.userAgent });
    cb.onError({ code: 'RENDER_WEBGL_UNAVAILABLE', message: '이 브라우저에서 WebGL을 쓸 수 없습니다.' });
    return NOOP_GAME;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const el = renderer.domElement;
  el.style.display = 'block';
  el.style.touchAction = 'none';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(el);

  // 상태와 장면
  const world = new World(data, { maxTrees: touch ? 2000 : 4000 });
  const t = world.t, W = (t.nx - 1) * t.step, Dp = (t.nz - 1) * t.step, size = Math.max(W, Dp);
  const scene = new THREE.Scene();
  const bg = new THREE.Color('#dfe6ea');
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, size * 1.3, size * 3.5);
  const terrain = makeTerrain(data, world, renderer.capabilities.getMaxAnisotropy());
  const trees = makeTrees(world);
  const blocks = makeBlocks(world, data);
  scene.add(terrain.mesh, trees.mesh, blocks.mesh, ...makeLights(world, touch ? 1024 : 2048));

  const g = world.blocks.g;
  const falls = new Flyers(new THREE.BoxGeometry(g, 1, g), rubbleMaterial(), touch ? 1500 : 4000);   // 동시에 떠 있는 물리 큐브 상한, 넘으면 바로 잔해가 된다
  const toppleMat = blockMaterials();   // 기우는 덩어리는 아직 건물 모양이라 창문을 둔다
  const shards = new Flyers(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }), touch ? 600 : 1200, 2, 0.18);
  const debris = new Debris(touch ? 8000 : 20000,{ x0: t.x0, z0: t.z0, w: W, d: Dp }, g, (x, z) => heightAt(t, x, z));
  const smoke = new Particles(touch ? 900 : 1400, false);
  const fire = new Particles(touch ? 300 : 500, true);   // PC는 지팡이 꼬리(최대 약 190개)가 착탄 불꽃을 밀어내지 않게 넉넉히
  const fireballs = new Fireballs();
  const sparks = new Sparks(touch ? 500 : 1000);
  const waves = new Shockwaves();
  const domes = new ShockDomes();   // 신의 지팡이 충격파 돔·흙먼지 벽
  const tracers = new Tracers();
  // 버섯구름 전용 연기 (붕괴 먼지가 smoke를 다 채워도 구름이 빠지지 않게 따로 둔다)
  const cloud = new Particles(touch ? 300 : 600, false);
  // 로켓 연기 꼬리 전용 (다연장·열압력탄). 여러 줄 꼬리가 폭발 먼지와 자리를 다투지 않게 따로 둔다
  const trail = new Particles(touch ? 500 : 1000, false);   // 지팡이 한 줄이 최대 300덩이(1,500m ÷ 5m)라 두 줄이 겹쳐도 남게
  // 폭발 연기·그을음 전용 로우폴리 덩이 (흙먼지는 smoke 빌보드에 남긴다)
  const puffs = new Particles(touch ? 400 : 700, false, true);
  scene.add(falls.mesh, shards.mesh, debris.mesh, smoke.mesh, puffs.mesh, fire.mesh, fireballs.group, tracers.lines, cloud.mesh, trail.mesh, sparks.lines, waves.group, domes.group);
  // 병원에서 대피하는 사람·차 (R69). 장면 순회 dispose가 메시를 함께 치운다
  const crowd = new Evacuees(world, data, touch);
  crowd.ground = (x, z) => debris.groundAt(x, z);   // 끊긴 도로 판정에 잔해 더미 높이까지 (R82)
  scene.add(crowd.people, crowd.cars);
  const sound = new Sound(logError);
  // 병원 카드를 눌러 들어오면 그 클릭이 사용자 입력으로 남아 있어 BGM이 바로 나온다. 주소로 바로 열면 브라우저가 막아 첫 탭(onDown)에서 나온다
  sound.unlock();

  // 카메라: 병원 부지 중심을 45° 위에서 비스듬히
  const camera = new THREE.PerspectiveCamera(36, 1, 1, size * 6);
  const target0 = new THREE.Vector3(0, heightAt(t, 0, 0), 0);
  const view0 = new THREE.Spherical(THREE.MathUtils.clamp(size * 0.85, 260, 700), Math.PI / 4, -0.55);
  camera.position.setFromSpherical(view0).add(target0);
  const controls = new OrbitControls(camera, el);
  controls.target.copy(target0);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.12, minDistance: 20, maxDistance: size * 2, maxPolarAngle: 1.3, screenSpacePanning: false, zoomToCursor: true });
  controls.update();

  // 모든 무기는 화면 밖에서 날아온다: at(k)의 k를 키워 출발점이 화면 가장자리 밖이나 카메라 뒤로 나가게 한다(최대 16배)
  const outK = (at: (k: number) => THREE.Vector3) => {
    let k = 1;
    for (const v = new THREE.Vector3(); k < 16; k *= 1.1) {
      v.copy(at(k)).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) break;
    }
    return k;
  };

  // 이름표: hosp=1이고 이름 있는 큰 건물부터 최대 40개
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  container.appendChild(layer);
  const narrow = !matchMedia('(min-width: 1024px)').matches;
  const buildingsTotal = world.buildings.filter(isLabeled).length;
  const labels = world.buildings.filter((b) => b.hosp && b.name)
    .sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 40)
    .map((b) => {
      const div = document.createElement('div');
      div.textContent = b.name!;
      div.style.cssText = 'position:absolute;left:0;top:0;padding:3px 8px;border-radius:6px;background:rgba(24,26,30,.86);color:#fff;font:600 14px/1.25 system-ui,sans-serif;white-space:nowrap;pointer-events:none;will-change:transform';
      // 휴대폰 폭에서는 글자를 줄이고 긴 이름은 말줄임으로 자른다
      if (narrow) Object.assign(div.style, { fontSize: '12px', maxWidth: '45vw', overflow: 'hidden', textOverflow: 'ellipsis' });
      layer.appendChild(div);
      return { b, div, p: new THREE.Vector3(b.cx, b.topY + 4, b.cz) };
    });
  let labelsOn = true;

  // 화면 섬광(중성자탄·신의 지팡이 흰색, 열압력탄 주황): 캔버스·이름표 위를 덮는 div. 입력은 통과시킨다
  const flashEl = document.createElement('div');
  flashEl.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none';
  container.appendChild(flashEl);
  let flashEnd = 0, flashLen = FLASH_MS, flashMax = 1;   // 섬광 끝 시각·길이(ms)·최대 세기: 중성자탄 1.2초, 신의 지팡이 0.5초, 열압력탄 0.45초(최대 0.6)
  // 섬광을 건다: ms 길이, 색, 최대 세기
  const flash = (ms: number, color: string, max = 1) => {
    flashLen = ms;
    flashEnd = performance.now() + ms;
    flashMax = max;
    flashEl.style.background = color;
  };
  // 중성자탄 발사 문구: 위쪽 가운데에 한 줄로 띄운다. 입력은 통과시킨다
  const nukeEl = document.createElement('div');
  nukeEl.setAttribute('role', 'alert');
  nukeEl.style.cssText = "position:absolute;left:50%;top:22%;transform:translateX(-50%);padding:8px 16px;border:1px solid #ff4136;border-radius:6px;background:rgba(10,10,12,.6);color:#ff4136;font:700 clamp(13px,3.4vw,26px)/1.2 'Pretendard GOV',system-ui,sans-serif;letter-spacing:.16em;text-shadow:0 0 8px rgba(255,65,54,.65);white-space:nowrap;pointer-events:none;opacity:0";
  container.appendChild(nukeEl);
  let nukeAnim: Animation | undefined;

  // 크기 따라가기
  const resize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const onLost = (e: Event) => {
    e.preventDefault();
    logError('RENDER_CONTEXT_LOST', 'webglcontextlost', new Error('WebGL context lost'));
    cb.onError({ code: 'RENDER_CONTEXT_LOST', message: '그래픽 장치 연결이 끊겼습니다. 새로고침해 주세요.' });
  };
  el.addEventListener('webglcontextlost', onLost);

  // ---- 상태 알림 ----
  let canUndo = false, lastStats = '', statT = 0;
  const emitUndo = () => { const c = world.canUndo(); if (c !== canUndo) { canUndo = c; cb.onCanUndo(c); } };
  const emitStats = () => {
    const s: GameStats = { score: world.score, rank: world.rank(), destroyed: world.destroyed, total: world.blocks.n, buildingsDown: world.buildingsDown, buildingsTotal, nearbyDown: world.nearbyDown, civilDown: world.civilDown, combo: world.combo, comboMul: world.comboMul };
    const k = JSON.stringify(s);
    if (k !== lastStats) { lastStats = k; cb.onStats(s); sound.stats(s.rank, s.score); }
  };

  // ---- 연출 도우미 ----
  const col = new THREE.Color(), grey = new THREE.Color('#8a8780'), glassTint = new THREE.Color('#d8eef7'), dirt = new THREE.Color('#7a6a55'), soot = new THREE.Color('#1e1c1a');
  let shake = 0;
  // 화면 확대 펀치(도, 음수 = 확대): 시야각에 더한다. 감쇠 스프링(ζ≈0.58)이라 0을 살짝 넘어 튕겼다가 약 0.7초에 멈춘다(쫀쫀한 반동)
  const fov0 = camera.fov;
  let kick = 0, kickV = 0;
  // 펀치를 더한다. 연달아 쌓여도 ±8도를 넘지 않는다. 동작 줄이기면 걸지 않는다
  const punch = (deg: number) => { if (!calm) kick = THREE.MathUtils.clamp(kick + deg, -8, 8); };
  // 신의 지팡이의 늦게 오는 충격파("딱-딱" 소리와 같은 실제 시각 ms): 그 순간 흔들림·펀치. 되돌리기·전부 복구 때 지운다
  const knocks: { at: number; act: number }[] = [];
  const quakes: { x: number; z: number; age: number }[] = [];   // 벙커버스터 지진 흙먼지 띠
  // 신의 지팡이 돔이 부푸는 동안 돔 안(땅 중심 구)을 모두 지운다. done = 이미 지운 반경
  const vapors: { x: number; y: number; z: number; act: number; age: number; done: number }[] = [];
  // 기울며 넘어가는 덩어리들. 한 프레임에 떼어 낼 블록 상한 TIP_LIM (넘으면 다음 프레임으로 미룬다)
  const tips: Tip[] = [], TIP_LIM = touch ? 120 : 300;
  const mtx = new THREE.Matrix4(), hid = new THREE.Matrix4().makeScale(0, 0, 0), tv = new THREE.Vector3(), te = new THREE.Euler();
  // 히트 스톱: 큰 폭발 직후 몇 프레임 화면을 멈춰 "뻥" 하는 타격감을 준다 (남은 초)
  // 연달아 터질 때 화면이 뚝뚝 끊기지 않게 한 번 멈춘 뒤 0.4초(실제 시간)는 다시 멈추지 않는다
  let stop = 0, stopCool = 0;
  // 큰 순간(열압력 점화·지팡이 착탄)의 확실한 화면 정지: stopCool을 무시하고 건다. 동작 줄이기면 걸지 않는다
  const freeze = (s: number) => { if (!calm) { stop = Math.max(stop, s); stopCool = 0.4; } };
  // 슬로모션: 정지가 풀린 뒤 hold초(실제 시간) 동안 시간을 k배로 늦추고, ease초에 걸쳐 1배로 되돌린다. 동작 줄이기면 걸지 않는다
  let slowK = 1, slowHold = 0, slowEase = 1, slowLeft = 0;
  const slowmo = (k: number, hold: number, ease: number) => { if (!calm) { slowK = k; slowHold = hold; slowEase = ease; slowLeft = ease; } };
  // 블록 i의 기본색
  const baseColor = (i: number) => col.fromArray(blocks.base, i * 3);
  // 물리 큐브로 날릴 블록인지: 바깥 옆면이 있거나 꼭대기 층이면 항상, 안쪽 블록은 2개 중 1개만 (나머지는 조용히 사라진다)
  const showy = (i: number) => world.blocks.outer[i] !== 0 || world.blocks.cl[i] === world.buildings[world.blocks.bld[i]].nl - 1 || Math.random() < 0.5;
  // 먼지·연기 한 덩이
  const puff = (p: THREE.Vector3 | number[], s0: number, s1: number, life: number, a0: number, c: THREE.Color, rise = 0.6) => {
    const a = Array.isArray(p) ? p : [p.x, p.y, p.z];
    smoke.emit(a, [(Math.random() - 0.5) * s0, Math.random() * s0 * 0.5, (Math.random() - 0.5) * s0], life * (0.8 + Math.random() * 0.4), s0, s1, a0, c, rise);
  };
  // 맞은 사람·차가 조각으로 흩어지는 연출 (R77). 사람은 옷 색 조각 3개+먼지, 차는 차 색 조각·검은 연기·불꽃·불티. lim개까지만
  const smash = (dead: Dead[], act: number, lim = 1e9) => {
    const r = Math.random;
    for (let k = 0; k < dead.length && k < lim; k++) {
      const e = dead[k], p = [e.x, e.y, e.z];
      if (!e.car) {
        for (let n = 0; n < 3; n++) { const s = 0.2 + r() * 0.1; shards.spawn(p, [(r() - 0.5) * 5, 2 + r() * 3, (r() - 0.5) * 5], 12, [s, s, s], e.color, act); }
        puff(p, 0.6, 2, 0.8, 0.4, dirt, 0.3);
        continue;
      }
      for (let n = 0, m = 6 + Math.floor(r() * 3); n < m; n++) { const s = 0.4 + r() * 0.4; shards.spawn(p, [(r() - 0.5) * 8, 3 + r() * 5, (r() - 0.5) * 8], 10, [s, s * 0.6, s], e.color, act); }
      for (let n = 0; n < 2; n++) puff(p, 1.5, 5, 2.5, 0.6, soot, 0.8);
      for (let n = 0; n < 4; n++) fire.emit(p, [(r() - 0.5) * 3, 1 + r() * 3, (r() - 0.5) * 3], 0.4 + r() * 0.3, 0.8, 1.8, 0.9, col.setHSL(0.07 + r() * 0.04, 1, 0.55));
      for (let n = 0; n < 6; n++) sparks.emit(p, [(r() - 0.5) * 16, r() * 12, (r() - 0.5) * 16], 0.2 + r() * 0.2);
    }
  };

  // 월드가 쌓아 둔 부서진/떨어지는 블록을 화면에 반영한다
  // glass: 충격파 겉면처럼 유리창이 깨지는 장면이면 true. 통째 블록 없이 납작한 유리 조각만 뿌린다
  const drain = (act: number, c: THREE.Vector3, R: number, glass = false) => {
    const B = world.blocks;
    // whole = 통째로 솟구치는 블록 예산, 넘으면 작은 파편
    let budget = touch ? 200 : 400, whole = touch ? 200 : 600;
    // 먼지 puff는 한 번에 330개 안쪽으로 (중성자탄은 수만 블록이 한꺼번에 들어온다)
    const every = Math.max(6, Math.ceil(world.killed.length / 300));
    world.killed.forEach((i, n) => {
      blocks.write(i);
      const p = [B.x[i], B.y[i], B.z[i]];
      if (n < 30 || n % every === 0) puff(p, g * (glass ? 0.4 : 0.8), g * (glass ? 1.25 : 2.5), 2.2, 0.45, baseColor(i).lerp(grey, 0.6), 0.4);
      if (glass) {
        // 유리 조각 1~2개: 폭발 반대쪽으로 얇은 판이 날아간다
        const gc = baseColor(i).clone().lerp(glassTint, 0.8);
        for (let k = 0, m = 1 + (Math.random() < 0.5 ? 1 : 0); k < m; k++) {
          const dir = new THREE.Vector3(p[0] - c.x, 0, p[2] - c.z);
          if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          dir.normalize().multiplyScalar(6 + Math.random() * 6);
          const s = g * (0.05 + Math.random() * 0.05);
          shards.spawn([p[0] + (Math.random() - 0.5) * g, p[1], p[2] + (Math.random() - 0.5) * g], [dir.x, 2 + Math.random() * 3, dir.z], 20, [s, s * 0.3, s], gc, act);
        }
        // 4개 중 1개는 유리 반짝임 불티
        if (Math.random() < 0.25) sparks.emit(p, [(Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6], 0.2 + Math.random() * 0.15);
        return;
      }
      // 폭발로 부서진 블록은 통째로 들썩 솟았다가 꼭대기 근처에서 쪼개진다(burst). 중심에 가까울수록 높이
      if (R > 0 && whole > 0 && showy(i)) {
        const near = 1 - Math.min(1, Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z) / R);
        const vy = (4 + Math.random() * (4 + R * 0.5)) * (1 + 0.6 * near) * 1.4;
        // 쪼개지는 때를 블록마다 흩는다: 20%는 안 쪼개지고 통째로 떨어지며, 나머지는 오르는 중~내려오는 중 아무 때나
        const ttl = Math.random() < 0.2 ? 0 : THREE.MathUtils.clamp((vy / 9.8) * (0.35 + Math.random() * 1.15), 0.12, 0.5 + Math.random() * 1.1);
        const dir = new THREE.Vector3(p[0] - c.x, 0, p[2] - c.z);
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize().multiplyScalar((3 + Math.random() * 5) * (0.5 + R / 18) * 1.1);
        if (falls.spawn(p, [dir.x, vy, dir.z], 3, [1, B.hgt[i], 1], baseColor(i), act, [0, 0, 0], ttl, B.bld[i])) { whole--; return; }
      }
      const shardColor = baseColor(i).lerp(grey, 0.35);
      const cnt = Math.min(budget, 1 + (Math.random() < 0.5 ? 1 : 0));
      budget -= cnt;
      for (let k = 0; k < cnt; k++) {
        const dir = new THREE.Vector3(p[0] - c.x, 0, p[2] - c.z);
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize().multiplyScalar((R > 0 ? (3 + Math.random() * 5) * (0.5 + R / 18) : 2 + Math.random() * 3) * 2.2);
        const s = g * (0.1 + Math.random() * 0.15);
        shards.spawn([p[0] + (Math.random() - 0.5) * g, p[1], p[2] + (Math.random() - 0.5) * g], [dir.x, (3 + Math.random() * (R > 0 ? 3 + R * 0.4 : 3)) * 1.4, dir.z], 16, [s, s * 0.7, s], shardColor, act);
      }
    });
    world.fallen.forEach((i) => {
      blocks.write(i);
      if (!showy(i)) return;
      // 받침을 잃은 블록은 튀지 않고 제자리에서 내려앉는다 (위 속도 0, 수평은 ±0.3m/s 흔들림만)
      const v = [(Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6];
      const ok = falls.spawn([B.x[i], B.y[i], B.z[i]], v, 0.5, [1, B.hgt[i], 1], baseColor(i), act, undefined, 0, B.bld[i]);
      if (!ok) landBlock(B.x[i], B.z[i], B.hgt[i], baseColor(i), act);
    });
    // 기울 덩어리: 축 위치의 그룹 안에 블록을 인스턴스로 옮겨 담고 원래 블록은 숨긴다
    world.topples.forEach((tp) => {
      const grp = new THREE.Group(), n = tp.blocks.length;
      grp.position.set(tp.px, tp.py, tp.pz);
      const mesh = new THREE.InstancedMesh(falls.mesh.geometry, toppleMat, n);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      let top = 0;
      tp.blocks.forEach((i, j) => {
        blocks.write(i);
        mesh.setMatrixAt(j, mtx.makeScale(1, B.hgt[i], 1).setPosition(B.x[i] - tp.px, B.y[i] - tp.py, B.z[i] - tp.pz));
        mesh.setColorAt(j, baseColor(i));
        top = Math.max(top, B.y[i] + B.hgt[i] / 2);
      });
      grp.add(mesh);
      scene.add(grp);
      tips.push({ act: tp.act, grp, mesh, ids: tp.blocks, left: tp.blocks.map((_, j) => j), ax: new THREE.Vector3(tp.dz, 0, -tp.dx), th: 0, om: 0, H: Math.max(6, top - tp.py), p0: grp.position.clone() });
      // 주저앉기 시작하는 낮은 굉음과 밑둥 둘레 흙먼지
      sound.boom(1.6, 70, 0.9);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 6.28, x = tp.px + Math.cos(a) * g * 2, z = tp.pz + Math.sin(a) * g * 2;
        puff([x, debris.groundAt(x, z) + 1, z], g * 1.5, g * 5, 3.5, 0.5, col.copy(dirt).lerp(grey, 0.5), 0.5);
      }
    });
    world.killed.length = world.fallen.length = world.topples.length = 0;
  };

  // 떨어진 블록이 땅에 닿아 잔해 무더기가 된다
  // 조각 예산: 초당 CHIPS개씩 다시 찬다. 한 동이 통째 무너져도 프레임과 잔해 버퍼가 버티게 한다
  let landCount = 0;
  const CHIPS = touch ? 900 : 2400, chip = new THREE.Color();
  let chips = CHIPS;
  const landBlock = (x: number, z: number, hgt: number, c: THREE.Color, act: number) => {
    const dc = c.clone().lerp(grey, 0.45);
    // 예산이 있으면 8~14개로 잘게, 모자라면 조금 굵은 2개로
    const fine = chips >= 14, cnt = fine ? 8 + Math.floor(Math.random() * 7) : 2, big = fine ? 1 : 1.6;
    chips -= cnt;
    for (let k = 0; k < cnt; k++) {
      const s = g * (0.12 + Math.random() * 0.18) * big, sy = Math.min(hgt, s * (0.5 + Math.random() * 0.5));
      const px = x + (Math.random() - 0.5) * g * 0.9, pz = z + (Math.random() - 0.5) * g * 0.9;
      chip.copy(dc).multiplyScalar(0.85 + Math.random() * 0.3);
      // 앞의 1개만 낮게 튀어 흩어지고 (파편이 꽉 차면 바로 놓음) 나머지는 그 자리에 놓인다
      if (k < 1 && shards.spawn([px, debris.groundAt(px, pz) + s, pz], [(Math.random() - 0.5) * 4, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 4], 8, [s, sy, s], chip, act)) continue;
      debris.add(px, debris.groundAt(px, pz) + sy * 0.4, pz, s, sy, s * (0.7 + Math.random() * 0.6), chip, act);
    }
    if (landCount++ % 3 === 0) puff([x, debris.groundAt(x, z) + 1, z], g * 1.2, g * 6, 5, 0.45, dc.lerp(grey, 0.5), 0.5);
    if (landCount % 8 === 0) sound.boom(0.5, 260, 0.3);
  };

  // 통째로 솟은 블록이 공중에서 쪼개진다: 그 자리에서 조각을 사방으로 뿌리고 먼지 한 덩이
  const burst = (k: number) => {
    const f = falls.get(k), dc = f.color.clone().lerp(grey, 0.35);
    // 조각 예산이 모자라면 1~2개만
    const cnt = chips >= 10 ? 3 + (Math.random() < 0.5 ? 1 : 0) : 1 + (Math.random() < 0.5 ? 1 : 0);
    chips -= cnt;
    for (let n = 0; n < cnt; n++) {
      const s = g * (0.15 + Math.random() * 0.2);
      tv.randomDirection().multiplyScalar(4 + Math.random() * 3);
      chip.copy(dc).multiplyScalar(0.85 + Math.random() * 0.3);
      shards.spawn([f.x + (Math.random() - 0.5) * g, f.y + (Math.random() - 0.5) * f.sy, f.z + (Math.random() - 0.5) * g], [f.vx + tv.x, f.vy + tv.y, f.vz + tv.z], 16, [s, s * 0.7, s], chip, f.act);
    }
    puff([f.x, f.y, f.z], g * 1.2, g * 3.5, 2.2, 0.45, dc.lerp(grey, 0.4), 0.4);
  };

  // ---- 날아가는 블록·파편과 건물의 부딪힘 ----
  // hits = 이번 프레임 피해 [act, 블록, 피해] 묶음 (재사용). fdt = 이번 프레임 dt (부딪힘 콜백용)
  const hits: number[] = [], hitP = new THREE.Vector3();
  let fdt = 0, hitCount = 0;

  // 축 위치 (px, pz)에서 수평 반경 r 안에 bbox가 걸친 건물 번호 (자기 건물 self 제외)
  const nearOf = (self: number, px: number, pz: number, r: number) => {
    const out: number[] = [];
    world.buildings.forEach((b, k) => {
      if (k !== self && Math.hypot(Math.max(b.min[0] - px, 0, px - b.max[0]), Math.max(b.min[2] - pz, 0, pz - b.max[2])) < r) out.push(k);
    });
    return out;
  };

  // 직전 위치 (px, py, pz)가 블록 b 상자 밖으로 가장 멀리 벗어난 축 (0 x, 1 y, 2 z). 직전에도 상자 안이면 -1
  const wallAxis = (b: number, px: number, py: number, pz: number) => {
    const B = world.blocks;
    const ox = Math.abs(px - B.x[b]) - g / 2, oy = Math.abs(py - B.y[b]) - B.hgt[b] / 2, oz = Math.abs(pz - B.z[b]) - g / 2;
    if (ox <= 0 && oy <= 0 && oz <= 0) return -1;
    return ox >= oy && ox >= oz ? 0 : oy >= oz ? 1 : 2;
  };

  // 작은 파편이 건물에 닿으면 튕긴다. 벽 속에서 생겼거나 지붕 위에 느리게 내려앉으면 지운다(true)
  const shardHit = (k: number) => {
    const f = shards.get(k), b = world.blockAt(f.x, f.y, f.z);
    if (b < 0) return false;
    const axis = wallAxis(b, f.x - f.vx * fdt, f.y - f.vy * fdt, f.z - f.vz * fdt);
    if (axis < 0 || (axis === 1 && f.vy < 0 && f.vy > -2)) return true;
    shards.bounce(k, axis, fdt);
    return false;
  };

  // 큰 블록이 건물에 닿으면: 다른 건물에 빠르게 부딪히면 피해를 주고 쪼개진다. 아니면 튕기거나 그 자리에서 쪼개진다
  const fallHit = (k: number) => {
    const f = falls.get(k), b = world.blockAt(f.x, f.y, f.z);
    if (b < 0) return false;
    const sp = Math.hypot(f.vx, f.vy, f.vz), other = world.blocks.bld[b] !== f.tag;
    const axis = wallAxis(b, f.x - f.vx * fdt, f.y - f.vy * fdt, f.z - f.vz * fdt);
    // 외곽선이 겹친 옆 건물 안에서 출발한 블록은 그냥 지나간다 (생기자마자 옆 건물을 부수는 연쇄를 막는다)
    if (other && axis < 0) return false;
    if (other && sp > 4) {
      hits.push(f.act, b, BLOCK_HP * THREE.MathUtils.clamp(sp / 8, 0.6, 2));
      burst(k);
      return true;
    }
    if (axis < 0 || (axis === 1 && f.vy < 0 && f.vy > -2)) { burst(k); return true; }
    falls.bounce(k, axis, fdt);
    return false;
  };

  // 이번 프레임에 쌓인 부딪힘 피해를 한 번에 준다 (hitBlock마다 건물 BFS가 돌아 프레임당 상한을 둔다)
  const applyHits = () => {
    if (!hits.length) return;
    const B = world.blocks, max = Math.min(hits.length, (touch ? 15 : 30) * 3);
    let act = 0;
    for (let n = 0; n < max; n += 3) {
      const b = hits[n + 1];
      act = hits[n];
      world.hitBlock(act, b, hits[n + 2]);
      hitP.set(B.x[b], B.y[b], B.z[b]);
      puff(hitP, g * 1.2, g * 3.5, 2.2, 0.45, baseColor(b).lerp(grey, 0.5), 0.4);
      if (hitCount++ % 4 === 0) sound.boom(0.5, 200, 0.3);
    }
    hits.length = 0;
    // 부서진 블록·지지 잃은 블록·새로 기우는 건물을 화면에 낸다 (연쇄 붕괴도 이 길로 생긴다)
    drain(act, hitP, 0);
  };

  // 받침 잃은 덩어리 한 프레임: 통째로 기울며 넘어가지 않고 제자리에서 아래로 주저앉는다(철거 발파처럼).
  // 약한 쪽으로 조금(LEAN)만 기울며 가라앉고, 땅 밑으로 들어간 블록은 그 자리 잔해가 된다. 남은 떼어 내기 예산을 돌려준다
  const stepTip = (tp: Tip, dt: number, lim: number) => {
    const LEAN = 0.1, SINK_G = 0.55 * 9.8, SINK_MAX = 14;
    tp.th = Math.min(LEAN, tp.th + 0.06 * dt);
    tp.om = Math.min(SINK_MAX, tp.om + SINK_G * dt);   // om = 가라앉는 속도(m/s)
    const P = tp.grp.position, B = world.blocks, p0 = tp.p0;
    P.y -= tp.om * dt;
    const q = tp.grp.quaternion.setFromAxisAngle(tp.ax, tp.th);
    const near = tp.near ??= nearOf(B.bld[tp.ids[0]], P.x, P.z, tp.H + g * 2);
    te.setFromQuaternion(q);
    // 위쪽 블록도 가끔 떨어져 나와 부서지며 쏟아진다 (초당 약 12%)
    const peel = dt * 0.12;
    let changed = false;
    for (let k = tp.left.length - 1; k >= 0 && lim > 0; k--) {
      const j = tp.left[k], i = tp.ids[j];
      tv.set(B.x[i] - p0.x, B.y[i] - p0.y, B.z[i] - p0.z).applyQuaternion(q);
      const x = P.x + tv.x, y = P.y + tv.y, z = P.z + tv.z;
      const sunk = y + B.hgt[i] / 2 < debris.groundAt(x, z) + g * 0.5;
      // 옆 건물 블록을 파고들면 피해를 주고 뗀다. 아니면 땅에 묻혔거나 무작위로 조금씩만 뗀다
      const hb = near.length && tp.th > 0.05 ? world.blockAt(x, y, z, near) : -1;
      if (hb >= 0) hits.push(tp.act, hb, BLOCK_HP * 2);
      else if (!sunk && Math.random() >= peel) continue;
      tp.left[k] = tp.left[tp.left.length - 1];
      tp.left.pop();
      tp.mesh.setMatrixAt(j, hid);
      changed = true;
      lim--;
      if (!showy(i)) continue;
      const c = baseColor(i);
      // 묻힌 블록은 그 자리 잔해 더미로, 떨어져 나온 블록은 같이 가라앉는 속도로 떨어지며 부서진다
      if (sunk) { landBlock(x, z, B.hgt[i], c, tp.act); if (Math.random() < 0.06) puff([x, y + g, z], g * 1.5, g * 5, 3, 0.4, c.clone().lerp(grey, 0.6), 0.5); }
      else if (!falls.spawn([x, y, z], [(Math.random() - 0.5) * 1.2, -tp.om, (Math.random() - 0.5) * 1.2], 1, [1, B.hgt[i], 1], c, tp.act, [te.x, te.y, te.z], 0.3 + Math.random() * 0.5, B.bld[i])) landBlock(x, z, B.hgt[i], c, tp.act);
    }
    if (changed) tp.mesh.instanceMatrix.needsUpdate = true;
    // 주저앉는 동안 남은 블록 밑동에서 먼지구름이 바깥으로 굴러 나와 피어오른다(철거 발파 먼지). 초당 약 10덩이(휴대폰 5)
    if (tp.left.length && Math.random() < dt * (touch ? 5 : 10)) {
      const i = tp.ids[tp.left[(Math.random() * tp.left.length) | 0]], x = B.x[i], z = B.z[i], a = Math.random() * 6.28, v = 2 + Math.random() * 3;
      smoke.emit([x, debris.groundAt(x, z) + g, z], [Math.cos(a) * v, 1 + Math.random() * 2, Math.sin(a) * v], 5 + Math.random() * 2, g * 3, g * 9, 0.55, col.copy(dirt).lerp(grey, 0.6), 0.4);
    }
    return lim;
  };

  // 기울 덩어리 제거: 지오메트리·재질은 falls와 공유라 인스턴스 버퍼만 버린다
  const removeTip = (tp: Tip) => { scene.remove(tp.grp); tp.mesh.dispose(); };

  // ---- 조준 ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // 화면 좌표가 가리키는 블록 또는 땅
  const pick = (cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    ray.setFromCamera(ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const h = world.raycast([o.x, o.y, o.z], [d.x, d.y, d.z]);
    return h && { p: o.clone().addScaledVector(d, h.t), block: h.block };
  };

  // ---- 무기 ----
  let weapon: WeaponId = 'rifle';
  const shots: Shot[] = [];
  const blasts: Blast[] = [];
  const ringGeo = new THREE.RingGeometry(0.9, 1, 96).rotateX(-Math.PI / 2);
  const shellGeo = new THREE.CapsuleGeometry(0.35, 1.3, 4, 8).rotateX(Math.PI / 2);
  const shellMat = new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.5, metalness: 0.4 });
  const rodMat = new THREE.MeshBasicMaterial({ color: '#fff3dd' });   // 신의 지팡이: 하얗게 달아오른 텅스텐 막대
  const shadowGeo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
  // 중성자탄 조준 표식용 공유 자원: 지면 원판, 600m 빔, 레이저 점 텍스처
  const warnGeo = new THREE.CircleGeometry(1, 128).rotateX(-Math.PI / 2);
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 600, 0)]);
  const dotTex = puffTexture();
  // 지면 표식 셰이더: 테두리, 옅은 채움, 거리 점선, 사방 눈금, 줄어드는 카운트다운 원
  const WARN_VS = 'varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const WARN_FS = `
    uniform float uP, uPulse, uFade;
    varying vec2 vP;
    // 반경 c에 화면 w픽셀 두께의 선(fwidth로 확대해도 굵기 유지)
    float line(float d, float w, float aw) { return 1.0 - smoothstep((w * 0.5 - 0.5) * aw, (w * 0.5 + 0.5) * aw, abs(d)); }
    void main() {
      float r = length(vP), aw = fwidth(r), ang = atan(vP.y, vP.x);
      float fill = mix(0.03, 0.14, r * r);
      float edge = line(r - (1.0 - aw), 1.5, aw) * uPulse;
      float dash = step(0.5, fract(ang * 7.6394)) * 0.22;
      float marks = max(line(r - 0.33, 1.0, aw), line(r - 0.66, 1.0, aw)) * dash;
      float tick = step(0.9, r) * line(abs(mod(ang + 0.7854, 1.5708) - 0.7854) * r, 1.5, aw) * 0.8;
      float cd = line(r - (1.0 - uP), 1.5, aw) * 0.95;
      float a = max(max(fill, edge), max(max(marks, tick), cd));
      gl_FragColor = vec4(mix(vec3(1.0, 0.2, 0.15), vec3(1.0, 0.62, 0.55), cd), a * uFade);
    }`;

  // 소총 한 발 (맞은 블록 하나)
  const fireAuto = (act: number, cx: number, cy: number) => {
    const hit = pick(cx, cy);
    if (!hit) return;
    const P = WEAPON_PARAMS[weapon];
    if (weapon === 'rifle') {
      // 총구 위치: 화면 오른쪽 아래 모서리 바로 밖, 카메라와 맞은 곳 사이 깊이
      const z = camera.position.clone().lerp(hit.p, 0.5).project(camera).z;
      tracers.add(new THREE.Vector3(1.15, -1.15, z).unproject(camera), hit.p);
      fire.emit([hit.p.x, hit.p.y, hit.p.z], [0, 0, 0], 0.12, 0.4, 1.4, 1, col.set('#ffe2a0'));
      for (let k = 0; k < 6; k++) sparks.emit([hit.p.x, hit.p.y, hit.p.z], [(Math.random() - 0.5) * 30, Math.random() * 18, (Math.random() - 0.5) * 30], 0.15 + Math.random() * 0.15);
    }
    if (hit.block >= 0) {
      world.hitBlock(act, hit.block, P.D, P.pts);
      puff(hit.p, 0.8, 3, 0.9, 0.5, baseColor(hit.block).lerp(grey, 0.5), 0.3);
      blocks.write(hit.block);
      drain(act, hit.p, 0);
    } else {
      puff(hit.p, 0.8, 3, 0.9, 0.5, dirt, 0.3);
    }
    smash(crowd.blast(hit.p.x, hit.p.z, 0), act);   // 총소리에 도망, 맞은 사람·차는 파괴 (R76·R77)
    shake = Math.max(shake, P.shake);
    sound.hit(weapon);
  };

  // 연사 무기 한 발: 소총은 즉시 맞히고 나머지(유탄·박격포·포탄·항공폭탄)는 날려 보낸다
  const shoot = (act: number, cx: number, cy: number) => (weapon === 'rifle' ? fireAuto(act, cx, cy) : launch(cx, cy));

  // 날아가는 무기 발사: 탄을 띄우고 delay 뒤 폭발
  const launch = (cx: number, cy: number) => {
    const hit = pick(cx, cy);
    if (!hit) return;
    const act = world.begin();
    emitUndo();
    // 블록을 맞혔으면 조준 방향으로 반 칸 더 밀어 넣어 벽 속에서 터지게 한다
    if (hit.block >= 0) hit.p.addScaledVector(ray.ray.direction, g * 0.5);
    // 중성자탄은 어차피 일대를 다 부수니 지붕·벽을 맞혀도 그 아래 지면에서 터뜨린다(불덩이·버섯구름이 땅에서 솟게)
    if (weapon === 'nuke') hit.p.y = heightAt(t, hit.p.x, hit.p.z);
    // 벙커버스터·신의 지팡이가 땅을 맞히면 땅속 1m에서 터져 깊은 크레이터를 판다
    if ((weapon === 'bunker' || weapon === 'rod') && hit.block < 0) hit.p.y = heightAt(t, hit.p.x, hit.p.z) - 1;
    const target = hit.p, from = target.clone(), back = camera.position.clone().sub(target).setY(0).normalize();
    const side = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    // 하늘 무기의 출발점(k = 높이 배율). 포탄·다연장: 카메라 쪽 뒤 오른편 높은 곳, 항공폭탄: 카메라 쪽 130m·위 250m(약 62°), 박격포·중성자탄: 바로 위
    const at = (k: number) => {
      const p = target.clone();
      if (weapon === 'artillery') p.addScaledVector(back, 420 * k).addScaledVector(side, 120 * k).y += 160 * k;
      // 다연장: 화면 오른쪽 옆에서 가로질러 날아와야 연기 꼬리 여러 줄이 하늘에 길게 보인다(카메라 뒤에서 오면 꼬리가 겹쳐 짧게 보임)
      else if (weapon === 'mlrs') p.addScaledVector(side, 450 * k).addScaledVector(back, 120 * k).y += 200 * k;
      else if (weapon === 'bomb' || weapon === 'cluster') p.addScaledVector(back, 130 * k).y += 250 * k;
      // 벙커버스터: 카메라 쪽 25m·위 450m에서 거의 수직(약 87°)으로 내리꽂힌다
      else if (weapon === 'bunker') p.addScaledVector(back, 25 * k).y += 450 * k;
      // 열압력 로켓: 카메라 쪽 뒤 350m·위 70m에서 낮고 빠르게(직사에 가깝게) 날아온다
      else if (weapon === 'thermo') p.addScaledVector(back, 350 * k).addScaledVector(side, 40 * k).y += 70 * k;
      // 신의 지팡이: 궤도에서 거의 수직으로(카메라 쪽 60m·위 1,500m) 내리꽂힌다
      else if (weapon === 'rod') p.addScaledVector(back, 60 * k).y += 1500 * k;
      // 높이는 flyShot의 박격포(120)·중성자탄(600) 낙하 높이와 같아야 출발점이 정말 화면 밖이 된다
      else p.y += (weapon === 'nuke' ? 600 : 120) * k;
      return p;
    };
    // 유탄발사기: 카메라 쪽 60m 뒤 어깨 높이에서 쏜다. 화면 안이면 더 물러난다
    const low = (k: number) => {
      const p = target.clone().addScaledVector(back, 60 * k);
      p.y = heightAt(t, p.x, p.z) + 1.5;
      return p;
    };
    const k = outK(weapon === 'grenade' ? low : at);
    if (weapon === 'grenade') from.copy(low(k));
    else if (weapon !== 'mortar' && weapon !== 'nuke') from.copy(at(k));
    if (weapon === 'mlrs') { salvo(act, target, from, k, ray.ray.direction.clone()); return; }
    const mesh = new THREE.Mesh(shellGeo, weapon === 'rod' ? rodMat : shellMat);
    mesh.scale.setScalar(weapon === 'nuke' ? 2.4 * 1.8 : weapon === 'bomb' || weapon === 'cluster' ? 2.4 : weapon === 'bunker' ? 2 : weapon === 'grenade' ? 0.8 : 1.2);
    // 열압력 로켓은 굵고 길게, 신의 지팡이는 가늘고 길게(6m×0.3m를 보이게 키워 12m×0.6m)
    if (weapon === 'thermo') mesh.scale.set(2, 2, 3.5);
    if (weapon === 'rod') mesh.scale.set(0.9, 0.9, 6);
    mesh.visible = false;
    scene.add(mesh);
    const shot: Shot = { w: weapon, act, target, from, age: 0, mesh, k };
    if (weapon === 'cluster') shot.aim = ray.ray.direction.clone();   // 자탄은 쏜 순간의 조준 방향으로 흩뿌린다(열릴 때 카메라가 움직였어도)
    if ((weapon === 'bunker' || weapon === 'thermo' || weapon === 'rod') && hit.block >= 0) shot.bld = world.blocks.bld[hit.block];
    if (weapon === 'bomb' || weapon === 'nuke' || weapon === 'bunker' || weapon === 'cluster') {
      shot.shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0, depthWrite: false }));
      shot.shadow.position.copy(target).y += 0.3;
      scene.add(shot.shadow);
    }
    if (weapon === 'rod') {
      // 위성 조준 표식: 하늘(1,500m)에서 목표까지 내려오는 가는 하늘색 수직선 + 지면의 작은 원. 경고 문구·사이렌 없이 조용하게
      // 흰색은 밝은 바닥·건물에 묻혀 안 보여 하늘색으로, 건물에 가려지지 않게 깊이 검사 없이 그린다
      const wg = new THREE.Group();
      wg.position.copy(target);
      const line = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: '#4cc3ff', transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      line.scale.y = 1500 / 600;
      const mark = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#4cc3ff', transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      mark.position.y = 0.5;
      mark.scale.setScalar(6);
      mark.renderOrder = 3;
      wg.add(line, mark);
      shot.warn = wg;
      scene.add(wg);
    }
    if (weapon === 'nuke') {
      // 조준 표식 묶음: 지면 원판(반경 R) + 레이저 점 + 하늘로 뻗는 빔. 건물에 가려지지 않게 깊이 검사 없이 그린다
      const g = new THREE.Group();
      g.position.copy(target);
      const disc = new THREE.Mesh(warnGeo, new THREE.ShaderMaterial({
        vertexShader: WARN_VS, fragmentShader: WARN_FS, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uP: { value: 0 }, uPulse: { value: 0.85 }, uFade: { value: 0 } },
      }));
      disc.position.y = 0.5;
      disc.scale.setScalar(WEAPON_PARAMS.nuke.R);
      disc.renderOrder = 3;
      // 레이저 점: sizeAttenuation 끔이라 거리와 상관없이 화면에서 같은 크기
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: '#ff3326', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, sizeAttenuation: false }));
      dot.position.y = 0.6;
      dot.scale.setScalar(0.03);
      dot.renderOrder = 4;
      const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: '#ff3326', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(disc, dot, beam);
      shot.warn = g;
      scene.add(g);
      // "NUCLEAR LAUNCH DETECTED": 0.35초 간격 계단식 세 번 깜빡임 → 켜진 채 → 착탄 때 180ms에 사라짐
      const D = WEAPON_PARAMS.nuke.delay! * 1000, end = (D - 180) / D;
      const step = (ms: number, opacity: number) => ({ offset: ms / D, opacity, easing: 'step-end' });
      nukeAnim?.cancel();
      nukeEl.textContent = 'NUCLEAR LAUNCH DETECTED';
      nukeAnim = nukeEl.animate(calm
        ? [{ offset: 0, opacity: 1 }, { offset: end, opacity: 1, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }, { offset: 1, opacity: 0 }]
        : [step(0, 1), step(350, 0), step(700, 1), step(1050, 0), step(1400, 1), step(1750, 0), { offset: 2100 / D, opacity: 1 }, { offset: end, opacity: 1, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }, { offset: 1, opacity: 0 }],
      { duration: D });
    }
    sound.launch(weapon);
    shots.push(shot);
  };

  // (x, z)에 위(top)에서 아래로 쏴 맞은 지붕 또는 땅 자리. 블록이면 반 칸 밀어 넣는다 (집속탄 자탄·다연장 로켓 탄착점)
  const dropAt = (x: number, z: number, top: number) => {
    const h = world.raycast([x, top, z], [0, -1, 0]);
    return new THREE.Vector3(x, h ? top - h.t - (h.block >= 0 ? g * 0.5 : 0) : heightAt(t, x, z), z);
  };

  // 조준 방향 d에 수직인 판에서 c를 (a, b)m 옮긴 자리로 d를 따라 쏴 맞은 곳(블록이면 반 칸 밀어 넣는다).
  // 위에서 수직으로 떨어뜨리면 지붕과 앞 땅에만 맞아 화면에 보이는 벽 가운데가 비므로, 보이는 벽·지붕·땅에 고르게 맞힌다.
  // 판을 지나 40m 안에서 안 맞으면(건물 너머 허공) 멀리 뒤 땅까지 가지 않게 그 자리에서 아래로 떨어뜨린다
  const aimAt = (c: THREE.Vector3, d: THREE.Vector3, a: number, b: number) => {
    const r = new THREE.Vector3(-d.z, 0, d.x);
    if (r.lengthSq() < 1e-6) r.set(1, 0, 0); else r.normalize();   // 수직으로 내려다볼 때는 아무 가로축
    const p = c.clone().addScaledVector(r, a).addScaledVector(new THREE.Vector3().crossVectors(r, d).normalize(), b);
    const o = p.clone().addScaledVector(d, -300), h = world.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 340);
    return h ? o.addScaledVector(d, h.t + (h.block >= 0 ? g * 0.5 : 0)) : dropAt(p.x, p.z, p.y);
  };

  // 다연장 로켓 일제 사격: MLRS_N발을 MLRS_GAP초 간격으로 차례로 쏜다(age를 음수로 시작해 차례가 오면 출발).
  // 무유도라 조준점 둘레 화면 기준 타원(가로 36m × 세로 24m)에 흩어진다. 모두 같은 act라 되돌리기 한 번에 돌아온다
  const salvo = (act: number, target: THREE.Vector3, from: THREE.Vector3, k: number, aim: THREE.Vector3) => {
    const f = target.clone().sub(from).setY(0).normalize(), sd = new THREE.Vector3(-f.z, 0, f.x);
    for (let n = 0; n < MLRS_N; n++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random());
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.scale.set(0.8, 0.8, 2.5);   // 가늘고 긴 로켓
      mesh.visible = false;
      scene.add(mesh);
      shots.push({ w: 'mlrs', act, target: aimAt(target, aim, Math.cos(a) * 18 * r, Math.sin(a) * 12 * r), from: from.clone().addScaledVector(sd, (Math.random() - 0.5) * 12), age: -MLRS_GAP * n, mesh, k });
      sound.launch('mlrs', MLRS_GAP * n);
    }
  };

  // 꼬리 입자를 낼 자리가 화면 안(조금 넉넉히)인지. 화면 밖 꼬리가 입자 상한을 먼저 채우지 않게 한다
  const pv = new THREE.Vector3();
  const seen = (v: THREE.Vector3) => { pv.copy(v).project(camera); return pv.z < 1 && Math.abs(pv.x) < 1.3 && Math.abs(pv.y) < 1.3; };

  // 탄 위치를 무기별 궤적으로 옮긴다
  const flyShot = (s: Shot, T: number) => {
    const a = s.age, prev = s.mesh.position.clone();
    const p = s.mesh.position;
    if (a < 0) return;   // 다연장 로켓: 아직 발사 차례가 아니다(숨긴 채 멈춤)
    s.mesh.visible = true;
    if (s.sub) {
      // 집속탄 자탄은 열린 자리에서 떨어지며 빨라지고, 벙커버스터 바닥 폭발은 건물 속이라 보이지 않는다
      const u = a / T;
      p.lerpVectors(s.from, s.target, u * u);
      s.mesh.visible = s.w === 'cluster';
      // 벙커버스터 신관이 타는 동안: 땅이 점점 세게 떨리고(0.15→0.5), 뚫린 구멍과 둘레 땅에서 흙먼지가 피어오른다
      if (s.w === 'bunker') {
        shake = Math.max(shake, 0.15 + 0.35 * u);
        if (Math.random() < 0.016 * 10) puff(s.from, 1.2, 4, 1.2, 0.45, grey, 0.6);
        const R = WEAPON_PARAMS.bunker.R;
        if (Math.random() < 0.016 * (touch ? 12 : 25) * (0.3 + u)) {
          const ang = Math.random() * 6.28, r = R * (0.4 + Math.random() * 1.4), qx = s.target.x + Math.cos(ang) * r, qz = s.target.z + Math.sin(ang) * r;
          smoke.emit([qx, heightAt(t, qx, qz) + 0.3, qz], [0, 1 + Math.random() * 2, 0], 0.8 + Math.random() * 0.4, 1, 3.5, 0.4, col.copy(dirt).lerp(grey, 0.5), 0.3);
        }
      }
    } else if (s.w === 'grenade') {
      // 낮은 포물선으로 날아가 닿는 순간 터진다(신관 지연 없음)
      const u = a / T;
      p.lerpVectors(s.from, s.target, u).y += 10 * s.k * u * (1 - u);
    } else if (s.w === 'mortar') {
      // 0.6초 안에 떨어지므로 120m에서 낙하시켜 끝 속도(약 400m/s)에도 탄이 화면에 보이게 한다
      p.copy(s.target).y += 120 * s.k * (1 - (a / T) ** 2);
    } else if (s.w === 'artillery' || s.w === 'mlrs' || s.w === 'thermo') {
      // 포물선 높이: 다연장은 높게, 열압력 로켓은 낮고 곧게(직사에 가깝게)
      const u = a / T;
      p.lerpVectors(s.from, s.target, u).y += (s.w === 'mlrs' ? 120 : s.w === 'thermo' ? 15 : 60) * s.k * u * (1 - u);
    } else if (s.w === 'rod') {
      // 신의 지팡이: ROD_AIM초까지는 위성 조준 표식만 보이고, 그 뒤 일정한 극초음속으로 거의 수직으로 꽂힌다.
      // 떨어지는 동안 조준선은 옅어지고, 지면 원은 밝아지며 작아진다(반경 6 → 2, "곧 꽂힌다" 예고)
      const u = Math.max(0, (a - ROD_AIM) / (T - ROD_AIM));
      s.mesh.visible = u > 0;
      p.lerpVectors(s.from, s.target, u);
      const show = Math.min(1, a / 0.4), [line, mark] = s.warn!.children as [THREE.Line, THREE.Mesh];
      (line.material as THREE.Material).opacity = 0.85 * show * (1 - u);
      (mark.material as THREE.Material).opacity = show * (0.85 + 0.15 * u);
      mark.scale.setScalar(6 - 4 * u);
      // 마지막 0.15초: 흰 섬광이 0 → 0.15로 차올라 착탄 섬광으로 이어진다(다른 섬광이 켜져 있으면 건드리지 않는다)
      if (!calm && !flashEnd && a > T - 0.15) {
        flashEl.style.background = '#fff';
        flashEl.style.opacity = String((a - T + 0.15) / 0.15 * 0.15);
      }
    } else {
      // 항공폭탄·집속탄·벙커버스터는 from에서 내려오고(집속탄은 목표 위 약 80m에서 멈춰 열린다), 중성자탄은 3초 뒤 600m에서 수직으로 내려오고 그림자가 커진다
      const nuke = s.w === 'nuke', t0 = nuke ? 3 : s.w === 'bunker' ? 0.9 : 1.2, R = WEAPON_PARAMS[s.w].R;
      const u = Math.max(0, (a - t0) / (T - t0));
      s.mesh.visible = u > 0;
      if (nuke) p.copy(s.target).y += 600 * s.k * (1 - u * u);
      else p.lerpVectors(s.target, s.from, s.w === 'cluster' ? CLUSTER_OPEN + (1 - CLUSTER_OPEN) * (1 - u * u) : 1 - u * u);
      const m = s.shadow!.material as THREE.MeshBasicMaterial;
      m.opacity = 0.45 * Math.min(1, a / T + 0.2);
      s.shadow!.scale.setScalar(R * (nuke ? 0.15 + 0.85 * (a / T) : 1.4 - 0.6 * (a / T)));
      // 조준 표식 갱신: 카운트다운 진행, 0.25초 나타나기, 테두리 맥동(0.8Hz)·레이저 점 떨림(4Hz). 동작 줄이기면 고정 밝기
      if (s.warn) {
        const [disc, dot, beam] = s.warn.children as [THREE.Mesh, THREE.Sprite, THREE.Line];
        const uf = (disc.material as THREE.ShaderMaterial).uniforms, fade = Math.min(1, a / 0.25);
        uf.uP.value = a / T;
        uf.uFade.value = fade;
        uf.uPulse.value = calm ? 0.85 : 0.85 + 0.15 * Math.sin(a * 5.03);
        dot.scale.setScalar(0.03 * (calm ? 1 : 1 + 0.15 * Math.sin(a * 25.1)));
        (dot.material as THREE.SpriteMaterial).opacity = fade;
        (beam.material as THREE.LineBasicMaterial).opacity = 0.35 * fade;
      }
    }
    if (prev.distanceToSquared(p) > 1e-6) s.mesh.lookAt(p.clone().multiplyScalar(2).sub(prev));
    // 흰 연기 꼬리(다연장·열압력·신의 지팡이): 지나온 거리 SP m마다 한 덩이. 처음 보인 프레임은 직전 위치가 원점이라 건너뛴다
    if (!s.sub && s.mesh.visible && (s.w === 'mlrs' || s.w === 'thermo' || s.w === 'rod')) {
      const rod = s.w === 'rod', big = s.w === 'thermo' ? 1.8 : 1, SP = rod ? 5 : 12, d = s.trail === undefined ? 0 : prev.distanceTo(p);
      for (s.trail = (s.trail ?? 0) + d; s.trail >= SP; s.trail -= SP) {
        if (!seen(tv.lerpVectors(p, prev, (s.trail - SP) / d))) continue;
        // 지팡이는 우주에서 내리꽂힌 흰 구름 줄: 16~20초 하늘에 남아 6→18m로 천천히 퍼지며 옅어진다. 5m 간격이라 점선이 아니라 한 줄기로 보인다
        if (rod) trail.emit([tv.x, tv.y, tv.z], [(Math.random() - 0.5) * 1.2, Math.random() * 0.4, (Math.random() - 0.5) * 1.2], 16 + Math.random() * 4, 6, 18, 0.85, col.setScalar(0.93 + Math.random() * 0.07), 0.05);
        // 꼬리는 3~4초 남아 일제 사격 연기가 하늘에 줄지어 걸려 보이게 한다. 흰색은 밝은 바닥에 묻혀 연회색(0.6~0.7)
        else trail.emit([tv.x, tv.y, tv.z], [(Math.random() - 0.5) * 1.5, Math.random() * 0.8, (Math.random() - 0.5) * 1.5], 3 + Math.random(), 3 * big, 12 * big, 0.6, col.setScalar(0.6 + Math.random() * 0.1), 0.3);
      }
      // 꼬리 끝 주황 엔진 불꽃 (짧게 살아 로켓을 따라간다)
      if (!rod && d > 0) { tv.subVectors(prev, p).setLength(2.5 * big).add(p); fire.emit([tv.x, tv.y, tv.z], [0, 0, 0], 0.07, 1.8 * big, 0.6 * big, 1, col.setHSL(0.08, 1, 0.6)); }
    }
  };

  // 탄 제거
  const removeShot = (s: Shot) => {
    scene.remove(s.mesh);
    if (s.shadow) { scene.remove(s.shadow); (s.shadow.material as THREE.Material).dispose(); }
    // 조준 표식은 재질만 버린다(지오메트리·텍스처는 공유)
    if (s.warn) { scene.remove(s.warn); s.warn.traverse((o) => { if ('material' in o) (o.material as THREE.Material).dispose(); }); }
    // 착탄 전에 되돌리기·전부 복구로 지워지면 경고 문구도 바로 내린다
    if (s.w === 'nuke' && s.age < WEAPON_PARAMS.nuke.delay!) nukeAnim?.cancel();
    // 신의 지팡이 착탄 직전 차오르던 섬광도 지운다(착탄이면 바로 뒤 explode가 다시 켠다)
    if (s.w === 'rod' && !flashEnd) flashEl.style.opacity = '0';
  };

  // 집속탄 운반탄이 열린다: 자탄을 조준점 둘레 화면 기준 가로로 긴 띠(52×26m)에 흩뿌리고 0.3~0.9초에 걸쳐 차례로 떨어뜨린다
  const openCluster = (s: Shot) => {
    const o = new THREE.Vector3().lerpVectors(s.target, s.from, CLUSTER_OPEN);
    for (let n = 0; n < 12; n++) sparks.emit([o.x, o.y, o.z], [(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30], 0.2 + Math.random() * 0.2);
    puff(o, 2, 6, 1.2, 0.5, grey, 0.2);
    for (let n = 0; n < CLUSTER_N; n++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random());
      const target = aimAt(s.target, s.aim!, Math.cos(a) * 26 * r, Math.sin(a) * 13 * r);
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.scale.setScalar(0.5);
      mesh.visible = false;
      scene.add(mesh);
      shots.push({ w: 'cluster', act: s.act, target, from: o.clone(), age: 0, mesh, k: s.k, T: 0.3 + 0.6 * (n + Math.random()) / CLUSTER_N, sub: true });
    }
  };

  // 벙커버스터가 닿는다: 건물이면 탄 지나간 기둥(반경 1칸 남짓)을 지붕부터 바닥까지 부수고 1층에서, 땅이면 땅속에서 0.22초 뒤 터진다
  const pierce = (s: Shot) => {
    const p = s.target.clone();
    if (s.bld !== undefined) {
      const b = world.buildings[s.bld];
      world.drill(s.act, s.bld, p.x, p.z, g * 1.2);
      drain(s.act, p, 0);
      p.y = b.baseY + b.floorH * 0.5;
    }
    // 뚫고 들어간 자리에서 짧은 먼지·불티
    for (let n = 0; n < 24; n++) sparks.emit([s.target.x, s.target.y, s.target.z], [(Math.random() - 0.5) * 16, Math.random() * 22, (Math.random() - 0.5) * 16], 0.2 + Math.random() * 0.25);
    for (let n = 0; n < 6; n++) puff(s.target, 2.5, 7, 1.4, 0.55, s.bld !== undefined ? grey : dirt, 0.4);
    shake = Math.max(shake, 0.5);
    sound.boom(0.15, 520, 0.8);   // 뚫고 들어가는 둔한 "퉁". 그 뒤 신관이 타는 동안은 조용하다
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.visible = false;
    scene.add(mesh);
    shots.push({ w: 'bunker', act: s.act, target: p, from: s.target.clone(), age: 0, mesh, k: s.k, T: BUNKER_FUSE, sub: true, bld: s.bld });
  };

  // 열압력탄 1단(착탄 순간): 작은 폭약이 연료를 엷은 황백색 구름으로 뿌린다(THERMO_FIRE초에 반경 약 0.8R). 피해는 없고 점화·긴 폭풍·진공은 stepThermo가 잇는다
  const fuel = (s: Shot) => {
    const { x, y, z } = s.target, R = WEAPON_PARAMS.thermo.R;
    for (let n = 0, N = touch ? 36 : 60; n < N; n++) {
      tv.randomDirection();
      tv.y = Math.abs(tv.y) * 0.5;
      const v = R * 3 * (0.7 + Math.random() * 0.3);   // 끌림(초당 1.6) 때문에 0.35초에 약 0.8R까지 나간다
      smoke.emit([x, y + 1, z], [tv.x * v, tv.y * v, tv.z * v], 0.7 + Math.random() * 0.2, 2, R * 0.6, 0.35, col.set('#f0dd8a'), 0.1);
    }
    for (let n = 0; n < 12; n++) sparks.emit([x, y + 0.5, z], [(Math.random() - 0.5) * 14, Math.random() * 10, (Math.random() - 0.5) * 14], 0.15 + Math.random() * 0.15);
    shake = Math.max(shake, 0.4);
    sound.hit('thermo');
    blasts.push({ w: 'thermo', act: s.act, c: s.target.clone(), age: 0, acc: 0, bld: s.bld });
  };

  // 신의 지팡이가 꽂힌다: 건물이면 지붕부터 바닥까지 기둥(반경 2칸)을 꿰뚫고 1층 받침(반경 R)까지 없앤 뒤 1층에서 터진다. 땅이면 땅속 1m에서 바로 터진다
  const impact = (s: Shot) => {
    if (s.bld !== undefined) {
      const b = world.buildings[s.bld], { x, z } = s.target;
      world.drill(s.act, s.bld, x, z, g * 2);
      world.drill(s.act, s.bld, x, z, WEAPON_PARAMS.rod.R, true);
      s.target.y = b.baseY + b.floorH * 0.5;
    }
    explode(s);
  };

  // 탄이 닿았을 때: 집속탄 운반탄은 열리고, 벙커버스터는 파고들고, 열압력탄은 연료를 뿌리고, 신의 지팡이는 건물을 꿰뚫고, 나머지(자탄·바닥 폭발 포함)는 터진다
  // 벙커버스터 바닥 폭발은 터지기 전에 반경 2R 안 1층을 모두 없애 맞은 건물이 확실히 내려앉게 한다 (selfcheck R73)
  const land = (s: Shot) => {
    if (s.sub && s.bld !== undefined) world.drill(s.act, s.bld, s.target.x, s.target.z, WEAPON_PARAMS.bunker.R * 2, true);
    if (s.sub) explode(s); else if (s.w === 'cluster') openCluster(s); else if (s.w === 'bunker') pierce(s); else if (s.w === 'thermo') fuel(s); else if (s.w === 'rod') impact(s); else explode(s);
  };

  // 폭발 뒤 연출 제거 (중성자탄은 충격파 링 재질도 버린다)
  const removeBlast = (b: Blast) => { if (b.ring) { scene.remove(b.ring); (b.ring.material as THREE.Material).dispose(); } };

  // 폭발: 피해, 크레이터, 나무, 연출 (열압력탄 점화는 탄 없이 부른다)
  const explode = (s: Pick<Shot, 'w' | 'act' | 'target' | 'sub'>) => {
    const P = WEAPON_PARAMS[s.w], { x, y, z } = s.target, R = P.R, nuke = s.w === 'nuke';
    const bomblet = s.sub && s.w === 'cluster', rod = s.w === 'rod';
    const q = nuke && touch ? 0.5 : bomblet ? 0.35 : s.w === 'mlrs' ? 0.5 : 1;   // 터치 기기 중성자탄은 입자 수만 절반, 집속탄 자탄은 수십 발이 겹치니 35%, 다연장 로켓은 50%
    world.damageSphere(s.act, x, y, z, R, s.w === 'thermo' ? P.D / 3 : P.D);   // 열압력탄은 긴 폭풍이라 3번에 나눠 준다(나머지 둘은 stepThermo)
    smash(crowd.blast(x, z, R), s.act);
    const above = y - heightAt(t, x, z);
    if (above < R) {
      const k = 1 - Math.max(0, above) / R;
      terrain.update(world.crater(s.act, x, z, rod ? R * 0.5 : R, P.crater * k));   // 신의 지팡이 크레이터는 깊고 좁게
      // 크레이터는 반경 max(R, 1.5칸)까지 파이고 보간으로 한 칸 더 번진다
      debris.settle(x, z, Math.max(R, t.step * 1.5) + t.step);
      if (world.killTrees(s.act, x, z, R * (nuke ? 1.6 : 1.2)).length) trees.update();
      // 흙 파편 크기·속도는 항공폭탄 반경(18m) 기준이 상한 (중성자탄이 집채만 한 흙덩이를 뿌리지 않게)
      const Rd = Math.min(R, 18);
      for (let n = 0; n < 6 + R; n++) {
        const a = Math.random() * 6.28, v = 2 + Math.random() * Rd * 0.6, sz = (0.3 + Rd / 20) * (0.6 + Math.random() * 0.8);
        shards.spawn([x, y + 0.5, z], [Math.cos(a) * v * 2.2, (4 + Math.random() * Rd * 0.6) * 1.4, Math.sin(a) * v * 2.2], 14, [0.6 * sz, 0.4 * sz, 0.6 * sz], dirt, s.act);
      }
    }
    drain(s.act, s.target, R);
    if (s.w === 'bunker' && s.sub) {
      // 땅속 폭발 "펑": 화면 정지·펀치, 맞은 자리 둘레(1.5R)에서 어두운 흙먼지가 한꺼번에 솟고, 가운데 기둥이 치솟고,
      // 지진처럼 바깥으로 번지는 흙먼지 띠(quakes)와 땅을 기는 흙먼지 벽이 퍼진다
      freeze(0.12);
      slowmo(0.35, 0.22, 0.4);   // 흙먼지가 솟는 순간을 늘인다
      punch(-4);
      flash(260, '#ffb070', 0.3);
      shake = Math.max(shake, 3.6);
      const gy = heightAt(t, x, z);
      // 연기 덩이는 적게(8개) 크게: 많으면 각진 공이 겹쳐 알갱이가 보인다. 검정~회색으로 섞는다
      for (let n = 0, N = touch ? 6 : 8; n < N; n++) {
        const ang = Math.random() * 6.28, r = R * 1.6 * Math.sqrt(Math.random()), px = x + Math.cos(ang) * r, pz = z + Math.sin(ang) * r, sh = 0.1 + Math.random() * 0.25;
        puffs.emit([px, heightAt(t, px, pz) + 1, pz], [Math.cos(ang) * 5, 10 + Math.random() * 18 * (1 - r / (R * 1.7)), Math.sin(ang) * 5], 2.6 + Math.random() * 1.2, R * 0.45, R * 1.4, 0.85, col.setRGB(sh * 1.2, sh, sh * 0.8), 0.9);
      }
      for (let n = 0; n < 3; n++) {
        const sh = 0.08 + Math.random() * 0.25;
        puffs.emit([x + (Math.random() - 0.5) * 4, gy + 2, z + (Math.random() - 0.5) * 4], [(Math.random() - 0.5) * 3, 22 + Math.random() * 30, (Math.random() - 0.5) * 3], 3 + Math.random(), R * 0.4, R * 1.2, 0.85, col.setRGB(sh * 1.1, sh, sh * 0.9), 1);
      }
      quakes.push({ x, z, age: 0 });
      domes.spawn(x, gy, z, R, false);
    }
    if (rod) {
      // 운동에너지 충돌: 흙 파편·먼지를 거의 수직으로 수십 m 뿜어 올리고(흙기둥), 흰 섬광(0.5초)·충격파 돔·바깥벽 2차 피해(R~2R)
      // 타격감: 확실한 화면 정지 0.16초, 확대 펀치 -6도, 흔들림 5.5. 0.25·0.4초에 늦게 오는 충격파("딱-딱")가 한 번씩 더 친다
      flash(500, '#fff');
      freeze(0.16);
      slowmo(0.3, 0.3, 0.45);   // 정지가 풀리면 0.3초 동안 0.3배속, 0.45초에 걸쳐 원래 속도로 (돔이 부푸는 순간을 늘인다)
      punch(-6);
      shake = Math.max(shake, 5.5);
      knocks.push({ at: performance.now() + 250, act: s.act }, { at: performance.now() + 400, act: s.act });
      // 충격파: 납작한 흰 링 대신 테두리가 빛나는 반구 돔이 "쭝" 하고 부풀고 흙먼지 벽이 굴러 나간다(차르 봄바 영상 참고)
      domes.spawn(x, heightAt(t, x, z), z, R);
      vapors.push({ x, y: heightAt(t, x, z), z, act: s.act, age: 0, done: 0 });
      for (let n = 0, N = touch ? 24 : 40; n < N; n++) {
        const sz = 0.6 + Math.random() * 0.9;
        shards.spawn([x, y + 1, z], [(Math.random() - 0.5) * 8, 25 + Math.random() * 25, (Math.random() - 0.5) * 8], 10, [sz, sz * 0.7, sz], dirt, s.act);
        smoke.emit([x + (Math.random() - 0.5) * 4, y + 2, z + (Math.random() - 0.5) * 4], [(Math.random() - 0.5) * 3, 30 + Math.random() * 65, (Math.random() - 0.5) * 3], 4 + Math.random() * 2, 4, 14, 0.6, col.copy(dirt).lerp(grey, 0.3), 0.4);
      }
      // 분출 커튼: 흙 파편을 45~70도로 바깥쪽에 비스듬히 던진다(30~55m/s)
      for (let n = 0, N = touch ? 20 : 36; n < N; n++) {
        const a = Math.random() * 6.28, el = (45 + Math.random() * 25) * Math.PI / 180, sp = 30 + Math.random() * 25, sz = 0.5 + Math.random() * 0.8;
        shards.spawn([x, y + 1, z], [Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp], 10, [sz, sz * 0.7, sz], dirt, s.act);
      }
      world.damageRing(s.act, x, z, R, R * 2, R, R, 300);
      drain(s.act, s.target, 10, true);
    }
    // 신의 지팡이는 폭약이 없어 불덩이·불꽃을 작게 (불보다 흙·먼지). 흰 섬광은 화면 덮개(flash)가 맡는다.
    // 큰 흰빛 불덩이를 더 띄우면 슬로모션 동안 점광원이 길게 남아 화면이 하얗게 날아가고 웅크린 돔이 안 보인다
    fireballs.spawn(x, y, z, R * (rod ? 0.4 : 0.9), nuke ? (calm ? 0.2 : 0.6) : 0);
    // 지팡이는 돔이 대신하고, 열압력탄은 점화 때 stepThermo가 큰 링 하나만 띄운다(두 겹이면 충격이 두 번 온 것처럼 보인다)
    if (!rod && s.w !== 'thermo') waves.spawn(x, y, z, R, !nuke);
    if (!calm && (nuke || stopCool <= 0)) { stop = Math.max(stop, nuke ? 0.12 : 0.025 + R * 0.004); stopCool = 0.4; }
    // 불티 160개 상한: 사방으로 튀어 나가는 빛줄기
    for (let n = 0; n < Math.min(160, 20 + R * 6) * q; n++) {
      const a = Math.random() * 6.28, up = Math.random(), sp = (10 + R * 3) * (0.4 + Math.random() * 0.8), h = Math.sqrt(1 - up * up);
      sparks.emit([x, y + 0.5, z], [Math.cos(a) * h * sp, up * sp, Math.sin(a) * h * sp], 0.4 + Math.random() * 0.5);
    }
    // 불꽃 150개, 연기 100개 상한 (중성자탄)
    for (let n = 0; n < Math.min(150, 6 + R) * q * (rod ? 0.3 : 1); n++) {
      fire.emit([x, y + R * 0.2, z], [(Math.random() - 0.5) * R * 3, Math.random() * R * 2, (Math.random() - 0.5) * R * 3], 0.45 + Math.random() * 0.3, R * 0.5, R * 1.1, 0.9, col.setHSL(0.07 + Math.random() * 0.04, 1, 0.55));
    }
    // 중성자탄은 연기 덩이 크기·높이를 반경 30m 기준으로 묶어 바닥 먼지로 깔고, 위쪽은 버섯구름에 맡긴다
    const Rs = nuke ? 30 : R;
    // 각진 덩이가 겹치면 알갱이(분자)처럼 보여 3개(자탄·로켓은 1~2개)만 크고 진하게 띄운다. 마지막 하나는 검은 그을음 (사용자 요청)
    // 한 점에서 솟지 않게 착탄점 둘레(0.3~0.9R)에 고르게 나눈 방향 + 흔들림으로 흩고, 크기도 0.55~1.45배로 제각각
    // 수명은 ±35%로 흩어 한 폭발의 덩이들이 한꺼번에 꺼지지 않게 한다
    for (let n = 0, N = Math.max(1, Math.round(3 * q)), a0 = Math.random() * 6.28; n < N; n++) {
      const soot = N > 1 && n === N - 1, sh = soot ? 0.06 + Math.random() * 0.1 : 0.25 + Math.random() * 0.35, sk = 0.55 + Math.random() * 0.9;
      const a = a0 + (n / N) * 6.28 + (Math.random() - 0.5) * 1.2, r = R * (0.3 + Math.random() * 0.6), cx = Math.cos(a), cz = Math.sin(a);
      puffs.emit([x + cx * r, y + Math.random() * Rs * 0.3, z + cz * r],
        [cx * R * 0.3 * Math.random(), 2 + Math.random() * (3 + Rs * 0.4), cz * R * 0.3 * Math.random()],
        (2.7 + Rs * 0.18) * 1.3 * (0.65 + Math.random() * 0.7), Rs * 0.85 * sk, Rs * 2.8 * sk, soot ? 0.82 : 0.75,
        soot ? col.setRGB(sh * 1.1, sh, sh * 0.9) : col.setRGB(sh, sh * 0.97, sh * 0.94), soot ? 1.2 : 0.8);
    }
    // 바닥을 따라 둥글게 밀려 나가는 흙먼지 (끌림으로 반경 R×1.4쯤에서 멈춘다). 신의 지팡이는 더 많고 빠르고 큰 흙먼지 장막
    const g0 = above < R ? heightAt(t, x, z) + 0.5 : y, Rg = Math.min(R, 30);
    for (let n = 0, N = rod ? (touch ? 50 : 90) : Math.min(80, 10 + R * 2) * q; n < N; n++) {
      const a = (n / N) * 6.28 + Math.random() * 0.2, v = R * (rod ? 3 : 2.2) * (0.8 + Math.random() * 0.4);
      smoke.emit([x + Math.cos(a) * R * 0.2, g0, z + Math.sin(a) * R * 0.2], [Math.cos(a) * v, 0.5 + Math.random(), Math.sin(a) * v],
        1.5 + Rg * 0.1 + Math.random(), rod ? R * 0.3 : Rg * 0.25, rod ? R : Rg * 0.9, 0.5, col.copy(dirt).lerp(grey, 0.5), 0.2);
    }
    shake = Math.max(shake, nuke && calm ? 1.5 : P.shake);
    if (nuke) {
      flash(FLASH_MS, '#fff');
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#fff1d6', transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
      ring.position.set(x, heightAt(t, x, z) + 2, z);
      ring.scale.setScalar(0.01);
      scene.add(ring);
      blasts.push({ w: 'nuke', act: s.act, c: s.target.clone(), age: 0, acc: 0, ring });
    }
    // 자탄은 30%, 다연장 로켓은 60%만 소리를 내 겹침을 줄인다(동시 재생 수는 sound.ts HIT.max). 열압력탄 소리는 착탄 때(fuel) 점화음까지 미리 걸어 둔다
    if (Math.random() < (bomblet ? 0.3 : s.w === 'mlrs' ? 0.6 : s.w === 'thermo' ? 0 : 1)) sound.hit(s.w);
    // 같은 발에서 나온 탄(자탄·바닥 폭발·로켓)이나 이어지는 연출(중성자탄 충격파·열압력탄 긴 폭풍)이 남아 있으면 기록을 아직 닫지 않는다
    if (!shots.some((o) => o.act === s.act) && !blasts.some((b) => b.act === s.act)) world.dropIfEmpty(s.act);
    emitUndo();
  };

  // 중성자탄 한 프레임: 충격파 링을 넓히며 R ~ R×2 바깥벽에 2차 피해, 버섯구름 기둥·머리를 뿌린다
  const stepBlast = (b: Blast, dt: number) => {
    const R = WEAPON_PARAMS.nuke.R, { x, y, z } = b.c, ring = b.ring!;   // 중성자탄은 늘 링이 있다
    const ringR = (a: number) => R * 2.2 * (1 - (1 - Math.min(1, a / RING_T)) ** 2);
    const r0 = ringR(b.age);
    b.age += dt;
    const r1 = ringR(b.age);
    ring.scale.setScalar(Math.max(0.01, r1));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * Math.max(0, 1 - b.age / RING_T);
    ring.visible = b.age < RING_T;
    if (r1 > R && r0 < R * 2 && r1 > r0) {
      world.damageRing(b.act, x, z, Math.max(r0, R), Math.min(r1, R * 2), R, R, 300);
      smash(crowd.blast(x, z, r1, false), b.act, 20);   // 매 프레임 불리니 연출은 프레임당 20개까지
      drain(b.act, b.c, 10, true);
    }
    if (b.age >= CLOUD_T) return;
    // 머리 높이: 30m에서 135m까지 올라가며 그 아래를 기둥이 채운다
    const u = b.age / CLOUD_T, h = 30 + 105 * (1 - (1 - u) ** 2), N = touch ? 300 : 600;
    b.acc += (dt * N) / CLOUD_T;
    for (; b.acc >= 1; b.acc--) {
      const a = Math.random() * 6.28, sh = 0.4 + Math.random() * 0.12;
      if (Math.random() < 0.35) {
        const rr = R * 0.08 * Math.random();
        cloud.emit([x + Math.cos(a) * rr, y + Math.random() * h * 0.95, z + Math.sin(a) * rr], [Math.cos(a) * 1.5, 2 + Math.random() * 2, Math.sin(a) * 1.5],
          6 + Math.random() * 2, 10, 20, 0.7, col.setRGB(sh, sh * 0.95, sh * 0.88), 1.2);
      } else {
        // 머리 입자는 끌림(초당 1.6)으로 멈출 때 120~170m에 닿도록 위로 쏜다. 일찍 나온 입자일수록 빠르게 솟는다
        const rr = R * 0.6 * Math.sqrt(Math.random()), top = 125 + Math.random() * 25 - h;
        cloud.emit([x + Math.cos(a) * rr, y + h + Math.random() * 10, z + Math.sin(a) * rr], [Math.cos(a) * (2 + rr * 0.12), 1.6 * Math.max(0, top), Math.sin(a) * (2 + rr * 0.12)],
          6 + Math.random() * 2, 22, 48, 0.8, col.setRGB(sh * 1.1, sh * 1.05, sh), 1.5);
      }
      // 머리 안쪽 주황 불빛: 짧게 살아서 머리가 주황에서 회색으로 바뀌어 보인다. 처음에 많고 점점 준다
      if (Math.random() < 0.18 * (1 - u)) {
        const rr = R * 0.35 * Math.sqrt(Math.random());
        fire.emit([x + Math.cos(a) * rr, y + h + 8, z + Math.sin(a) * rr], [0, 1.6 * Math.max(0, 130 - h), 0], 1.6 + Math.random(), 24, 40, 0.55, col.setHSL(0.06 + Math.random() * 0.03, 1, 0.5), 1);
      }
    }
  };

  // 열압력탄 한 프레임 (착탄 뒤 age초): THERMO_FIRE초에 점화해 구름 부피 전체가 1.2초 동안 타오르고, 피해는 0.5초 동안 3번(긴 폭풍).
  // 맞은 건물이 있으면 매번 그 건물 안(반경 1.6R)에만 같은 피해를 더 준다(닫힌 공간에서 반사된 충격파). 1초에 진공(빨려 드는 흙먼지)과 검은 연기 기둥
  const stepThermo = (b: Blast, dt: number) => {
    const P = WEAPON_PARAMS.thermo, R = P.R, { x, y, z } = b.c, a0 = b.age;
    b.age += dt;
    const at = (s: number) => a0 < s && b.age >= s;
    const pulse = [0, 0.25, 0.5].findIndex((d) => at(THERMO_FIRE + d));
    // 점화 0.1초 전: 구름 중심에 작은 노란 빛 몇 개("곧 터진다" 예고)
    if (at(THERMO_FIRE - 0.1)) {
      for (let n = 0; n < 6; n++) fire.emit([x + (Math.random() - 0.5) * R * 0.5, y + 1 + Math.random() * R * 0.3, z + (Math.random() - 0.5) * R * 0.5], [0, 1, 0], 0.2, 1, 3, 0.9, col.setHSL(0.13, 1, 0.65));
    }
    if (pulse === 0) {
      // 큰 불덩이를 먼저 띄우고 explode의 보통 불덩이(R×0.9)가 점광원을 이어받게 한다.
      // 큰 불덩이가 빛을 차지하면 세기 120·r²가 화면 전체를 하얗게 날려 버린다
      fireballs.spawn(x, y + R * 0.3, z, R * 1.4);
      explode({ w: 'thermo', act: b.act, target: b.c });
      world.damageRing(b.act, x, z, R, R * 1.8, R, R * 0.8, 150);   // 바깥벽 약한 2차 피해
      drain(b.act, b.c, 10, true);
      // 점화 타격감: 화면 정지 0.12초, 주황 섬광 0.45초(최대 0.6), 확대 펀치 -4도, 흔들림 3.5
      freeze(0.12);
      flash(450, '#ff9a3c', 0.6);
      punch(-4);
      shake = Math.max(shake, 3.5);
      // 바깥 충격파 링
      waves.spawn(x, y, z, R * 1.8);
      // 바닥 불파도: 바닥을 따라 바깥으로 퍼지는 불 입자 링 (끌림 때문에 0.6초에 약 R까지 나간다)
      const h0 = heightAt(t, x, z), gy = y - h0 < R ? h0 + 0.5 : y;
      for (let n = 0, N = touch ? 28 : 48; n < N; n++) {
        const ang = (n / N) * 6.28 + Math.random() * 0.15, v = R * 2.5 * (0.85 + Math.random() * 0.3);
        fire.emit([x + Math.cos(ang) * R * 0.3, gy, z + Math.sin(ang) * R * 0.3], [Math.cos(ang) * v, 1 + Math.random(), Math.sin(ang) * v], 0.6, R * 0.15, R * 0.35, 0.9, col.setHSL(0.06 + Math.random() * 0.04, 1, 0.55));
      }
    } else if (pulse > 0) {
      // 긴 폭풍은 피해만 나눠 준다. 화면 충격(펀치·큰 흔들림)은 점화 한 번만이고 여기선 낮게 울리기만 한다
      world.damageSphere(b.act, x, y, z, R, P.D / 3);
      shake = Math.max(shake, 0.8);
    }
    if (pulse >= 0) {
      if (b.bld !== undefined) world.damageSphere(b.act, x, y, z, R * 1.6, P.D / 3, b.bld);
      drain(b.act, b.c, R);
      emitUndo();
    }
    // 긴 불덩이: 구름 반경(0.8R) 안 여러 곳에서 시간차로 불이 핀다
    if (b.age > THERMO_FIRE && b.age < THERMO_FIRE + 1.2) {
      for (b.acc += dt * (touch ? 50 : 90); b.acc >= 1; b.acc--) {
        tv.randomDirection().multiplyScalar(R * 0.8 * Math.cbrt(Math.random()));
        const px = x + tv.x, pz = z + tv.z;
        fire.emit([px, Math.max(heightAt(t, px, pz) + 1, y + tv.y), pz], [0, 2 + Math.random() * 4, 0], 0.5 + Math.random() * 0.3, R * 0.3, R * 0.7, 0.85, col.setHSL(0.05 + Math.random() * 0.05, 1, 0.5 + Math.random() * 0.1), 0.5);
      }
    }
    if (at(1)) {
      // 진공: 식으며 압력이 떨어져 바깥(1.5R) 흙먼지가 중심으로 빨려 들고, 검은 연기 기둥이 솟는다
      // 화면 충격은 점화 한 번만 준다(사용자 요청). 진공은 흙먼지·연기 그림만
      const g0 = heightAt(t, x, z) + 0.5;
      for (let n = 0, N = touch ? 24 : 40; n < N; n++) {
        const ang = (n / N) * 6.28, v = R * 1.6 * (0.8 + Math.random() * 0.4);
        smoke.emit([x + Math.cos(ang) * R * 1.5, g0, z + Math.sin(ang) * R * 1.5], [-Math.cos(ang) * v, 0.5, -Math.sin(ang) * v], 1.2 + Math.random() * 0.4, R * 0.15, R * 0.4, 0.5, col.copy(dirt).lerp(grey, 0.4), 0.2);
      }
      for (let n = 0; n < 4; n++) {
        const sh = 0.06 + Math.random() * 0.2;
        puffs.emit([x + (Math.random() - 0.5) * R * 0.3, y + 2, z + (Math.random() - 0.5) * R * 0.3], [(Math.random() - 0.5) * 2, 8 + n * 12, (Math.random() - 0.5) * 2], 5 + Math.random() * 2, R * 0.45, R * 1.3, 0.8, col.setRGB(sh * 1.1, sh, sh * 0.9), 1.2);
      }
    }
  };

  // ---- 입력 ----
  let down: { id: number; x: number; y: number; moved: boolean } | null = null;
  let firing: { act: number; acc: number } | null = null;
  let holdTimer = 0;
  const aim = { x: 0, y: 0 };
  const pointers = new Set<number>();

  // 연사 시작/끝
  const startFiring = () => {
    firing = { act: world.begin(), acc: 1 };
    controls.enabled = false;
    emitUndo();
  };
  const stopFiring = () => {
    if (!firing) return;
    world.dropIfEmpty(firing.act);
    firing = null;
    controls.enabled = true;
    emitUndo();
  };

  const onDown = (e: PointerEvent) => {
    sound.unlock();
    pointers.add(e.pointerId);
    clearTimeout(holdTimer);
    if (pointers.size > 1 || (e.pointerType === 'mouse' && e.button !== 0)) { stopFiring(); down = null; return; }
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    aim.x = e.clientX; aim.y = e.clientY;
    if (AUTO[weapon]) holdTimer = window.setTimeout(() => { if (down && !down.moved) startFiring(); }, 150);
  };
  const onMove = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return;
    aim.x = e.clientX; aim.y = e.clientY;
    if (!firing && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down.moved = true; clearTimeout(holdTimer); }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (!down || e.pointerId !== down.id) return;
    clearTimeout(holdTimer);
    if (firing) stopFiring();
    else if (!down.moved && e.type === 'pointerup') {
      if (AUTO[weapon]) {
        // 짧게 한 번 누르면 한 발
        const act = world.begin();
        shoot(act, e.clientX, e.clientY);
        world.dropIfEmpty(act);
        emitUndo();
      } else launch(e.clientX, e.clientY);
    }
    down = null;
  };
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  // ---- 시점 애니메이션 ----
  let viewAnim: { from: THREE.Spherical; to: THREE.Spherical; u: number } | null = null;
  const sph = new THREE.Spherical();

  // ---- 프레임 루프 ----
  let last = performance.now(), ready = false;
  const shakeOff = new THREE.Vector3();
  const ground = (x: number, z: number) => debris.groundAt(x, z);
  const frame = () => {
    const now = performance.now(), raw = Math.min(0.05, (now - last) / 1000);
    last = now;
    let dt = raw;
    stopCool -= raw;
    if (stop > 0) { stop -= raw; dt = 0; }
    else if (slowK < 1) {
      if (slowHold > 0) { slowHold -= raw; dt *= slowK; }
      else if (slowLeft > 0) { slowLeft -= raw; const u = 1 - Math.max(0, slowLeft) / slowEase; dt *= slowK + (1 - slowK) * u * u; }
      else slowK = 1;
    }
    world.time += dt;

    if (firing) {
      firing.acc += dt * WEAPON_PARAMS[weapon].rate!;
      while (firing.acc >= 1) { firing.acc -= 1; shoot(firing.act, aim.x, aim.y); }
    }
    for (let k = shots.length - 1; k >= 0; k--) {
      const s = shots[k], T = s.T ?? WEAPON_PARAMS[s.w].delay!;
      s.age += dt;
      if (s.age >= T) { removeShot(s); shots.splice(k, 1); land(s); } else flyShot(s, T);
    }
    for (let k = blasts.length - 1; k >= 0; k--) {
      const b = blasts[k];
      if (b.w === 'thermo') stepThermo(b, dt); else stepBlast(b, dt);
      // 끝난 연출은 치우고, 그 발에서 아무것도 안 바뀌었으면 되돌리기 기록을 닫는다
      if (b.age >= (b.w === 'thermo' ? THERMO_END : CLOUD_T)) { removeBlast(b); blasts.splice(k, 1); world.dropIfEmpty(b.act); emitUndo(); }
    }
    // 신의 지팡이 늦은 충격파: "딱-딱" 소리와 같은 실제 시각에 흔들림 2.0·펀치 -1.5도
    for (let k = knocks.length - 1; k >= 0; k--) if (now >= knocks[k].at) { shake = Math.max(shake, 2); punch(-1.5); knocks.splice(k, 1); }
    // 벙커버스터 지진: 반경 3R까지 지수 감속으로 번지는 띠를 따라 흙먼지가 차례로 솟는다
    for (let k = quakes.length - 1; k >= 0; k--) {
      const q = quakes[k], R = WEAPON_PARAMS.bunker.R;
      if ((q.age += dt) >= QUAKE_T) { quakes.splice(k, 1); continue; }
      const rq = R * 3 * spring(q.age, 5, 0.6);   // 천천히 붙었다 밀려 나가 살짝 넘쳤다 멈춘다
      for (let n = 0, N = dt > 0 ? (touch ? 5 : 10) : 0; n < N; n++) {
        const ang = Math.random() * 6.28, px = q.x + Math.cos(ang) * rq, pz = q.z + Math.sin(ang) * rq;
        smoke.emit([px, heightAt(t, px, pz) + 0.5, pz], [Math.cos(ang) * 3, 5 + Math.random() * 8, Math.sin(ang) * 3], 1.4 + Math.random() * 0.8, R * 0.25, R * 0.8, 0.7, col.copy(dirt).multiplyScalar(0.75), 0.3);
      }
    }
    // 섬광은 실제 시간으로 지운다 (느린 프레임에도 1.2초를 넘기지 않게)
    if (flashEnd) {
      const f = Math.max(0, (flashEnd - now) / flashLen);
      flashEl.style.opacity = String((calm ? 0.45 : 1) * flashMax * f * f);
      if (!f) flashEnd = 0;
    }
    chips = Math.min(CHIPS, chips + dt * CHIPS);
    for (let k = tips.length - 1, lim = TIP_LIM; k >= 0; k--) {
      lim = stepTip(tips[k], dt, lim);
      if (!tips[k].left.length) { removeTip(tips[k]); tips.splice(k, 1); }
    }
    fdt = dt;
    falls.update(dt, ground, (k) => { const f = falls.get(k); landBlock(f.x, f.z, f.sy, f.color, f.act); }, burst, fallHit);
    shards.update(dt, ground, (k) => {
      const f = shards.get(k);
      debris.add(f.x, ground(f.x, f.z) + f.sy * 0.3, f.z, f.sx, f.sy, f.sz, f.color, f.act);
    }, undefined, shardHit);
    applyHits();
    debris.update(dt);
    smoke.update(dt, camera.quaternion);
    puffs.update(dt, camera.quaternion);
    fire.update(dt, camera.quaternion);
    cloud.update(dt, camera.quaternion);
    trail.update(dt, camera.quaternion);
    fireballs.update(dt);
    sparks.update(dt);
    waves.update(dt);
    domes.update(dt);
    // 신의 지팡이: 돔과 같은 반경(ShockDomes.reach)으로 4m 넓어질 때마다 그 안의 블록·나무·사람·차를 증발시킨다(3R ≈ 84m까지)
    for (let k = vapors.length - 1; k >= 0; k--) {
      const v = vapors[k], R = WEAPON_PARAMS.rod.R;
      v.age += dt;
      const r = ShockDomes.reach(R, v.age), end = r > R * 2.97;
      if (r < R * 0.5 || (r - v.done < 4 && !end)) continue;
      world.damageSphere(v.act, v.x, v.y, v.z, r, 1e6);
      if (world.killTrees(v.act, v.x, v.z, r).length) trees.update();
      smash(crowd.blast(v.x, v.z, r, false), v.act, 20);
      tv.set(v.x, v.y, v.z);
      drain(v.act, tv, 10, true);
      v.done = r;
      if (end) { vapors.splice(k, 1); emitUndo(); }
    }
    tracers.update(dt);
    crowd.update(dt);
    blocks.flush();

    // 카메라: 시점 전환 → 컨트롤 → 범위 제한 → 흔들림
    if (viewAnim) {
      viewAnim.u = Math.min(1, viewAnim.u + dt / 0.7);
      const e = 1 - (1 - viewAnim.u) ** 3, f = viewAnim.from, to = viewAnim.to;
      sph.set(f.radius + (to.radius - f.radius) * e, f.phi + (to.phi - f.phi) * e, f.theta + (to.theta - f.theta) * e);
      camera.position.setFromSpherical(sph).add(controls.target);
      if (viewAnim.u >= 1) viewAnim = null;
    }
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, t.x0, t.x0 + W);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, t.z0, t.z0 + Dp);
    controls.update();
    // 확대 펀치: 화면 정지 중(dt 0)에는 펀치가 그대로 머물고, 풀리면 약 0.5초에 기본 시야각으로 돌아온다
    if (kick || kickV) {
      kickV += (-90 * kick - 11 * kickV) * dt;
      kick += kickV * dt;
      if (Math.abs(kick) < 0.01 && Math.abs(kickV) < 0.05) kick = kickV = 0;
      camera.fov = fov0 + kick;
      camera.updateProjectionMatrix();
    }
    shake *= Math.exp(-dt * 7);
    shakeOff.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shake);
    camera.position.add(shakeOff);
    camera.updateMatrixWorld();

    // 이름표 위치
    layer.style.display = labelsOn ? '' : 'none';
    if (labelsOn) {
      const w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
      for (const L of labels) {
        v.copy(L.p).project(camera);
        const hide = L.b.down || v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
        L.div.style.visibility = hide ? 'hidden' : 'visible';
        if (!hide) L.div.style.transform = `translate(${((v.x + 1) / 2) * w}px,${((1 - v.y) / 2) * h}px) translate(-50%,-100%)`;
      }
    }

    renderer.render(scene, camera);
    camera.position.sub(shakeOff);

    statT += dt;
    if (statT >= 0.1) { statT = 0; emitStats(); }
    if (!ready) { ready = true; cb.onReady(); emitStats(); emitUndo(); }
  };
  renderer.setAnimationLoop(frame);

  return {
    setWeapon(id) { stopFiring(); weapon = id; },
    undo() {
      stopFiring();
      const r = world.undo();
      if (!r) return;
      r.blocks.forEach(blocks.write);
      falls.removeIf((a) => a === r.id);
      shards.removeIf((a) => a === r.id);
      debris.removeAction(r.id);
      for (let k = shots.length - 1; k >= 0; k--) if (shots[k].act === r.id) { removeShot(shots[k]); shots.splice(k, 1); }
      // 되돌린 중성자탄의 충격파가 기록 없는 피해를 더 주지 않게 멈춘다
      for (let k = blasts.length - 1; k >= 0; k--) if (blasts[k].act === r.id) { removeBlast(blasts[k]); blasts.splice(k, 1); }
      for (let k = knocks.length - 1; k >= 0; k--) if (knocks[k].act === r.id) knocks.splice(k, 1);
      quakes.length = 0;   // 흙먼지 띠는 연출뿐이라 되돌리면 그냥 멈춘다
      for (let k = vapors.length - 1; k >= 0; k--) if (vapors[k].act === r.id) vapors.splice(k, 1);   // 되돌린 지팡이가 기록 없는 피해를 더 주지 않게
      for (let k = tips.length - 1; k >= 0; k--) if (tips[k].act === r.id) { removeTip(tips[k]); tips.splice(k, 1); }
      if (r.terrain.length) terrain.update(r.terrain);
      if (r.trees.length) trees.update();
      emitUndo();
      emitStats();
    },
    restoreAll() {
      stopFiring();
      world.restoreAll();
      for (let i = 0; i < world.blocks.n; i++) blocks.write(i);
      falls.removeIf(() => true);
      shards.removeIf(() => true);
      debris.clear();
      smoke.clear(); puffs.clear(); fire.clear(); fireballs.clear(); cloud.clear(); trail.clear(); sparks.clear(); waves.clear(); domes.clear();
      shots.forEach(removeShot);
      shots.length = 0;
      blasts.forEach(removeBlast);
      blasts.length = 0;
      knocks.length = 0;
      quakes.length = 0;
      vapors.length = 0;
      tips.forEach(removeTip);
      tips.length = 0;
      terrain.update();
      trees.update();
      emitUndo();
      emitStats();
    },
    setLabels(on) { labelsOn = on; },
    setSound(on) { sound.setOn(on); },
    setMusic(on) { sound.setMusic(on); },
    setVolume(v) { sound.setVolume(v); },
    setTopView(on) {
      const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      viewAnim = { from, to: new THREE.Spherical(from.radius, on ? 0.0001 : Math.PI / 4, from.theta), u: 0 };
    },
    capture() {
      return new Promise<Blob>((res, rej) => {
        renderer.render(scene, camera);
        el.toBlob((b) => {
          if (b) return res(b);
          const err = new Error('canvas.toBlob returned null');
          logError('RENDER_CAPTURE_FAILED', 'capture', err);
          rej(err);
        }, 'image/png');
      });
    },
    dispose() {
      renderer.setAnimationLoop(null);
      clearTimeout(holdTimer);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('webglcontextlost', onLost);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      controls.dispose();
      sound.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
      toppleMat[0].map?.dispose(); toppleMat.forEach((m) => m.dispose());   // 기운 건물이 없으면 장면에 안 들어가 위 순회가 못 치운다
      renderer.dispose();
      el.remove();
      layer.remove();
      flashEl.remove();
      nukeAnim?.cancel();
      nukeEl.remove();
      warnGeo.dispose(); beamGeo.dispose(); dotTex.dispose(); rodMat.dispose();
    },
  };
}
