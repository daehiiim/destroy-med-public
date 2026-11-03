// 엔진 단독 확인 페이지 (/src/game/dev.html?h=_sample). 화면 쪽 React와 무관한 개발용
import { WEAPONS, createGame, type Game, type GameStats, type HospitalData } from './index.ts';

const id = new URLSearchParams(location.search).get('h') ?? '_sample';
const bar = document.getElementById('bar')!, hud = document.getElementById('hud')!;
let stats: GameStats | null = null, canUndo = false, fps = 0;

// 상태 표시 갱신
const draw = () => {
  hud.textContent = stats
    ? `점수 ${stats.score}  랭크 ${stats.rank}  콤보 ${stats.combo} ×${stats.comboMul.toFixed(2)}\n블록 ${stats.destroyed}/${stats.total}  무너짐 ${stats.buildingsDown}동·주변 ${stats.nearbyDown}채\nfps ${fps}  되돌리기 ${canUndo ? '가능' : '없음'}`
    : '로딩';
};

const data = (await (await fetch(`/data/h/${id}.json`)).json()) as HospitalData;
const game: Game = createGame(document.getElementById('game')!, data, {
  onReady: () => console.log('ready'),
  onStats: (s) => { stats = s; draw(); },
  onCanUndo: (c) => { canUndo = c; draw(); },
  onError: (e) => { hud.textContent = `${e.code}: ${e.message}`; },
});
Object.assign(window, { game });

// 버튼 하나 추가
const btn = (label: string, fn: (b: HTMLButtonElement) => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => fn(b);
  bar.appendChild(b);
  return b;
};
const wbtns = WEAPONS.map((w) => btn(`${w.key} ${w.name}`, (b) => {
  game.setWeapon(w.id);
  wbtns.forEach((x) => x.classList.toggle('on', x === b));
}));
wbtns[0].classList.add('on');
btn('되돌리기', () => game.undo());
btn('전부 복구', () => game.restoreAll());
let labels = true, top = false;
btn('이름표', () => game.setLabels((labels = !labels)));
btn('위에서', () => game.setTopView((top = !top)));
window.addEventListener('keydown', (e) => {
  const w = WEAPONS.find((x) => x.key === e.key);
  if (w) wbtns[WEAPONS.indexOf(w)].click();
});

// fps 측정
let frames = 0, t0 = performance.now();
const tick = () => {
  frames++;
  const now = performance.now();
  if (now - t0 >= 1000) { fps = Math.round((frames * 1000) / (now - t0)); frames = 0; t0 = now; draw(); }
  requestAnimationFrame(tick);
};
tick();
