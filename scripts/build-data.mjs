// 병원별 장면 데이터(건물·도로·녹지·지형)를 OSM + VWorld + 카카오 + AWS Terrain Tiles에서 받아 public/data 에 JSON으로 굽는다.
// 건물은 VWorld 건물통합정보 + 카카오 이름표, VWorld 가 실패하면 OSM 건물을 쓴다. 키는 프로젝트 루트 .env.
// 사용: npm run data (전체) / npm run data -- gachon-gil (하나) / --force (이미 있어도 다시 받음)
//       --buildings-only: 있는 파일의 부지·도로·녹지·지형은 두고 건물만 VWorld + 카카오로 바꾼다 (Overpass 안 부름)
//       --looks-only: 있는 파일의 건물 모양·이름·hosp는 두고 지붕색 c·외벽색 w·외벽 모양 st만 넣는다 (VWorld 위성 타일 + WFS)
//       --roof-only: 병원 건물(hosp=1)만 외벽 5종(w·st)을 고르고 옥상 위성 사진 public/data/roof/<id>.jpg + JSON roof 를 넣는다
// 샌드박스처럼 프록시 뒤에서 돌릴 때는 NODE_USE_ENV_PROXY=1 을 붙인다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { HOSPITALS } from './hospitals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch { /* .env 가 없으면 VWorld·카카오 없이 OSM 건물만 쓴다 */ }
const OUT_DIR = path.join(ROOT, 'public/data');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const VWORLD = 'https://api.vworld.kr/req/wfs';
const KAKAO = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const BLOCK_BUDGET = 140_000; // 엔진은 블록 15만 개를 넘으면 칸을 3m→4m 로 키운다(world.ts buildBlocks). 여유를 두고 자른다
const UA = 'smash-hospital-build/0.1';
const STEP = 8; // 지형 격자 간격(m)
const PAD = 120; // 부지 바깥 여유(m)
const MAX_SIDE = 900; // 한 변 최대(m)
const FALLBACK_HALF = 300; // 부지 없을 때 병원 중심 ±(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;

// ---------- 에러 (ERROR.md: 도메인 코드 + 한 줄 JSON 진단 로그) ----------

/** 도메인 에러 코드를 가진 에러. retryable·upstream 은 진단 로그에 그대로 실린다. */
class DataError extends Error {
  constructor(code, message, { httpStatus = 0, retryable = false, upstream = null, cause } = {}) {
    super(message, { cause });
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.upstream = upstream;
  }
}

/** 홈 경로를 가린 스택트레이스. */
const cleanStack = (e) => String(e?.stack ?? '').split(os_home()).join('~');
function os_home() { return process.env.HOME || '/nonexistent'; }

/** 진단 로그를 stdout 한 줄 JSON 으로 낸다. 직렬화가 실패하면 최소 정보만 찍는다. */
function logError(err, ctx) {
  const code = err.code ?? 'DATA_PARSE_FAILED';
  try {
    console.log('APP_ERROR_DIAGNOSTIC ' + JSON.stringify({
      code,
      httpStatus: err.httpStatus ?? 0,
      layer: 'script', component: 'build-data', operation: 'buildHospital',
      function: ctx.fn, failurePoint: ctx.step, lastOkStep: ctx.lastOk,
      retryable: !!err.retryable,
      input: { id: ctx.id, query: ctx.query, force: ctx.force },
      output: ctx.output ?? null,
      errormessage: err.message, error_message: err.message,
      stacktrace: cleanStack(err),
      diagnostic: { nextAction: nextAction(code), step: ctx.step },
      exception: err.cause ? String(err.cause?.message ?? err.cause) : err.name,
      upstream: err.upstream,
    }));
  } catch {
    console.log(`APP_ERROR_DIAGNOSTIC {"code":"${code}","id":"${ctx.id}","error_message":${JSON.stringify(String(err.message))}}`);
  }
}
function nextAction(code) {
  return ({
    DATA_UPSTREAM_TIMEOUT: '잠시 뒤 같은 id 로 npm run data -- <id> 재실행',
    DATA_SITE_NOT_FOUND: 'hospitals.mjs 의 query.re / 좌표를 OSM 에서 다시 확인',
    DATA_PARSE_FAILED: '응답 형식 변경 여부 확인 후 parse 로직 수정',
    DATA_TERRAIN_FAILED: 's3.amazonaws.com 접근과 타일 좌표 확인',
    DATA_SATELLITE_FAILED: 'api.vworld.kr WMTS 접근(VWORLD_KEY)과 JPEG 디코딩 확인 후 --looks-only <id> 재실행',
  })[code] ?? '로그의 errormessage 확인';
}

// ---------- 네트워크 ----------

/** Overpass 질의. UA 필수, 502/504 등은 20s→40s→80s 백오프로 최대 5회 재시도. */
async function overpass(ql, label) {
  const waits = [20, 40, 80, 80];
  let last;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: AbortSignal.timeout(150_000),
      });
      if (res.ok) {
        const j = await res.json().catch((e) => { throw new DataError('DATA_PARSE_FAILED', 'Overpass 응답이 JSON 이 아님', { httpStatus: res.status, cause: e }); });
        // 200 인데 서버 쪽 시간 초과/메모리 초과면 remark 로 알려 준다
        if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark)) {
          throw new DataError('DATA_UPSTREAM_TIMEOUT', `Overpass remark: ${j.remark}`, { httpStatus: 200, retryable: true, upstream: { endpoint: OVERPASS, status: 200 } });
        }
        return j;
      }
      const retry = res.status >= 500 || res.status === 429;
      last = new DataError('DATA_UPSTREAM_TIMEOUT', `Overpass HTTP ${res.status}`, { httpStatus: res.status, retryable: retry, upstream: { endpoint: OVERPASS, status: res.status, label } });
      if (!retry) throw last;
    } catch (e) {
      if (e instanceof DataError && e.code === 'DATA_PARSE_FAILED') throw e;
      if (e instanceof DataError && !e.retryable) throw e;
      last = e instanceof DataError ? e : new DataError('DATA_UPSTREAM_TIMEOUT', `Overpass 호출 실패: ${e?.message}`, { retryable: true, upstream: { endpoint: OVERPASS, label }, cause: e });
    }
    if (a < 4) {
      console.log(`  Overpass 재시도 ${a + 1}/4 (${waits[a]}s 대기): ${last.message}`);
      await sleep(waits[a] * 1000);
    }
  }
  throw last;
}

// ---------- 지오메트리 ----------

/** 위경도 → 로컬 미터 변환기. x = 동쪽(+), z = 남쪽(+). */
function makeProj(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110574;
  return {
    fwd: (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * kz],
    inv: (x, z) => [lat0 - z / kz, lon0 + x / kx],
  };
}
const area = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
const centroid = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
/** 점이 폴리곤 안인지(레이캐스팅). */
function inPoly(pt, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > pt[1]) !== (r[j][1] > pt[1]) && pt[0] < ((r[j][0] - r[i][0]) * (pt[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

/** 끊어진 outer 선분들을 끝점끼리 이어 닫힌 링으로 조립한다. 점은 [lat,lon], 닫는 점 중복 제거. */
function joinRings(segs) {
  const rest = segs.filter((s) => s.length > 1).map((s) => s.slice());
  const rings = [];
  while (rest.length) {
    let cur = rest.pop(), grew = true;
    while (!eq(cur[0], cur.at(-1)) && grew) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        const s = rest[i], end = cur.at(-1);
        if (eq(s[0], end)) { cur = cur.concat(s.slice(1)); rest.splice(i, 1); grew = true; break; }
        if (eq(s.at(-1), end)) { cur = cur.concat(s.slice(0, -1).reverse()); rest.splice(i, 1); grew = true; break; }
      }
    }
    if (eq(cur[0], cur.at(-1)) && cur.length >= 4) rings.push(cur.slice(0, -1));
  }
  return rings;
}

/** OSM way/relation 요소에서 닫힌 링들([lat,lon] 배열)을 뽑는다. 관계는 outer 만, inner 구멍은 버린다. */
function elementRings(el) {
  const g = (geo) => geo.map((p) => [p.lat, p.lon]);
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return [];
    const p = g(el.geometry);
    return eq(p[0], p.at(-1)) ? [p.slice(0, -1)] : [];
  }
  if (el.type === 'relation') {
    const segs = (el.members ?? []).filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => g(m.geometry));
    return joinRings(segs);
  }
  return [];
}

/** Douglas-Peucker 단순화. open=false 면 닫힌 링으로 취급하지 않고 선으로만 줄인다. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let mx = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len;
      if (d > mx) { mx = d; mi = i; }
    }
    if (mx > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** 소수 1자리 반올림 + 연속 중복점 제거. */
function roundPts(pts) {
  const out = [];
  for (const [x, z] of pts) {
    const p = [r1(x), r1(z)];
    if (!out.length || !eq(out.at(-1), p)) out.push(p);
  }
  return out;
}
/** 사각형 [x0,z0,x1,z1] 에 폴리곤을 자른다 (Sutherland-Hodgman). */
function clipPoly(pts, [x0, z0, x1, z1]) {
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= z0, (a, b) => [a[0] + ((b[0] - a[0]) * (z0 - a[1])) / (b[1] - a[1]), z0]],
    [(p) => p[1] <= z1, (a, b) => [a[0] + ((b[0] - a[0]) * (z1 - a[1])) / (b[1] - a[1]), z1]],
  ];
  let out = pts;
  for (const [inside, cut] of edges) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[(i + inp.length - 1) % inp.length], b = inp[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) return [];
  }
  return out;
}
/** 선을 박스(여유 포함) 안에 있는 구간들로 나눈다. 구간 양끝에 바깥 이웃점 하나를 붙인다. */
function clipLine(pts, [x0, z0, x1, z1]) {
  const ins = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1;
  const runs = []; let cur = [];
  pts.forEach((p, i) => {
    if (ins(p)) { if (!cur.length && i > 0) cur.push(pts[i - 1]); cur.push(p); } else if (cur.length) { cur.push(p); runs.push(cur); cur = []; }
  });
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

// ---------- OSM 해석 ----------

const ROAD_W = { motorway: 12, trunk: 12, primary: 12, secondary: 9, service: 4, pedestrian: 4 };
const ROAD_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian)$';
const roadWidth = (hw) => ROAD_W[hw.replace('_link', '')] ?? 6;
const isGreen = (t) => ['park', 'garden', 'pitch'].includes(t.leisure) || ['grass', 'forest', 'recreation_ground'].includes(t.landuse) || ['wood', 'scrub'].includes(t.natural);
const name = (t) => t.name || t['name:ko'] || undefined;

/** 부지 검색: amenity=hospital 중 이름이 맞는 것, 여러 개면 면적이 가장 큰 것. 못 찾으면 null. */
async function findSite(q) {
  const re = q.re.replace(/"/g, '\\"');
  const ql = `[out:json][timeout:90];(way["amenity"="hospital"]["name"~"${re}"](around:1500,${q.lat},${q.lon});relation["amenity"="hospital"]["name"~"${re}"](around:1500,${q.lat},${q.lon}););out geom;`;
  const j = await overpass(ql, 'site');
  const proj = makeProj(q.lat, q.lon);
  let best = null;
  for (const el of j.elements ?? []) {
    const rings = elementRings(el).map((r) => r.map(([la, lo]) => proj.fwd(la, lo)));
    const a = rings.reduce((s, r) => s + area(r), 0);
    if (a > 0 && (!best || a > best.area)) best = { area: a, name: el.tags?.name, osm: `${el.type[0]}${el.id}`, latlon: elementRings(el) };
  }
  return best;
}

/** 범위 안 건물·도로·녹지를 한 번에 받는다. */
async function fetchScene(bbox) {
  const b = `(${bbox.join(',')})`;
  const green = `["leisure"~"^(park|garden|pitch)$"]`, lu = `["landuse"~"^(grass|forest|recreation_ground)$"]`, nat = `["natural"~"^(wood|scrub)$"]`;
  const ql = `[out:json][timeout:120];(way["building"]${b};relation["building"]${b};way["highway"~"${ROAD_RE}"]${b};way${green}${b};way${lu}${b};way${nat}${b};relation${green}${b};relation${lu}${b};relation${nat}${b};);out geom;`;
  return overpass(ql, 'scene');
}

/** Overpass 응답 → 장면 데이터 (건물/도로/녹지, 로컬 좌표). */
function parseScene(elements, proj, siteLocal, box) {
  const toLocal = (ring) => ring.map(([la, lo]) => proj.fwd(la, lo));
  const buildings = [], roads = [], green = [], hospPts = []; // hospPts: amenity/building=hospital 건물 무게중심 (VWorld 병원 판정용)
  const seen = new Set();
  const pad = [box[0] - 60, box[1] - 60, box[2] + 60, box[3] + 60];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (t.building && t.building !== 'no') {
      for (const ring of elementRings(el)) {
        const o = toLocal(ring);
        if (area(o) < 20) continue;
        const key = `${el.type}${el.id}:${o.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tagged = t.amenity === 'hospital' || t.building === 'hospital';
        if (tagged) hospPts.push(centroid(o));
        const hosp = tagged || siteLocal.some((s) => inPoly(centroid(o), s)) ? 1 : 0;
        let h = parseFloat(t.height);
        if (!(h > 0)) { const lv = parseFloat(t['building:levels']); h = lv > 0 ? lv * 3.5 : (hosp ? 6 : 3) * 3.5; }
        h = r1(Math.min(200, Math.max(3, h)));
        const ro = roundPts(o);
        if (ro.length < 3) continue;
        const b = { o: ro, h, lv: Math.max(1, Math.round(h / 3.5)), hosp };
        const n = name(t); if (n) b.n = n;
        buildings.push(b);
      }
    } else if (t.highway && el.type === 'way' && el.geometry) {
      const p = el.geometry.map((g) => proj.fwd(g.lat, g.lon));
      for (const run of clipLine(p, pad)) { const s = roundPts(simplify(run, 0.8)); if (s.length >= 2) roads.push({ p: s, w: roadWidth(t.highway) }); }
    } else if (isGreen(t)) {
      for (const ring of elementRings(el)) {
        const c = clipPoly(toLocal(ring), pad);
        if (c.length < 3 || area(c) < 20) continue;
        const s = roundPts(simplify(c, 1.0));
        if (s.length >= 3) green.push(s);
      }
    }
  }
  return { buildings, roads, green, hospPts };
}

// ---------- 건물: VWorld 건물통합정보 + 카카오 이름표 ----------

/** VWorld WFS 한 번 호출 → GeoJSON 지물 배열. 본문이 XML(`<`)이면 간헐 INCORRECT_KEY 로 보고 3s→6s→…(최대 30s) 백오프로 15회까지 다시 부른다. */
async function vworldOnce(bb) {
  const key = process.env.VWORLD_KEY;
  if (!key) throw new DataError('DATA_UPSTREAM_TIMEOUT', 'VWORLD_KEY 없음 (.env)', { upstream: { endpoint: VWORLD } });
  const qs = new URLSearchParams({ service: 'WFS', request: 'GetFeature', version: '1.1.0', typename: 'lt_c_bldginfo', srsname: 'EPSG:4326', output: 'application/json', maxfeatures: '1000', key, domain: 'localhost' });
  // 키에 등록된 서비스 URL과 맞는 domain 값이 없으면 INCORRECT_KEY 를 준다 (2026-10-26 확인)
  const bbox = bb.join(','); // 1.1.0 + EPSG:4326 은 위도,경도 순서
  let last;
  for (let a = 0; a < 15; a++) {
    try {
      const res = await fetch(`${VWORLD}?${qs}&bbox=${bbox}`, { signal: AbortSignal.timeout(60_000) });
      const body = await res.text();
      if (res.ok && !body.trimStart().startsWith('<')) return JSON.parse(body).features ?? [];
      const code = body.match(/code="([^"]+)"/)?.[1] ?? null;
      last = new DataError('DATA_UPSTREAM_TIMEOUT', `VWorld HTTP ${res.status} ${code ?? ''}`.trim(), { httpStatus: res.status, retryable: true, upstream: { endpoint: VWORLD, status: res.status, code, bbox } });
    } catch (e) {
      last = new DataError('DATA_UPSTREAM_TIMEOUT', `VWorld 호출 실패: ${e?.message}`, { retryable: true, upstream: { endpoint: VWORLD, bbox }, cause: e });
    }
    if (a < 14) await sleep(Math.min(30, 3 * 2 ** a) * 1000);
  }
  throw last;
}

/** bbox(남,서,북,동) 안 건물을 모두 받는다. 1000개가 꽉 차면 4등분해 다시 받고 지물 id 로 중복을 지운다. */
async function fetchVworld(bb, out = new Map(), depth = 0) {
  const feats = await vworldOnce(bb);
  if (feats.length >= 1000 && depth < 4) {
    const [s, w, n, e] = bb, mLat = +((s + n) / 2).toFixed(6), mLon = +((w + e) / 2).toFixed(6);
    for (const q of [[s, w, mLat, mLon], [s, mLon, mLat, e], [mLat, w, n, mLon], [mLat, mLon, n, e]]) await fetchVworld(q, out, depth + 1);
  } else for (const f of feats) out.set(f.id ?? f.properties?.ufid, f); // ufid 는 여러 건물이 같이 쓰는 일이 있어 지물 id 로 거른다
  return out;
}

/** 카카오 키워드 검색(거리순·정확도순 각 3쪽)으로 병원 이름 POI 를 모은다. 실패하면 경고만 남기고 받은 만큼 돌려준다. */
async function kakaoSearch(h, lat0, lon0, radius) {
  const key = process.env.KAKAO_REST_API_KEY, docs = new Map();
  if (!key) { console.log('  경고: KAKAO_REST_API_KEY 없음 — 카카오 이름표 생략'); return []; }
  try {
    // 거리순만 쓰면 식당·출입구가 45개 한도를 채워 부속 건물이 빠진다. 정확도순을 더해 병원 POI 를 넓게 모은다
    for (const sort of ['distance', 'accuracy']) {
      for (let page = 1; page <= 3; page++) {
        const qs = new URLSearchParams({ query: h.name, x: lon0, y: lat0, radius: Math.min(20000, Math.ceil(radius)), sort, size: 15, page });
        const res = await fetch(`${KAKAO}?${qs}`, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`Kakao HTTP ${res.status}`);
        const j = await res.json();
        for (const d of j.documents ?? []) docs.set(d.id, d);
        if (j.meta?.is_end) break;
      }
    }
  } catch (e) { console.log(`  경고: 카카오 검색 실패 (${e?.message}) — 받은 ${docs.size}건만 쓴다`); }
  return [...docs.values()];
}

const compact = (s) => String(s ?? '').replace(/\s+/g, '');
/** 병원 이름 비교용 정규화: 공백과 '대학교·대학·대'를 뺀다 ("가천대 길병원" = "가천길병원"). */
const core = (s) => compact(s).replace(/대학교|대학|대/g, '');
/** 글자 사이 공백을 허용하는 정규식 ("가천대길병원" → "가천대 길병원"도 맞음). */
const looseRe = (s) => new RegExp(s.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));

/** 카카오 결과 → 이 병원 POI [{p:[x,z], label, dept}]. 의료·장례식장만, 범위 안, 이름에 병원 이름이 든 것. main 은 병원 대표 이름. */
function hospitalPois(docs, h, proj, box) {
  const m = docs.find((d) => /병원 > (종합병원|대학병원)/.test(d.category_name ?? '') && (core(d.place_name).includes(core(h.name)) || core(h.name).includes(core(d.place_name))));
  const bases = [compact(m?.place_name), compact(h.name)].filter(Boolean).sort((a, b) => b.length - a.length);
  const pois = [];
  for (const d of docs) {
    const cat = d.category_name ?? '';
    if (!(cat.startsWith('의료,건강') || cat.includes('장례식장')) || cat.includes('약국')) continue;
    const base = bases.find((b) => compact(d.place_name).includes(b));
    if (!base) continue;
    const p = proj.fwd(+d.y, +d.x);
    if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) continue;
    const label = d.place_name.replace(looseRe(base), '').replace(/^[\s\-·,()]+|[\s\-·,()]+$/g, '') || '본관';
    pois.push({ p, label, dept: /(과|클리닉)$/.test(label) }); // 진료과 POI 는 병원 판정에만 쓰고 이름표로는 안 쓴다
  }
  return { pois, mainName: m?.place_name };
}

/** VWorld 지물 → 링 후보 [{o, c, a, p}] (로컬 좌표, 무게중심이 범위 안, 15m² 이상). MultiPolygon 바깥 링마다 하나. */
function vworldRings(features, proj, box) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    for (const poly of polys) {
      const o = (poly[0] ?? []).map(([lo, la]) => proj.fwd(la, lo));
      if (o.length > 1 && eq(o[0], o.at(-1))) o.pop();
      if (o.length < 3) continue;
      const c = centroid(o), a = area(o);
      if (a < 15 || c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) continue;
      out.push({ o, c, a, p: { ...f.properties } });
    }
  }
  return out;
}

const blank = (v) => v == null || v === '' || v === 0 || v === '0';
/** 같은 건물이 두 줄로 온 것(무게중심이 서로 안 + 넓이 비 0.7~1.4)을 합친다. 외곽선은 height>0 쪽, 빈 속성은 다른 줄 값으로 채운다. */
function mergeDup(rings) {
  rings.sort((a, b) => (+b.p.height || 0) - (+a.p.height || 0));
  const kept = [];
  for (const r of rings) {
    const k = kept.find((k) => Math.abs(k.c[0] - r.c[0]) < 30 && Math.abs(k.c[1] - r.c[1]) < 30
      && r.a / k.a >= 0.7 && r.a / k.a <= 1.4 && inPoly(r.c, k.o) && inPoly(k.c, r.o));
    if (!k) { kept.push(r); continue; }
    for (const [key, v] of Object.entries(r.p)) if (blank(k.p[key]) && !blank(v)) k.p[key] = v;
  }
  return kept;
}

const BAD_NAME = /^(주건축물|부속건축물)|신축공사|^제?[\d\s\-]+(동|호)?$|^\S+동 \d/;
/** 뜻 있는 건물 이름이면 그대로, 아니면 '' (주건축물·숫자만·주소 모양 등). */
const goodName = (s) => { const t = String(s ?? '').trim(); return t && !BAD_NAME.test(t) ? t : ''; };

const MAX_LABELS = 24; // 이름표가 너무 많으면 화면을 덮는다. 큰 건물부터 이만큼만 이름을 남긴다
const UTILITY = /수위실|경비실|보일러|주차|소각|쓰레기|폐기물|전산실|기계실|변전|발전기|정압|펌프|창고|화장실|저장소|물탱크|캐노피|요금계산/; // 설비 이름은 이름표로 안 쓴다
/** 병원 건물 이름표를 다듬는다: "연건 12동[간호대학 본관]" → 괄호 안, 병원 이름 접두어 제거, 같은 이름은 가장 큰 건물 하나만, 큰 건물부터 MAX_LABELS 개. */
function tidyLabels(out, whole, bases) {
  const pre = bases.filter(Boolean).map((b) => looseRe(compact(b)));
  const clean = (n) => {
    let t = (n.match(/\[([^\]]+)\]\s*$/)?.[1] ?? n).replace(/^[A-Z]\d+\.\s*/, ''); // 행정 동 번호 + [실제 이름], 캠퍼스 건물 번호(B14.)
    const par = t.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (par && whole(par[1])) t = par[2]; // "서울대학교병원(쓰레기종합처리장)" → 괄호 안
    if (whole(t)) return '본관';
    for (const r of pre) t = t.replace(new RegExp('^' + r.source), '');
    t = goodName(t.replace(/^[\s\-·,)]+|[\s\-·,(]+$/g, ''));
    return t && !UTILITY.test(t) ? t : '';
  };
  const named = out.filter((b) => b.n).sort((a, b) => area(b.o) * b.h - area(a.o) * a.h);
  const seen = new Set();
  for (const b of named) {
    const n = clean(b.n);
    if (!n || seen.has(n) || seen.size >= MAX_LABELS) delete b.n;
    else { b.n = n; seen.add(n); }
  }
}

/** VWorld 지물 + 카카오 POI + OSM 단서 → 장면 건물 배열과 로그용 통계. 병원 건물에만 이름을 넣는다. */
function vworldBuildings(features, { pois, mainName }, { proj, box, siteLocal, osm, hospPts, h }) {
  const ms = mergeDup(vworldRings(features, proj, box));
  // 병원 판정 (a) 부지 안 (c) OSM 병원 태그 건물이 안에 있음
  const hosp = ms.map((m) => siteLocal.some((s) => inPoly(m.c, s)) || hospPts.some((p) => inPoly(p, m.o)));
  // (b) 카카오 POI 가 외곽선 안, 없으면 무게중심 25m 안 가장 가까운 건물
  const labels = ms.map(() => []);
  for (const poi of pois) {
    let i = ms.findIndex((m) => inPoly(poi.p, m.o));
    if (i < 0) {
      let best = 25;
      ms.forEach((m, k) => { const d = Math.hypot(m.c[0] - poi.p[0], m.c[1] - poi.p[1]); if (d <= best) { best = d; i = k; } });
    }
    if (i >= 0) { hosp[i] = true; labels[i].push(poi); }
  }
  // (d) 위에서 고른 건물과 같은 필지(pnu) = 같은 병원 캠퍼스
  const pnus = new Set(ms.filter((m, i) => hosp[i] && m.p.pnu).map((m) => m.p.pnu));
  ms.forEach((m, i) => { if (m.p.pnu && pnus.has(m.p.pnu)) hosp[i] = true; });

  // 카카오 이름표: 대표(본관) > 진료과가 아닌 것 > 무게중심에 가까운 것
  const kakaoName = (m, ls) => ls.filter((l) => !l.dept)
    .sort((a, b) => (b.label === '본관') - (a.label === '본관') || Math.hypot(a.p[0] - m.c[0], a.p[1] - m.c[1]) - Math.hypot(b.p[0] - m.c[0], b.p[1] - m.c[1]))[0]?.label;
  const kakaoMain = ms.some((m, i) => hosp[i] && kakaoName(m, labels[i]) === '본관');
  const whole = (s) => core(s) === core(h.name) || (mainName && core(s) === core(mainName));
  // VWorld 이름이 가장 정확하다(외곽선에 붙은 값). 카카오 좌표는 수십 m 어긋나 남의 건물에 떨어지기도 해서
  // 카카오 이름표는 VWorld 이름이 없는 건물에만, 같은 이름은 한 번만 쓴다
  const vwName = ms.map((m, i) => hosp[i] ? [m.p.bld_nm, m.p.dong_nm].map(goodName).find((s) => s && !whole(s)) : undefined);
  const used = new Set(vwName.filter(Boolean));
  const out = [];
  ms.forEach((m, i) => {
    const o = roundPts(simplify(m.o, 0.3));
    if (o.length < 3) return;
    if (o.length > 3 && eq(o[0], o.at(-1))) o.pop();
    let ht = +m.p.height > 0 ? +m.p.height : +m.p.grnd_flr > 0 ? +m.p.grnd_flr * 3.5 : 7;
    ht = r1(Math.min(200, Math.max(3, ht)));
    const b = { o, h: ht, lv: Math.max(1, Math.round(ht / 3.5)), hosp: hosp[i] ? 1 : 0 };
    if (hosp[i]) {
      let kn = kakaoName(m, labels[i]);
      if (kn && used.has(kn)) kn = undefined;
      if (kn) used.add(kn);
      let n = vwName[i] || kn || goodName(m.p.bld_nm) || goodName(m.p.dong_nm) || osm.find((ob) => ob.n && inPoly(centroid(ob.o), m.o))?.n;
      if (n && whole(n) && !kakaoMain) n = '본관'; // 병원 전체 이름("가천길병원")은 카카오 본관이 없을 때만 본관으로
      if (n) b.n = n;
    }
    out.push(b);
  });

  // 블록 예산: 추정 블록이 넘치면 병원이 아닌 건물을 원점에서 먼 것부터 버린다
  const est = (b) => Math.ceil(area(b.o) / 9) * b.lv;
  let total = out.reduce((s, b) => s + est(b), 0), dropped = 0;
  if (total > BLOCK_BUDGET) {
    const far = out.filter((b) => !b.hosp).map((b) => [b, Math.hypot(...centroid(b.o))]).sort((a, b) => b[1] - a[1]);
    const drop = new Set();
    for (const [b] of far) { if (total <= BLOCK_BUDGET) break; drop.add(b); total -= est(b); }
    dropped = drop.size;
    out.splice(0, out.length, ...out.filter((b) => !drop.has(b)));
  }
  tidyLabels(out, whole, [mainName, h.name]);
  const hb = out.filter((b) => b.hosp);
  return { buildings: out, stats: `VWorld ${features.length} → 중복합침 ${ms.length} · 병원 ${hb.length}동(이름 ${hb.filter((b) => b.n).length}) · 카카오 POI ${pois.length} · 예산으로 버림 ${dropped}` };
}

// ---------- 지형 ----------

const Z = 15, NPX = 256 * 2 ** Z;
const TILE_CACHE = new Map();
/** 위경도 → z15 전역 픽셀 좌표. */
const gpx = (lat, lon) => [((lon + 180) / 360) * NPX, ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * NPX];

/** terrarium 타일 하나를 받아 높이 배열(Float32 256x256)로 디코드한다. 3회 재시도, 결과는 캐시. */
async function getTile(tx, ty) {
  const key = `${tx}/${ty}`;
  if (TILE_CACHE.has(key)) return TILE_CACHE.get(key);
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new DataError('DATA_TERRAIN_FAILED', `terrain HTTP ${res.status}`, { httpStatus: res.status, retryable: res.status >= 500, upstream: { endpoint: url, status: res.status } });
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      const h = new Float32Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) h[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
      TILE_CACHE.set(key, h);
      return h;
    } catch (e) {
      last = e instanceof DataError ? e : new DataError('DATA_TERRAIN_FAILED', `terrain 타일 실패: ${e?.message}`, { retryable: true, upstream: { endpoint: url }, cause: e });
      await sleep(2000 * (a + 1));
    }
  }
  throw last;
}

/** 범위(로컬 박스)를 step 간격 격자로 샘플한 지형. 최저점을 0 으로 맞춘다. */
async function buildTerrain(proj, [x0, z0, x1, z1]) {
  const nx = Math.floor((x1 - x0) / STEP) + 1, nz = Math.floor((z1 - z0) / STEP) + 1;
  const [laA, loA] = proj.inv(x0, z0), [laB, loB] = proj.inv(x0 + (nx - 1) * STEP, z0 + (nz - 1) * STEP);
  const pa = gpx(laA, loA), pb = gpx(laB, loB);
  const [pxMin, pxMax] = [Math.min(pa[0], pb[0]) - 2, Math.max(pa[0], pb[0]) + 2];
  const [pyMin, pyMax] = [Math.min(pa[1], pb[1]) - 2, Math.max(pa[1], pb[1]) + 2];
  const tiles = new Map();
  for (let ty = Math.floor(pyMin / 256); ty <= Math.floor(pyMax / 256); ty++) {
    for (let tx = Math.floor(pxMin / 256); tx <= Math.floor(pxMax / 256); tx++) tiles.set(`${tx}/${ty}`, await getTile(tx, ty));
  }
  const px = (X, Y) => tiles.get(`${Math.floor(X / 256)}/${Math.floor(Y / 256)}`)[(Y % 256) * 256 + (X % 256)];
  const sample = (lat, lon) => { // 쌍선형 보간 (픽셀 중심 기준)
    const [gx, gy] = gpx(lat, lon), fx = gx - 0.5, fy = gy - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    return (px(ix, iy) * (1 - tx) + px(ix + 1, iy) * tx) * (1 - ty) + (px(ix, iy + 1) * (1 - tx) + px(ix + 1, iy + 1) * tx) * ty;
  };
  const raw = [];
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) { const [la, lo] = proj.inv(x0 + j * STEP, z0 + i * STEP); raw.push(sample(la, lo)); }
  const min = Math.min(...raw);
  return { x0, z0, step: STEP, nx, nz, h: raw.map((v) => r1(v - min)) };
}

// ---------- 겉모습: 위성 지붕색 + 건물 구조·용도 → 외벽 모양·색 ----------

const SAT = 'https://api.vworld.kr/req/wmts/1.0.0';
const SNPX = NPX * 4; // 위성 타일은 z17 (약 0.95m/px) = z15 픽셀의 4배
const satPx = (lat, lon) => gpx(lat, lon).map((v) => v * 4);
const satLL = (gx, gy) => [(Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / SNPX))) * 180) / Math.PI, (gx / SNPX) * 360 - 180];
// 외벽 모양 st별 팔레트 (0 기본, 1 아파트, 2 유리 커튼월, 3 벽돌 저층). 병원은 흰색·연회색 계열
const WALLS = [['#e2d7c5', '#cfcfca', '#ddd5c8', '#c4c0b7', '#e8e4dc'], ['#eeeae2', '#e6e1d6', '#f1efe9', '#dcd8cf'], ['#d4dee5', '#c6d3dc', '#dfe5e8', '#bccbd6'], ['#b9765a', '#a8644b', '#c4866a', '#9c5e48']];
const HOSP_WALLS = ['#f4f5f1', '#e9efee', '#eef0ec'];
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const unhex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

/** 위성 타일 하나(기본 z17)를 받아 RGBA 256x256 으로 푼다 (jpeg-js: sips 는 샌드박스에서 임시 파일을 못 써 실패한다). 3회 재시도. */
async function satTile(tx, ty, z = 17) {
  const url = `${SAT}/${process.env.VWORLD_KEY}/Satellite/${z}/${ty}/${tx}.jpeg`;
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new DataError('DATA_SATELLITE_FAILED', `위성 타일 HTTP ${res.status}`, { httpStatus: res.status, retryable: res.status >= 500, upstream: { endpoint: `${SAT}/<key>/Satellite/${z}/${ty}/${tx}.jpeg`, status: res.status } });
      return jpeg.decode(Buffer.from(await res.arrayBuffer()), { useTArray: true }).data;
    } catch (e) {
      last = e instanceof DataError ? e : new DataError('DATA_SATELLITE_FAILED', `위성 타일 실패: ${e?.message}`, { retryable: true, upstream: { endpoint: `${SAT}/<key>/Satellite/${z}/${ty}/${tx}.jpeg` }, cause: e });
      if (!last.retryable) break;
      await sleep(1500 * (a + 1));
    }
  }
  throw last;
}

/** 점에서 다각형 변까지 가장 짧은 거리(m). */
function edgeDist([px, pz], r) {
  let best = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, pz - az - t * dz));
  }
  return best;
}

/** 외곽선 안쪽(변에서 1m 넘게 안) 위성 픽셀의 채널별 중앙값 → 살짝 밝고 진하게 보정한 지붕색. 안쪽 픽셀이 없으면 무게중심 3x3. */
function roofColor(o, proj, px) {
  const g = o.map(([x, z]) => satPx(...proj.inv(x, z)));
  const xs = g.map((p) => p[0]), ys = g.map((p) => p[1]), ch = [[], [], []];
  const add = (gx, gy) => { const v = px(gx, gy); if (v) v.forEach((c, i) => ch[i].push(c)); };
  for (let gy = Math.floor(Math.min(...ys)); gy <= Math.max(...ys); gy++) for (let gx = Math.floor(Math.min(...xs)); gx <= Math.max(...xs); gx++) {
    const p = proj.fwd(...satLL(gx + 0.5, gy + 0.5));
    if (inPoly(p, o) && edgeDist(p, o) > 1) add(gx, gy);
  }
  if (!ch[0].length) { const [cx, cy] = satPx(...proj.inv(...centroid(o))); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(Math.floor(cx) + dx, Math.floor(cy) + dy); }
  if (!ch[0].length) return null;
  const med = ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]), m = (med[0] + med[1] + med[2]) / 3;
  return hex(med.map((v) => Math.min(255, Math.max(0, (m + (v - m) * 1.25) * 0.85 + 40)))); // 위성 사진은 탁해서 채도 25%·밝기 조금 올린다
}

/** 건물 구조(strct_cd)·용도(usability) → 외벽 모양 번호. 속성이 없으면 높이로 추정한다. */
function styleOf(b, p) {
  if (b.hosp) return 0;
  if (!p) return b.h >= 25 ? 1 : b.h <= 10 ? 3 : 0;
  const s = String(p.strct_cd ?? ''), u = String(p.usability ?? '');
  if (u.startsWith('02')) return 1;
  if (u.startsWith('14') || s === '31' || s === '32') return 2;
  if (['11', '12', '19'].includes(s) || u.startsWith('01')) return 3;
  return 0;
}

/** 장면 데이터 d 의 건물마다 지붕색 c·외벽색 w·외벽 모양 st(0이면 생략)를 넣는다. features 는 VWorld 건물 지물(없으면 높이로 추정). 외곽선·높이·이름·hosp 는 안 건드린다. */
async function addLooks(d, features) {
  const t = d.terrain, proj = makeProj(...d.center), box = [t.x0, t.z0, t.x0 + (t.nx - 1) * t.step, t.z0 + (t.nz - 1) * t.step];
  const rings = features ? mergeDup(vworldRings(features, proj, box)).filter((r) => !blank(r.p.strct_cd) || !blank(r.p.usability)) : [];
  // 지도 범위를 덮는 z17 타일을 모두 받는다
  const corners = [[box[0], box[1]], [box[2], box[3]]].map(([x, z]) => satPx(...proj.inv(x, z)));
  const [tx0, tx1] = [corners[0][0], corners[1][0]].map((v) => Math.floor(v / 256)).sort((a, b) => a - b);
  const [ty0, ty1] = [corners[0][1], corners[1][1]].map((v) => Math.floor(v / 256)).sort((a, b) => a - b);
  const tiles = new Map();
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) { tiles.set(`${tx}/${ty}`, await satTile(tx, ty)); await sleep(120); }
  const px = (gx, gy) => {
    const a = tiles.get(`${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`);
    if (!a) return null;
    const o = ((gy & 255) * 256 + (gx & 255)) * 4;
    return [a[o], a[o + 1], a[o + 2]];
  };
  let matched = 0;
  d.buildings.forEach((b, k) => {
    const c = centroid(b.o), r = rings.find((r) => inPoly(c, r.o));
    if (r) matched++;
    const st = styleOf(b, r?.p), pal = b.hosp ? HOSP_WALLS : WALLS[st];
    const roof = roofColor(b.o, proj, px) ?? pal[k % pal.length], f = 0.15 + (k % 3) * 0.05; // 외벽에 지붕색을 15~25% 섞어 건물마다 조금씩 다르게
    b.c = roof;
    b.w = hex(unhex(pal[k % pal.length]).map((v, i) => v * (1 - f) + unhex(roof)[i] * f));
    if (st) b.st = st; else delete b.st;
  });
  const cnt = [0, 0, 0, 0]; d.buildings.forEach((b) => b.hosp || cnt[b.st ?? 0]++);
  return `타일 ${tiles.size}장 · 속성 매칭 ${matched}/${d.buildings.length} · 모양 기본${cnt[0]}/아파트${cnt[1]}/유리${cnt[2]}/벽돌${cnt[3]} · ${hospLooks(d, features)}`;
}

// ---------- 병원 건물: 외벽 5종 + 옥상 위성 사진 (22-hospital-detail.md) ----------

// 병원 외벽 H0~H4 → 아틀라스 칸 번호 st (H0 격자창은 기본 0번 칸, H1 유리 커튼월, H2 가로 띠창, H3 세로 핀·루버, H4 벽돌·타일). 8번 칸(로비)은 엔진이 맨 아래층에 쓴다
const HOSP_ST = [0, 4, 5, 6, 7];
// H별 외벽색. 유리 동은 무늬 색이 살게 흰색, 벽돌 동은 갈색·베이지
const HOSP_PAL = [HOSP_WALLS, ['#ffffff'], ['#f3f3ef', '#eef1f0'], ['#e6e3dc', '#dfe1de'], ['#b5785c', '#d6c19c', '#a96c52']];

/** 병원 건물 하나의 외벽 종류(0~4)를 사용 승인일 연도·층수·높이·구조로 고른다. 연도를 모르면 높이·번호로. */
function hospKind(b, p, k) {
  const y = parseInt(String(p?.useapr_day ?? '').slice(0, 4), 10) || 0, s = String(p?.strct_cd ?? '');
  if ((y > 1900 && y < 1990) || ['11', '12', '13', '19'].includes(s)) return 4;
  if ((y >= 2010 && b.lv >= 10) || s === '31' || s === '32') return 1;
  if (y >= 2000 && y < 2010) return 2;
  if (b.h >= 30) return 3;
  return y ? 0 : [0, 2, 1, 4, 3][k % 5];
}

/** 병원 건물(hosp=1)마다 외벽 종류를 골라 w·st 를 넣는다. 한 종류가 40%를 넘으면 덜 쓴 종류로 돌려 고루 섞는다. 외곽선·높이·이름·hosp·c 는 안 건드린다. */
function hospLooks(d, features) {
  const t = d.terrain, proj = makeProj(...d.center), box = [t.x0, t.z0, t.x0 + (t.nx - 1) * t.step, t.z0 + (t.nz - 1) * t.step];
  const rings = features ? mergeDup(vworldRings(features, proj, box)) : [];
  const hb = d.buildings.map((b, k) => [b, k]).filter(([b]) => b.hosp);
  const cap = hb.length >= 3 ? Math.ceil(hb.length * 0.4) : Infinity, used = [0, 0, 0, 0, 0];
  let dated = 0;
  for (const [b, k] of hb) {
    const c = centroid(b.o), p = rings.find((r) => inPoly(c, r.o))?.p;
    if (!blank(p?.useapr_day)) dated++;
    let h = hospKind(b, p, k);
    if (used[h] >= cap) h = used.indexOf(Math.min(...used));
    used[h]++;
    const pal = HOSP_PAL[h], roof = b.c ?? pal[0], f = h === 1 ? 0 : 0.15 + (k % 3) * 0.05;
    b.w = hex(unhex(pal[k % pal.length]).map((v, i) => v * (1 - f) + unhex(roof)[i] * f));
    if (HOSP_ST[h]) b.st = HOSP_ST[h]; else delete b.st;
  }
  return `병원 ${hb.length}동 · 사용승인일 ${dated} · H0~H4 ${used.join('/')}`;
}

const roofPx = (lat, lon) => gpx(lat, lon).map((v) => v * 8); // z18 전역 픽셀 (약 0.47m/px)

/** 병원 건물 전체 범위(+10m)를 덮는 z18 위성 사진을 이어 붙여 public/data/roof/<id>.jpg 로 쓰고 d.roof 를 넣는다.
 *  높은 건물은 지붕이 옆으로 밀려 찍혀서, 병원 외곽선이 사진 경계와 가장 잘 겹치는 평행 이동(±15m)을 찾아 사진을 그만큼 옮겨 자른다. */
async function addRoof(d) {
  const hb = d.buildings.filter((b) => b.hosp);
  if (!hb.length) { delete d.roof; return '병원 건물 없음'; }
  const proj = makeProj(...d.center), all = hb.flatMap((b) => b.o), xs = all.map((p) => p[0]), zs = all.map((p) => p[1]);
  const R = [Math.min(...xs) - 10, Math.min(...zs) - 10, Math.max(...xs) + 10, Math.max(...zs) + 10].map(r1);
  const S = 25; // 탐색 15m + 가장자리 여유
  const [gx0, gy0] = roofPx(...proj.inv(R[0] - S, R[1] - S)), [gx1, gy1] = roofPx(...proj.inv(R[2] + S, R[3] + S));
  const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor(gx1 / 256), ty0 = Math.floor(gy0 / 256), ty1 = Math.floor(gy1 / 256);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256, img = new Uint8Array(W * H * 4);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const a = await satTile(tx, ty, 18);
    for (let r = 0; r < 256; r++) img.set(a.subarray(r * 1024, r * 1024 + 1024), (((ty - ty0) * 256 + r) * W + (tx - tx0) * 256) * 4);
    await sleep(120);
  }
  // 로컬 미터 → 모자이크 픽셀
  const at = (x, z) => { const [u, v] = roofPx(...proj.inv(x, z)); return [u - tx0 * 256, v - ty0 * 256]; };
  // 밝기를 3x3 으로 흐린 뒤 기울기 크기(사진 경계 세기)를 구한다
  const gray = new Float32Array(W * H), blur = new Float32Array(W * H), grad = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = img[i * 4] + img[i * 4 + 1] + img[i * 4 + 2];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += gray[(y + j) * W + x + i]; blur[y * W + x] = s / 9; }
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) grad[y * W + x] = Math.abs(blur[y * W + x + 1] - blur[y * W + x - 1]) + Math.abs(blur[(y + 1) * W + x] - blur[(y - 1) * W + x]);
  // 병원 외곽선 위 0.5m 간격 점
  const pts = [];
  for (const b of hb) for (let i = 0; i < b.o.length; i++) {
    const [ax, az] = b.o[i], [bx, bz] = b.o[(i + 1) % b.o.length], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let q = 0; q < n; q++) pts.push(at(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n));
  }
  const p0 = at(R[0], R[1]), kx = at(R[0] + 1, R[1])[0] - p0[0], kz = at(R[0], R[1] + 1)[1] - p0[1]; // 1m 당 픽셀
  const score = (dx, dz) => { let s = 0; for (const [u, v] of pts) s += grad[Math.round(v + dz * kz) * W + Math.round(u + dx * kx)]; return s; };
  const s0 = score(0, 0);
  let best = [0, 0], bs = s0;
  for (let dz = -15; dz <= 15; dz += 0.5) for (let dx = -15; dx <= 15; dx += 0.5) { const s = score(dx, dz); if (s > bs) { bs = s; best = [dx, dz]; } }
  if (bs < s0 * 1.1) best = [0, 0]; // 차이가 뚜렷하지 않으면 옮기지 않는다
  // 옮긴 범위를 잘라 긴 변 1024px 이하로 줄인다 (출력 1px 을 n×n 점 평균)
  const [cx0, cy0] = at(R[0] + best[0], R[1] + best[1]), [cx1, cy1] = at(R[2] + best[0], R[3] + best[1]);
  const cw = cx1 - cx0, ch = cy1 - cy0, sc = Math.min(1, 1024 / Math.max(cw, ch));
  const OW = Math.round(cw * sc), OH = Math.round(ch * sc), n = Math.max(2, Math.ceil(1 / sc)), out = Buffer.alloc(OW * OH * 4, 255);
  for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
    const acc = [0, 0, 0];
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const sx = Math.floor(cx0 + ((ox + (a + 0.5) / n) * cw) / OW), sy = Math.floor(cy0 + ((oy + (b + 0.5) / n) * ch) / OH), o = (sy * W + sx) * 4;
      acc[0] += img[o]; acc[1] += img[o + 1]; acc[2] += img[o + 2];
    }
    out.set(acc.map((v) => v / (n * n)), (oy * OW + ox) * 4);
  }
  // 목표 200KB: 넘으면 품질을 5씩 낮춘다 (50까지)
  let q = 75, jpg;
  for (;; q -= 5) { jpg = jpeg.encode({ data: out, width: OW, height: OH }, q).data; if (jpg.length <= 200 * 1024 || q <= 50) break; }
  fs.mkdirSync(path.join(OUT_DIR, 'roof'), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'roof', `${d.id}.jpg`), jpg);
  d.roof = { x0: R[0], z0: R[1], x1: R[2], z1: R[3] };
  return `z18 타일 ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)}장 · 기울기 보정 ${best[0]},${best[1]}m (경계 점수 x${(bs / s0).toFixed(2)}) · ${OW}x${OH} q${q} · ${(jpg.length / 1024).toFixed(0)}KB`;
}

/** 있는 장면 파일의 병원 건물에 외벽 5종(w·st)과 옥상 사진(roof)만 넣는다. 사진이 실패해도 외벽은 쓴다. */
async function rebuildRoof(h, ctx) {
  const file = path.join(OUT_DIR, 'h', `${h.id}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8')), proj = makeProj(...d.center), all = d.buildings.filter((b) => b.hosp).flatMap((b) => b.o);
  ctx.fn = 'rebuildRoof'; ctx.step = 'vworld';
  if (all.length) {
    // 병원 건물 범위(+20m)의 VWorld 지물만 받는다 (사용 승인일·구조)
    const xs = all.map((p) => p[0]), zs = all.map((p) => p[1]);
    const [sLat, wLon] = proj.inv(Math.min(...xs) - 20, Math.max(...zs) + 20), [nLat, eLon] = proj.inv(Math.max(...xs) + 20, Math.min(...zs) - 20);
    const features = [...(await fetchVworld([sLat, wLon, nLat, eLon].map((v) => +v.toFixed(6)))).values()];
    console.log(`  외벽: ${hospLooks(d, features)}`);
  }
  ctx.lastOk = 'vworld'; ctx.step = 'satellite';
  try { console.log(`  옥상: ${await addRoof(d)}`); } catch (e) { logError(e, ctx); }
  fs.writeFileSync(file, JSON.stringify(d));
}

/** 있는 장면 파일에 지붕색·외벽색·외벽 모양만 넣는다. 실패하면 파일을 건드리지 않는다. */
async function rebuildLooks(h, ctx) {
  const file = path.join(OUT_DIR, 'h', `${h.id}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8')), t = d.terrain, proj = makeProj(...d.center);
  const box = [t.x0, t.z0, t.x0 + (t.nx - 1) * t.step, t.z0 + (t.nz - 1) * t.step];
  const [sLat, wLon] = proj.inv(box[0], box[3]), [nLat, eLon] = proj.inv(box[2], box[1]);
  ctx.fn = 'rebuildLooks'; ctx.step = 'vworld';
  const features = [...(await fetchVworld([sLat, wLon, nLat, eLon].map((v) => +v.toFixed(6)))).values()];
  ctx.lastOk = 'vworld'; ctx.step = 'satellite';
  const before = fs.statSync(file).size;
  console.log(`  겉모습: ${await addLooks(d, features)}`);
  const body = JSON.stringify(d);
  fs.writeFileSync(file, body);
  console.log(`  완료: 건물당 +${((body.length - before) / d.buildings.length).toFixed(1)}B · ${(body.length / 1024).toFixed(0)}KB`);
}

// ---------- 병원 하나 ----------

/** 병원 하나의 장면 JSON 을 만들어 파일로 쓴다. 건물 수를 반환. */
async function buildHospital(h, ctx) {
  const q = h.query;
  ctx.fn = 'buildHospital'; ctx.step = 'site';
  const site = await findSite(q);
  ctx.lastOk = 'site';
  if (!site) console.log(`  경고: DATA_SITE_NOT_FOUND ${h.id} — 병원 중심 ±${FALLBACK_HALF}m 로 대체`);
  else console.log(`  부지: ${site.osm} "${site.name}" ${Math.round(site.area)}m²`);

  // 원점·범위 계산: 부지 경계 상자 + PAD, 한 변 최대 MAX_SIDE. 부지가 없으면 중심 ±300m
  let lat0 = q.lat, lon0 = q.lon, halfW = FALLBACK_HALF, halfH = FALLBACK_HALF;
  if (site) {
    const pts = site.latlon.flat();
    const las = pts.map((p) => p[0]), los = pts.map((p) => p[1]);
    lat0 = (Math.min(...las) + Math.max(...las)) / 2; lon0 = (Math.min(...los) + Math.max(...los)) / 2;
    const tmp = makeProj(lat0, lon0);
    const loc = pts.map(([la, lo]) => tmp.fwd(la, lo));
    halfW = Math.min(MAX_SIDE / 2, Math.max(...loc.map((p) => Math.abs(p[0]))) + PAD);
    halfH = Math.min(MAX_SIDE / 2, Math.max(...loc.map((p) => Math.abs(p[1]))) + PAD);
  }
  lat0 = Math.round(lat0 * 1e6) / 1e6; lon0 = Math.round(lon0 * 1e6) / 1e6;
  const proj = makeProj(lat0, lon0);
  halfW = Math.floor(halfW / STEP) * STEP; halfH = Math.floor(halfH / STEP) * STEP; // 격자에 맞춤
  const box = [-halfW, -halfH, halfW, halfH];
  const [sLat, wLon] = proj.inv(box[0], box[3]), [nLat, eLon] = proj.inv(box[2], box[1]);
  const siteLocal = site ? site.latlon.map((r) => r.map(([la, lo]) => proj.fwd(la, lo))) : [];

  await sleep(1500);
  ctx.step = 'scene';
  const j = await fetchScene([sLat, wLon, nLat, eLon].map((v) => +v.toFixed(6)));
  ctx.lastOk = 'scene';
  let scene;
  try { scene = parseScene(j.elements ?? [], proj, siteLocal, box); } catch (e) { throw new DataError('DATA_PARSE_FAILED', `장면 해석 실패: ${e.message}`, { cause: e }); }
  ctx.lastOk = 'parse';

  // 건물은 VWorld + 카카오 이름표. VWorld 가 끝내 실패하면 진단 로그만 남기고 OSM 건물로 계속한다
  ctx.step = 'vworld';
  let buildings = scene.buildings, features = null;
  try { features = [...(await fetchVworld([sLat, wLon, nLat, eLon].map((v) => +v.toFixed(6)))).values()]; } catch (e) {
    logError(e instanceof DataError ? e : new DataError('DATA_UPSTREAM_TIMEOUT', `VWorld 실패: ${e?.message}`, { retryable: true, cause: e }), ctx);
  }
  if (features?.length) {
    ctx.step = 'kakao';
    const docs = await kakaoSearch(h, lat0, lon0, Math.hypot(halfW, halfH));
    ctx.step = 'buildings';
    const vb = vworldBuildings(features, hospitalPois(docs, h, proj, box), { proj, box, siteLocal, osm: scene.buildings, hospPts: scene.hospPts, h });
    buildings = vb.buildings;
    console.log(`  건물: ${vb.stats}`);
  } else console.log(`  건물: VWorld 실패 — OSM 건물 ${buildings.length}동으로 대체`);
  ctx.lastOk = 'buildings';

  ctx.step = 'terrain';
  const terrain = await buildTerrain(proj, box);
  ctx.lastOk = 'terrain';

  ctx.step = 'write';
  const data = {
    id: h.id, name: h.name, short: h.short, center: [lat0, lon0], terrain,
    site: siteLocal.map((r) => roundPts(simplify(r, 0.5))),
    buildings, roads: scene.roads, green: scene.green,
  };
  ctx.step = 'satellite';
  try { console.log(`  겉모습: ${await addLooks(data, features)}`); } catch (e) { logError(e, ctx); } // 위성 타일이 실패해도 장면은 쓴다 (엔진은 c 없이도 그린다)
  try { console.log(`  옥상: ${await addRoof(data)}`); } catch (e) { logError(e, ctx); } // 사진이 없으면 엔진은 단색 지붕
  ctx.step = 'write';
  const body = JSON.stringify(data);
  fs.writeFileSync(path.join(OUT_DIR, 'h', `${h.id}.json`), body);
  console.log(`  완료: 건물 ${buildings.length} · 도로 ${scene.roads.length} · 녹지 ${scene.green.length} · ${(body.length / 1024).toFixed(0)}KB`);
  return buildings.length;
}

/** 있는 장면 파일의 부지·도로·녹지·지형은 그대로 두고 건물만 VWorld + 카카오로 바꾼다. VWorld 가 실패하면 파일을 건드리지 않는다. */
async function rebuildBuildings(h, ctx) {
  const file = path.join(OUT_DIR, 'h', `${h.id}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8')), t = d.terrain, [lat0, lon0] = d.center;
  const proj = makeProj(lat0, lon0), box = [t.x0, t.z0, t.x0 + (t.nx - 1) * t.step, t.z0 + (t.nz - 1) * t.step];
  const [sLat, wLon] = proj.inv(box[0], box[3]), [nLat, eLon] = proj.inv(box[2], box[1]);
  ctx.fn = 'rebuildBuildings'; ctx.step = 'vworld';
  const features = [...(await fetchVworld([sLat, wLon, nLat, eLon].map((v) => +v.toFixed(6)))).values()];
  if (!features.length) throw new DataError('DATA_UPSTREAM_TIMEOUT', 'VWorld 건물 0개', { retryable: true, upstream: { endpoint: VWORLD } });
  ctx.lastOk = 'vworld'; ctx.step = 'kakao';
  const docs = await kakaoSearch(h, lat0, lon0, Math.hypot(box[2] - box[0], box[3] - box[1]) / 2);
  ctx.step = 'buildings';
  // 기존 파일의 병원 건물 무게중심을 OSM 병원 태그 단서 대신 쓴다
  const hospPts = d.buildings.filter((b) => b.hosp).map((b) => centroid(b.o));
  const vb = vworldBuildings(features, hospitalPois(docs, h, proj, box), { proj, box, siteLocal: d.site, osm: d.buildings, hospPts, h });
  console.log(`  건물: ${vb.stats}`);
  d.buildings = vb.buildings;
  ctx.step = 'satellite';
  console.log(`  겉모습: ${await addLooks(d, features)}`);
  try { console.log(`  옥상: ${await addRoof(d)}`); } catch (e) { logError(e, ctx); } // 병원 외곽선이 바뀌었으니 사진 범위도 다시
  const body = JSON.stringify(d);
  fs.writeFileSync(file, body);
  console.log(`  완료: 건물 ${d.buildings.length} · ${(body.length / 1024).toFixed(0)}KB`);
}

/** public/data/hospitals.json: 파일이 있는 병원만 목록 순서대로 모은다. */
function writeIndex() {
  const list = [];
  for (const h of HOSPITALS) {
    const f = path.join(OUT_DIR, 'h', `${h.id}.json`);
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    list.push({ id: h.id, name: h.name, short: h.short, group: h.group, region: h.region, lat: d.center[0], lon: d.center[1], buildings: d.buildings.length });
  }
  fs.writeFileSync(path.join(OUT_DIR, 'hospitals.json'), JSON.stringify(list));
  return list.length;
}

// ---------- 진입점 ----------

/** 인자(id 목록, --force)를 읽어 병원들을 순서대로 처리하고 실패 목록을 출력한다. */
async function main() {
  const args = process.argv.slice(2), looks = args.includes('--looks-only'), roof = args.includes('--roof-only'), only = looks || roof || args.includes('--buildings-only'), force = only || args.includes('--force');
  const ids = args.filter((a) => !a.startsWith('--'));
  const targets = ids.length ? HOSPITALS.filter((h) => ids.includes(h.id)) : HOSPITALS;
  if (ids.length && targets.length !== ids.length) console.log(`알 수 없는 id: ${ids.filter((i) => !HOSPITALS.some((h) => h.id === i)).join(', ')}`);
  fs.mkdirSync(path.join(OUT_DIR, 'h'), { recursive: true });
  const failed = [], ok = [];
  let first = true;
  for (const [i, h] of targets.entries()) {
    const file = path.join(OUT_DIR, 'h', `${h.id}.json`);
    if (!force && fs.existsSync(file)) { console.log(`[${i + 1}/${targets.length}] ${h.id} 건너뜀 (이미 있음)`); ok.push(h.id); continue; }
    if (only && !fs.existsSync(file)) { console.log(`[${i + 1}/${targets.length}] ${h.id} 파일 없음 — --buildings-only 불가`); failed.push({ id: h.id, code: 'DATA_HOSPITAL_NOT_FOUND', reason: '장면 파일 없음' }); continue; }
    if (!first) await sleep(only ? 500 : 5000); // 병원 사이 쉰다 (Overpass 를 안 부르면 짧게)
    first = false;
    console.log(`[${i + 1}/${targets.length}] ${h.id} ${h.name}`);
    const ctx = { id: h.id, query: h.query, force, step: 'start', lastOk: 'none' };
    try { await (roof ? rebuildRoof : looks ? rebuildLooks : only ? rebuildBuildings : buildHospital)(h, ctx); ok.push(h.id); } catch (e) {
      const err = e instanceof DataError ? e : new DataError('DATA_PARSE_FAILED', `예기치 못한 오류: ${e?.message}`, { cause: e });
      if (!(e instanceof DataError)) err.stack = e?.stack;
      logError(err, ctx);
      failed.push({ id: h.id, code: err.code, reason: err.message });
    }
  }
  const n = writeIndex();
  console.log(`\n성공 ${ok.length} / 실패 ${failed.length} (hospitals.json ${n}개)`);
  for (const f of failed) console.log(`  실패 ${f.id} ${f.code}: ${f.reason}`);
}
main().catch((e) => { logError(Object.assign(e, { code: e.code ?? 'DATA_PARSE_FAILED' }), { id: '-', step: 'main', lastOk: 'none', fn: 'main' }); process.exit(1); });
