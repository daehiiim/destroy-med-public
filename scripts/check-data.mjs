// public/data 의 JSON 이 01-data.md 스키마를 지키는지 검사하는 self-check. 어긋나면 종료 코드 1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
const errors = [], warns = [];
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);

/** 조건이 거짓이면 오류 목록에 쌓는다. */
const must = (id, ok, msg) => { if (!ok && errors.length < 200) errors.push(`${id}: ${msg}`); };

/** 병원 하나의 장면 JSON 을 검사한다. */
function checkHospital(id, d) {
  must(id, d.id === id, 'id 불일치');
  must(id, typeof d.name === 'string' && typeof d.short === 'string', 'name/short 누락');
  must(id, Array.isArray(d.center) && d.center.length === 2 && num(d.center[0]) && num(d.center[1]), 'center 형식');
  const t = d.terrain ?? {};
  must(id, [t.x0, t.z0, t.step, t.nx, t.nz].every(num) && t.nx > 1 && t.nz > 1, 'terrain 숫자 필드');
  must(id, Array.isArray(t.h) && t.h.length === t.nx * t.nz && t.h.every(num), `terrain.h 길이 ${t.h?.length} != ${t.nx * t.nz}`);
  must(id, t.h?.length && Math.min(...t.h) === 0, 'terrain 최저점이 0 이 아님');
  must(id, Array.isArray(d.site) && d.site.every((r) => r.every(pt)), 'site 형식');
  must(id, Array.isArray(d.buildings) && d.buildings.length > 0, '건물 0개');
  for (const [i, b] of (d.buildings ?? []).entries()) {
    const ok = Array.isArray(b.o) && b.o.length >= 3 && b.o.every(pt) && !(b.o.length > 3 && b.o[0][0] === b.o.at(-1)[0] && b.o[0][1] === b.o.at(-1)[1])
      && num(b.h) && b.h > 0 && b.h <= 200 && b.lv === Math.max(1, Math.round(b.h / 3.5)) && (b.hosp === 0 || b.hosp === 1) && (b.n === undefined || typeof b.n === 'string');
    if (!ok) { must(id, false, `buildings[${i}] 잘못됨 ${JSON.stringify(b).slice(0, 120)}`); break; }
  }
  must(id, (d.roads ?? []).every((r) => Array.isArray(r.p) && r.p.length >= 2 && r.p.every(pt) && num(r.w) && r.w > 0), 'roads 형식');
  must(id, (d.green ?? []).every((g) => g.length >= 3 && g.every(pt)), 'green 형식');
}

const list = JSON.parse(fs.readFileSync(path.join(DIR, 'hospitals.json'), 'utf8'));
must('hospitals.json', Array.isArray(list) && list.length > 0, '비어 있음');
let total = 0;
for (const e of list) {
  must(e.id, ['top10', 'capital', 'national'].includes(e.group), `group ${e.group}`);
  must(e.id, [e.name, e.short, e.region].every((s) => typeof s === 'string' && s) && num(e.lat) && num(e.lon), '목록 필드');
  const f = path.join(DIR, 'h', `${e.id}.json`);
  if (!fs.existsSync(f)) { must(e.id, false, 'h/<id>.json 없음'); continue; }
  const raw = fs.readFileSync(f, 'utf8');
  total += raw.length;
  if (raw.length > 600 * 1024) warns.push(`${e.id}: ${(raw.length / 1024).toFixed(0)}KB (목표 600KB 초과)`);
  const d = JSON.parse(raw);
  must(e.id, e.buildings === d.buildings.length, `목록 buildings ${e.buildings} != ${d.buildings.length}`);
  checkHospital(e.id, d);
}
const files = fs.readdirSync(path.join(DIR, 'h')).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
must('h/', files.length === list.length, `h/ 파일 ${files.length}개 != 목록 ${list.length}개`);

for (const w of warns) console.log('경고', w);
console.log(errors.length ? errors.join('\n') : `check-data OK: 병원 ${list.length}개, 장면 JSON 합계 ${(total / 1048576).toFixed(2)}MB`);
process.exit(errors.length ? 1 : 0);
