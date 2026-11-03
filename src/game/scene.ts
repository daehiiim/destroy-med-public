// 정적 장면 만들기: 지형(바닥 캔버스 텍스처), 나무, 건물 블록, 조명
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HospitalData, XZ } from './types.ts';
import type { World } from './world.ts';

const HOSP_COLORS = ['#f4f5f1', '#cfe6df', '#e9efee'];
const OTHER_COLORS = ['#e2d7c5', '#cfcfca', '#ddd5c8', '#c4c0b7', '#e8e4dc'];
const ROOF = '#e3e6e2'; // 지붕색이 없는 옛 데이터의 옥상 바탕색 (건물 색과 곱한다)
const SLOTS = 16; // 외벽 아틀라스 칸 수 (64px 칸, 폭 1024px)
const LOBBY = 8;  // 병원 맨 아래층 유리 로비 칸
// 민간 외벽 모양(데이터 st 0~3) → 같은 계열 변형 칸들. 건물 번호로 하나를 골라 같은 모양만 줄지어 서지 않게 한다 (9 상가는 5층 이하만)
const VARIANTS = [[0, 10, 9], [1, 11], [2, 12], [3, 13]];
const HOSP_GRID = 14; // 병원 기본 격자창(데이터 st 0)

// 바닥 텍스처: 기본 땅, 병원 부지, 녹지, 도로를 캔버스에 그린다
function groundTexture(data: HospitalData, w: World, maxAniso: number) {
  const t = w.t, W = (t.nx - 1) * t.step, H = (t.nz - 1) * t.step;
  const ppm = Math.min(2048 / W, 2048 / H, 4);
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * ppm); cv.height = Math.round(H * ppm);
  const g = cv.getContext('2d')!;
  const X = (x: number) => (x - t.x0) * ppm, Z = (z: number) => (z - t.z0) * ppm;
  // 다각형 하나를 칠한다
  const poly = (p: XZ[], fill: string) => {
    g.beginPath();
    p.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.closePath(); g.fillStyle = fill; g.fill();
  };
  g.fillStyle = '#a9b29a'; g.fillRect(0, 0, cv.width, cv.height);
  data.site.forEach((p) => poly(p, '#d6d7d2'));
  data.green.forEach((p) => poly(p, '#6f9a4c'));
  g.lineCap = g.lineJoin = 'round';
  // 도로: 연한 보도 테두리 위에 어두운 노면
  for (const [pad, col] of [[2.4, '#c9cac5'], [0, '#3d4148']] as const) {
    g.strokeStyle = col;
    for (const r of data.roads) {
      g.lineWidth = (r.w + pad) * ppm;
      g.beginPath();
      r.p.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

// 지형 메시: 격자 정점 + 그을림을 vertex color로
export function makeTerrain(data: HospitalData, w: World, maxAniso: number) {
  const t = w.t, n = t.nx * t.nz;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3).fill(1);
  // 처음 높이와 정점별 (맨땅, 맨틀) 비율: 깊게 팬 곳은 지도 무늬 대신 회색 흙, 더 깊으면 붉은 맨틀로 덮는다
  const h0 = Float32Array.from(t.h), bare = new Float32Array(n * 2);
  for (let i = 0; i < t.nz; i++) for (let j = 0; j < t.nx; j++) {
    const k = i * t.nx + j;
    pos.set([t.x0 + j * t.step, t.h[k], t.z0 + i * t.step], k * 3);
    uv.set([j / (t.nx - 1), 1 - i / (t.nz - 1)], k * 2);
  }
  const idx: number[] = [];
  for (let i = 0; i < t.nz - 1; i++) for (let j = 0; j < t.nx - 1; j++) {
    const a = i * t.nx + j, b = a + 1, c = a + t.nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aBare', new THREE.BufferAttribute(bare, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: groundTexture(data, w, maxAniso), vertexColors: true, roughness: 1 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.bareColor = { value: new THREE.Color('#8e8c87') };
    // 맨틀 색 단계: 적갈색 → 밝은 빨강 → 주황 → 흰 열기 (깊을수록 밝아진다)
    s.uniforms.hotRamp = { value: ['#94503c', '#e8301a', '#ffa23a', '#fff4e0'].map((c) => new THREE.Color(c)) };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aBare;\nvarying vec2 vBare;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBare = aBare;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 bareColor;\nuniform vec3 hotRamp[4];\nvarying vec2 vBare;\nvec3 hot(float m) { return m < 0.35 ? mix(hotRamp[0], hotRamp[1], m / 0.35) : m < 0.7 ? mix(hotRamp[1], hotRamp[2], (m - 0.35) / 0.35) : mix(hotRamp[2], hotRamp[3], (m - 0.7) / 0.3); }')
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= mix(mix(texture2D(map, vMapUv).rgb, bareColor, vBare.x), hot(vBare.y), min(vBare.y * 5.0, 1.0));')
      // 맨틀은 깊을수록 스스로 빛나 그늘에서도 달아오르고, 끝에는 폭발처럼 하얗게 보인다
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += hot(vBare.y) * vBare.y * 1.2;');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  // 바뀐 정점(없으면 전부)을 월드 높이·그을림으로 다시 맞춘다
  const update = (verts?: number[]) => {
    const p = geo.attributes.position as THREE.BufferAttribute, c = geo.attributes.color as THREE.BufferAttribute;
    const b = geo.attributes.aBare as THREE.BufferAttribute;
    for (const k of verts ?? Array.from({ length: n }, (_, i) => i)) {
      p.setY(k, t.h[k]);
      // 0.6m 넘게 파이면 회색이 섞이기 시작해 2m에서 완전히 덮인다
      const bk = THREE.MathUtils.smoothstep(h0[k] - t.h[k], 0.6, 2);
      // 6m부터 붉어지기 시작해 45m에서 하얗게 달아오른다 (중성자탄 한 발 9m는 적갈색, 다섯 발쯤 겹치면 흰색)
      b.setXY(k, bk, THREE.MathUtils.clamp((h0[k] - t.h[k] - 6) / 39, 0, 1));
      // 맨땅은 그을림을 덜 받아 검정이 아니라 회색으로 남는다. 가장자리만 짙게 탄다
      const v = 1 - w.scorch[k] * (1 - 0.6 * bk);
      c.setXYZ(k, v, v * 0.97, v * 0.95);
    }
    p.needsUpdate = c.needsUpdate = b.needsUpdate = true;
    geo.computeVertexNormals();
  };
  return { mesh, update };
}

// 나무: 저폴리 구 수관 + 원기둥 줄기 InstancedMesh
export function makeTrees(w: World) {
  const crown = new THREE.IcosahedronGeometry(2.4, 0).scale(1, 1.25, 1).translate(0, 4.6, 0);
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 2.6, 5).translate(0, 1.3, 0).toNonIndexed();
  const paint = (g: THREE.BufferGeometry, c: string) => {
    const col = new THREE.Color(c), a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) a.set([col.r, col.g, col.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const geo = mergeGeometries([paint(crown, '#ffffff'), paint(trunk, '#6b5440')])!;
  const n = w.treeAlive.length;
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), Math.max(1, n));
  mesh.count = n;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    // 줄기는 갈색 그대로 두고 수관만 녹색 변화를 준다 (instanceColor는 정점색과 곱해짐)
    mesh.setColorAt(k, c.setHSL(0.27 + (k % 7) * 0.008, 0.45, 0.24 + (k % 5) * 0.02));
  }
  // 살아 있는 나무만 보이게 행렬을 쓴다
  const update = () => {
    for (let k = 0; k < n; k++) {
      const sc = w.treeAlive[k] ? w.trees[k * 4 + 3] : 0;
      q.setFromAxisAngle(up, k * 2.39);
      mesh.setMatrixAt(k, m.compose(p.set(w.trees[k * 4], w.trees[k * 4 + 1] - 0.2, w.trees[k * 4 + 2]), q, s.setScalar(sc)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update();
  return { mesh, update };
}

// 외벽 텍스처 아틀라스: 64px 칸 SLOTS개를 가로로. 실사 외벽 사진을 보고 32×32 픽셀 아트로 옮겨 그렸다(한 점 = 2×2px).
// 0 기본 창문, 1 아파트 발코니, 2 유리 커튼월, 3 벽돌 저층, 병원 전용 4 유리 커튼월, 5 가로 띠창, 6 세로 핀·루버, 7 벽돌·타일,
// 8 1층 유리 로비, 민간 변형 9 상가 간판, 10 오피스 석재 패널, 11 아파트 창+실외기, 12 짙은 유리 격자, 13 빌라 방범창, 병원 14 격자창.
// 블록 한 면 = 한 칸이고 옆 블록·윗층과 그대로 이어 붙는다. 건물 색과 곱해지므로 바탕은 밝게 둔다. repeat.x = 1/SLOTS라 그대로 쓰면 0번 칸만 보인다
function windowTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64 * SLOTS; cv.height = 64;
  const g = cv.getContext('2d')!;
  // 칸 i 안의 32×32 격자 (x, y)부터 w×h 점을 칠한다
  const r = (i: number, c: string, x: number, y: number, w = 1, h = 1) => { g.fillStyle = c; g.fillRect(i * 64 + x * 2, y * 2, w * 2, h * 2); };
  // 유리창 한 개: 짙은 테두리, 위쪽 하늘 반사, 아래쪽 어두운 유리, 대각선 반짝임 두 점, 가운데 창살, 아래 창턱과 그림자
  const win = (i: number, x: number, y: number, w: number, h: number, [hi, mid, lo]: string[], frame: string, sill = '#ffffff') => {
    r(i, frame, x, y, w, h);
    r(i, mid, x + 1, y + 1, w - 2, h - 2);
    r(i, hi, x + 1, y + 1, w - 2, Math.round((h - 2) / 3));
    r(i, lo, x + 1, y + h - 3, w - 2, 2);
    r(i, hi, x + 3, y + h - 6); r(i, hi, x + 4, y + h - 7); r(i, hi, x + w - 6, y + 4); r(i, hi, x + w - 5, y + 3);
    r(i, frame, x + (w >> 1), y + 1, 1, h - 2);
    r(i, sill, x - 1, y + h, w + 2, 1); r(i, '#cfcdc7', x, y + h + 1, w, 1);
  };
  const BLUE = ['#9db3c3', '#5f7689', '#46596a'], TEAL = ['#a6cdd5', '#5f8f9c', '#456d78'];
  // 벽돌 줄눈: 2점 높이 벽돌 + 1점 줄눈, 길이 8, 줄마다 반 칸 어긋남 (가장자리에서 잘려도 옆 칸과 이어진다)
  const bricks = (i: number) => {
    r(i, '#f7f7f5', 0, 0, 32, 32);
    for (let y = 0; y < 32; y += 3) for (let x = (y / 3) % 2 ? -4 : 0; x < 32; x += 8) {
      const x0 = Math.max(0, x), x1 = Math.min(32, x + 7);
      r(i, ['#e4e4e2', '#d9d9d6', '#ebebe9'][((x + 8) / 4 + y) % 3], x0, y, x1 - x0, 2);
    }
  };

  // 0 기본: 콘크리트 벽에 2짝 창, 층 사이 슬래브 띠
  r(0, '#f3f2ee', 0, 0, 32, 32); r(0, '#e3e2dd', 0, 0, 32, 3); r(0, '#d2d1cc', 0, 3, 32, 1); r(0, '#e9e8e3', 0, 4, 1, 28);
  win(0, 7, 8, 18, 15, BLUE, '#59616a');
  r(0, '#d8d3c6', 8, 9, 8, 4); for (let y = 9; y < 13; y += 2) r(0, '#c3bdaf', 8, y, 8, 1);   // 왼쪽 짝 블라인드
  // 1 아파트: 옆 칸과 이어지는 큰 발코니 창, 아래는 난간 벽과 홈
  r(1, '#f4f2ee', 0, 0, 32, 32); r(1, '#e2dfd8', 0, 0, 32, 2);
  r(1, '#5a6e7f', 0, 3, 32, 16); r(1, '#8ba1b1', 0, 3, 32, 4); r(1, '#47596a', 0, 17, 32, 2);
  r(1, '#e8e6e1', 0, 3, 1, 16); r(1, '#e8e6e1', 16, 3, 1, 16); r(1, '#a6b9c6', 5, 13); r(1, '#a6b9c6', 6, 12); r(1, '#a6b9c6', 22, 9);
  r(1, '#d2cfc8', 0, 19, 32, 1); r(1, '#eeece7', 0, 20, 32, 8); r(1, '#d9d6cf', 0, 24, 32, 1); r(1, '#c3c0b9', 0, 28, 32, 1); r(1, '#e6e3dc', 0, 29, 32, 3);
  // 2 유리 커튼월: 하늘 반사 띠, 얇은 멀리언, 층 사이 짙은 스팬드럴
  r(2, '#7d9cb4', 0, 0, 32, 32); r(2, '#adc3d2', 0, 0, 32, 8); r(2, '#95b0c3', 0, 8, 32, 5);
  r(2, '#b9ccd9', 3, 10, 5, 1); r(2, '#b9ccd9', 20, 5, 7, 1); r(2, '#8aa6bb', 9, 18, 6, 1);
  r(2, '#c9d3da', 0, 26, 32, 1); r(2, '#3f5566', 0, 27, 32, 5); r(2, '#56707f', 0, 27, 32, 1);
  r(2, '#e3e8ec', 0, 0, 1, 32); r(2, '#e3e8ec', 16, 0, 1, 27);
  // 3 벽돌 저층: 벽돌 위 세운 벽돌 인방, 짙은 창, 흰 창턱
  bricks(3); r(3, '#d2d2cf', 8, 6, 16, 2);
  win(3, 9, 8, 14, 13, ['#8a9caa', '#56697a', '#3f4b55'], '#3f4b55', '#f4f4f2');
  // 4 병원 유리 커튼월: 청록 큰 판, 멀리언 3줄, 가로 창살, 짙은 띠 (외벽색이 흰색이라 이 색이 그대로 보인다)
  r(4, '#79b3bf', 0, 0, 32, 32); r(4, '#b6dce4', 0, 0, 32, 10); r(4, '#98c9d3', 0, 10, 32, 6);
  r(4, '#c8e6ec', 4, 6, 4, 1); r(4, '#c8e6ec', 25, 12, 4, 1); r(4, '#8bbfca', 13, 20, 5, 1);
  r(4, '#e6f1f3', 0, 15, 32, 1); r(4, '#3d6672', 0, 28, 32, 4); r(4, '#5a8792', 0, 28, 32, 1);
  for (const x of [0, 11, 22]) r(4, '#e6f1f3', x, 0, 1, 28);
  // 5 병원 가로 띠창: 흰 패널 띠 사이로 옆 칸과 이어지는 긴 창
  r(5, '#f7f7f4', 0, 0, 32, 32); r(5, '#e7e8e4', 0, 4, 32, 1);
  r(5, '#a3abb0', 0, 9, 32, 1); r(5, '#4d6170', 0, 10, 32, 15); r(5, '#819aab', 0, 10, 32, 4); r(5, '#3e505d', 0, 23, 32, 2);
  r(5, '#e2e5e5', 15, 10, 1, 15); r(5, '#a9bfcc', 4, 19); r(5, '#a9bfcc', 5, 18); r(5, '#a9bfcc', 24, 13);
  r(5, '#ffffff', 0, 25, 32, 1); r(5, '#d3d4d0', 0, 26, 32, 1);
  // 6 병원 세로 핀·루버: 밝은 세로 핀(빛 받는 면·그림자 면) 사이 좁은 창
  r(6, '#f2f1ec', 0, 0, 32, 32);
  for (const x of [0, 8, 16, 24]) {
    r(6, '#4f6371', x + 3, 2, 4, 27); r(6, '#7d93a2', x + 3, 2, 4, 5); r(6, '#3d4d58', x + 3, 27, 4, 2);
    r(6, '#ffffff', x, 0, 1, 32); r(6, '#c9c8c2', x + 1, 0, 1, 32); r(6, '#e0dfd9', x + 2, 0, 1, 32);
  }
  r(6, '#d9d8d2', 0, 30, 32, 2);
  // 7 병원 벽돌·타일 동: 4점 네모 타일 줄눈 위에 작은 창 둘
  r(7, '#f8f8f6', 0, 0, 32, 32);
  for (let k = 0; k < 32; k += 4) { r(7, '#e3e2de', 0, k, 32, 1); r(7, '#e3e2de', k, 0, 1, 32); }
  for (const x of [4, 19]) win(7, x, 8, 9, 12, ['#8a9caa', '#4a5a66', '#36424c'], '#3f4b55', '#f2f2f0');
  // 8 1층 유리 로비: 흰 차양과 그림자, 큰 유리, 짙은 문틀, 가운데 자동문과 손잡이
  r(8, '#6f93a8', 0, 0, 32, 32); r(8, '#f2f2f0', 0, 0, 32, 4); r(8, '#d6d7d5', 0, 4, 32, 1); r(8, '#3c4247', 0, 5, 32, 1);
  r(8, '#a7c3d3', 0, 6, 32, 6); r(8, '#c2d6e1', 3, 8, 6, 1); r(8, '#58788c', 0, 28, 32, 3); r(8, '#3c4247', 0, 31, 32, 1);
  for (const x of [0, 15, 31]) r(8, '#3c4247', x, 5, 1, 27);
  r(8, '#4e6a7b', 9, 14, 13, 17); r(8, '#3c4247', 9, 14, 13, 1); r(8, '#3c4247', 15, 14, 2, 17); r(8, '#c0c4c6', 14, 21, 1, 4); r(8, '#c0c4c6', 17, 21, 1, 4);
  // 9 상가: 층마다 빨강·파랑 간판(글자 덩어리), 아래 시트지 붙은 넓은 창
  r(9, '#f0eee9', 0, 0, 32, 32);
  r(9, '#c8463d', 0, 2, 16, 8); r(9, '#2f6fb0', 16, 2, 16, 8); r(9, '#7a2a25', 0, 9, 16, 1); r(9, '#1d4775', 16, 9, 16, 1);
  for (const x of [3, 6, 9]) r(9, '#ffffff', x, 4, 2, 4);
  for (const x of [19, 22, 25, 28]) r(9, '#ffe066', x, 4, 2, 4);
  win(9, 2, 12, 28, 13, BLUE, '#59616a');
  r(9, '#f4efe0', 5, 17, 6, 3); r(9, '#f4efe0', 20, 17, 4, 3); r(9, '#e3d48a', 24, 17, 3, 3);   // 창에 붙인 시트지 글자
  r(9, '#dedbd4', 0, 28, 32, 4);
  // 10 오피스 석재 패널: 줄눈 있는 돌판, 멀리언 4칸 짙은 띠창
  r(10, '#ebe9e4', 0, 0, 32, 32); r(10, '#d3d1cb', 0, 0, 32, 1); r(10, '#d3d1cb', 0, 27, 32, 1); r(10, '#d3d1cb', 0, 0, 1, 32); r(10, '#d3d1cb', 16, 27, 1, 5);
  for (const [x, y] of [[4, 3], [11, 29], [21, 2], [27, 30], [8, 30], [25, 4]]) r(10, '#dcd9d2', x, y);
  r(10, '#58616a', 2, 7, 28, 15); r(10, '#3e4a55', 3, 8, 26, 13); r(10, '#6d7d8a', 3, 8, 26, 3);
  for (const x of [9, 16, 23]) r(10, '#58616a', x, 8, 1, 13);
  r(10, '#8a9aa6', 5, 17); r(10, '#8a9aa6', 6, 16); r(10, '#8a9aa6', 19, 11);
  r(10, '#f7f6f2', 1, 22, 30, 1); r(10, '#cfcdc7', 2, 23, 28, 1);
  // 11 아파트 창 + 에어컨 실외기 받침
  r(11, '#f3f1ec', 0, 0, 32, 32); r(11, '#e0ddd6', 0, 27, 32, 5); r(11, '#cbc8c1', 0, 27, 32, 1);
  win(11, 3, 6, 16, 14, BLUE, '#59616a');
  r(11, '#b9b6af', 21, 12, 9, 10); r(11, '#d6d4ce', 22, 13, 7, 8);
  for (let y = 14; y < 21; y += 2) r(11, '#aeaba4', 22, y, 7, 1);
  r(11, '#8f8c86', 24, 15, 3, 3); r(11, '#cfccc5', 25, 16); r(11, '#9a978f', 21, 22, 9, 1);
  // 12 짙은 유리 격자: 8점 칸 유리마다 반사가 달라 사무실 빌딩처럼 보인다
  r(12, '#4a5d6c', 0, 0, 32, 32);
  ['#56697a', '#4b5c6b', '#61778a', '#435563', '#5b6f80', '#8ea6b6', '#4f6170', '#66798a'].forEach((c, k) => r(12, c, (k % 4) * 8, (k >> 2) * 8 + 8, 8, 8));
  r(12, '#7d93a3', 0, 0, 32, 8); r(12, '#2f3d48', 0, 24, 32, 8);
  for (let k = 0; k < 32; k += 8) { r(12, '#c8d0d6', k, 0, 1, 32); r(12, '#c8d0d6', 0, k, 32, 1); }
  // 13 빌라: 벽돌 벽에 방범창 달린 창
  bricks(13);
  win(13, 7, 7, 18, 14, ['#8a9caa', '#56697a', '#3f4b55'], '#3f4b55', '#f4f4f2');
  r(13, '#2e3338', 6, 6, 20, 1); for (let x = 6; x < 27; x += 3) r(13, '#2e3338', x, 6, 1, 16);
  // 14 병원 격자창: 흰 패널, 청록 유리 2짝, 아래 민트 띠
  r(14, '#f6f7f4', 0, 0, 32, 32); r(14, '#e6e9e6', 0, 0, 1, 32); r(14, '#e6e9e6', 0, 4, 32, 1);
  win(14, 5, 7, 22, 16, TEAL, '#6a7c82');
  r(14, '#e6ebe9', 0, 27, 32, 5); r(14, '#8fc0c4', 0, 28, 32, 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;   // 가까이서 픽셀 점이 또렷하게
  tex.repeat.set(1 / SLOTS, 1);
  return tex;
}

// 날아가거나 떨어지는 블록 재질: 무늬 없이 건물 색만 (옥상과 같은 바탕색에 블록별 건물 색을 곱한다)
export function rubbleMaterial() {
  return new THREE.MeshStandardMaterial({ color: '#e3e6e2', roughness: 0.9 });
}

// 병원 실내 텍스처: 색 지도와 전등 빛 지도를 같은 배치로 그린다.
// 위에서부터 천장 슬래브, 형광등이 달린 천장판, 연한 벽, 복도 손잡이, 민트색 징두리 벽, 걸레받이, 바닥 슬래브, 왼쪽 기둥
function interiorTextures() {
  const S = 128;
  // 캔버스 하나를 만들어 그리기 함수를 돌리고 sRGB 텍스처로 돌려준다
  const paint = (draw: (g: CanvasRenderingContext2D) => void) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    draw(cv.getContext('2d')!);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  // 형광등 아래로 번지는 빛 (색 지도에는 밝게, 빛 지도에는 은은하게)
  const spill = (g: CanvasRenderingContext2D, rgb: string, a: number) => {
    const r = g.createRadialGradient(64, 14, 4, 64, 14, 70);
    r.addColorStop(0, `rgba(${rgb},${a})`); r.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = r; g.fillRect(0, 14, S, 92);
  };
  const map = paint((g) => {
    g.fillStyle = '#e6ece9'; g.fillRect(0, 0, S, S);
    spill(g, '255,250,232', 0.55);
    g.fillStyle = '#8e8b85'; g.fillRect(0, 0, S, 8);
    g.fillStyle = '#eef0ec'; g.fillRect(0, 8, S, 6);
    g.fillStyle = '#d3d6d2'; g.fillRect(0, 14, S, 1);
    g.fillStyle = '#fffdf2'; g.fillRect(30, 9, 68, 4);
    g.fillStyle = '#9fc9bd'; g.fillRect(0, 76, S, 26);
    g.fillStyle = '#c3cfd2'; g.fillRect(0, 70, S, 4);
    g.fillStyle = '#8c9a9e'; g.fillRect(0, 74, S, 1);
    g.fillStyle = '#5f7f7a'; g.fillRect(0, 102, S, 4);
    g.fillStyle = '#7f7d78'; g.fillRect(0, 106, S, 22);
    g.fillStyle = '#a3a19b'; g.fillRect(0, 106, S, 2);
    g.fillStyle = '#d4d8d5'; g.fillRect(0, 8, 12, 98);
    g.fillStyle = '#aeb3b0'; g.fillRect(12, 8, 2, 98);
  });
  const glow = paint((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    spill(g, '255,236,196', 0.22);
    g.fillStyle = '#fff6dc'; g.fillRect(30, 9, 68, 4);
    g.fillStyle = '#000'; g.fillRect(0, 0, S, 8); g.fillRect(0, 106, S, 22);
  });
  return { map, glow };
}

// 블록 재질: 옆면 창문, 윗면·아랫면 옥상색 (BoxGeometry 면 순서 +x,-x,+y,-y,+z,-z).
// outer면 인스턴스 속성 aOuter(Blocks.outer 비트)를 읽어 외벽 면만 창문, 나머지는 불 켜진 병원 실내를 그린다.
// aCut = (바닥 높이, 층 높이): 맨 아래층 블록은 바닥 아래를 창문 없는 시멘트 받침으로 칠하고 창문은 바닥 위 한 층에만 편다
// aStyle = 외벽 모양 번호(아틀라스 칸), aRoof = 지붕색 / 외벽색 (instanceColor가 외벽색 × 손상 어둡기라 곱하면 지붕색 × 손상 어둡기)
// aPhoto = 병원 맨 위층 블록이면 1 / 외벽색 G (윗면에 옥상 사진을 손상 어둡기만 곱해 칠한다), 아니면 0
export function blockMaterials(outer = false, data?: HospitalData) {
  const side = new THREE.MeshStandardMaterial({ map: windowTexture(), roughness: 0.75 });
  const top = new THREE.MeshStandardMaterial({ color: outer ? '#ffffff' : ROOF, roughness: 0.9 });
  if (outer) {
    // 병원 옥상 위성 사진 (R83). 다 받기 전이나 실패하면 photoOn = 0이라 지금처럼 단색 지붕
    const photo = { roofMap: { value: null as THREE.Texture | null }, roofBox: { value: new THREE.Vector4(0, 0, 1, 1) }, photoOn: { value: 0 } };
    const rb = data?.roof;
    if (rb) {
      photo.roofBox.value.set(rb.x0, rb.z0, rb.x1 - rb.x0, rb.z1 - rb.z0);
      const url = `/data/roof/${encodeURIComponent(data.id)}.jpg`;
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;   // three가 GPU 최대치로 자른다
        photo.roofMap.value = tex; photo.photoOn.value = 1;
        top.addEventListener('dispose', () => tex.dispose());
      }, undefined, (e) => {
        console.error('APP_ERROR_DIAGNOSTIC ' + JSON.stringify({
          code: 'RENDER_ROOF_PHOTO_FAILED', operation: 'loadRoofPhoto', layer: 'game-engine', message: String((e as Error)?.message ?? e),
          input: { url }, output: null, nextAction: 'public/data/roof/<id>.jpg 와 build-data --roof-only 확인 (게임은 단색 지붕으로 계속)',
        }));
      });
    }
    top.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, photo);
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aRoof;\nattribute float aPhoto;\nuniform vec4 roofBox;\nvarying vec3 vRoof;\nvarying float vPhoto;\nvarying vec2 vRuv;')
        // 윗면만 사진, 월드 xz → 사진 uv (사진 위쪽 = 북쪽 = z가 작은 쪽)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRoof = aRoof;
          vPhoto = normal.y > 0.5 ? aPhoto : 0.0;
          vec4 rw = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          vRuv = vec2((rw.x - roofBox.x) / roofBox.z, 1.0 - (rw.z - roofBox.y) / roofBox.w);`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D roofMap;\nuniform float photoOn;\nvarying vec3 vRoof;\nvarying float vPhoto;\nvarying vec2 vRuv;')
        // diffuseColor.g × aPhoto = 손상 어둡기 (instanceColor = 외벽색 × 어둡기)
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (photoOn > 0.5 && vPhoto > 0.0) diffuseColor.rgb = texture2D(roofMap, vRuv).rgb * diffuseColor.g * vPhoto; else diffuseColor.rgb *= vRoof;');
    };
    const interior = interiorTextures();
    side.onBeforeCompile = (s) => {
      s.uniforms.interiorMap = { value: interior.map };
      s.uniforms.interiorGlow = { value: interior.glow };
      s.uniforms.cement = { value: new THREE.Color('#9d9c97') };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOuter;\nattribute vec2 aCut;\nattribute float aStyle;\nvarying float vOuter;\nvarying float vWy;\nvarying vec2 vCut;\nvarying float vStyle;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float faceBit = normal.x > 0.5 ? 1.0 : normal.x < -0.5 ? 2.0 : normal.z > 0.5 ? 4.0 : 8.0;
          vOuter = mod(floor((aOuter + 0.5) / faceBit), 2.0);
          vWy = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;
          vCut = aCut;
          vStyle = aStyle;`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D interiorMap;\nuniform sampler2D interiorGlow;\nuniform vec3 cement;\nvarying float vOuter;\nvarying float vWy;\nvarying vec2 vCut;\nvarying float vStyle;')
        // wuv = 면 안 0~1 좌표 (map의 repeat.x 1/SLOTS를 되돌림), auv = 아틀라스에서 그 모양 칸 (가장자리는 옆 칸이 번지지 않게 살짝 안쪽)
        .replace('#include <map_fragment>', `vec2 wuv = vec2(vMapUv.x * ${SLOTS}.0, vMapUv.y);
          if (vCut.y > 0.0) wuv.y = clamp((vWy - vCut.x) / vCut.y, 0.0, 1.0);
          bool plinth = vWy < vCut.x;
          vec2 auv = vec2((clamp(wuv.x, 0.02, 0.98) + vStyle) / ${SLOTS}.0, wuv.y);
          diffuseColor *= vOuter > 0.5 ? texture2D(map, auv) : texture2D(interiorMap, wuv);`)
        // 받침은 건물 색·손상 어둡기와 상관없이 시멘트색
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (plinth) diffuseColor.rgb = cement;')
        // 실내 면만 전등 빛을 더한다 (건물 색과 곱하지 않아 늘 따뜻한 흰빛)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vOuter < 0.5 && !plinth) totalEmissiveRadiance += texture2D(interiorGlow, wuv).rgb;');
    };
  }
  return [side, side, top, top, side, side];
}

// 건물 블록 InstancedMesh와 블록별 기본색. 장면 데이터 건물(w.buildings와 같은 순서)에 c·w·st가 있으면 지붕색·외벽색·외벽 모양으로 쓴다.
// 병원 건물은 맨 아래층을 유리 로비 칸으로, data.roof가 있으면 맨 위층 윗면을 옥상 사진으로 칠한다
export function makeBlocks(w: World, data?: HospitalData) {
  const B = w.blocks, n = B.n, src = data?.buildings;
  const geo = new THREE.BoxGeometry(B.g, 1, B.g);
  geo.setAttribute('aOuter', new THREE.InstancedBufferAttribute(Float32Array.from(B.outer), 1));
  // 맨 아래층만 (바닥 높이, 층 높이), 나머지는 받침 없음 (-1e9, 0)
  const cut = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const b = w.buildings[B.bld[i]];
    cut[i * 2] = B.cl[i] === 0 ? b.baseY : -1e9; cut[i * 2 + 1] = B.cl[i] === 0 ? b.floorH : 0;
  }
  geo.setAttribute('aCut', new THREE.InstancedBufferAttribute(cut, 2));
  const mesh = new THREE.InstancedMesh(geo, blockMaterials(true, data), Math.max(1, n));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const base = new Float32Array(n * 3), style = new Float32Array(n), roof = new Float32Array(n * 3), photo = new Float32Array(n);
  const c = new THREE.Color(), r = new THREE.Color(), def = new THREE.Color(ROOF);
  w.buildings.forEach((b, k) => {
    const s = src?.[k], pal = b.hosp ? HOSP_COLORS : OTHER_COLORS;
    c.set(s?.w ?? pal[k % pal.length]);
    // 지붕색이 없으면 지금처럼 외벽색 × 옥상 바탕색
    if (s?.c) r.set(s.c); else r.copy(c).multiply(def);
    const ratio = [r.r / Math.max(c.r, 1e-3), r.g / Math.max(c.g, 1e-3), r.b / Math.max(c.b, 1e-3)];
    const st = s?.st ?? 0, vs = VARIANTS[st] ?? [st], v = vs[k % vs.length];
    const look = b.hosp ? (st || HOSP_GRID) : v === 9 && b.nl > 5 ? 10 : v;
    for (let i = b.start; i < b.end; i++) {
      base.set([c.r, c.g, c.b], i * 3); roof.set(ratio, i * 3);
      style[i] = b.hosp && B.cl[i] === 0 ? LOBBY : look;
      if (b.hosp && data?.roof && B.cl[i] === b.nl - 1) photo[i] = 1 / Math.max(c.g, 1e-3);
    }
  });
  geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1));
  geo.setAttribute('aPhoto', new THREE.InstancedBufferAttribute(photo, 1));
  geo.setAttribute('aRoof', new THREE.InstancedBufferAttribute(roof, 3));
  const mat = mesh.instanceMatrix.array as Float32Array;
  const col = new Float32Array(n * 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
  let lo = Infinity, hi = -1;
  // 블록 i의 행렬·색을 현재 HP에 맞게 쓴다 (부서지면 크기 0)
  const write = (i: number) => {
    const on = w.hp[i] > 0 ? 1 : 0, o = i * 16;
    mat.fill(0, o, o + 16);
    mat[o] = on; mat[o + 5] = on * B.hgt[i]; mat[o + 10] = on;
    mat[o + 12] = B.x[i]; mat[o + 13] = B.y[i]; mat[o + 14] = B.z[i]; mat[o + 15] = 1;
    const f = 0.55 + 0.45 * Math.max(0, w.hp[i]) / 100;
    col[i * 3] = base[i * 3] * f; col[i * 3 + 1] = base[i * 3 + 1] * f; col[i * 3 + 2] = base[i * 3 + 2] * f;
    lo = Math.min(lo, i); hi = Math.max(hi, i);
  };
  for (let i = 0; i < n; i++) write(i);
  // 바뀐 범위만 GPU로 올린다
  const flush = () => {
    if (hi < 0) return;
    const im = mesh.instanceMatrix, ic = mesh.instanceColor!;
    im.clearUpdateRanges(); im.addUpdateRange(lo * 16, (hi - lo + 1) * 16); im.needsUpdate = true;
    ic.clearUpdateRanges(); ic.addUpdateRange(lo * 3, (hi - lo + 1) * 3); ic.needsUpdate = true;
    lo = Infinity; hi = -1;
  };
  return { mesh, write, flush, base };
}

// 조명: 반구광 + 그림자 방향광 (그림자 카메라를 지도 크기에 맞춘다)
export function makeLights(w: World, shadowSize: number) {
  const t = w.t, cx = t.x0 + ((t.nx - 1) * t.step) / 2, cz = t.z0 + ((t.nz - 1) * t.step) / 2;
  const half = (Math.max(t.nx, t.nz) - 1) * t.step * 0.72;
  const hemi = new THREE.HemisphereLight('#e8f2ff', '#7d8270', 1.6);
  const sun = new THREE.DirectionalLight('#fff3e2', 2.6);
  sun.position.set(cx - 0.45 * half, 1.1 * half, cz + 0.3 * half);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: half * 4 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  return [hemi, sun, sun.target];
}
