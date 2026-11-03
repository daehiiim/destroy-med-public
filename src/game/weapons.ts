// 무기 목록과 밸런스 수치 (02-engine.md 무기 표)
import type { WeaponId, WeaponInfo } from './types.ts';

export const WEAPONS: WeaponInfo[] = [
  // 위력순(약 → 강). 단축키·해금 랭크는 칸 위치를 따른다 (v0.53.0)
  { id: 'rifle', key: '1', name: '머신건', desc: '누르고 있으면 연사', unlock: 'F' },
  { id: 'grenade', key: '2', name: '유탄발사기', short: '유탄', desc: '누르면 연사 폭발', unlock: 'E' },
  { id: 'mortar', key: '3', name: '박격포', desc: '누르면 연사 낙하', unlock: 'D' },
  { id: 'artillery', key: '4', name: '포탄', desc: '누르면 연사 포격', unlock: 'C' },
  { id: 'cluster', key: '5', name: '집속탄', desc: '자탄 수십 발 살포', unlock: 'B' },
  { id: 'mlrs', key: '6', name: '다연장 로켓', short: '다연장', desc: '로켓 일제 사격', unlock: 'B+' },
  { id: 'bomb', key: '7', name: '항공폭탄', short: '폭탄', desc: '누르면 연사 폭격', unlock: 'A' },
  { id: 'bunker', key: '8', name: '벙커버스터', short: '벙커', desc: '뚫고 1층에서 폭발', unlock: 'A' },
  { id: 'thermo', key: '9', name: '열압력탄', short: '열압력', desc: '연료 구름 불폭풍', unlock: 'A+' },
  { id: 'rod', key: '0', name: '신의 지팡이', short: '지팡이', desc: '궤도 텅스텐 낙하', unlock: 'SS' },
  { id: 'nuke', key: '-', name: '중성자탄', short: '중성자', desc: '일대가 통째로 증발', unlock: 'SSS' },
];

export interface WeaponParams {
  R: number;        // 피해 반경 m (0 = 맞은 블록 하나)
  D: number;        // 중심 피해
  crater: number;   // 크레이터 깊이 m
  shake: number;    // 화면 흔들림 m
  rate?: number;    // 연사 무기: 초당 발수
  delay?: number;   // 날아가는 무기: 착탄까지 초 (집속탄은 운반탄이 열릴 때까지)
  pts?: number;     // 직접 깬 블록 하나의 고정 점수 (소총만. 맵 배율 없이 50점이라 3개 깨면 어느 맵이든 D. 콤보 배율은 받아 오래 쏘면 C에 닿기도 한다)
}

export const WEAPON_PARAMS: Record<WeaponId, WeaponParams> = {
  rifle: { R: 0, D: 7, crater: 0, shake: 0.1, rate: 10, pts: 50 },
  grenade: { R: 3, D: 140, crater: 0.4, shake: 0.4, delay: 0.9, rate: 6 },
  mortar: { R: 6, D: 220, crater: 1, shake: 0.6, delay: 0.6, rate: 4 },
  artillery: { R: 10, D: 320, crater: 2, shake: 1.2, delay: 0.75, rate: 3 },
  // 집속탄: R·D·crater는 자탄 하나 값. 자탄 수는 index.ts CLUSTER_N
  cluster: { R: 5, D: 200, crater: 0.5, shake: 0.6, delay: 2.0 },
  // 다연장 로켓: 로켓 하나 값. 발수는 index.ts MLRS_N, 발사 간격은 MLRS_GAP
  mlrs: { R: 7, D: 260, crater: 0.8, shake: 0.8, delay: 1.5 },
  bomb: { R: 18, D: 500, crater: 4, shake: 2.2, delay: 2.2, rate: 2 },
  // 벙커버스터: 지붕을 뚫고 1층(또는 땅속)에서 터진다. R·D는 바닥 폭발 값
  bunker: { R: 12, D: 900, crater: 5, shake: 2.4, delay: 1.6 },
  // 열압력탄: D는 0.5초 동안 3번에 나눠 주는 합. 땅은 얕게 판다. 맞은 건물 속은 index.ts stepThermo가 더 부순다
  thermo: { R: 20, D: 420, crater: 1.5, shake: 2.6, delay: 1.2 },
  // 신의 지팡이: 위성 조준 2.4초 + 낙하 0.6초. 크레이터는 깊고 좁게(반경 R/2)
  rod: { R: 28, D: 1600, crater: 8, shake: 4, delay: 3.0 },
  nuke: { R: 120, D: 6000, crater: 9, shake: 7, delay: 4.2 },
};

// 열압력탄 연료 구름이 점화되는 시각(착탄 뒤 초). 화면(index.ts)과 소리(sound.ts)가 같이 쓴다
export const THERMO_FIRE = 0.35;
// 신의 지팡이 위성 조준 시간(초). 남은 delay - ROD_AIM초 동안 1,500m를 떨어진다. 화면(index.ts)과 낙하음(sound.ts)이 같이 쓴다
export const ROD_AIM = 2.4;
