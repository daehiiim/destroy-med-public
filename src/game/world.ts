// 파괴 엔진의 순수 상태 (three.js 없음): 지형 높이, 블록, 지지 검사, 점수, 되돌리기 기록
import type { HospitalData, Rank, XZ } from './types.ts';

// 스타일 랭크 기준: [랭크, 최근 5초 점수, 최소 콤보]. 높은 랭크부터. 수치 근거는 23-rank-combo.md "측정값"
export const RANK_THRESHOLDS: [Rank, number, number?][] = [
  ['SSS', 70000, 80], ['SS', 60000, 50], ['S', 50000, 20], ['A+', 45000], ['A', 35000], ['A-', 26000],
  ['B+', 18000], ['B', 10000], ['B-', 4000], ['C', 500], ['D', 150], ['E', 40], ['F', 0],
];
const TIERS = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export const BLOCK_HP = 100;
// 점수 배율 1인 맵 크기(블록 수). 실제 병원 53곳 블록 수의 중간값. 작은 맵은 점수를 더, 큰 맵은 덜 준다
const REF_BLOCKS = 47000;
export const MAX_BLOCKS = 150000;
const MAX_UNDO = 30;
const RANK_WINDOW = 5;
const COMBO_GAP = 2;                       // 콤보가 끊기는 쉼(초). 항공폭탄 연사 간격(0.5초)·사람 손 속도보다 길게
const COMBO_SAME = 0.15;                   // 이 시간 안에 거듭 부순 것은 콤보 한 번
const TILT_AT = 0.5;                       // 1층 받침이 이 비율 넘게 사라지면 남은 기둥이 무게를 못 버텨 비어 있는 쪽으로 기운다
const CELL = 20;                           // blockAt 버킷 칸 크기(m)

// 버킷 칸 (i, j) → Map 키 (좌표가 ±5만 칸 안이라 겹치지 않는다)
const cellKey = (i: number, j: number) => i * 100003 + j;

// 최근 점수와 콤보로 랭크를 고른다: 두 조건을 모두 채운 가장 높은 랭크
export function rankFor(points: number, combo = 0): Rank {
  for (const [r, min, c = 0] of RANK_THRESHOLDS) if (points >= min && combo >= c) return r;
  return 'F';
}

// +/-를 뗀 글자 단계 (F=0 … SSS=8). 소리·속보처럼 9단계 표를 쓰는 곳이 쓴다
export function rankTier(r: Rank): number {
  return TIERS.indexOf(r.replace(/[+-]/, ''));
}

// 거리 d에서의 폭발 피해 (반경 R, 중심 피해 D)
export function falloff(D: number, R: number, d: number): number {
  return d >= R ? 0 : D * (1 - (d / R) ** 2);
}

// 점이 다각형 안인지 (짝홀 규칙)
export function pointInPoly(x: number, z: number, poly: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 시드 고정 난수 (mulberry32)
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Terrain { x0: number; z0: number; step: number; nx: number; nz: number; h: Float32Array }

// 데이터 지형을 최대 4m 간격으로 쌍선형 보간해 촘촘하게 만든다 (크레이터 해상도용)
export function makeTerrain(t: HospitalData['terrain'], maxStep = 4): Terrain {
  const f = Math.max(1, Math.ceil(t.step / maxStep));
  const src: Terrain = { ...t, h: Float32Array.from(t.h) };
  if (f === 1) return src;
  const nx = (t.nx - 1) * f + 1, nz = (t.nz - 1) * f + 1, step = t.step / f;
  const h = new Float32Array(nx * nz);
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) h[i * nx + j] = heightAt(src, t.x0 + j * step, t.z0 + i * step);
  return { x0: t.x0, z0: t.z0, step, nx, nz, h };
}

// 정사각 창(반지름 r칸)으로 격자를 훑어 f로 접는다 (최소·최대·합 필터 공용)
function sweep(a: Float32Array, nx: number, nz: number, r: number, f: (acc: number, v: number) => number, init: number) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) {
    let v = init;
    for (let ii = Math.max(0, i - r); ii <= Math.min(nz - 1, i + r); ii++)
      for (let jj = Math.max(0, j - r); jj <= Math.min(nx - 1, j + r); jj++) v = f(v, a[ii * nx + jj]);
    o[i * nx + j] = v;
  }
  return o;
}

// 고층 건물 밑 가짜 언덕을 깎는다. 위성 고도(SRTM)는 건물 지붕까지 땅으로 잡아 고층 단지가 언덕이 된다.
// 땅 추정 = 64m 창 열림 연산(최소→최대, 그보다 좁은 솟음만 지움). 25m 이상 건물 근처만, 건물 높이 40%까지만 낮춘다
export function flattenTowers(t: HospitalData['terrain'], buildings: HospitalData['buildings'], R = 8, K = 0.4, D = 3): Float32Array {
  const { nx, nz, step } = t, h = Float32Array.from(t.h);
  let cap = new Float32Array(h.length);
  for (const b of buildings) {
    if (b.h < 25) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.o) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let i = Math.max(0, Math.floor((z0 - t.z0) / step)); i <= Math.min(nz - 1, Math.ceil((z1 - t.z0) / step)); i++)
      for (let j = Math.max(0, Math.floor((x0 - t.x0) / step)); j <= Math.min(nx - 1, Math.ceil((x1 - t.x0) / step)); j++)
        if (pointInPoly(t.x0 + j * step, t.z0 + i * step, b.o)) cap[i * nx + j] = Math.max(cap[i * nx + j], K * b.h);
  }
  // 깎는 한도를 D칸 넓힌 뒤 같은 폭으로 평균 내 가장자리를 부드럽게 잇는다
  cap = sweep(sweep(cap, nx, nz, D, Math.max, 0), nx, nz, D, (s, v) => s + v / (2 * D + 1) ** 2, 0);
  const ground = sweep(sweep(h, nx, nz, R, Math.min, Infinity), nx, nz, R, Math.max, -Infinity);
  for (let k = 0; k < h.length; k++) h[k] -= Math.min(Math.max(0, h[k] - ground[k]), cap[k]);
  return h;
}

// (x,z)의 지형 높이 (쌍선형, 범위 밖은 가장자리 값)
export function heightAt(t: Terrain, x: number, z: number): number {
  const fx = Math.min(Math.max((x - t.x0) / t.step, 0), t.nx - 1.001);
  const fz = Math.min(Math.max((z - t.z0) / t.step, 0), t.nz - 1.001);
  const j = Math.floor(fx), i = Math.floor(fz), u = fx - j, v = fz - i;
  const k = i * t.nx + j;
  return (t.h[k] * (1 - u) + t.h[k + 1] * u) * (1 - v) + (t.h[k + t.nx] * (1 - u) + t.h[k + t.nx + 1] * u) * v;
}

export interface Building {
  start: number; end: number;          // 블록 범위 [start, end)
  ncx: number; ncz: number; nl: number; gridOff: number;
  floorH: number; baseY: number; hosp: 0 | 1; name?: string;
  cx: number; cz: number; topY: number;
  min: [number, number, number]; max: [number, number, number];
  dead: number; down: boolean;
}

// 이름표가 붙는 병원 건물인지 (index.ts 이름표와 같은 기준). 무너진 "동" 수는 이것만 센다
export const isLabeled = (b: Building) => !!(b.hosp && b.name);

export interface Blocks {
  n: number; g: number;
  x: Float32Array; y: Float32Array; z: Float32Array; hgt: Float32Array;
  bld: Int32Array; ci: Int16Array; cj: Int16Array; cl: Int16Array;
  grid: Int32Array;                    // 건물별 (l, i, j) → 블록 번호, 없으면 -1
  outer: Uint8Array;                   // 바깥에 닿은 옆면 비트 (+x 1, -x 2, +z 4, -z 8). 이 면에만 창문을 그린다
}

// 건물 외곽선 하나를 g 간격 칸으로 나눠 안쪽 칸 중심 목록을 낸다 (칸이 없으면 무게중심 한 칸)
export function cellsOf(o: XZ[], g: number) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of o) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const ncx = Math.max(1, Math.ceil((x1 - x0) / g)), ncz = Math.max(1, Math.ceil((z1 - z0) / g));
  const ox = (x0 + x1 - ncx * g) / 2, oz = (z0 + z1 - ncz * g) / 2;
  const cells: [i: number, j: number][] = [];
  for (let i = 0; i < ncz; i++) for (let j = 0; j < ncx; j++) {
    if (pointInPoly(ox + (j + 0.5) * g, oz + (i + 0.5) * g, o)) cells.push([i, j]);
  }
  if (!cells.length) cells.push([Math.floor(ncz / 2), Math.floor(ncx / 2)]);
  return { ncx, ncz, ox, oz, cells };
}

// 모든 건물을 블록으로 쌓는다. 총량이 maxBlocks를 넘으면 칸을 키운다 (3→4→5m…)
export function buildBlocks(data: HospitalData, t: Terrain, maxBlocks = MAX_BLOCKS): { blocks: Blocks; buildings: Building[] } {
  let g = 3;
  let plans = data.buildings.map((b) => cellsOf(b.o, g));
  const count = () => plans.reduce((s, p, k) => s + p.cells.length * data.buildings[k].lv, 0);
  while (count() > maxBlocks) { g += 1; plans = data.buildings.map((b) => cellsOf(b.o, g)); }
  const n = count();
  const blocks: Blocks = {
    n, g,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), hgt: new Float32Array(n),
    bld: new Int32Array(n), ci: new Int16Array(n), cj: new Int16Array(n), cl: new Int16Array(n),
    grid: new Int32Array(plans.reduce((s, p, k) => s + p.ncx * p.ncz * data.buildings[k].lv, 0)).fill(-1),
    outer: new Uint8Array(n),
  };
  const buildings: Building[] = [];
  let bi = 0, goff = 0;
  data.buildings.forEach((b, k) => {
    const p = plans[k], lv = Math.max(1, b.lv), floorH = b.h / lv;
    // 바닥 = 칸 네 귀퉁이·가운데 지형 높이의 최댓값(언덕에 안 묻히게).
    // 맨 아래층은 가장 낮은 땅보다 한 층 더 아래까지 내려 시멘트 받침(lowY~baseY, 창문 없음)이 된다
    let baseY = -Infinity, lowY = Infinity;
    for (const [i, j] of p.cells) for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
      const y = heightAt(t, p.ox + (j + u) * g, p.oz + (i + v) * g);
      baseY = Math.max(baseY, y); lowY = Math.min(lowY, y);
    }
    lowY -= floorH;
    let cx = 0, cz = 0;
    for (const [x, z] of b.o) { cx += x; cz += z; }
    cx /= b.o.length; cz /= b.o.length;
    const start = bi;
    for (let l = 0; l < lv; l++) for (const [i, j] of p.cells) {
      blocks.x[bi] = p.ox + (j + 0.5) * g;
      blocks.z[bi] = p.oz + (i + 0.5) * g;
      blocks.y[bi] = l === 0 ? (lowY + baseY + floorH) / 2 : baseY + (l + 0.5) * floorH;
      blocks.hgt[bi] = l === 0 ? baseY + floorH - lowY : floorH;
      blocks.bld[bi] = k; blocks.ci[bi] = i; blocks.cj[bi] = j; blocks.cl[bi] = l;
      blocks.grid[goff + (l * p.ncz + i) * p.ncx + j] = bi;
      bi++;
    }
    // 같은 층 옆 칸이 건물 밖이면 그 면은 외벽이다 (층마다 칸 배치가 같다)
    const has = (i: number, j: number) => i >= 0 && i < p.ncz && j >= 0 && j < p.ncx && blocks.grid[goff + i * p.ncx + j] >= 0;
    for (let q = start; q < bi; q++) {
      const i = blocks.ci[q], j = blocks.cj[q];
      blocks.outer[q] = (has(i, j + 1) ? 0 : 1) | (has(i, j - 1) ? 0 : 2) | (has(i + 1, j) ? 0 : 4) | (has(i - 1, j) ? 0 : 8);
    }
    buildings.push({
      start, end: bi, ncx: p.ncx, ncz: p.ncz, nl: lv, gridOff: goff, floorH, baseY, hosp: b.hosp, name: b.n,
      cx, cz, topY: baseY + b.h,
      min: [p.ox, lowY, p.oz], max: [p.ox + p.ncx * g, baseY + b.h, p.oz + p.ncz * g],
      dead: 0, down: false,
    });
    goff += p.ncx * p.ncz * lv;
  });
  return { blocks, buildings };
}

// 지형판 밖으로 나무·차를 허용하는 여유분(m) (R75). 건물은 이 경계와 상관없다
export const EDGE = 10;

// 녹지 안에 시드 고정 나무 위치를 뿌린다 (건물 안·도로 위·지형판 ±EDGE 밖 제외)
export function placeTrees(data: HospitalData, t: Terrain, max: number, seed = 7) {
  const rand = rng(seed);
  const area = (p: XZ[]) => Math.abs(p.reduce((s, [x, z], i) => { const [x2, z2] = p[(i + 1) % p.length]; return s + x * z2 - x2 * z; }, 0)) / 2;
  const areas = data.green.map(area), total = areas.reduce((a, b) => a + b, 0) || 1;
  const want = Math.min(max, Math.round(total / 25));
  const pts: number[] = [];
  const ex = t.x0 + (t.nx - 1) * t.step + EDGE, ez = t.z0 + (t.nz - 1) * t.step + EDGE;   // 지형판 끝 + 여유분
  const bboxes = data.buildings.map((b) => {
    const xs = b.o.map((p) => p[0]), zs = b.o.map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  });
  // 점이 도로 폭 안인지
  const onRoad = (x: number, z: number) => data.roads.some((r) => r.p.some((a, i) => {
    const b = r.p[i + 1];
    if (!b) return false;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1;
    const s = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L));
    return Math.hypot(x - a[0] - s * dx, z - a[1] - s * dz) < r.w / 2 + 1.5;
  }));
  data.green.forEach((poly, k) => {
    const nWant = Math.round((want * areas[k]) / total);
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    for (let tries = 0, got = 0; got < nWant && tries < nWant * 6 && pts.length < max * 4; tries++) {
      const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0);
      if (x < t.x0 - EDGE || x > ex || z < t.z0 - EDGE || z > ez) continue;
      if (!pointInPoly(x, z, poly)) continue;
      if (bboxes.some((bb, bi) => x > bb[0] && x < bb[1] && z > bb[2] && z < bb[3] && pointInPoly(x, z, data.buildings[bi].o))) continue;
      if (onRoad(x, z)) continue;
      pts.push(x, heightAt(t, x, z), z, 0.7 + rand() * 0.6);
      got++;
    }
  });
  return Float32Array.from(pts); // [x, y, z, scale] × n
}

interface Rec {
  id: number;
  hp: Map<number, number>;                 // 블록 → 이전 HP
  terr: Map<number, [number, number]>;     // 지형 정점 → [이전 높이, 이전 그을림]
  trees: Set<number>;                      // 이 행동이 쓰러뜨린 나무
  score: number;
  combo?: boolean;                         // 이 행동이 콤보를 이미 올렸는지 (한 발 = 콤보 한 번)
}

// 밑둥을 잃고 한쪽으로 기우는 덩어리: 넘어갈 블록, 축 위치(px, py, pz), 넘어가는 수평 방향(dx, dz)
export interface Topple { act: number; k: number; blocks: number[]; px: number; py: number; pz: number; dx: number; dz: number }

export interface UndoResult { id: number; blocks: number[]; terrain: number[]; trees: number[] }

// 게임 한 판의 상태
export class World {
  t: Terrain;
  t0: Float32Array;
  scorch: Float32Array;
  blocks: Blocks;
  buildings: Building[];
  hp: Float32Array;
  trees: Float32Array;
  treeAlive: Uint8Array;
  score = 0;
  destroyed = 0;
  buildingsDown = 0;                       // 이름표 붙은 병원 건물만 센다
  nearbyDown = 0;                          // 그 밖의 주변 건물
  civilDown = 0;                           // 병원이 아닌 민간 건물(hosp===0)이 무너진 수. 점수는 주지 않고 경고·속보만 띄운다
  time = 0;
  scoreMul = 1;                            // 맵 크기 점수 배율 = √(REF_BLOCKS / 블록 수) (0.5~2). 제곱근이라 큰 맵도 중간 맵과 비슷한 속도로 랭크가 오른다(23-rank-combo.md)
  combo = 0;                               // 연속 타격 콤보: 무기가 직접 병원 블록을 깬 횟수(같은 순간·같은 한 발은 한 번)
  private comboT = -9;                     // 콤보가 마지막으로 오른 시각
  private hospKills = 0;                   // 지금까지 깬 병원 블록 수 (이번 타격에 깼는지 보는 용도)
  killed: number[] = [];                   // 폭발·타격으로 부서진 블록 (렌더러가 비운다)
  fallen: number[] = [];                   // 지지를 잃고 떨어지는 블록
  topples: Topple[] = [];                  // 기울며 넘어가는 덩어리 (렌더러가 비운다)
  private recent: [number, number][] = [];
  private recs: Rec[] = [];
  private nextId = 1;
  private touched = new Set<number>();
  private cell: Map<number, number[]> = new Map();   // 20m 칸 → 그 칸에 bbox가 걸친 건물 번호 (blockAt 후보 줄이기)

  constructor(data: HospitalData, opts: { maxBlocks?: number; maxTrees?: number } = {}) {
    this.t = makeTerrain({ ...data.terrain, h: [...flattenTowers(data.terrain, data.buildings)] });
    this.t0 = Float32Array.from(this.t.h);
    this.scorch = new Float32Array(this.t.h.length);
    const { blocks, buildings } = buildBlocks(data, this.t, opts.maxBlocks);
    this.blocks = blocks;
    this.buildings = buildings;
    this.hp = new Float32Array(blocks.n).fill(BLOCK_HP);
    this.scoreMul = Math.min(2, Math.max(0.5, Math.sqrt(REF_BLOCKS / Math.max(1, blocks.n))));
    this.trees = placeTrees(data, this.t, opts.maxTrees ?? 4000);
    this.treeAlive = new Uint8Array(this.trees.length / 4).fill(1);
    buildings.forEach((b, k) => {
      for (let i = Math.floor(b.min[2] / CELL); i <= Math.floor(b.max[2] / CELL); i++)
        for (let j = Math.floor(b.min[0] / CELL); j <= Math.floor(b.max[0] / CELL); j++) {
          const key = cellKey(i, j), l = this.cell.get(key);
          if (l) l.push(k); else this.cell.set(key, [k]);
        }
    });
  }

  // 점이 들어 있는 살아 있는 블록 번호, 없으면 -1. among이 있으면 그 건물들만, 없으면 점이 든 20m 칸의 건물만 본다
  blockAt(x: number, y: number, z: number, among?: number[]): number {
    const list = among ?? this.cell.get(cellKey(Math.floor(z / CELL), Math.floor(x / CELL)));
    if (!list) return -1;
    const B = this.blocks, g = B.g;
    for (let n = 0; n < list.length; n++) {
      const b = this.buildings[list[n]];
      if (y < b.min[1] || y >= b.max[1]) continue;
      const j = Math.floor((x - b.min[0]) / g), i = Math.floor((z - b.min[2]) / g);
      if (j < 0 || j >= b.ncx || i < 0 || i >= b.ncz) continue;
      // 0층은 받침(min[1])부터 baseY + floorH까지, 그 위는 한 층씩
      const l = y < b.baseY + b.floorH ? 0 : Math.floor((y - b.baseY) / b.floorH);
      if (l >= b.nl) continue;
      const q = B.grid[b.gridOff + (l * b.ncz + i) * b.ncx + j];
      if (q >= 0 && this.hp[q] > 0) return q;
    }
    return -1;
  }

  // 사용자 행동 하나의 기록을 연다
  begin(): number {
    const id = this.nextId++;
    this.recs.push({ id, hp: new Map(), terr: new Map(), trees: new Set(), score: 0 });
    if (this.recs.length > MAX_UNDO) this.recs.shift();
    return id;
  }

  canUndo() { return this.recs.length > 0; }

  // 아무것도 안 바뀐 기록이면 버린다 (헛손질 되돌리기 방지)
  dropIfEmpty(id: number) {
    const k = this.recs.findIndex((r) => r.id === id);
    const r = this.recs[k];
    if (r && !r.hp.size && !r.terr.size && !r.trees.size) this.recs.splice(k, 1);
  }

  private rec(id: number) { return this.recs.find((r) => r.id === id); }

  // 콤보 점수 배율 (최대 ×3)
  get comboMul() { return 1 + Math.min(this.combo, 60) / 30; }

  // 무기가 직접 병원 블록을 깼으면(h0 이후 늘었으면) 콤보 +1. 0.15초 안 거듭 타격과
  // 같은 한 발(기록 r)의 뒤 타격(중성자탄 링·열압력 펄스·자탄·다연장 로켓·벙커 기둥)은 한 번으로 친다. 소총은 누르는 동안 기록이 하나라 시간만 본다
  private bump(r: Rec | undefined, h0: number, rifle = false) {
    if (!r || this.hospKills === h0 || this.time - this.comboT < COMBO_SAME || (!rifle && r.combo)) return;
    this.combo++;
    this.comboT = this.time;
    r.combo = true;
  }

  private addScore(r: Rec | undefined, pts: number, mul = this.scoreMul) {
    pts = Math.round(pts * mul * this.comboMul);
    this.score += pts;
    if (r) r.score += pts;
    this.recent.push([this.time, pts]);
  }

  private setHp(r: Rec | undefined, i: number, v: number) {
    if (r && !r.hp.has(i)) r.hp.set(i, this.hp[i]);
    this.hp[i] = v;
  }

  // 블록 하나를 없앤다 (점수·무너짐 판정 포함). to는 렌더러에 넘길 목록 (killed·fallen·기울 덩어리)
  // pts가 있으면 맵 배율·병원 ×2 없이 그 점수만 준다 (소총)
  private kill(r: Rec | undefined, i: number, to: number[], pts?: number) {
    this.setHp(r, i, 0);
    const k = this.blocks.bld[i], b = this.buildings[k];
    b.dead++;
    this.destroyed++;
    if (b.hosp) this.hospKills++;
    // 민간 건물(hosp 0)은 블록·붕괴 보너스 모두 점수에 넣지 않는다
    if (b.hosp) { if (pts) this.addScore(r, pts, 1); else this.addScore(r, 20); }
    if (!b.down && b.dead >= 0.9 * (b.end - b.start)) {
      b.down = true;
      if (isLabeled(b)) this.buildingsDown++; else this.nearbyDown++;
      if (!b.hosp) this.civilDown++; else this.addScore(r, 5000);
    }
    to.push(i);
    this.touched.add(k);
  }

  // 블록 하나에 피해를 준다 (소총·떨어진 블록 부딪힘). pts는 이 피해로 깨진 블록의 고정 점수.
  // pts가 있는 것(소총)만 콤보를 올린다. 떨어진 블록 부딪힘은 pts 없이 불린다
  hitBlock(id: number, i: number, D: number, pts?: number) {
    if (this.hp[i] <= 0) return;
    const r = this.rec(id), nh = this.hp[i] - D, h0 = this.hospKills;
    if (nh <= 0) this.kill(r, i, this.killed, pts);
    else { this.setHp(r, i, nh); this.touched.add(this.blocks.bld[i]); }
    if (pts !== undefined) this.bump(r, h0, true);
    this.settle(r);
  }

  // 구 반경 안 블록에 감쇠 피해를 준다 (폭발물). only ≥ 0이면 그 건물에만 준다 (열압력탄 닫힌 공간 증폭)
  damageSphere(id: number, x: number, y: number, z: number, R: number, D: number, only = -1) {
    const r = this.rec(id), B = this.blocks, h0 = this.hospKills;
    this.buildings.forEach((b, k) => {
      if (only >= 0 && k !== only) return;
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dy = Math.max(b.min[1] - y, 0, y - b.max[1]), dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
      if (dx * dx + dy * dy + dz * dz >= R * R) return;
      for (let i = b.start; i < b.end; i++) {
        if (this.hp[i] <= 0) continue;
        const dmg = falloff(D, R, Math.hypot(B.x[i] - x, B.y[i] - y, B.z[i] - z));
        if (dmg <= 0) continue;
        const nh = this.hp[i] - dmg;
        if (nh <= 0) this.kill(r, i, this.killed);
        else this.setHp(r, i, nh);
      }
    });
    this.bump(r, h0);
    this.settle(r);
  }

  // 땅 위 고리(수평 거리 r0 ~ r1) 안 바깥벽 블록에 피해를 준다 (중성자탄 충격파).
  // 피해는 고리 기준 반경 R0에서 D, R0 + W에서 0으로 줄어든다 (falloff)
  damageRing(id: number, x: number, z: number, r0: number, r1: number, R0: number, W: number, D: number) {
    const r = this.rec(id), B = this.blocks, h0 = this.hospKills;
    this.buildings.forEach((b) => {
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
      const far = Math.hypot(Math.max(Math.abs(b.min[0] - x), Math.abs(b.max[0] - x)), Math.max(Math.abs(b.min[2] - z), Math.abs(b.max[2] - z)));
      if (Math.hypot(dx, dz) >= r1 || far < r0) return;
      for (let i = b.start; i < b.end; i++) {
        if (this.hp[i] <= 0 || !B.outer[i]) continue;
        const d = Math.hypot(B.x[i] - x, B.z[i] - z);
        if (d < r0 || d >= r1) continue;
        const dmg = falloff(D, W, Math.max(0, d - R0));
        if (dmg <= 0) continue;
        const nh = this.hp[i] - dmg;
        if (nh <= 0) this.kill(r, i, this.killed);
        else this.setHp(r, i, nh);
      }
    });
    this.bump(r, h0);
    this.settle(r);
  }

  // 벙커버스터: 건물 k에서 수평 반경 r 안 블록을 부순다.
  // ground=false면 지붕부터 바닥까지(탄 지나간 기둥, 폭발 파편으로), true면 1층만(받침을 없애 위층이 제자리에서 내려앉게, 제자리 낙하로)
  drill(id: number, k: number, x: number, z: number, r: number, ground = false) {
    const rec = this.rec(id), b = this.buildings[k], B = this.blocks, h0 = this.hospKills;
    for (let i = b.start; i < b.end; i++) {
      if (this.hp[i] > 0 && (!ground || B.cl[i] === 0) && Math.hypot(B.x[i] - x, B.z[i] - z) < r) this.kill(rec, i, ground ? this.fallen : this.killed);
    }
    this.bump(rec, h0);
    this.settle(rec);
  }

  // 피해받은 건물마다 땅에 닿은 층부터 6방향 BFS, 닿지 못한 블록은 떨어뜨린다
  private settle(r: Rec | undefined) {
    const touched = [...this.touched];
    this.touched.clear();
    for (const k of touched) {
      const tp = this.tilt(k), u = tp ? [] : this.unsupported(k);
      if (!tp) { for (const i of u) this.kill(r, i, this.fallen); continue; }
      // 기울면 1층 위 전부가 한 덩어리로 넘어간다. 1층 받침은 그루터기로 남는다
      const top: Topple = { ...tp, act: r?.id ?? 0, k, blocks: [] };
      for (const i of tp.blocks) this.kill(r, i, top.blocks);
      this.topples.push(top);
    }
    this.touched.clear();
  }

  // 건물 k가 밑둥을 잃어 한쪽으로 기우는지 본다. 기울면 넘어갈 블록·축·방향, 아니면 null
  // 위층 무게 중심이 남은 받침 바깥 모서리를 넘어서거나, 받침이 TILT_AT 넘게 사라지고 g/2 넘게 쏠리면 넘어간다.
  // 둘 다 아니면 기울지 않고 걸친 부분만 unsupported로 떨어진다 (부분 붕괴)
  tilt(k: number) {
    const b = this.buildings[k], B = this.blocks, hp = this.hp, g = B.g;
    if (b.nl < 3) return null;
    const top: number[] = [];
    let sx = 0, sz = 0, ns = 0, ng = 0, cx = 0, cz = 0;
    for (let i = b.start; i < b.end; i++) {
      // 1층은 받침(죽은 칸도 원래 바닥 넓이로 센다), 그 위 살아 있는 블록은 무게
      if (B.cl[i] === 0) { ng++; if (hp[i] > 0) { sx += B.x[i]; sz += B.z[i]; ns++; } continue; }
      if (hp[i] > 0) { top.push(i); cx += B.x[i]; cz += B.z[i]; }
    }
    if (top.length < 8 || !ns || ns === ng) return null;
    sx /= ns; sz /= ns; cx /= top.length; cz /= top.length;
    const L = Math.hypot(cx - sx, cz - sz);
    if (L < 1e-6) return null;
    const dx = (cx - sx) / L, dz = (cz - sz) / L;
    // 축: 넘어가는 쪽 가장 먼 받침의 바깥 모서리
    let far = -Infinity;
    for (let i = b.start; i < b.end && B.cl[i] === 0; i++) if (hp[i] > 0) far = Math.max(far, (B.x[i] - sx) * dx + (B.z[i] - sz) * dz);
    const s = far + g / 2;
    if (L <= s && ((ng - ns) / ng < TILT_AT || L < g / 2)) return null;
    return { blocks: top, px: sx + dx * s, py: b.baseY + b.floorH, pz: sz + dz * s, dx, dz };
  }

  // 건물 k에서 지지를 잃은 살아 있는 블록 목록.
  // 땅에 닿은 층부터 6방향 BFS. 단, 옆으로만 버티는 거리(span)는 약 6m까지만 허용해
  // 아래층이 사라진 긴 외팔보는 무너지게 한다 (위아래 이동은 span 유지, 옆 이동은 +1)
  unsupported(k: number): number[] {
    const b = this.buildings[k], B = this.blocks, hp = this.hp;
    const maxSpan = Math.max(1, Math.round(6 / B.g));
    const span = new Int16Array(b.end - b.start).fill(32767);
    const q: number[] = [];
    for (let i = b.start; i < b.end && B.cl[i] === 0; i++) if (hp[i] > 0) { span[i - b.start] = 0; q.push(i); }
    const at = (l: number, ii: number, j: number) =>
      l < 0 || l >= b.nl || ii < 0 || ii >= b.ncz || j < 0 || j >= b.ncx ? -1 : B.grid[b.gridOff + (l * b.ncz + ii) * b.ncx + j];
    // 더 짧은 span을 찾으면 다시 큐에 넣는다 (값이 maxSpan 이하라 반복 횟수가 작다)
    const relax = (n: number, v: number) => {
      if (n >= 0 && hp[n] > 0 && v <= maxSpan && v < span[n - b.start]) { span[n - b.start] = v; q.push(n); }
    };
    for (let h = 0; h < q.length; h++) {
      const i = q[h], s = span[i - b.start], l = B.cl[i], ii = B.ci[i], j = B.cj[i];
      relax(at(l + 1, ii, j), s); relax(at(l - 1, ii, j), s);
      relax(at(l, ii + 1, j), s + 1); relax(at(l, ii - 1, j), s + 1); relax(at(l, ii, j + 1), s + 1); relax(at(l, ii, j - 1), s + 1);
    }
    const out: number[] = [];
    for (let i = b.start; i < b.end; i++) if (hp[i] > 0 && span[i - b.start] > maxSpan) out.push(i);
    return out;
  }

  // 지형을 반경 안에서 smoothstep으로 파고 그을린다. 바뀐 정점 번호를 돌려준다
  crater(id: number, x: number, z: number, R: number, depth: number): number[] {
    const r = this.rec(id), t = this.t, rc = Math.max(R, t.step * 1.5), out: number[] = [];
    const j0 = Math.max(0, Math.floor((x - rc - t.x0) / t.step)), j1 = Math.min(t.nx - 1, Math.ceil((x + rc - t.x0) / t.step));
    const i0 = Math.max(0, Math.floor((z - rc - t.z0) / t.step)), i1 = Math.min(t.nz - 1, Math.ceil((z + rc - t.z0) / t.step));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const d = Math.hypot(t.x0 + j * t.step - x, t.z0 + i * t.step - z);
      if (d >= rc) continue;
      const s = 1 - d / rc, w = s * s * (3 - 2 * s), k = i * t.nx + j;
      if (r && !r.terr.has(k)) r.terr.set(k, [t.h[k], this.scorch[k]]);
      t.h[k] -= depth * w;
      this.scorch[k] = Math.min(0.75, Math.max(this.scorch[k], 0.25 + 0.5 * w));
      out.push(k);
    }
    return out;
  }

  // 반경 안 나무를 쓰러뜨린다. 바뀐 나무 번호를 돌려준다
  killTrees(id: number, x: number, z: number, R: number): number[] {
    const r = this.rec(id), out: number[] = [];
    for (let k = 0; k < this.treeAlive.length; k++) {
      if (!this.treeAlive[k] || Math.hypot(this.trees[k * 4] - x, this.trees[k * 4 + 2] - z) >= R) continue;
      this.treeAlive[k] = 0;
      r?.trees.add(k);
      out.push(k);
    }
    return out;
  }

  // 반직선이 처음 닿는 블록 또는 지형. 블록이 아니면 block = -1
  raycast(o: [number, number, number], d: [number, number, number], maxT = 4000): { t: number; block: number } | null {
    const B = this.blocks, half = B.g / 2;
    let best = Infinity, blk = -1;
    // 상자와 반직선의 진입 거리 (안 맞으면 Infinity)
    const slab = (mn: number[], mx: number[]) => {
      let t0 = 0, t1 = best;
      for (let a = 0; a < 3; a++) {
        const inv = 1 / d[a];
        let ta = (mn[a] - o[a]) * inv, tb = (mx[a] - o[a]) * inv;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return Infinity;
      }
      return t0;
    };
    for (const b of this.buildings) {
      if (b.down && b.dead === b.end - b.start) continue;
      if (slab(b.min, b.max) === Infinity) continue;
      for (let i = b.start; i < b.end; i++) {
        if (this.hp[i] <= 0) continue;
        const hh = B.hgt[i] / 2;
        const tt = slab([B.x[i] - half, B.y[i] - hh, B.z[i] - half], [B.x[i] + half, B.y[i] + hh, B.z[i] + half]);
        if (tt < best) { best = tt; blk = i; }
      }
    }
    // 지형: 1m 간격으로 내려가며 땅 밑에 들어간 첫 점을 찾고 이분법으로 다듬는다
    const t = this.t, xMax = t.x0 + (t.nx - 1) * t.step, zMax = t.z0 + (t.nz - 1) * t.step;
    const below = (s: number) => {
      const x = o[0] + d[0] * s, z = o[2] + d[2] * s;
      if (x < t.x0 || x > xMax || z < t.z0 || z > zMax) return false;
      return o[1] + d[1] * s <= heightAt(t, x, z);
    };
    for (let s = 1; s < Math.min(maxT, best); s += 1) {
      if (!below(s)) continue;
      let lo = s - 1, hi = s;
      for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (below(m)) hi = m; else lo = m; }
      if (hi < best) { best = hi; blk = -1; }
      break;
    }
    return best === Infinity ? null : { t: best, block: blk };
  }

  // 마지막 행동을 되돌린다
  undo(): UndoResult | null {
    const r = this.recs.pop();
    if (!r) return null;
    const ks = new Set<number>();
    for (const [i, v] of r.hp) { this.hp[i] = v; ks.add(this.blocks.bld[i]); }
    for (const [k, [h, s]] of r.terr) { this.t.h[k] = h; this.scorch[k] = s; }
    for (const k of r.trees) this.treeAlive[k] = 1;
    this.score -= r.score;
    this.combo = 0;
    for (const k of ks) {
      const b = this.buildings[k];
      let dead = 0;
      for (let i = b.start; i < b.end; i++) if (this.hp[i] <= 0) dead++;
      this.destroyed += dead - b.dead;
      const was = b.down ? 1 : 0;
      b.dead = dead;
      b.down = dead >= 0.9 * (b.end - b.start);
      if (isLabeled(b)) this.buildingsDown += (b.down ? 1 : 0) - was; else this.nearbyDown += (b.down ? 1 : 0) - was;
      if (!b.hosp) this.civilDown += (b.down ? 1 : 0) - was;
    }
    return { id: r.id, blocks: [...r.hp.keys()], terrain: [...r.terr.keys()], trees: [...r.trees] };
  }

  // 처음 상태로 전부 되돌린다
  restoreAll() {
    this.hp.fill(BLOCK_HP);
    this.t.h.set(this.t0);
    this.scorch.fill(0);
    this.treeAlive.fill(1);
    for (const b of this.buildings) { b.dead = 0; b.down = false; }
    this.score = this.destroyed = this.buildingsDown = this.nearbyDown = this.civilDown = 0;
    this.recs = [];
    this.recent = [];
    this.combo = 0;
    this.killed = [];
    this.fallen = [];
    this.topples = [];
  }

  // 최근 5초 점수와 콤보로 매긴 랭크. 매 프레임 불리므로 콤보 끊김도 여기서 본다
  rank(): Rank {
    while (this.recent.length && this.recent[0][0] < this.time - RANK_WINDOW) this.recent.shift();
    if (this.time - this.comboT > COMBO_GAP) this.combo = 0;
    return rankFor(this.recent.reduce((s, [, p]) => s + p, 0), this.combo);
  }
}
