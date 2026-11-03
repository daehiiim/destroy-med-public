// 병원에서 대피하는 사람·차 (R69 18-evacuees.md, R75~R78 20-evacuee-panic.md, R79~R82 21-evacuee-flow.md). 박스 InstancedMesh 두 개, 상태는 Float32Array, 프레임마다 행렬만 다시 쓴다
import * as THREE from 'three';
import type { HospitalData, XZ } from './types.ts';
import { EDGE, heightAt, type Building, type Terrain, type World } from './world.ts';

const PCOL = [0xf2f2ee, 0xf2f2ee, 0x6f9fd8, 0x5b8fcf, 0x33363d, 0x4a4038, 0x2c3a4f];   // 흰 가운·파랑 환자복·어두운 사복
const CCOL = [0xf4f4f4, 0x1c1d20, 0xa9adb3, 0xb3201c, 0xffffff, 0x6b6f75];            // 흰·검·은·빨강·구급차 흰·회색
const TAU = Math.PI * 2;

// blast가 돌려주는 죽은 사람·차 하나 (index.ts 파괴 연출용)
export interface Dead { x: number; y: number; z: number; car: boolean; color: THREE.Color }

// 도로 선 p의 s번째 구간을 시작점에서 u미터 간 점과 진행 방위(φ, local +z가 향할 각)를 out에 쓴다
export function along(p: XZ[], s: number, u: number, out: Float32Array) {
  const a = p[s], b = p[s + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  out[0] = a[0] + (dx * u) / L;
  out[1] = a[1] + (dz * u) / L;
  out[2] = Math.atan2(dx, dz);
}

// 구간 길이
const segLen = (p: XZ[], s: number) => Math.hypot(p[s + 1][0] - p[s][0], p[s + 1][1] - p[s][1]);

// 도로 선 p의 (s,u)에서 du미터(부호 있음) 옮긴 구간·거리를 w에 쓴다. 선 끝을 넘으면 false
function walk(p: XZ[], s: number, u: number, du: number, w: Float64Array) {
  u += du;
  if (du > 0) while (u > segLen(p, s)) { u -= segLen(p, s); if (++s >= p.length - 1) return false; }
  else while (u < 0) { if (--s < 0) return false; u += segLen(p, s); }
  w[0] = s; w[1] = u;
  return true;
}

// 각 a를 목표각 b 쪽으로 최단 방향, 최대 m라디안만 돌린 값
function turn(a: number, b: number, m: number) {
  let e = b - a;
  e -= Math.round(e / TAU) * TAU;
  return a + Math.max(-m, Math.min(m, e));
}

// instanceMatrix 배열의 k번째 칸에 Y축 회전 φ·크기 sc·위치를 쓴다 (sc=0이면 숨김)
function put(m: Float32Array, k: number, x: number, y: number, z: number, phi: number, sc: number) {
  const c = Math.cos(phi) * sc, s = Math.sin(phi) * sc, o = k * 16;
  m[o] = c; m[o + 1] = 0; m[o + 2] = -s; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = sc; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = s; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}

export class Evacuees {
  people: THREE.InstancedMesh;
  cars: THREE.InstancedMesh;
  // 땅 + 잔해 더미 높이 (index.ts가 debris.groundAt을 연결). 없으면 지형 높이만 본다 (R82 막힌 도로 판정)
  ground?: (x: number, z: number) => number;
  private world: World;
  private data: HospitalData;
  private hosp: number[];        // 병원 건물(hosp=1) 번호
  private bin: number[];         // bbox 중심이 지형판 ±EDGE 안인 건물 번호 (병원이 다 무너졌을 때 나오기, 들어가기 목표)
  private roads: number[];       // 차가 다닐 도로 번호 (40m 이상, 지형판 ±EDGE 안 꼭짓점이 있는 것)
  private ent: number[][] = [];  // 진입점 [도로, 구간, 구간 안 거리, 안쪽 방향] (R79)
  private jn: number[][];        // 도로 끝(도로*2+끝) → 이어진 [도로, 꼭짓점, …] (교차로 갈아타기)
  private h0: Terrain;           // 처음 지형 높이 (막힌 도로 판정 기준)
  private bx0: number; private bx1: number; private bz0: number; private bz1: number;   // 지도 범위
  private np: number;            // 일반 사람 수. 그 뒤 칸은 건물 탈출용 예비 슬롯 (R78)
  // 사람: x, z, 진행각, 속도, 남은 거리, 숨김 초(예비 대기는 Infinity), 도망 초, 도망 목표각
  private px: Float32Array; private pz: Float32Array; private pa: Float32Array; private ps: Float32Array;
  private pl: Float32Array; private pw: Float32Array; private pr: Float32Array; private pt: Float32Array;
  // 사람 반응 대기: 남은 지연 초, 지연 뒤 도망 초, 지연 뒤 목표각 / 예비 슬롯이 나올 건물 번호(-1 없음)
  private pq: Float32Array; private pn: Float32Array; private pg: Float32Array; private pb: Int32Array;
  // 사람 들어가기(R80): 목표 건물 번호(-1 아님, -2 고를 건물 없음), 남은 제한 초
  private pe: Int32Array; private pk: Float32Array;
  // 차: 도로, 구간, 구간 안 거리(m), 방향 ±1, 속도, 숨김 초, 도망 초
  private cr: Int32Array; private cs: Int32Array; private cu: Float32Array; private cd: Int8Array;
  private cv: Float32Array; private cw: Float32Array; private cf: Float32Array;
  // 차: 부호 있는 현재 속도, 그리는 방위, 반응 남은 지연 초, 지연 뒤 도망 초, 지연 뒤 방향
  private cvel: Float32Array; private ch: Float32Array; private cq: Float32Array; private cn: Float32Array; private cg: Int8Array;
  private cut: Uint8Array;        // 차: U턴 중이면 1 (끝날 때까지 천천히 돈다)
  private cp: Int32Array;         // 차: 바로 전에 달린 도로 (교차로에서 되돌아가지 않게, -1 없음)
  private tmp = new Float32Array(3);
  private ahead = new Float32Array(3);   // 차 앞길 확인용 점
  private wk = new Float64Array(2);
  private tick = 0;
  private panic = 0.7;           // 첫 폭발 전에는 천천히, 뒤로는 1

  constructor(world: World, data: HospitalData, touch: boolean) {
    this.world = world;
    this.data = data;
    const np = touch ? 150 : 400, N = np + (touch ? 60 : 150), nc = touch ? 20 : 50, t = world.t;
    this.np = np;
    this.bx0 = t.x0; this.bz0 = t.z0; this.bx1 = t.x0 + (t.nx - 1) * t.step; this.bz1 = t.z0 + (t.nz - 1) * t.step;
    this.h0 = { ...t, h: Float32Array.from(t.h) };
    this.hosp = world.buildings.flatMap((b, k) => (b.hosp ? [k] : []));
    this.bin = world.buildings.flatMap((b, k) => (this.inMap((b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2) ? [k] : []));
    this.roads = data.roads.flatMap((r, k) => {
      let L = 0;
      for (let s = 0; s + 1 < r.p.length; s++) L += segLen(r.p, s);
      return L >= 40 && r.p.some(([x, z]) => this.inMap(x, z)) ? [k] : [];
    });
    // 진입점: 끝이 지도 밖인 도로 끝에서 안쪽으로 2m씩 걸어 처음 지도 안에 드는 지점
    const o = this.tmp, w = this.wk;
    for (const r of this.roads) {
      const p = data.roads[r].p, n = p.length;
      for (const dir of [1, -1]) {
        const e = dir > 0 ? p[0] : p[n - 1];
        if (this.inMap(e[0], e[1])) continue;
        let s = dir > 0 ? 0 : n - 2, u = dir > 0 ? 0 : segLen(p, n - 2);
        while (walk(p, s, u, 2 * dir, w)) {
          s = w[0]; u = w[1];
          along(p, s, u, o);
          if (this.inMap(o[0], o[1])) { this.ent.push([r, s, u, dir]); break; }
        }
      }
    }
    // 교차로: 도로 끝마다 3m 안에 꼭짓점이 있는 다른 도로와 그 꼭짓점 (도로마다 가장 가까운 것 하나)
    this.jn = Array.from({ length: data.roads.length * 2 }, () => []);
    for (const r of this.roads) for (let e = 0; e < 2; e++) {
      const p = data.roads[r].p, [ex, ez] = e ? p[p.length - 1] : p[0], L = this.jn[r * 2 + e];
      for (const q of this.roads) {
        if (q === r) continue;
        let best = -1, bd = 9;
        data.roads[q].p.forEach(([x, z], v) => { const d = (x - ex) ** 2 + (z - ez) ** 2; if (d < bd) { bd = d; best = v; } });
        if (best >= 0) L.push(q, best);
      }
    }
    const F = () => new Float32Array(N);
    this.px = F(); this.pz = F(); this.pa = F(); this.ps = F(); this.pl = F(); this.pw = F(); this.pr = F(); this.pt = F();
    this.pq = F(); this.pn = F(); this.pg = F(); this.pb = new Int32Array(N).fill(-1);
    this.pe = new Int32Array(N).fill(-1); this.pk = F();
    this.cr = new Int32Array(nc); this.cs = new Int32Array(nc); this.cu = new Float32Array(nc); this.cd = new Int8Array(nc);
    this.cv = new Float32Array(nc); this.cw = new Float32Array(nc); this.cf = new Float32Array(nc);
    this.cvel = new Float32Array(nc); this.ch = new Float32Array(nc); this.cq = new Float32Array(nc); this.cn = new Float32Array(nc); this.cg = new Int8Array(nc); this.cut = new Uint8Array(nc);
    this.cp = new Int32Array(nc).fill(-1);

    const make = (geo: THREE.BoxGeometry, n: number, cols: number[]) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), Math.max(1, n));
      m.castShadow = m.receiveShadow = false;
      m.frustumCulled = false;   // 인스턴스가 계속 움직여 경계 구가 금방 틀린다
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const c = new THREE.Color();
      for (let k = 0; k < n; k++) m.setColorAt(k, c.setHex(cols[(k * 7 + (k >> 2)) % cols.length]));
      m.count = n;
      return m;
    };
    this.people = make(new THREE.BoxGeometry(0.5, 1.7, 0.5), N, PCOL);
    this.cars = make(new THREE.BoxGeometry(1.8, 1.4, 4.3), this.roads.length ? nc : 0, CCOL);

    // 대피가 이미 시작된 느낌: 나온 뒤 경로의 0~70%를 이미 걸어간 상태로 시작(지형판 밖까지 갔으면 건물 앞). 예비 슬롯은 숨긴 채 대기
    for (let i = 0; i < np; i++) {
      this.spawnPerson(i);
      const d = Math.random() * this.pl[i] * 0.7, x = this.px[i] + Math.cos(this.pa[i]) * d, z = this.pz[i] + Math.sin(this.pa[i]) * d;
      if (x < this.bx0 || x > this.bx1 || z < this.bz0 || z > this.bz1) continue;
      this.px[i] = x; this.pz[i] = z; this.pl[i] -= d;
    }
    this.pw.fill(Infinity, np);
    // 처음에만 도로 중간에 흩어 놓는다 (이미 달리는 느낌). 그 뒤로는 진입점에서만 들어온다
    for (let i = 0; i < this.cars.count; i++) this.spawnCar(i, true);
    this.update(1e-3);
  }

  // 점이 지형판 ±EDGE 안인지
  private inMap(x: number, z: number) {
    return x >= this.bx0 - EDGE && x <= this.bx1 + EDGE && z >= this.bz0 - EDGE && z <= this.bz1 + EDGE;
  }

  // 사람 i를 건물 b의 bbox 테두리 바로 바깥, 각 a 방향에 두고 그쪽을 보게 한다
  private rim(i: number, b: Building, a: number) {
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, hx = (b.max[0] - b.min[0]) / 2, hz = (b.max[2] - b.min[2]) / 2;
    const c = Math.cos(a), s = Math.sin(a);
    const r = Math.min(hx / Math.max(Math.abs(c), 1e-3), hz / Math.max(Math.abs(s), 1e-3)) + 1.5;
    this.px[i] = cx + c * r; this.pz[i] = cz + s * r; this.pa[i] = this.pt[i] = a;
  }

  // 목록에서 무너지지 않은 건물 하나를 무작위로 고른다 (없으면 -1)
  private pick(list: number[]) {
    const B = this.world.buildings;
    let n = 0;
    for (const k of list) if (!B[k].down) n++;
    n = Math.floor(Math.random() * n);
    for (const k of list) if (!B[k].down && n-- === 0) return k;
    return -1;
  }

  // 사람 i를 무너지지 않은 병원 건물(없으면 지도 안 아무 건물) 둘레에서 바깥쪽을 보고 내보낸다 (R80·R81).
  // 나올 건물이 하나도 없으면 숨긴 채 1초 뒤 다시 시도
  private spawnPerson(i: number) {
    this.ps[i] = 1.2 + Math.random() * 0.6;
    this.pl[i] = 100 + Math.random() * 100;
    this.pw[i] = 0; this.pr[i] = 0; this.pq[i] = 0; this.pe[i] = -1;
    let k = this.pick(this.hosp);
    if (k < 0) k = this.pick(this.bin);
    if (k < 0) { this.pw[i] = 1; return; }
    this.rim(i, this.world.buildings[k], Math.random() * TAU);
  }

  // 예비 슬롯 i를 대기로 돌린다 (숨김, 나올 건물 없음)
  private idle(i: number) {
    this.pw[i] = Infinity; this.pb[i] = -1; this.pq[i] = 0; this.pe[i] = -1;
  }

  // 사람 i를 숨긴다(건물로 들어감·지형판 밖). 일반 슬롯은 2~6초 뒤 다른 건물에서 다시 나오고, 예비 슬롯은 대기로
  private hide(i: number) {
    if (i < this.np) { this.pw[i] = 2 + Math.random() * 4; this.pe[i] = -1; } else this.idle(i);
  }

  // 사람 i가 들어갈 가장 가까운(bbox 거리) 무너지지 않은 지도 안 건물을 골라 적고 돌려준다. 없으면 -2 (걷다가 지형판 밖에서 사라짐)
  private enter(i: number) {
    const B = this.world.buildings, x = this.px[i], z = this.pz[i];
    let best = -2, bd = Infinity;
    for (const k of this.bin) {
      const b = B[k];
      if (b.down) continue;
      const ex = Math.max(b.min[0] - x, 0, x - b.max[0]), ez = Math.max(b.min[2] - z, 0, z - b.max[2]), d = ex * ex + ez * ez;
      if (d < bd) { bd = d; best = k; }
    }
    // 제한 시간은 20초 + 천천히 걸어 닿는 시간 (멀리서 고른 건물에 가는 도중 숨지 않게)
    this.pk[i] = 20 + Math.sqrt(bd) / (this.ps[i] * 0.7);
    return (this.pe[i] = best);
  }

  // 점이 막혔는지: 처음 높이보다 0.8m 넘게 파였거나 잔해가 쌓였다 (R82)
  private blocked(x: number, z: number) {
    return Math.abs((this.ground ? this.ground(x, z) : heightAt(this.world.t, x, z)) - heightAt(this.h0, x, z)) > 0.8;
  }

  // 도로 r의 (s,u)에서 dir 쪽 처음 8m(2m 간격)에 막힌 점이 없는지
  private passable(r: number, s: number, u: number, dir: number) {
    const p = this.data.roads[r].p, o = this.tmp, w = this.wk;
    for (let d = 0; d <= 8; d += 2) {
      if (d) { if (!walk(p, s, u, 2 * dir, w)) return true; s = w[0]; u = w[1]; }
      along(p, s, u, o);
      if (this.blocked(o[0], o[1])) return false;
    }
    return true;
  }

  // 차 i를 도로 r의 (s,u)에 dir 방향으로 올린다
  private place(i: number, r: number, s: number, u: number, dir: number) {
    along(this.data.roads[r].p, s, u, this.tmp);
    this.cr[i] = r; this.cs[i] = s; this.cu[i] = u; this.cd[i] = this.cg[i] = dir; this.cp[i] = -1;
    this.cw[i] = 0; this.cf[i] = 0; this.cq[i] = 0;
    this.cv[i] = 8 + Math.random() * 6;
    this.cvel[i] = dir * this.cv[i] * this.panic;
    this.ch[i] = dir > 0 ? this.tmp[2] : this.tmp[2] + Math.PI; this.cut[i] = 0;
  }

  // 차 i를 진입점(지도 가장자리)에서 안쪽으로 들여보낸다 (R79). mid거나 진입점이 없는 맵이면 도로 중간 지도 안 지점에.
  // 고른 진입점 처음 8m가 막혔거나 8번 뽑아 실패하면 숨긴 채 0.5초 뒤 다시 시도
  private spawnCar(i: number, mid = false) {
    const o = this.tmp;
    for (let n = 0; n < 8; n++) {
      if (!mid && this.ent.length) {
        const e = this.ent[Math.floor(Math.random() * this.ent.length)];
        if (this.passable(e[0], e[1], e[2], e[3])) return this.place(i, e[0], e[1], e[2], e[3]);
        continue;
      }
      const r = this.roads[Math.floor(Math.random() * this.roads.length)], p = this.data.roads[r].p;
      const s = Math.floor(Math.random() * (p.length - 1)), u = Math.random() * segLen(p, s);
      along(p, s, u, o);
      if (this.inMap(o[0], o[1])) return this.place(i, r, s, u, Math.random() < 0.5 ? 1 : -1);
    }
    this.cw[i] = 0.5;
  }

  // 도로 끝(key = 도로*2+끝)에서 이어진 도로 하나로 차 i를 옮긴다. 방금 온 도로는 다른 길이 있으면 피하고,
  // 처음 8m가 막힌 길은 뺀다. 속도 크기와 그리는 방위는 이어받는다. 갈 길이 없으면 false
  private transfer(i: number, key: number) {
    const L = this.jn[key], m = L.length >> 1, k0 = Math.floor(Math.random() * m);
    for (let pass = 0; pass < 2; pass++) for (let n = 0; n < m; n++) {
      const q = ((k0 + n) % m) * 2, r = L[q], v = L[q + 1];
      if ((r === this.cp[i]) !== (pass === 1)) continue;   // 첫 바퀴는 온 도로 빼고, 둘째 바퀴는 온 도로만
      const p = this.data.roads[r].p, last = p.length - 1, mid = v > 0 && v < last;
      let dir = v === 0 ? 1 : v === last ? -1 : Math.random() < 0.5 ? 1 : -1;
      for (let t = 0; t < (mid ? 2 : 1); t++, dir = -dir) {
        const s = dir > 0 ? v : v - 1, u = dir > 0 ? 0 : segLen(p, s);
        if (!this.passable(r, s, u, dir)) continue;
        this.cg[i] = this.cg[i] === this.cd[i] ? dir : -dir;   // 밀린 반응(뒤집기 여부)은 새 도로 방향 기준으로
        this.cp[i] = this.cr[i]; this.cr[i] = r; this.cs[i] = s; this.cu[i] = u; this.cd[i] = dir;
        this.cvel[i] = Math.abs(this.cvel[i]) * dir;
        return true;
      }
    }
    return false;
  }

  // 폭발(소총은 R=0): 죽는 반경 안은 숨겼다 다시 내보내고 목록으로 돌려준다(R77).
  // 들리는 반경 H 안은 소리가 닿는 지연 뒤 폭발 반대쪽으로 도망(R76). emerge면 근처 건물에서 예비 사람이 뛰어나온다(R78)
  blast(x: number, z: number, R: number, emerge = true): Dead[] {
    this.panic = 1;
    const out: Dead[] = [], H = Math.max(4 * R, 50 + 8 * R), H2 = H * H, t = this.world.t;
    const kp = Math.max(R, 1.5) ** 2, kc = (R + 2.5) ** 2;
    for (let i = 0; i < this.px.length; i++) {
      if (this.pw[i] > 0) continue;
      const dx = this.px[i] - x, dz = this.pz[i] - z, d2 = dx * dx + dz * dz;
      if (d2 < kp) {
        out.push({ x: this.px[i], y: heightAt(t, this.px[i], this.pz[i]) + 0.85, z: this.pz[i], car: false, color: this.people.getColorAt(i, new THREE.Color()) });
        if (i < this.np) this.pw[i] = 6 + Math.random() * 6; else this.idle(i);
      } else if (d2 < H2) {
        const d = Math.sqrt(d2), wait = d / 340 + 0.15 + Math.random() * 0.45;
        // 이미 반응 대기 중이면 더 이른 지연을 지킨다 (중성자탄 충격파가 매 프레임 불러도 반응이 밀리지 않게)
        this.pn[i] = Math.max(this.pq[i] > 0 ? this.pn[i] : 0, 3 + 5 * (1 - d / H) + Math.random() * 1.5);
        this.pq[i] = this.pq[i] > 0 ? Math.min(this.pq[i], wait) : wait;
        this.pg[i] = Math.atan2(dz, dx) + (Math.random() - 0.5) * 0.6;
      }
    }
    const o = this.tmp;
    for (let i = 0; i < this.cars.count; i++) {
      if (this.cw[i] > 0) continue;
      along(this.data.roads[this.cr[i]].p, this.cs[i], this.cu[i], o);
      const dx = o[0] - x, dz = o[1] - z, d2 = dx * dx + dz * dz;
      if (d2 < kc) {
        out.push({ x: o[0], y: heightAt(t, o[0], o[1]) + 0.7, z: o[1], car: true, color: this.cars.getColorAt(i, new THREE.Color()) });
        this.cw[i] = 6 + Math.random() * 6;
      } else if (d2 < H2) {
        const d = Math.sqrt(d2), wait = d / 340 + 0.15 + Math.random() * 0.45;
        this.cn[i] = Math.max(this.cq[i] > 0 ? this.cn[i] : 0, 3 + 5 * (1 - d / H) + Math.random() * 1.5);
        this.cq[i] = this.cq[i] > 0 ? Math.min(this.cq[i], wait) : wait;
        // 폭발 쪽으로 가던 차는 지연 뒤 방향만 뒤집는다 → 서서히 서고 반대로 출발
        this.cg[i] = (Math.sin(o[2]) * dx + Math.cos(o[2]) * dz) * this.cd[i] < 0 ? -this.cd[i] : this.cd[i];
      }
    }
    if (!emerge) return out;
    // 무너지지 않은 건물 중 bbox가 R+1 안인 것마다 예비 사람을 0.1~1.5초에 걸쳐 건물 둘레 사방에서 내보내 폭발 반대쪽으로 뛰게 한다 (한 번에 24명 상한)
    // 폭발 반대쪽 면에서만 나오면 카메라 쪽에서 건물에 가려 안 보여 둘레 전체에서 낸다
    const B = this.world.buildings, N = this.px.length, rr = (R + 1) ** 2;
    let left = 24, j = this.np;
    for (let k = 0; k < B.length && left > 0 && j < N; k++) {
      const b = B[k];
      if (b.down) continue;
      const ex = Math.max(b.min[0] - x, 0, x - b.max[0]), ez = Math.max(b.min[2] - z, 0, z - b.max[2]);
      if (ex * ex + ez * ez >= rr) continue;
      let n = Math.min(left, R > 0 ? Math.min(12, Math.floor(3 + R / 2)) : Math.random() < 0.3 ? 1 : 0);
      for (; n > 0 && j < N; j++) {
        if (this.pw[j] !== Infinity) continue;
        this.rim(j, b, Math.random() * TAU);
        this.pa[j] = this.pt[j] = Math.atan2(this.pz[j] - z, this.px[j] - x) + (Math.random() - 0.5) * 0.6;
        const d = Math.hypot(this.px[j] - x, this.pz[j] - z);
        this.ps[j] = 1.2 + Math.random() * 0.6; this.pl[j] = 60 + Math.random() * 60; this.pq[j] = 0; this.pe[j] = -1;
        this.pr[j] = 3 + 5 * Math.max(0, 1 - d / H) + Math.random() * 1.5;
        this.pb[j] = k; this.pw[j] = 0.1 + Math.random() * 1.4;
        n--; left--;
      }
    }
    return out;
  }

  // 한 프레임: 걷기·달리기를 진행하고 인스턴스 행렬을 다시 쓴다 (dt=0이면 그대로)
  update(dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    const t = this.world.t, B = this.world.buildings, pm = this.people.instanceMatrix.array as Float32Array, check = this.tick++ & 7;
    for (let i = 0; i < this.px.length; i++) {
      if (this.pw[i] > 0) {
        this.pw[i] -= dt;
        // 일반 슬롯은 건물에서 다시 나오고, 예비 슬롯은 나올 건물이 아직 서 있으면 그 자리에 나타나고 아니면 대기로
        if (this.pw[i] <= 0) {
          if (i < this.np) this.spawnPerson(i);
          else if (this.pb[i] < 0 || B[this.pb[i]].down) this.idle(i);
          else this.pb[i] = -1;
        }
        if (this.pw[i] > 0) { put(pm, i, 0, -1e4, 0, 0, 0); continue; }
      }
      // 소리가 닿아 반응 지연이 끝나면 도망 시작
      if (this.pq[i] > 0) {
        this.pq[i] -= dt;
        if (this.pq[i] <= 0) { this.pt[i] = this.pg[i]; this.pr[i] = Math.max(this.pr[i], this.pn[i]); }
      }
      const run = this.pr[i] > 0;
      let e = this.pe[i];
      // 도망 중엔 들어가기를 멈추고(초당 2.5rad 이하로 돈다), 도망이 끝나면 그때 자리에서 목표를 새로 고른다
      if (run) { this.pr[i] -= dt; this.pa[i] = turn(this.pa[i], this.pt[i], 2.5 * dt); e = this.pe[i] = -1; }
      else {
        const x = this.px[i], z = this.pz[i];
        // 걷기 거리가 다 됐거나 지형판 가장자리 15m 안이면 들어가기 시작, 목표가 무너졌으면 다시 고른다 (R80·R81)
        if ((e === -1 && (this.pl[i] <= 0 || x < this.bx0 + 15 || x > this.bx1 - 15 || z < this.bz0 + 15 || z > this.bz1 - 15)) || (e >= 0 && B[e].down)) e = this.enter(i);
        if (e >= 0) {
          const b = B[e], cx = (b.min[0] + b.max[0]) / 2 - x, cz = (b.min[2] + b.max[2]) / 2 - z;
          this.pt[i] = Math.atan2(cz, cx); this.pa[i] = turn(this.pa[i], this.pt[i], 2.5 * dt);
          // bbox 중심 2m 안(ㄱ자처럼 중심이 빈 땅)이거나 제한 시간이 지나면 그 자리에서 숨는다
          if ((this.pk[i] -= dt) <= 0 || cx * cx + cz * cz < 4) { this.hide(i); put(pm, i, 0, -1e4, 0, 0, 0); continue; }
        } else this.pa[i] += (Math.random() - 0.5) * dt * 2;   // 살짝 흔들리는 걸음
      }
      const v = run ? this.ps[i] * 3.33 : this.ps[i] * this.panic, step = v * dt;   // 뛰면 4~6m/s
      let a = this.pa[i], x = this.px[i] + Math.cos(a) * step, z = this.pz[i] + Math.sin(a) * step;
      // 8프레임에 한 번 앞을 본다. 들어가는 중이면 1m 앞이 무너지지 않은 건물 블록일 때 그 건물로 들어가 숨고,
      // 아니면 2m 앞이 살아 있는 블록일 때 90도 튼다 (목표각도 같이 돌려 벽 쪽으로 되돌아가지 않게)
      if ((i & 7) === check) {
        const f = e >= 0 ? 1 : 2, q = this.world.blockAt(x + Math.cos(a) * f, heightAt(t, x, z) + 0.8, z + Math.sin(a) * f);
        if (q >= 0 && e < 0) {
          const r = Math.random() < 0.5 ? 1.57 : -1.57;
          a = this.pa[i] = a + r; this.pt[i] += r;
        } else if (q >= 0 && !B[this.world.blocks.bld[q]].down) { this.px[i] = x; this.pz[i] = z; this.hide(i); put(pm, i, 0, -1e4, 0, 0, 0); continue; }
      }
      this.px[i] = x; this.pz[i] = z; this.pl[i] -= step;
      if (x < this.bx0 || x > this.bx1 || z < this.bz0 || z > this.bz1) { this.hide(i); put(pm, i, 0, -1e4, 0, 0, 0); continue; }
      put(pm, i, x, heightAt(t, x, z) + 0.85, z, 0, 1);
    }
    this.people.instanceMatrix.needsUpdate = true;

    if (!this.cars.count) return;
    const cm = this.cars.instanceMatrix.array as Float32Array, o = this.tmp, w = this.wk;
    for (let i = 0; i < this.cars.count; i++) {
      if (this.cw[i] > 0) {
        this.cw[i] -= dt;
        if (this.cw[i] <= 0) this.spawnCar(i);
        if (this.cw[i] > 0) { put(cm, i, 0, -1e4, 0, 0, 0); continue; }
      }
      if (this.cq[i] > 0) {
        this.cq[i] -= dt;
        if (this.cq[i] <= 0) { this.cd[i] = this.cg[i]; this.cf[i] = Math.max(this.cf[i], this.cn[i]); }
      }
      if (this.cf[i] > 0) this.cf[i] -= dt;
      // 목표 속도로 가속 4m/s², 감속 7m/s²
      const want = this.cd[i] * this.cv[i] * (this.cf[i] > 0 ? 1.6 : this.panic), e = want - this.cvel[i];
      const acc = (this.cvel[i] * e >= 0 ? 4 : 7) * dt, du = (this.cvel[i] += Math.max(-acc, Math.min(acc, e))) * dt;
      let p = this.data.roads[this.cr[i]].p, s = this.cs[i], u = this.cu[i];
      // 구간 넘김은 이번 프레임 이동량 부호로 (U턴 중에는 cd와 실제 진행 방향이 다르다)
      if (walk(p, s, u, du, w)) { s = w[0]; u = w[1]; }
      else {
        // 도로 끝: 지도 밖이면 사라지고, 안이면 이어진 도로로 갈아타거나 막다른 길에서 서서 돌아선다(U턴은 cut 흐름)
        const end = du > 0, ep = end ? p[p.length - 1] : p[0];
        if (!this.inMap(ep[0], ep[1])) { this.cw[i] = 0.5 + Math.random() * 2.5; put(cm, i, 0, -1e4, 0, 0, 0); continue; }
        if (this.transfer(i, this.cr[i] * 2 + (end ? 1 : 0))) { p = this.data.roads[this.cr[i]].p; s = this.cs[i]; u = this.cu[i]; }
        else { s = end ? p.length - 2 : 0; u = end ? segLen(p, s) : 0; this.cd[i] = this.cg[i] = end ? -1 : 1; this.cvel[i] = 0; }
      }
      along(p, s, u, o);
      // 지도 밖으로 나가면 사라지고 0.5~3초 뒤 진입점에서 다시 들어온다
      if (!this.inMap(o[0], o[1])) { this.cw[i] = 0.5 + Math.random() * 2.5; put(cm, i, 0, -1e4, 0, 0, 0); continue; }
      this.cs[i] = s; this.cu[i] = u;
      // 8프레임에 한 번(차마다 엇갈려) 도로를 따라 8m+제동 거리 앞을 본다(R82). 도로 중심이 막혔거나(크레이터·잔해)
      // 그 안에 이어진 길 없는 막다른 끝이 있으면 미리 감속→U턴한다(끝에서 급정거하지 않게). 이미 돌아서는 중이면 그대로
      if ((i & 7) === check && !this.cut[i] && this.cvel[i] * this.cd[i] > 0) {
        const L = 8 + this.cvel[i] ** 2 / 14, d = this.cd[i], a = this.ahead;
        let stop: boolean;
        if (walk(p, s, u, d * L, w)) { along(p, w[0], w[1], a); stop = this.blocked(a[0], a[1]); }
        else { const ep = d > 0 ? p[p.length - 1] : p[0]; stop = this.inMap(ep[0], ep[1]) && !this.jn[this.cr[i] * 2 + (d > 0 ? 1 : 0)].length; }
        if (stop) this.cd[i] = this.cg[i] = -d;
      }
      // 그리는 방위는 진행 방향(거의 서 있으면 cd)을 따라간다. U턴(100° 넘게 차이로 시작)은 끝날 때까지 초당 2rad, 길 모퉁이는 초당 6rad. 오른쪽 차로 오프셋도 그 방위 기준이라 U턴하듯 건너간다
      const fwd = Math.abs(this.cvel[i]) > 0.5 ? this.cvel[i] : this.cd[i], aim = fwd > 0 ? o[2] : o[2] + Math.PI;
      const de = Math.abs(turn(this.ch[i], aim, 9) - this.ch[i]);
      if (de > 1.75) this.cut[i] = 1; else if (de < 0.05) this.cut[i] = 0;
      const phi = (this.ch[i] = turn(this.ch[i], aim, (this.cut[i] ? 2 : 6) * dt)), off = this.data.roads[this.cr[i]].w * 0.25;
      const x = o[0] - Math.cos(phi) * off, z = o[1] + Math.sin(phi) * off;
      put(cm, i, x, heightAt(t, x, z) + 0.7, z, phi, 1);
    }
    this.cars.instanceMatrix.needsUpdate = true;
  }

  // 전부 숨기고 다시 내보낼 때까지 잠시 쉰다 (예비 슬롯은 대기로, 밀린 반응은 취소)
  clear() {
    this.pw.fill(1); this.cw.fill(1); this.pb.fill(-1); this.pq.fill(0); this.cq.fill(0);
  }

  // 지오메트리·재질 해제 (장면에 넣었다면 index.ts dispose의 scene.traverse도 같은 일을 한다)
  dispose() {
    for (const m of [this.people, this.cars]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
  }
}
