// 엔진 공개 타입과 장면 데이터 스키마 (01-data.md, 02-engine.md 계약)

export type XZ = [number, number];

export interface HospitalData {
  id: string;
  name: string;
  short: string;
  center: [lat: number, lon: number];
  // 로컬 좌표: 미터, x = 동쪽(+), z = 남쪽(+). h는 행 우선(z 먼저 i, x는 j)
  terrain: { x0: number; z0: number; step: number; nx: number; nz: number; h: number[] };
  site: XZ[][];
  // c: 지붕색(위성 사진), w: 외벽색, st: 외벽 모양 (0 기본·병원 격자창, 1 아파트, 2 유리 커튼월, 3 벽돌 저층,
  // 병원 전용 4 유리 커튼월, 5 가로 띠창, 6 세로 핀·루버, 7 벽돌·타일). 없으면 기본 팔레트
  buildings: { o: XZ[]; h: number; lv: number; n?: string; hosp: 0 | 1; c?: string; w?: string; st?: number }[];
  roads: { p: XZ[]; w: number }[];
  green: XZ[][];
  // 병원 옥상 위성 사진 /data/roof/<id>.jpg 가 덮는 로컬 범위(m). 없으면 단색 지붕
  roof?: { x0: number; z0: number; x1: number; z1: number };
}

export type WeaponId = 'rifle' | 'grenade' | 'mortar' | 'artillery' | 'mlrs' | 'bomb' | 'thermo' | 'bunker' | 'cluster' | 'nuke' | 'rod';
// 13단계. B·A만 +/-로 나눈다 (23-rank-combo.md)
export type Rank = 'F' | 'E' | 'D' | 'C' | 'B-' | 'B' | 'B+' | 'A-' | 'A' | 'A+' | 'S' | 'SS' | 'SSS';
// short: 휴대폰 무기 칸(약 60px, 6칸 × 2줄)에 이름이 안 들어갈 때 대신 쓰는 짧은 이름 (3글자 이하)
export interface WeaponInfo { id: WeaponId; key: string; name: string; short?: string; desc: string; unlock: Rank }

export interface GameStats {
  score: number;
  rank: Rank;
  destroyed: number;
  total: number;
  buildingsDown: number;  // 무너진 병원 건물(이름표가 붙은 동) 수
  buildingsTotal: number; // 병원 건물(이름표가 붙은 동) 전체 수
  nearbyDown: number;     // 무너진 주변 건물(이름표 없는 건물) 수
  civilDown: number;      // 무너진 민간 건물(병원이 아닌 건물) 수. 점수에는 넣지 않는다
  combo: number;          // 연속 타격 콤보 (2초 넘게 안 맞히면 0)
  comboMul: number;       // 콤보 점수 배율 (1~3)
}

export interface GameError { code: string; message: string }

export interface GameCallbacks {
  onReady(): void;
  onStats(s: GameStats): void;
  onCanUndo(can: boolean): void;
  onError(err: GameError): void;
}

export interface Game {
  setWeapon(id: WeaponId): void;
  undo(): void;
  restoreAll(): void;
  setLabels(on: boolean): void;
  setSound(on: boolean): void;
  setMusic(on: boolean): void;  // 배경음악만 켜기/끄기
  setVolume(v: number): void;   // 0~1
  setTopView(on: boolean): void;
  capture(): Promise<Blob>;
  dispose(): void;
}
