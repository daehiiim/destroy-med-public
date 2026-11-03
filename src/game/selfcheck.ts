// 엔진 순수 로직 self-check: 블록 생성, 피해 감쇠, 지지 BFS, 밸런스, 되돌리기 (npm run check:engine)
/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { HospitalData } from './types.ts';
import { EDGE, RANK_THRESHOLDS, World, cellsOf, falloff, flattenTowers, rankFor, rankTier } from './world.ts';
import { WEAPONS, WEAPON_PARAMS } from './weapons.ts';
import { Evacuees, along } from './crowd.ts';

// 평평한 지형 위에 건물 목록만 바꾼 작은 장면을 만든다
function flat(buildings: HospitalData['buildings']): HospitalData {
  return {
    id: 't', name: 't', short: 'T', center: [0, 0],
    terrain: { x0: -100, z0: -100, step: 8, nx: 26, nz: 26, h: new Array(26 * 26).fill(0) },
    site: [], buildings, roads: [], green: [],
  };
}

// 1. 폴리곤 → 칸
assert.equal(cellsOf([[0, 0], [9, 0], [9, 9], [0, 9]], 3).cells.length, 9);
assert.equal(cellsOf([[0, 0], [30, 0], [30, 6], [0, 6]], 3).cells.length, 20);
const lshape = cellsOf([[0, 0], [12, 0], [12, 6], [6, 6], [6, 12], [0, 12]], 3).cells.length;
assert.equal(lshape, 12, 'L자 건물 칸 수');
assert.equal(cellsOf([[0, 0], [1, 0], [1, 1]], 3).cells.length, 1, '작은 건물도 최소 한 칸');

// 2. 블록 쌓기: 칸 × 층, 맨 아래층은 묻힌 만큼 두 배 높이
{
  const w = new World(flat([{ o: [[0, 0], [9, 0], [9, 9], [0, 9]], h: 14, lv: 4, hosp: 1 }]));
  assert.equal(w.blocks.n, 36);
  assert.equal(w.blocks.hgt[0], 7);
  assert.equal(w.blocks.hgt[9], 3.5);
  // 3×3 칸: 모서리는 두 면, 변 가운데는 한 면, 한가운데는 창문 없음
  assert.deepEqual([...w.blocks.outer.slice(0, 9)], [10, 8, 9, 2, 0, 1, 6, 4, 5], '외벽 면 비트');
}

// 2-1. 고층 밑 가짜 언덕: 100m 건물 밑 20m 솟음은 깎고, 10m 건물 밑 솟음은 그대로 둔다
{
  const d = flat([
    { o: [[-60, -10], [-40, -10], [-40, 10], [-60, 10]], h: 100, lv: 30, hosp: 0 },
    { o: [[40, -10], [60, -10], [60, 10], [40, 10]], h: 10, lv: 3, hosp: 0 },
  ]);
  d.terrain.h = d.terrain.h.map((_, k) => { const x = -100 + (k % 26) * 8; return Math.abs(Math.abs(x) - 50) < 20 && Math.abs(-100 + Math.floor(k / 26) * 8) < 20 ? 20 : 0; });
  const h = flattenTowers(d.terrain, d.buildings), at = (x: number) => h[12 * 26 + (x + 100) / 8];
  assert.ok(at(-52) < 1, `고층 밑 솟음 깎임 (${at(-52)})`);
  assert.equal(at(52), 20, '저층 밑은 그대로');
}

// 3. 피해 감쇠
assert.equal(falloff(100, 10, 0), 100);
assert.equal(falloff(100, 10, 5), 75);
assert.equal(falloff(100, 10, 10), 0);
assert.equal(Math.ceil(100 / WEAPON_PARAMS.rifle.D), 15, '소총은 한 블록에 15발');
// 3-1. 소총은 블록 하나 50점 고정: 5초 안에 3개 = D, 4개여도 C 아래 (맵 배율과 무관)
assert.equal(rankFor(3 * WEAPON_PARAMS.rifle.pts!), 'D');
assert.equal(rankFor(4 * WEAPON_PARAMS.rifle.pts!), 'D');
{
  const w = new World(flat([{ o: [[0, 0], [6, 0], [6, 3], [0, 3]], h: 3.5, lv: 1, hosp: 1 }]));   // 두 칸이라 하나 깨도 무너짐 아님
  w.scoreMul = 3;
  w.hitBlock(w.begin(), 0, 100, WEAPON_PARAMS.rifle.pts);
  assert.equal(w.score, 50, '소총 블록 점수는 맵 배율을 안 받는다');
}

// 4. 지지 BFS: 한 칸짜리 5층 탑의 2층을 부수면 위 3개 층이 떨어진다
{
  const w = new World(flat([{ o: [[0, 0], [3, 0], [3, 3], [0, 3]], h: 17.5, lv: 5, hosp: 1 }]));
  const id = w.begin();
  w.hitBlock(id, 1, 100);
  assert.deepEqual(w.killed, [1]);
  assert.deepEqual(w.fallen, [2, 3, 4]);
  assert.equal(w.destroyed, 4);
  assert.equal(w.score, 80 * w.scoreMul); // 병원 블록 20점 × 4개, 블록 5개짜리 맵이라 배율 최대(2)
}
// 긴 2층 건물(12칸)의 아래층을 첫 칸만 남기고 부수면 6m(2칸)보다 먼 위층이 떨어진다
{
  const w = new World(flat([{ o: [[0, 0], [36, 0], [36, 3], [0, 3]], h: 7, lv: 2, hosp: 0 }]));
  const id = w.begin();
  for (let i = 1; i < 12; i++) w.hitBlock(id, i, 100);
  assert.deepEqual(w.fallen.sort((a, b) => a - b), [15, 16, 17, 18, 19, 20, 21, 22, 23], '외팔보 한계 밖 위층이 떨어진다');
}
// 짧게 옆으로 이어진 블록은 매달린 채 남는다 (6방향 연결)
{
  const w = new World(flat([{ o: [[0, 0], [6, 0], [6, 3], [0, 3]], h: 7, lv: 2, hosp: 0 }]));
  const id = w.begin();
  w.hitBlock(id, 0, 100); // 왼쪽 아래
  assert.equal(w.fallen.length, 0);
  assert.equal(w.unsupported(0).length, 0);
}
// 기울기: 9칸×1칸 5층 건물의 왼쪽 끝 1층을 한 칸씩 부순다.
// 4칸(44%)까지는 서 있고 걸친 쪽만 떨어지며, 5칸(56%)째에 남은 위층이 왼쪽(-x)으로 기운다. 1층 받침은 남는다
{
  const w = new World(flat([{ o: [[0, 0], [27, 0], [27, 3], [0, 3]], h: 17.5, lv: 5, hosp: 0 }]));
  const id = w.begin();
  for (let i = 0; i < 2; i++) w.hitBlock(id, i, 100);
  assert.deepEqual([w.topples.length, w.fallen.length], [0, 0], '밑둥 두 칸(22%)으로는 기울지 않는다');
  for (let i = 2; i < 4; i++) w.hitBlock(id, i, 100);
  assert.deepEqual([w.topples.length, w.fallen.length], [0, 8], '네 칸(44%)이면 걸친 두 줄만 떨어진다');
  w.hitBlock(id, 4, 100);
  assert.equal(w.topples.length, 1, '받침 절반 넘게 잃으면 기울 덩어리 하나');
  const tp = w.topples[0];
  assert.ok(tp.dx < -0.9 && tp.blocks.length === 28, '부순 쪽으로 남은 위층 28개가 기운다');
  assert.ok(Math.abs(tp.px - 15) < 1e-6 && tp.py === 3.5, '축은 남은 받침의 왼쪽 모서리, 1층 윗면');
  assert.ok([5, 6, 7, 8].every((i) => w.hp[i] === 100), '1층 받침은 그루터기로 남는다');
  w.undo();
  assert.ok(w.hp.every((v) => v === 100) && w.destroyed === 0 && w.score === 0, '기울기도 되돌리기 한 번에 전부 돌아온다');
  // 가운데 1층 다섯 칸(56%)을 뚫어도 대칭이라 기울지 않는다
  w.topples.length = 0;
  const id2 = w.begin();
  for (let i = 2; i < 7; i++) w.hitBlock(id2, i, 100);
  assert.equal(w.topples.length, 0, '가운데 구멍은 기울지 않는다');
}
// 무게 중심이 받침 밖이면 받침을 적게 잃어도 넘어간다: 9칸 중 오른쪽 위 블록을 걷어 내 무게를 왼쪽으로 몬 뒤 왼쪽 밑둥 세 칸을 부순다
{
  const w = new World(flat([{ o: [[0, 0], [27, 0], [27, 3], [0, 3]], h: 17.5, lv: 5, hosp: 0 }]));
  const id = w.begin();
  for (let l = 1; l < 5; l++) for (let j = 3; j < 9; j++) w.hitBlock(id, l * 9 + j, 100);
  for (let i = 0; i < 3; i++) w.hitBlock(id, i, 100);
  assert.equal(w.topples.length, 1, '무게가 받침 밖으로 나가면 33%만 잃어도 기운다');
}

// 5. 랭크
assert.equal(rankFor(0), 'F');
assert.equal(rankFor(39), 'F');
assert.equal(rankFor(40), 'E');
assert.equal(rankFor(149), 'E');
assert.equal(rankFor(150), 'D');
assert.equal(rankFor(500), 'C');
assert.equal(rankFor(1e6, 99), 'SSS');
// R85·R86 13단계: 점수만 넘고 콤보가 모자라면 S에 못 닿고 A+에서 멈춘다
assert.equal(RANK_THRESHOLDS.length, 13);
assert.equal(rankFor(1e6), 'A+', '콤보 없이는 A+까지');
assert.equal(rankFor(1e6, 19), 'A+');
assert.equal(rankFor(1e6, 20), 'S');
assert.equal(rankFor(1e6, 79), 'SS');
assert.equal(rankFor(0, 99), 'F', '콤보만으로는 안 오른다');
assert.ok(RANK_THRESHOLDS.every(([, p], k) => !k || p < RANK_THRESHOLDS[k - 1][1]), '높은 랭크일수록 점수 기준이 높다');
assert.deepEqual((['F', 'C', 'B-', 'B+', 'A-', 'A+', 'S', 'SSS'] as const).map(rankTier), [0, 3, 4, 4, 5, 5, 6, 8], '글자 단계');

// R88 연속 타격 콤보: 1층 병원 10칸 + 떨어진 민간 건물 3칸
{
  const mk = () => new World(flat([
    { o: [[0, 0], [30, 0], [30, 3], [0, 3]], h: 3.5, lv: 1, hosp: 1 },
    { o: [[60, 0], [69, 0], [69, 3], [60, 3]], h: 3.5, lv: 1, hosp: 0 },
  ]));
  const pts = WEAPON_PARAMS.rifle.pts!;
  const w = mk(), id = w.begin();
  w.scoreMul = 1;
  w.hitBlock(id, 0, 100, pts);
  assert.equal(w.combo, 1);
  assert.equal(w.score, pts, '첫 블록은 배율 1');
  w.hitBlock(id, 1, 100, pts);
  assert.equal(w.combo, 1, '같은 순간 두 블록은 +1');
  w.time += 0.2;
  w.hitBlock(id, 2, 100, pts);
  const t2 = w.time;   // 콤보가 마지막으로 오른 시각
  assert.equal(w.combo, 2, '소총은 같은 기록이어도 시간이 지나면 오른다');
  assert.equal(w.score, pts + 2 * Math.round(pts * (1 + 1 / 30)), '콤보 배율이 점수에 곱해진다 (콤보 1이 된 뒤 두 블록)');
  w.time += 0.2;
  w.hitBlock(id, 3, 100);
  assert.equal(w.combo, 2, '떨어진 블록 부딪힘(pts 없음)은 콤보를 안 올린다');
  w.time += 0.2;
  w.hitBlock(id, w.buildings[1].start, 100, pts);
  assert.equal(w.combo, 2, '민간 건물은 콤보를 안 올린다');
  w.time = t2 + 1.9;
  w.rank();
  assert.equal(w.combo, 2, '마지막으로 오른 뒤 2초 안이면 이어진다 (민간 건물 타격은 끊지도 않는다)');
  w.time = t2 + 2.1;
  w.rank();
  assert.equal(w.combo, 0, '2초 넘게 쉬면 0');
  // 폭발물: 한 발(기록 하나)의 여러 번 타격은 +1, 다른 발은 +1
  const e = mk(), a = e.begin();
  e.damageSphere(a, 1.5, 1, 1.5, 3, 140);
  e.time += 0.3;
  e.damageSphere(a, 7.5, 1, 1.5, 3, 140);
  assert.equal(e.combo, 1, '같은 한 발은 콤보 한 번');
  e.time += 0.3;
  e.damageSphere(e.begin(), 13.5, 1, 1.5, 3, 140);
  assert.equal(e.combo, 2);
  assert.ok(e.comboMul > 1);
  e.undo();
  assert.equal(e.combo, 0, '되돌리기는 콤보를 0으로');
  e.time += 0.3;
  e.damageSphere(e.begin(), 19.5, 1, 1.5, 3, 140);
  assert.equal(e.combo, 1);
  e.restoreAll();
  assert.equal(e.combo, 0, '전부 복구는 콤보를 0으로');
  const m = mk();
  m.combo = 999;
  assert.equal(m.comboMul, 3, '배율은 최대 ×3');
}

// 6. 밸런스와 되돌리기: 합성 데이터의 큰 병동(본관 90×22m, 12층)
const sample = JSON.parse(readFileSync(new URL('../../public/data/h/_sample.json', import.meta.url), 'utf8')) as HospitalData;
{
  const w = new World(sample);
  const k = w.buildings.findIndex((b) => b.name === '본관');
  const b = w.buildings[k], total = b.end - b.start;
  const P = WEAPON_PARAMS.bomb;
  // 지붕 정중앙에 항공폭탄 한 발
  const hit = w.raycast([b.cx, 300, b.cz], [0, -1, 0]);
  assert.ok(hit && hit.block >= 0, '위에서 쏘면 본관 지붕에 맞는다');
  const id = w.begin();
  w.damageSphere(id, b.cx, 300 - hit.t, b.cz, P.R, P.D);
  const ratio = b.dead / total;
  console.log(`항공폭탄 1발: 본관 ${b.dead}/${total} 블록 (${(ratio * 100).toFixed(1)}%), 떨어짐 ${w.fallen.length}`);
  assert.ok(b.dead > 0 && !b.down && ratio < 0.5, '항공폭탄 한 발이 큰 병동을 통째로 지우지 못한다');
  // 땅에 붙여 터뜨려도(아래층 파괴 → 위층 붕괴 포함) 절반을 넘지 못한다
  {
    const g2 = new World(sample), b2 = g2.buildings[k];
    g2.damageSphere(g2.begin(), b2.cx, b2.baseY, b2.cz, P.R, P.D);
    const r2 = b2.dead / (b2.end - b2.start);
    console.log(`항공폭탄 1발(지면): 본관 ${b2.dead}/${b2.end - b2.start} 블록 (${(r2 * 100).toFixed(1)}%), 떨어짐 ${g2.fallen.length}`);
    assert.ok(!b2.down && r2 < 0.5 && g2.fallen.length > 0, '지면 폭격: 위층 일부가 떨어지되 병동 전체는 남는다');
  }

  // 중성자탄: 본관 중심 지면에 한 발이면 본관이 통째로 사라진다. 바깥 고리 2차 피해도 같은 기록으로 되돌린다
  {
    const g3 = new World(sample), b3 = g3.buildings[k], N = WEAPON_PARAMS.nuke;
    const id3 = g3.begin();
    g3.damageSphere(id3, b3.cx, b3.baseY, b3.cz, N.R, N.D);
    const r3 = b3.dead / (b3.end - b3.start);
    g3.damageRing(id3, b3.cx, b3.cz, N.R, N.R * 1.6, N.R, N.R * 0.6, 150);
    console.log(`중성자탄 1발(지면): 본관 ${b3.dead}/${b3.end - b3.start} 블록 (${(r3 * 100).toFixed(1)}%), 전체 ${g3.destroyed}/${g3.blocks.n}`);
    assert.ok(r3 >= 0.9 && b3.down, '중성자탄 한 발에 본관 90% 이상이 사라지고 무너진다');
    g3.undo();
    assert.ok(g3.hp.every((v) => v === 100) && g3.destroyed === 0 && !b3.down, '중성자탄도 되돌리기 한 번에 전부 돌아온다');
  }

  // 되돌리기 정확성: 여러 행동 뒤 하나씩 되돌리면 각 단계 상태로 돌아온다
  const snap = () => ({ hp: Float32Array.from(w.hp), h: Float32Array.from(w.t.h), score: w.score, destroyed: w.destroyed, down: w.buildingsDown, near: w.nearbyDown, trees: Uint8Array.from(w.treeAlive) });
  const s1 = snap();
  const id2 = w.begin();
  w.damageSphere(id2, b.cx + 20, b.baseY, b.cz, 10, 320);
  w.crater(id2, b.cx + 20, b.cz, 10, 2);
  w.killTrees(id2, b.cx + 20, b.cz, 10);
  const id3 = w.begin();
  for (let i = 0; i < 30; i++) w.hitBlock(id3, b.end - 1, 7);
  assert.notEqual(w.score, s1.score);
  w.undo(); w.undo();
  const s2 = snap();
  assert.deepEqual(s2, s1, 'undo 두 번 뒤 첫 폭격 직후 상태와 같다');
  w.undo();
  assert.equal(w.score, 0);
  assert.equal(w.destroyed, 0);
  assert.ok(w.hp.every((v) => v === 100));
  assert.equal(w.canUndo(), false);

  // 전부 복구
  const id4 = w.begin();
  w.damageSphere(id4, b.cx, b.baseY, b.cz, 18, 500);
  w.crater(id4, b.cx, b.cz, 18, 4);
  w.restoreAll();
  assert.equal(w.score, 0);
  assert.equal(w.destroyed, 0);
  assert.ok(w.hp.every((v) => v === 100));
  assert.deepEqual(w.t.h, w.t0);
  assert.equal(w.canUndo(), false);
  console.log(`합성 데이터: 건물 ${w.buildings.length}동, 블록 ${w.blocks.n}개 (칸 ${w.blocks.g}m), 나무 ${w.treeAlive.length}그루`);
}

// 6-1. 민간 건물(hosp 0)은 무너져도 점수 0, 병원(hosp 1)만 점수가 오른다. 되돌리면 민간 피해 수도 돌아간다
{
  const bs = [0, 1, 2].map((k) => ({ o: [[k * 12, 0], [k * 12 + 3, 0], [k * 12 + 3, 3], [k * 12, 3]] as [number, number][], h: 3.5, lv: 1, hosp: (k < 2 ? 0 : 1) as 0 | 1 }));
  const w = new World(flat(bs));
  w.hitBlock(w.begin(), 0, 100);
  w.hitBlock(w.begin(), 1, 100, 50);
  assert.equal(w.civilDown, 2);
  assert.equal(w.score, 0, '민간 건물은 점수에 넣지 않는다');
  w.hitBlock(w.begin(), 2, 100);
  assert.ok(w.score > 0, '병원은 점수가 오른다');
  w.undo(); w.undo();
  assert.equal(w.civilDown, 1);
}

// 7. 받아 둔 실제 병원 데이터마다 블록 상한을 지키는지 확인
const dir = new URL('../../public/data/h/', import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_sample.json')) {
  const id = f.slice(0, -5);
  const data = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as HospitalData;
  const t0 = performance.now();
  const w = new World(data);
  assert.ok(w.blocks.n <= 150000);
  // R75: 지형판 밖 EDGE(10m) 넘은 나무가 없다
  const ex = w.t.x0 + (w.t.nx - 1) * w.t.step + EDGE, ez = w.t.z0 + (w.t.nz - 1) * w.t.step + EDGE;
  for (let k = 0; k < w.trees.length; k += 4) {
    const x = w.trees[k], z = w.trees[k + 2];
    assert.ok(x >= w.t.x0 - EDGE && x <= ex && z >= w.t.z0 - EDGE && z <= ez, `${id}: 지형판 밖 나무 ${x},${z}`);
  }
  // 점 → 블록 조회: 블록 중심은 그 블록, 부서지면 -1, 건물 밖은 -1
  // 외곽선이 겹친 건물이 있어 후보를 안 주면 겹친 옆 건물 블록이 나올 수 있다 (그래도 -1은 아니다)
  const B = w.blocks, id0 = w.begin();
  for (const i of [0, B.n >> 1, B.n - 1]) {
    assert.ok(w.blockAt(B.x[i], B.y[i], B.z[i]) >= 0, `${id}: blockAt 버킷 ${i}`);
    assert.equal(w.blockAt(B.x[i], B.y[i], B.z[i], [B.bld[i]]), i, `${id}: blockAt 블록 ${i}`);
    w.hitBlock(id0, i, 1e9);
    assert.equal(w.blockAt(B.x[i], B.y[i], B.z[i], [B.bld[i]]), -1, `${id}: 부서진 블록 ${i}`);
  }
  assert.equal(w.blockAt(w.t.x0 - 50, 0, w.t.z0 - 50), -1, `${id}: 건물 밖`);
  console.log(`${id}: 건물 ${w.buildings.length}동, 블록 ${w.blocks.n}개 (칸 ${w.blocks.g}m), 나무 ${w.treeAlive.length}그루, 생성 ${(performance.now() - t0).toFixed(0)}ms`);
}

// R69 대피 인파: 도로 보간과 폭발 반경 안 숨김
{
  const o = new Float32Array(3);
  along([[0, 0], [10, 0], [10, 20]], 1, 5, o);
  assert.deepEqual([...o], [10, 5, 0], '두 번째 구간 5m 지점, +z 방향');
  const d = flat([{ o: [[0, 0], [9, 0], [9, 9], [0, 9]], h: 7, lv: 2, hosp: 1 }]);
  d.roads = [{ p: [[-90, 30], [90, 30]], w: 8 }];
  const c = new Evacuees(new World(d), d, true);
  assert.equal(c.people.count, 150 + 60, '휴대폰 사람 수 (일반 150 + 건물 탈출 예비 60)');
  assert.equal(c.cars.count, 20, '휴대폰 차 수');
  c.update(0.016);
  const ys = () => { const m = c.people.instanceMatrix.array; return Array.from({ length: c.people.count }, (_, k) => m[k * 16 + 13]); };
  assert.ok(ys().slice(0, 150).every((y) => y > 0 && y < 2), '사람은 땅(0m) 위에 붙어 있다');
  assert.ok(ys().slice(150).every((y) => y < -1000), '예비 슬롯은 처음엔 숨어 대기');
  c.blast(0, 0, 500);
  c.update(0.016);
  assert.ok(ys().every((y) => y < -1000), '폭발 반경 안 사람은 숨는다');
}

// R76~R78 대피 인파: 소총에 죽는 반경, 건물 탈출, 차 U턴 방위 회전
{
  const d = flat([{ o: [[0, 0], [9, 0], [9, 9], [0, 9]], h: 7, lv: 2, hosp: 1 }]);
  d.roads = [{ p: [[-90, 30], [90, 30]], w: 8 }];
  const mk = () => new Evacuees(new World(d), d, true);
  // 소총(R=0): 1m 옆 사람은 죽고 60m 밖 사람은 안 죽는다
  {
    const c = mk(), px = c['px'], pz = c['pz'], pw = c['pw'];
    px[0] = 1; pz[0] = -20; px[1] = -61; pz[1] = -20;
    const dead = c.blast(0, -20, 0);
    assert.ok(dead.length >= 1, '소총 1m 옆 사람이 죽는다');
    assert.ok(dead.every((e) => Math.hypot(e.x, e.z + 20) < 2.6), '죽는 건 반경 안뿐');
    assert.ok(pw[0] > 0 && pw[1] === 0, '1m 사람은 숨고 61m 사람은 그대로');
  }
  // 건물 옆 폭발 뒤 2초면 예비 슬롯에서 사람이 나온다
  {
    const c = mk(), m = c.people.instanceMatrix.array;
    c.blast(14, 4, 6);
    for (let k = 0; k < 125; k++) c.update(0.016);
    let out = 0;
    for (let k = 150; k < c.people.count; k++) if (m[k * 16 + 13] > -1000) out++;
    assert.ok(out >= 1, `건물에서 탈출한 사람 ${out}명`);
  }
  // 차: 돌려세운 뒤 한 프레임 방위 변화 0.05rad 이하, 실제로 크게 도는 차가 있다
  {
    const c = mk(), m = c.cars.instanceMatrix.array, n = c.cars.count;
    const st = () => Array.from({ length: n }, (_, k) => [Math.atan2(m[k * 16 + 8], m[k * 16]), m[k * 16 + 12], m[k * 16 + 13], m[k * 16 + 14]]);
    c.blast(0, 30, 0);
    let prev = st(), worst = 0;
    const turned = new Float64Array(n);
    for (let f = 0; f < 300; f++) {
      c.update(0.016);
      const cur = st();
      for (let k = 0; k < n; k++) {
        const [a0, x0, y0, z0] = prev[k], [a1, x1, y1, z1] = cur[k];
        if (y0 < -1000 || y1 < -1000 || Math.hypot(x1 - x0, z1 - z0) > 1) continue;   // 숨김·재등장 프레임은 뺀다
        let e = a1 - a0;
        e -= Math.round(e / (Math.PI * 2)) * Math.PI * 2;
        worst = Math.max(worst, Math.abs(e)); turned[k] += Math.abs(e);
      }
      prev = cur;
    }
    assert.ok(worst <= 0.05, `차 한 프레임 방위 변화 ${worst.toFixed(3)}rad`);
    assert.ok(Math.max(...turned) > 2, '폭발 쪽으로 가던 차가 U턴한다');
  }
}

// R79~R82 대피 흐름: 교차로 갈아타기, 끊긴 도로 앞 U턴, 무너진 건물에서는 안 나온다
{
  const bld = { o: [[0, 0], [9, 0], [9, 9], [0, 9]] as [number, number][], h: 7, lv: 2, hosp: 1 as const };
  // 차 0만 도로 0의 cu 지점에 +방향으로 두고 나머지는 숨긴다
  const solo = (c: Evacuees, cu: number) => {
    const cw = c['cw'];
    cw.fill(1e9); cw[0] = 0;
    c['cr'][0] = 0; c['cs'][0] = 0; c['cu'][0] = cu; c['cd'][0] = c['cg'][0] = 1; c['cvel'][0] = 8; c['ch'][0] = Math.PI / 2;
    c['cq'][0] = 0; c['cf'][0] = 0; c['cut'][0] = 0; c['cp'][0] = -1;
  };
  // 두 도로가 (0,30)에서 만난다: 첫 도로 끝에 닿은 차가 사라지지 않고 둘째 도로로 넘어간다
  {
    const d = flat([bld]);
    d.roads = [{ p: [[-150, 30], [0, 30]], w: 8 }, { p: [[0, 30], [0, 150]], w: 8 }];
    const c = new Evacuees(new World(d), d, true);
    solo(c, 140);
    let hop = false;
    for (let f = 0; f < 300 && !hop; f++) {
      c.update(0.016);
      assert.ok(c['cw'][0] <= 0, '교차로에 닿은 차가 사라지지 않는다');
      hop = c['cr'][0] === 1;
    }
    assert.ok(hop && c['cd'][0] === 1, '첫 도로 끝에서 둘째 도로로 넘어간다');
  }
  // 도로 가운데(0,30) 지형을 2m 낮추면 그쪽으로 가던 차가 그 지점을 못 지나고 돌아선다
  {
    const d = flat([bld]);
    d.roads = [{ p: [[-150, 30], [0, 30], [150, 30]], w: 8 }];   // 꼭짓점이 하나는 지도 안에 있어야 차 도로가 된다
    const w = new World(d), c = new Evacuees(w, d, true);
    for (let k = 0; k < w.t.h.length; k++) if (Math.abs(w.t.x0 + (k % w.t.nx) * w.t.step) <= 4 && Math.abs(w.t.z0 + Math.floor(k / w.t.nx) * w.t.step - 30) <= 4) w.t.h[k] = -2;
    solo(c, 90);
    let maxX = -Infinity, back = false;
    for (let f = 0; f < 600 && !back; f++) {
      c.update(0.016);
      assert.ok(c['cw'][0] <= 0, '끊긴 도로 앞 차가 사라지지 않는다');
      maxX = Math.max(maxX, c['cs'][0] ? c['cu'][0] : -150 + c['cu'][0]);
      back = c['cvel'][0] < -2;
    }
    assert.ok(back && maxX < -4, `끊긴 도로 앞에서 돌아선다 (가장 멀리 간 x ${maxX.toFixed(1)})`);
  }
  // 무너진 병원 건물 근처에서는 아무도 나오지 않는다 (일반 재등장·폭발 탈출 모두)
  {
    const d = flat([bld, { ...bld, o: [[50, 0], [59, 0], [59, 9], [50, 9]] }]);
    const w = new World(d), c = new Evacuees(w, d, true), B = w.buildings, px = c['px'], pz = c['pz'], pw = c['pw'];
    B[1].down = true;
    c.clear();
    c.blast(54, 4, 4);
    let seen = 0;
    const hidden = Array.from(pw, (v) => v > 0);
    for (let f = 0; f < 400; f++) {
      c.update(0.025);
      for (let i = 0; i < pw.length; i++) {
        const h = pw[i] > 0;
        if (hidden[i] && !h) {
          seen++;
          const ex = Math.max(50 - px[i], 0, px[i] - 59), ez = Math.max(0 - pz[i], 0, pz[i] - 9);
          assert.ok(Math.hypot(ex, ez) > 3, `무너진 건물 옆에서 나옴 ${px[i].toFixed(1)},${pz[i].toFixed(1)}`);
        }
        hidden[i] = h;
      }
    }
    assert.ok(seen > 100, `다시 나온 사람 ${seen}명`);
  }
}

// R79·R80 실제 병원(서울대병원): 다시 생긴 차는 모두 진입점, 사람은 건물에서 나와 건물로 들어간다
{
  const data = JSON.parse(readFileSync(new URL('snuh.json', dir), 'utf8')) as HospitalData;
  const w = new World(data), t = w.t, B = w.buildings, t0 = performance.now(), c = new Evacuees(w, data, true);
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `대피 인파 생성 ${ms.toFixed(0)}ms`);
  const X0 = t.x0, X1 = t.x0 + (t.nx - 1) * t.step, Z0 = t.z0, Z1 = t.z0 + (t.nz - 1) * t.step;
  const nearAlive = (x: number, z: number) => B.some((b) => !b.down && Math.hypot(Math.max(b.min[0] - x, 0, x - b.max[0]), Math.max(b.min[2] - z, 0, z - b.max[2])) < 3);
  const px = c['px'], pz = c['pz'], pw = c['pw'], cw = c['cw'], np = c['np'], o = new Float32Array(3);
  const ph = Array.from(pw, (v) => v > 0), chd = Array.from(cw, (v) => v > 0);
  let cars = 0, ins = 0, outs = 0;
  for (let f = 0; f < 4000; f++) {
    c.update(0.05);
    for (let i = 0; i < cw.length; i++) {
      const h = cw[i] > 0;
      if (chd[i] && !h) {
        cars++;
        along(data.roads[c['cr'][i]].p, c['cs'][i], c['cu'][i], o);
        const m = Math.min(o[0] - (X0 - EDGE), X1 + EDGE - o[0], o[1] - (Z0 - EDGE), Z1 + EDGE - o[1]);
        assert.ok(m >= 0 && m <= 3, `다시 생긴 차가 진입점 밖 (경계까지 ${m.toFixed(1)}m)`);
      }
      chd[i] = h;
    }
    for (let i = 0; i < np; i++) {
      const h = pw[i] > 0, x = px[i], z = pz[i];
      if (!ph[i] && h) {
        ins++;
        assert.ok(nearAlive(x, z) || x < X0 || x > X1 || z < Z0 || z > Z1, `건물·지형판 밖이 아닌 곳에서 숨음 ${x.toFixed(1)},${z.toFixed(1)}`);
      } else if (ph[i] && !h) {
        outs++;
        assert.ok(nearAlive(x, z), `건물 밖에서 나타남 ${x.toFixed(1)},${z.toFixed(1)}`);
      }
      ph[i] = h;
    }
  }
  console.log(`snuh 대피: 진입점 ${c['ent'].length}곳, 다시 생긴 차 ${cars}대, 숨은 사람 ${ins}, 나온 사람 ${outs}, 생성 ${ms.toFixed(0)}ms`);
  assert.ok(cars > 0 && ins > 0 && outs > 0, '차·사람이 실제로 드나든다');
}

// R73·R74·R94 무기 표: 11개, 단축키 1~9·0·- 차례, 해금 랭크는 뒤로 갈수록 같거나 높다, 휴대폰 칸 이름은 3글자 이하
{
  const ri = (r: string) => RANK_THRESHOLDS.findIndex(([x]) => x === r);   // 작을수록 높은 랭크
  assert.equal(WEAPONS.length, 11, '무기 11개');
  assert.deepEqual(WEAPONS.map((w) => w.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'], '단축키 1~9·0·-');
  assert.deepEqual(WEAPONS.map((w) => w.id), Object.keys(WEAPON_PARAMS), '무기 표와 수치 표 순서');
  assert.ok(WEAPONS.every((w, k) => !k || ri(w.unlock) <= ri(WEAPONS[k - 1].unlock)), '해금 순서');
  // R87 해금 표 (23-rank-combo.md)
  assert.deepEqual(Object.fromEntries(WEAPONS.map((w) => [w.id, w.unlock])), {
    rifle: 'F', grenade: 'E', mortar: 'D', artillery: 'C', cluster: 'B', mlrs: 'B+', bomb: 'A', bunker: 'A', thermo: 'A+', rod: 'SS', nuke: 'SSS',
  }, '해금 표');
  assert.ok(WEAPONS.every((w) => (w.short ?? w.name).length <= 3), '휴대폰 칸 이름 3글자 이하');
  // 무기 칸 밑 설명은 공백 포함 10자 이하 (docs/add-weapon.md)
  for (const w of WEAPONS) assert.ok(w.desc.length <= 10, `${w.id} 설명 10자 초과: ${w.desc}`);
}

// R73 벙커버스터: 기둥을 뚫고 1층에서 터지면 맞은 건물이 내려앉는다(위층이 받침을 잃고 떨어지거나 기운다)
{
  const P = WEAPON_PARAMS.bunker;
  const shot = (w: World, k: number) => {
    const b = w.buildings[k], id = w.begin();
    w.drill(id, k, b.cx, b.cz, w.blocks.g * 1.2);
    const col = w.killed.length;
    w.drill(id, k, b.cx, b.cz, P.R * 2, true);
    w.damageSphere(id, b.cx, b.baseY + b.floorH * 0.5, b.cz, P.R, P.D);
    return { b, col, id };
  };
  // 21×21m 6층 건물: 1층 받침이 모두 사라져 통째로 내려앉는다
  const w1 = new World(flat([{ o: [[0, 0], [21, 0], [21, 21], [0, 21]], h: 21, lv: 6, hosp: 1 }]));
  const r1 = shot(w1, 0);
  console.log(`벙커버스터(21m 6층): 기둥 ${r1.col}블록, 전체 ${r1.b.dead}/${r1.b.end - r1.b.start}, 기욺 ${w1.topples.length}`);
  assert.ok(r1.col >= 6 * 5, '기둥이 지붕부터 바닥까지 뚫린다');
  assert.ok(r1.b.down, '작은 건물은 통째로 내려앉는다');
  // 큰 병동(본관 90m): 반경 2R(24m) 구간의 위층이 받침을 잃고 떨어지거나 기운다
  const w2 = new World(sample), k2 = w2.buildings.findIndex((b) => b.name === '본관'), r2 = shot(w2, k2);
  console.log(`벙커버스터(본관): 기둥 ${r2.col}블록, 전체 ${r2.b.dead}/${r2.b.end - r2.b.start}, 떨어짐 ${w2.fallen.length}, 기욺 ${w2.topples.length}`);
  assert.ok(w2.fallen.length > 0 || w2.topples.length > 0, '큰 건물도 위층 일부가 떨어진다');
  w2.undo();
  assert.ok(w2.hp.every((v) => v === 100), '벙커버스터 한 발은 되돌리기 한 번');
}

// R74 집속탄: 자탄 여러 발이 같은 기록(act) 하나에 쌓여 되돌리기 한 번에 돌아온다
{
  const w = new World(sample), b = w.buildings[0], P = WEAPON_PARAMS.cluster, id = w.begin();
  for (let n = 0; n < 24; n++) w.damageSphere(id, b.cx + (n % 6) * 8 - 20, b.topY, b.cz + Math.floor(n / 6) * 6 - 9, P.R, P.D);
  assert.ok(w.destroyed > 0);
  w.undo();
  assert.ok(w.hp.every((v) => v === 100) && w.destroyed === 0 && !w.canUndo(), '집속탄 한 발은 되돌리기 한 번');
}

// R92 열압력탄 닫힌 공간 증폭: 맞은 건물에만 더 준 피해(damageSphere only)는 옆 건물을 건드리지 않고, 맞은 건물 속은 더 크게 빈다
{
  const P = WEAPON_PARAMS.thermo;
  const d = flat([
    { o: [[0, 0], [60, 0], [60, 21], [0, 21]], h: 28, lv: 8, hosp: 1 },
    { o: [[0, 24], [21, 24], [21, 45], [0, 45]], h: 21, lv: 6, hosp: 0 },
  ]);
  const fire = (amp: boolean) => {
    const w = new World(d), b = w.buildings[0], id = w.begin(), y = b.baseY + b.floorH * 2.5;
    for (let n = 0; n < 3; n++) {
      w.damageSphere(id, 10.5, y, 10.5, P.R, P.D / 3);
      if (amp) w.damageSphere(id, 10.5, y, 10.5, P.R * 1.6, P.D / 3, 0);
    }
    return w;
  };
  const a = fire(true), n = fire(false), b1 = a.buildings[1];
  console.log(`열압력탄(60m 8층): 증폭 ${a.buildings[0].dead} / 없음 ${n.buildings[0].dead} 블록`);
  assert.ok(a.buildings[0].dead > n.buildings[0].dead, '닫힌 공간 증폭이 맞은 건물을 더 부순다');
  assert.deepEqual([...a.hp.slice(b1.start, b1.end)], [...n.hp.slice(b1.start, b1.end)], '증폭은 옆 건물에 피해를 주지 않는다');
}

console.log('engine self-check OK');
