// 움직이는 연출: 떨어지는 블록·파편, 잔해, 연기·먼지 빌보드, 불덩이, 불티, 충격파, 예광탄
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1);

// 중력으로 떨어지며 도는 상자들. 땅에 닿으면 land 콜백 후 사라진다.
// drag가 있으면 옆으로·위로 튀는 속도만 줄어 "팍 튀고 멈칫"하는 만화 같은 움직임이 된다. flash초 동안은 뜨거운 흰색에서 제 색으로 돌아온다
export class Flyers {
  mesh: THREE.InstancedMesh;
  n = 0;
  private cap: number;
  private drag: number;
  private flash: number;
  private age: Float32Array;
  private ttl: Float32Array;   // 인스턴스별 수명(초). 0이면 땅에 닿을 때까지
  private tag: Int32Array;     // 출신 건물 번호 (-1이면 없음). 부딪힘 판정에서 제 건물을 가린다
  // 한 개당 16칸: 위치3 속도3 회전3 각속도3 크기3 행동id
  private d: Float32Array;
  private col: Float32Array;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], cap: number, drag = 0, flash = 0) {
    this.cap = cap;
    this.drag = drag;
    this.flash = flash;
    this.age = new Float32Array(cap);
    this.ttl = new Float32Array(cap);
    this.tag = new Int32Array(cap);
    this.d = new Float32Array(cap * 16);
    this.col = new Float32Array(cap * 3);
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  // 하나 띄운다. rot(오일러 XYZ)이 없으면 무작위 회전, ttl초가 지나면 update의 expire로 넘긴다. tag는 출신 건물. 꽉 차면 false
  spawn(p: number[], v: number[], spin: number, size: number[], color: THREE.Color, act: number, rot?: number[], ttl = 0, tag = -1) {
    if (this.n >= this.cap) return false;
    const o = this.n * 16;
    this.d.set([...p, ...v, ...(rot ?? [Math.random() * 6, Math.random() * 6, Math.random() * 6]),
      (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, ...size, act], o);
    this.col.set([color.r, color.g, color.b], this.n * 3);
    this.age[this.n] = 0;
    this.ttl[this.n] = ttl;
    this.tag[this.n] = tag;
    this.n++;
    return true;
  }

  // k번째 정보 (위치, 속도, 크기, 행동id, 색, 출신 건물)
  get(k: number) {
    const o = k * 16, d = this.d;
    return { x: d[o], y: d[o + 1], z: d[o + 2], vx: d[o + 3], vy: d[o + 4], vz: d[o + 5], sx: d[o + 12], sy: d[o + 13], sz: d[o + 14], act: d[o + 15], color: _c.fromArray(this.col, k * 3), tag: this.tag[k] };
  }

  // 마지막 것과 바꿔 지운다
  private remove(k: number) {
    this.n--;
    this.d.copyWithin(k * 16, this.n * 16, this.n * 16 + 16);
    this.col.copyWithin(k * 3, this.n * 3, this.n * 3 + 3);
    this.age[k] = this.age[this.n];
    this.ttl[k] = this.ttl[this.n];
    this.tag[k] = this.tag[this.n];
  }

  // 벽에 맞아 튕긴다: 한 걸음 되돌리고 axis(0 x, 1 y, 2 z) 속도는 뒤집어 줄이고, 나머지 축과 회전은 늦춘다
  bounce(k: number, axis: number, dt: number) {
    const o = k * 16, d = this.d;
    for (let a = 0; a < 3; a++) {
      d[o + a] -= d[o + 3 + a] * dt;
      d[o + 3 + a] *= a === axis ? -0.35 : 0.7;
      d[o + 9 + a] *= 0.7;
    }
  }

  // 조건에 맞는 것을 모두 지운다 (되돌리기용)
  removeIf(pred: (act: number) => boolean) {
    for (let k = this.n - 1; k >= 0; k--) if (pred(this.d[k * 16 + 15])) this.remove(k);
  }

  // 한 프레임 움직이고 부딪힘·착지·수명 판정 후 행렬을 쓴다. collide가 true면 지우고, 땅에 먼저 닿으면 land, 공중에서 수명이 다하면 expire
  update(dt: number, ground: (x: number, z: number) => number, land: (k: number) => void, expire?: (k: number) => void, collide?: (k: number) => boolean) {
    const d = this.d, fr = Math.exp(-this.drag * dt);
    for (let k = this.n - 1; k >= 0; k--) {
      const o = k * 16;
      this.age[k] += dt;
      d[o + 3] *= fr; d[o + 5] *= fr;
      if (d[o + 4] > 0) d[o + 4] *= fr;
      d[o + 4] -= 9.8 * dt;
      for (let a = 0; a < 3; a++) { d[o + a] += d[o + 3 + a] * dt; d[o + 6 + a] += d[o + 9 + a] * dt; }
      if (collide && collide(k)) this.remove(k);
      else if (d[o + 1] - d[o + 13] / 2 <= ground(d[o], d[o + 2])) { land(k); this.remove(k); }
      else if (expire && this.ttl[k] > 0 && this.age[k] >= this.ttl[k]) { expire(k); this.remove(k); }
    }
    const ic = this.mesh.instanceColor!;
    for (let k = 0; k < this.n; k++) {
      const o = k * 16;
      _q.setFromEuler(_e.set(d[o + 6], d[o + 7], d[o + 8]));
      this.mesh.setMatrixAt(k, _m.compose(_p.fromArray(d, o), _q, _s.fromArray(d, o + 12)));
      const c = this.col, j = k * 3, w = this.flash ? Math.max(0, 1 - this.age[k] / this.flash) : 0;
      ic.setXYZ(k, c[j] + (1 - c[j]) * w, c[j + 1] + (0.85 - c[j + 1]) * w, c[j + 2] + (0.6 - c[j + 2]) * w);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    ic.needsUpdate = true;
  }
}

// 잔해 상자 고리 버퍼 (넘치면 가장 오래된 것부터 재사용) + 잔해 더미 높이 격자.
// 조각은 놓인 뒤 LIFE초쯤 지나 FADE초 동안 줄며 가라앉고 사라진다
const LIFE = 8, LIFE_RAND = 6, FADE = 1.5;
const KEEP = 0.35;   // 사라지지 않고 남는 잔해 비율
export class Debris {
  mesh: THREE.InstancedMesh;
  private alive = 0;
  private cap: number;
  private act: Int32Array;     // 0이면 빈 칸
  private d: Float32Array;     // 칸마다 위치3 크기3 회전3
  private die: Float32Array;   // 사라지기 시작하는 시각
  private head = 0;
  private used = 0;
  private now = 0;
  private dirty = false;
  private rebuildT = 0;
  private pile: Float32Array;
  private pileMax: number;
  private terrainH: (x: number, z: number) => number;
  private gx0: number; private gz0: number; private gs: number; private gnx: number; private gnz: number;

  constructor(cap: number, bounds: { x0: number; z0: number; w: number; d: number }, cell: number, terrainH: (x: number, z: number) => number) {
    this.terrainH = terrainH;
    this.cap = cap;
    this.act = new Int32Array(cap);
    this.d = new Float32Array(cap * 9);
    this.die = new Float32Array(cap);
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }), cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.gx0 = bounds.x0; this.gz0 = bounds.z0; this.gs = cell;
    this.gnx = Math.ceil(bounds.w / cell) + 1; this.gnz = Math.ceil(bounds.d / cell) + 1;
    this.pile = new Float32Array(this.gnx * this.gnz);
    // 칸별 더미 높이 상한: 이보다 높이 쌓이지 않아 기둥이 안 생긴다
    this.pileMax = cell * 0.6;
  }

  private cell(x: number, z: number) {
    const j = Math.floor((x - this.gx0) / this.gs), i = Math.floor((z - this.gz0) / this.gs);
    return i < 0 || j < 0 || i >= this.gnz || j >= this.gnx ? -1 : i * this.gnx + j;
  }

  // 땅 + 잔해 더미 높이
  groundAt(x: number, z: number) {
    const c = this.cell(x, z);
    return this.terrainH(x, z) + (c < 0 ? 0 : this.pile[c]);
  }

  // 조각 하나의 윗면 높이를 더미 격자에 반영한다 (상한까지만)
  private raise(x: number, top: number, z: number) {
    const c = this.cell(x, z);
    if (c >= 0) this.pile[c] = Math.min(this.pileMax, Math.max(this.pile[c], top - this.terrainH(x, z)));
  }

  // k번째 행렬을 쓴다. f는 사라진 정도(0~1): 크기가 줄고 땅속으로 내려간다
  private write(k: number, f: number) {
    const o = k * 9, d = this.d, s = 1 - f;
    _q.setFromEuler(_e.set(d[o + 6], d[o + 7], d[o + 8]));
    this.mesh.setMatrixAt(k, _m.compose(_p.set(d[o], d[o + 1] - d[o + 4] * f, d[o + 2]), _q, _s.set(d[o + 3] * s, d[o + 4] * s, d[o + 5] * s)));
  }

  // 잔해 하나를 놓는다
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.Color, act: number) {
    const k = this.head;
    this.head = (this.head + 1) % this.cap;
    this.used = Math.min(this.cap, this.used + 1);
    if (!this.act[k]) this.alive++;
    this.d.set([x, y, z, sx, sy, sz, (Math.random() - 0.5) * 0.8, Math.random() * 6.28, (Math.random() - 0.5) * 0.8], k * 9);
    // 35%는 사라지지 않고 더미로 남는다(버퍼가 차면 가장 오래된 것부터 덮어쓴다)
    this.die[k] = Math.random() < KEEP ? Infinity : this.now + LIFE + Math.random() * LIFE_RAND;
    this.write(k, 0);
    this.mesh.setColorAt(k, color);
    this.act[k] = act;
    this.raise(x, y + sy * 0.4, z);
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  // k번째 조각을 비우고 숨긴다 (더미는 나중에 다시 계산)
  private kill(k: number) {
    this.act[k] = 0;
    this.alive--;
    this.mesh.setMatrixAt(k, _m.makeScale(0, 0, 0));
    this.dirty = true;
  }

  // 남은 조각으로 더미 높이를 다시 계산한다
  private rebuild() {
    this.dirty = false;
    this.pile.fill(0);
    const d = this.d;
    for (let k = 0; k < this.used; k++) if (this.act[k]) this.raise(d[k * 9], d[k * 9 + 1] + d[k * 9 + 4] / 2, d[k * 9 + 2]);
    // 남은 조각이 없으면 버퍼를 처음으로 되돌린다
    if (!this.alive) { this.head = this.used = 0; this.mesh.count = 0; }
  }

  // 한 프레임: 수명이 다한 조각만 줄이며 가라앉히고, 사라진 것이 있으면 0.5초마다 더미를 다시 계산한다
  update(dt: number) {
    this.now += dt;
    let wrote = false;
    for (let k = 0; k < this.used; k++) {
      if (!this.act[k]) continue;
      const f = (this.now - this.die[k]) / FADE;
      if (f < 0) continue;
      if (f >= 1) this.kill(k); else this.write(k, f * f);
      wrote = true;
    }
    if (wrote) this.mesh.instanceMatrix.needsUpdate = true;
    this.rebuildT -= dt;
    if (this.dirty && this.rebuildT <= 0) { this.rebuildT = 0.5; this.rebuild(); }
  }

  // 크레이터로 땅이 꺼진 반경 r 안의 조각을 새 땅 위로 내린다 (공중에 뜨지 않게). 올리지는 않는다
  settle(x: number, z: number, r: number) {
    const d = this.d;
    for (let k = 0; k < this.used; k++) {
      const o = k * 9;
      if (!this.act[k] || (d[o] - x) ** 2 + (d[o + 2] - z) ** 2 >= r * r) continue;
      d[o + 1] = Math.min(d[o + 1], this.terrainH(d[o], d[o + 2]) + d[o + 4] * 0.4);
      this.write(k, 0);
    }
    this.rebuild();
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // 한 행동이 만든 잔해를 지우고 더미 높이를 다시 계산한다
  removeAction(id: number) {
    for (let k = 0; k < this.used; k++) if (this.act[k] === id) this.kill(k);
    this.rebuild();
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // 전부 지운다
  clear() {
    this.act.fill(0); this.pile.fill(0);
    this.head = this.used = this.alive = 0;
    this.dirty = false;
    this.mesh.count = 0;
  }
}

// 둥근 연기 텍스처
export function puffTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// 뭉게뭉게한 연기 텍스처: 둥근 덩이 9개를 겹쳐 가장자리가 울퉁불퉁하고, 덩이 가장자리가 조금 어두워 부피감이 난다
export function smokeTexture() {
  const S = 128, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 9; k++) {
    // 덩이 중심 거리 0.2S + 반지름 0.3S 이하라 캔버스 밖으로 잘리지 않는다
    const a = rnd() * 6.28, d = k ? S * (0.06 + rnd() * 0.14) : 0, r = S * (0.2 + rnd() * 0.1);
    const cx = S / 2 + Math.cos(a) * d, cy = S / 2 + Math.sin(a) * d, gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.8)');
    gr.addColorStop(0.6, 'rgba(215,215,215,0.5)');
    gr.addColorStop(1, 'rgba(170,170,170,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  return new THREE.CanvasTexture(cv);
}

// 카메라를 바라보는 빌보드 입자 (연기·먼지·불꽃). 인스턴스별 투명도는 aAlpha 속성
// lowpoly면 빌보드 대신 면이 각진 공을 띄운다: 햇빛 쪽은 밝고 반대쪽은 어두워 연기에 두께가 생긴다
export class Particles {
  mesh: THREE.InstancedMesh;
  private cap: number;
  private n = 0;
  // 한 개당 14칸: 위치3 속도3 나이 수명 시작크기 끝크기 시작투명도 위로뜨는힘 회전 회전속도
  private d: Float32Array;
  private col: Float32Array;
  private alpha: THREE.InstancedBufferAttribute;
  private lowpoly: boolean;

  constructor(cap: number, additive: boolean, lowpoly = false) {
    this.lowpoly = lowpoly;
    this.cap = cap;
    this.d = new Float32Array(cap * 14);
    this.col = new Float32Array(cap * 3);
    // 각진 공 지름 0.9: 빌보드 그림의 흐린 가장자리를 뺀 덩이 크기와 비슷하게 맞춘다
    const geo = lowpoly ? new THREE.IcosahedronGeometry(0.45, 0) : new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = lowpoly
      ? new THREE.MeshLambertMaterial({ flatShading: true, transparent: true, depthWrite: false })
      : new THREE.MeshBasicMaterial({ map: smokeTexture(), transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  // 입자 하나를 낸다 (꽉 차면 무시)
  emit(p: number[], v: number[], life: number, s0: number, s1: number, a0: number, color: THREE.Color, lift = 0) {
    if (this.n >= this.cap) return;
    // 각진 연기 덩이는 천천히(초당 0.15~0.35rad) 한 방향으로 돈다. 빠르면 덩이가 굴러다니는 공처럼 보인다
    const spin = this.lowpoly ? (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.2) : (Math.random() - 0.5) * 1.2;
    this.d.set([...p, ...v, 0, life, s0, s1, a0, lift, Math.random() * 6.28, spin], this.n * 14);
    this.col.set([color.r, color.g, color.b], this.n * 3);
    this.n++;
  }

  clear() { this.n = 0; this.mesh.count = 0; }

  // 나이를 먹이고 카메라 쪽으로 돌린 행렬을 쓴다
  update(dt: number, camQ: THREE.Quaternion) {
    const d = this.d, ic = this.mesh.instanceColor!;
    for (let k = this.n - 1; k >= 0; k--) {
      const o = k * 14;
      d[o + 6] += dt;
      if (d[o + 6] >= d[o + 7]) {
        this.n--;
        d.copyWithin(o, this.n * 14, this.n * 14 + 14);
        this.col.copyWithin(k * 3, this.n * 3, this.n * 3 + 3);
        continue;
      }
      const drag = Math.exp(-1.6 * dt);
      d[o + 3] *= drag; d[o + 5] *= drag; d[o + 4] = d[o + 4] * drag + d[o + 11] * dt;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
      d[o + 12] += d[o + 13] * dt;
    }
    for (let k = 0; k < this.n; k++) {
      const o = k * 14, f = d[o + 6] / d[o + 7], ease = 1 - (1 - f) ** 3;
      // 카메라를 보면서 화면 안에서 천천히 돌아 연기가 말려 오르는 것처럼 보인다
      // 각진 공은 월드 기준으로 굴러야 카메라를 돌려도 면 명암이 햇빛을 따라간다
      if (this.lowpoly) _q.setFromEuler(_e.set(d[o + 12], d[o + 12] * 0.7, d[o + 12] * 0.4));
      else _q.copy(camQ).multiply(_q2.setFromAxisAngle(_z, d[o + 12]));
      this.mesh.setMatrixAt(k, _m.compose(_p.fromArray(d, o), _q, _s.setScalar(d[o + 8] + (d[o + 9] - d[o + 8]) * ease)));
      ic.setXYZ(k, this.col[k * 3], this.col[k * 3 + 1], this.col[k * 3 + 2]);
      // 수명 30%(각진 덩이는 10%)부터 끝 5% 전까지 smoothstep으로 옅어져 크기가 다 커지기 전에 먼저 0에 닿는다 (뚝 끊기지 않게)
      // 나타나는 시간은 수명의 1/12, 길어도 0.3초 (지팡이 꼬리처럼 오래 남는 연기도 지나가는 순간 바로 보이게)
      const f0 = this.lowpoly ? 0.1 : 0.3, u = Math.min(1, Math.max(0, (f - f0) / (0.95 - f0)));
      this.alpha.setX(k, d[o + 10] * (1 - u * u * (3 - 2 * u)) * Math.min(1, d[o + 6] / Math.min(0.3, d[o + 7] / 12)));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = ic.needsUpdate = this.alpha.needsUpdate = true;
  }
}

// 불덩이 색: 흰빛 → 주황 → 검붉은색
const HOT = new THREE.Color('#fff6dc'), MID = new THREE.Color('#ffa63a'), END = new THREE.Color('#b8361a');
// 목표보다 살짝 넘쳤다 돌아오는 곡선 (펑 튀어나오는 느낌)
const backOut = (u: number) => 1 + 2.7 * (u - 1) ** 3 + 1.7 * (u - 1) ** 2;

// 펑 부풀었다 식으며 사라지는 가산 혼합 불덩이 구 + 섬광 포인트 라이트
export class Fireballs {
  group = new THREE.Group();
  private items: { mesh: THREE.Mesh; age: number; dur: number; r: number }[] = [];
  private geo = new THREE.SphereGeometry(1, 20, 14);
  private light = new THREE.PointLight('#ffb070', 0, 1, 1.2);
  private flash = 0;
  private hold = 0;

  constructor() { this.group.add(this.light); }

  // 폭발 하나. hold초 동안은 섬광을 줄이지 않고 켜 둔다 (중성자탄)
  spawn(x: number, y: number, z: number, r: number, hold = 0) {
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: '#ff8a3d', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.items.push({ mesh, age: 0, dur: 0.5 + r * 0.035, r });
    this.light.position.set(x, y + r * 0.5, z);
    this.light.distance = r * 8;
    this.flash = 120 * r * r;
    this.hold = hold;
  }

  update(dt: number) {
    if (this.hold > 0) this.hold -= dt;
    else this.flash *= Math.exp(-dt * 9);
    this.light.intensity = this.flash;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      it.age += dt;
      const f = it.age / it.dur;
      if (f >= 1) { this.group.remove(it.mesh); (it.mesh.material as THREE.Material).dispose(); this.items.splice(k, 1); continue; }
      // 앞 1/3 동안 넘치게 부풀고, 그 뒤로는 천천히 커지며 식는다
      it.mesh.scale.setScalar(it.r * (0.35 + 0.65 * backOut(Math.min(1, f * 3))) * (1 + 0.15 * f));
      const m = it.mesh.material as THREE.MeshBasicMaterial;
      if (f < 1 / 3) m.color.lerpColors(HOT, MID, f * 3); else m.color.lerpColors(MID, END, (f - 1 / 3) * 1.5);
      m.opacity = f < 0.4 ? 0.95 : 0.95 * (1 - ((f - 0.4) / 0.6) ** 2);
    }
  }

  clear() { for (const it of this.items) this.group.remove(it.mesh); this.items = []; this.flash = this.hold = 0; }
}

// 불티: 속도 방향으로 늘어진 짧은 빛줄기. 빠를수록 길고, 식으면서 어두워진다(가산 혼합이라 검정 = 안 보임)
export class Sparks {
  lines: THREE.LineSegments;
  private cap: number;
  private n = 0;
  // 한 개당 8칸: 위치3 속도3 나이 수명
  private d: Float32Array;
  private pos: Float32Array;
  private rgb: Float32Array;

  constructor(cap: number) {
    this.cap = cap;
    this.d = new Float32Array(cap * 8);
    this.pos = new Float32Array(cap * 6);
    this.rgb = new Float32Array(cap * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.rgb, 3));
    geo.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
  }

  // 불티 하나 (꽉 차면 무시)
  emit(p: number[], v: number[], life: number) {
    if (this.n >= this.cap) return;
    this.d.set([...p, ...v, 0, life], this.n * 8);
    this.n++;
  }

  clear() { this.n = 0; this.lines.geometry.setDrawRange(0, 0); }

  // 끌림·중력으로 움직이고 머리(밝음)–꼬리(어두움) 선을 쓴다
  update(dt: number) {
    const d = this.d, fr = Math.exp(-2.5 * dt);
    for (let k = this.n - 1; k >= 0; k--) {
      const o = k * 8;
      if ((d[o + 6] += dt) >= d[o + 7]) { this.n--; d.copyWithin(o, this.n * 8, this.n * 8 + 8); continue; }
      d[o + 3] *= fr; d[o + 4] = d[o + 4] * fr - 9.8 * dt; d[o + 5] *= fr;
      for (let a = 0; a < 3; a++) d[o + a] += d[o + 3 + a] * dt;
    }
    for (let k = 0; k < this.n; k++) {
      const o = k * 8, j = k * 6, b = 1 - d[o + 6] / d[o + 7];
      for (let a = 0; a < 3; a++) { this.pos[j + a] = d[o + a]; this.pos[j + 3 + a] = d[o + a] - d[o + 3 + a] * 0.045; }
      this.rgb.set([b, 0.85 * b, 0.5 * b, 0.6 * b, 0.25 * b, 0.05 * b], j);
    }
    const geo = this.lines.geometry;
    geo.setDrawRange(0, this.n * 2);
    geo.attributes.position.needsUpdate = geo.attributes.color.needsUpdate = true;
  }
}

// 충격파 막 셰이더: 화면에서 구의 가장자리만 보여 공기가 눌린 투명한 막처럼 보인다
const RIM_VS = 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const RIM_FS = 'uniform float uA; varying vec3 vN; varying vec3 vV; void main() { float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0); gl_FragColor = vec4(1.0, 0.97, 0.9, rim * uA); }';

// 폭발마다 빠르게 퍼지고 사라지는 충격파: 바닥을 훑는 흰 링 + 투명한 막
export class Shockwaves {
  group = new THREE.Group();
  private items: { ring: THREE.Mesh; bubble: THREE.Mesh; age: number; dur: number; r: number }[] = [];
  private ringGeo = new THREE.RingGeometry(0.8, 1, 96).rotateX(-Math.PI / 2);
  private ballGeo = new THREE.SphereGeometry(1, 32, 16);

  // 충격파 하나. ring=false면 막만 띄운다 (중성자탄은 피해 판정용 링이 따로 있다)
  spawn(x: number, y: number, z: number, r: number, ring = true) {
    const rm = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: '#fff4e2', transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    rm.position.set(x, y + 0.3, z);
    rm.visible = ring;
    const bm = new THREE.Mesh(this.ballGeo, new THREE.ShaderMaterial({ vertexShader: RIM_VS, fragmentShader: RIM_FS, uniforms: { uA: { value: 0.9 } }, transparent: true, depthWrite: false }));
    bm.position.set(x, y, z);
    rm.scale.setScalar(r * 0.3); bm.scale.setScalar(r * 0.4);
    this.group.add(rm, bm);
    this.items.push({ ring: rm, bubble: bm, age: 0, dur: 0.35 + r * 0.012, r });
  }

  // 링은 반경 R×3, 막은 R×2까지 감속하며 퍼지고 옅어진다
  update(dt: number) {
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      it.age += dt;
      const f = it.age / it.dur;
      if (f >= 1) { this.drop(it); this.items.splice(k, 1); continue; }
      const e = 1 - (1 - f) ** 3;
      it.ring.scale.setScalar(it.r * (0.3 + 2.7 * e));
      (it.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f) ** 1.5;
      it.bubble.scale.setScalar(it.r * (0.4 + 1.6 * e));
      (it.bubble.material as THREE.ShaderMaterial).uniforms.uA.value = 0.9 * (1 - f) ** 2;
    }
  }

  private drop(it: { ring: THREE.Mesh; bubble: THREE.Mesh }) {
    this.group.remove(it.ring, it.bubble);
    (it.ring.material as THREE.Material).dispose(); (it.bubble.material as THREE.Material).dispose();
  }

  clear() { this.items.forEach((it) => this.drop(it)); this.items = []; }
}

// 신의 지팡이 충격파 돔: 테두리만 빛나는 반투명 반구가 "쭝" 하고 순식간에 부풀고(지수 감속), 땅에 붙은 흙먼지 벽이 더 멀리 굴러 나간다.
// 차르 봄바 영상처럼 반구 밑동은 밝은 띠로 빛난다. 건물에 가려지도록 깊이 검사는 켠다
const DOME_VS = 'varying vec3 vN; varying vec3 vV; varying float vY; void main() { vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
// 흰 구름처럼 불투명(속 0.5) + 테두리·밑동은 더 진하게. 주황 기운은 뺐다(사용자 요청). 보통 혼합이라 밝은 바닥 위에서도 보인다
const DOME_FS = 'uniform float uA; varying vec3 vN; varying vec3 vV; varying float vY; void main() { float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); float band = smoothstep(0.22, 0.0, vY); gl_FragColor = vec4(0.97, 0.97, 0.98, min(0.95, (0.5 + rim * 0.45 + band * 0.4) * uA)); }';
const WALL_VS = 'varying float vH; void main() { vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const WALL_FS = 'uniform float uA; varying float vH; void main() { gl_FragColor = vec4(0.62, 0.56, 0.48, pow(1.0 - vH, 1.6) * uA); }';

// 감쇠 스프링 계단 응답(0→1): 처음엔 천천히 붙고, 가속해 목표를 살짝 넘었다가(ζ 0.55면 약 12%) 되돌아와 멈춘다.
// "쫀쫀한" 퍼짐용. t<0이면 0
export function spring(t: number, w: number, z: number) {
  if (t <= 0) return 0;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t));
}

export class ShockDomes {
  group = new THREE.Group();
  private items: { dome: THREE.Mesh; wall: THREE.Mesh; age: number; R: number }[] = [];
  private domeGeo = new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  private wallGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true).translate(0, 0.5, 0);
  private static CHARGE = 0.12;  // 터지기 전 작고 밝은 덩이로 웅크리는 시간(초, 화면 정지 뒤 흐르는 시간)
  private static HOLD = 0.4;     // 다 부푼 뒤 그대로 버티는 시간(초, 웅크림 뒤부터)
  private static DOME_T = 3.0;   // 돔 수명(초, 웅크림 뒤부터). HOLD 뒤 천천히 투명해진다
  private static WALL_T = 3.0;   // 흙먼지 벽 수명(초, 웅크림 뒤부터)

  // 나이 a초인 돔의 반경: 웅크림 동안 0.22R, 그 뒤 임계 감쇠(넘치지도 줄지도 않음)로 3R까지 "빵" 부푼다(0.2초에 절반, 0.5초에 90%).
  // index.ts가 같은 반경으로 돔 안을 지운다
  static reach(R: number, a: number) {
    const tau = a - ShockDomes.CHARGE;
    return tau < 0 ? R * 0.22 : R * (0.22 + 2.78 * (1 - Math.exp(-8 * tau) * (1 + 8 * tau)));
  }

  // 바닥 높이 y에 반경 R 기준 충격파 하나. dome=false면 흙먼지 벽만 (벙커버스터 땅속 폭발)
  spawn(x: number, y: number, z: number, R: number, withDome = true) {
    const mat = (vs: string, fs: string, add: boolean) => new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { uA: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending });
    const dome = new THREE.Mesh(this.domeGeo, mat(DOME_VS, DOME_FS, false));
    const wall = new THREE.Mesh(this.wallGeo, mat(WALL_VS, WALL_FS, false));
    dome.position.set(x, y, z); wall.position.set(x, y, z);
    dome.scale.setScalar(0.01); wall.scale.setScalar(0.01);
    dome.visible = dome.userData.on = withDome;
    this.group.add(dome, wall);
    this.items.push({ dome, wall, age: 0, R });
  }

  // 웅크림(CHARGE): 반경 0.22R 덩이가 떨며 버틴다 → 3R까지 "빵" 부푼 뒤 줄지 않고 그 크기 그대로 천천히 투명해진다.
  // 흙먼지 벽은 0.05초 늦게 조금 느리게 4R까지 밀려 나간다
  update(dt: number) {
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      it.age += dt;
      const a = it.age, tau = a - ShockDomes.CHARGE, fd = Math.max(0, tau) / ShockDomes.DOME_T, fw = Math.max(0, tau) / ShockDomes.WALL_T;
      if (fw >= 1) { this.drop(it); this.items.splice(k, 1); continue; }
      const m = it.dome.material as THREE.ShaderMaterial;
      const rd = ShockDomes.reach(it.R, a) * (tau < 0 ? 1 + 0.12 * Math.sin(a * 70) : 1);
      it.dome.scale.set(rd, rd * (tau < 0 ? 0.8 : 0.7), rd);
      const fade = Math.max(0, tau - ShockDomes.HOLD) / (ShockDomes.DOME_T - ShockDomes.HOLD);
      m.uniforms.uA.value = (1 - fade) ** 1.3;
      it.dome.visible = it.dome.userData.on && fd < 1;
      const tw = tau - 0.05, rw = tw <= 0 ? 0.01 : it.R * 4 * (1 - Math.exp(-5 * tw) * (1 + 5 * tw));
      it.wall.scale.set(rw, it.R * 0.3 * (0.5 + fw), rw);
      (it.wall.material as THREE.ShaderMaterial).uniforms.uA.value = tw <= 0 ? 0 : 0.75 * Math.min(1, tw / 0.1) * (1 - fw) ** 1.5;
    }
  }

  private drop(it: { dome: THREE.Mesh; wall: THREE.Mesh }) {
    this.group.remove(it.dome, it.wall);
    (it.dome.material as THREE.Material).dispose(); (it.wall.material as THREE.Material).dispose();
  }

  clear() { this.items.forEach((it) => this.drop(it)); this.items = []; }
}

// 예광탄 선 (짧게 빛나고 사라짐)
export class Tracers {
  lines: THREE.LineSegments;
  private segs: { a: THREE.Vector3; b: THREE.Vector3; age: number }[] = [];
  private pos = new Float32Array(32 * 6);

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#ffe08a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
  }

  add(a: THREE.Vector3, b: THREE.Vector3) {
    if (this.segs.length >= 32) this.segs.shift();
    this.segs.push({ a: a.clone(), b: b.clone(), age: 0 });
  }

  update(dt: number) {
    this.segs = this.segs.filter((s) => (s.age += dt) < 0.12);
    this.segs.forEach((s, k) => {
      // 탄이 날아가는 느낌: 뒤쪽 끝을 앞으로 당긴다
      const tail = s.a.clone().lerp(s.b, Math.min(1, s.age / 0.12) * 0.6);
      this.pos.set([tail.x, tail.y, tail.z, s.b.x, s.b.y, s.b.z], k * 6);
    });
    this.lines.geometry.setDrawRange(0, this.segs.length * 2);
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}
