import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { ArrowDownToLine, Bomb, ChevronsUp, CloudHail, Coffee, Crosshair, Flame, Home, Loader2, Lock, MessageSquareText, Plane, Radiation, Rocket, RotateCcw, Settings2, Share2, Target, Zap, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createGame, rankTier, RANK_THRESHOLDS, WEAPONS, type Game, type GameStats, type Rank, type WeaponId } from '@/game'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ErrorBox } from '@/components/ErrorBox'
import ShareDialog from '@/components/ShareDialog'
import DonateDialog from '@/components/DonateDialog'
import { loadHospitals } from '@/lib/hospitals'
import { logAppError, type AppError } from '@/lib/errors'
import { navigate } from '@/lib/route'

const ICONS: Record<WeaponId, LucideIcon> = { rifle: Crosshair, grenade: Bomb, mortar: Target, artillery: Rocket, mlrs: ChevronsUp, bomb: Plane, thermo: Flame, bunker: ArrowDownToLine, cluster: CloudHail, nuke: Radiation, rod: Zap }
const EMPTY: GameStats = { score: 0, rank: 'F', destroyed: 0, total: 0, buildingsDown: 0, buildingsTotal: 0, nearbyDown: 0, civilDown: 0, combo: 0, comboMul: 1 }

// 랭크 순서 번호. RANK_THRESHOLDS가 높은 랭크부터라 작을수록 높다
const rankIdx = (r: Rank) => RANK_THRESHOLDS.findIndex(([x]) => x === r)

// 이번 판 최고 랭크를 새로 찍을 때 뜨는 가상 속보. 단계가 오를수록 사태가 커진다
// 랭크마다 여러 문구 중 하나를 무작위로 고른다
const HEADLINES: Partial<Record<Rank, ((n: string) => string)[]>> = {
  D: [
    (n) => `${n} 주차장서 "펑" 소리… 주민 "타이어 터진 줄"`,
    (n) => `${n} 유리창 깨져… 병원 측 "단순 시설 노후"`,
    (n) => `"${n} 쪽에서 연기 나요" SNS 목격담 확산`,
    (n) => `${n} 대기 환자들 "진료 대기보다 소음이 더 길어"`,
    (n) => `${n} 화단 화분 3개 쓰러져… 경비원 "바람 탓"`,
    (n) => `${n} 정문 앞 화단 철쭉 일부 뽑혀… 구청 "원인 조사 중"`,
    (n) => `${n} 매점 아주머니 "오늘따라 손님이 빨리 나가"`,
    (n) => `${n} 공사 소음 민원… 병원 측 "공사 안 하는데요"`,
    (n) => `${n} 자판기 커피 쏟아져… 피해액 1,200원 추산`,
    (n) => `${n} 비둘기 떼 일제히 이륙… 조류학계 "이례적"`,
  ],
  C: [
    (n) => `${n} 인근서 원인 모를 굉음… 주민 신고 잇따라`,
    (n) => `${n} 매점 진열대 와르르… 컵라면 피해 집계 중`,
    (n) => `${n} 엘리베이터 전면 운행 중단… "계단 이용 바랍니다"`,
    (n) => `${n} 원무과 "번호표 기계는 무사합니다"`,
    (n) => `기상청 "${n} 일대 진동, 지진 아냐"`,
    (n) => `${n} 화장실 타일 일부 탈락… "물은 잘 나옵니다"`,
    (n) => `${n} 주차 정산기 고장… 오늘 주차 무료`,
    (n) => `${n} 건강검진 대기자들 "피검사보다 이게 더 무서워"`,
  ],
  B: [
    (n) => `${n} 건물 외벽 파손… 경찰·소방 출동`,
    (n) => `${n} 외벽에 구멍 숭숭… 전문가 "치즈 아니다"`,
    (n) => `${n} 수술 일정 줄줄이 연기… 환자들 "차라리 다행"`,
    (n) => `${n} 주변 교통 통제… 퇴근길 정체 극심`,
    (n) => `배달앱 "${n} 방면 주문 당분간 불가"`,
    (n) => `${n} 옥상 헬기장 "오늘은 착륙 사양"`,
    (n) => `${n} 병동 커튼 찢어져… 환자들 뜻밖의 탁 트인 전망`,
    (n) => `${n} 앞 버스 정류장 무정차 통과`,
    (n) => `${n} 간호사실 "인수인계 사항: 벽 없음"`,
    (n) => `${n} 구내식당 오늘 메뉴 '먼지 비빔밥'… 직원들 "평소랑 비슷"`,
  ],
  A: [
    (n) => `${n} 연쇄 폭발… 외래 진료 전면 중단`,
    (n) => `${n} 응급실 "지금은 우리가 응급"`,
    (n) => `보건복지부, ${n} 사태 긴급 대책회의 소집`,
    (n) => `${n} 건물 절반 사라져… 지도 앱 "업데이트 중"`,
    (n) => `${n} 주가 아닌데 관련주 폭락… 증권가 "이유 모름"`,
    (n) => `대한의사협회 "${n} 사태, 의료 공백 우려"`,
    (n) => `${n} 영안실 "당분간 예약 받습니다"`,
    (n) => `${n} 인근 아파트 단지 창문 집단 파손`,
  ],
  S: [
    (n) => `${n}에 테러 추정 공격… 환자 긴급 대피`,
    (n) => `군 당국, ${n} 상공 비행 금지구역 지정`,
    (n) => `${n} 반경 2km 주민 대피령… 대피소 "라면 동났다"`,
    (n) => `${n} 사태에 국회 긴급 현안질의… 여야 "일단 놀랐다"`,
    (n) => `외교부 "${n} 사태, 외국인 피해 확인 중"`,
    (n) => `${n} 주변 편의점 생수 품절 대란`,
    (n) => `국방부 "${n} 상황 예의주시… 배후 확인 중"`,
    (n) => `${n} 화재 연기, 수도권 전역에서 관측`,
    (n) => `${n} 사태에 보험사 긴급회의… "약관에 이런 건 없다"`,
    (n) => `${n} 인근 부동산 "전망 좋아졌다" 호가 상승`,
  ],
  SS: [
    (n) => `정부, ${n} 일대 국가 재난사태 선포`,
    (n) => `대통령, ${n} 사태 대국민 담화 예정`,
    (n) => `${n} 위성사진 공개… "원래 뭐가 있었는지 모르겠다"`,
    (n) => `${n} 일대 휴대폰 재난문자 1분에 한 통꼴`,
    (n) => `UN 안보리, ${n} 사태 긴급회의 소집`,
    (n) => `${n} 일대 지도에서 지워져… 내비 "경로를 찾을 수 없습니다"`,
    (n) => `주식시장 서킷브레이커 발동… "${n} 쇼크"`,
    (n) => `전국 병원 비상 근무 돌입… "${n} 다음은 어디"`,
  ],
  SSS: [
    (n) => `${n} 사실상 초토화… 외신 긴급 타전`,
    (n) => `${n} 자리에 거대한 구덩이만… 관광객 몰려`,
    (n) => `지리학계 "${n} 터, 새 지형으로 등재 검토"`,
    (n) => `${n} 사태, 세계 뉴스 1면 싹쓸이`,
    (n) => `NASA "${n} 섬광, 우주에서도 관측"`,
    (n) => `${n} 터에 버섯구름… 기상청 "구름 아닙니다"`,
    (n) => `교과서 출판사 "${n}, 다음 판 지도에서 삭제"`,
    (n) => `${n} 증발… 건강보험공단 "청구할 곳이 없다"`,
    (n) => `${n} 터, 유네스코 "세계 최대 구덩이 유산" 검토`,
    (n) => `${n} 사태 다큐 제작 확정… 제목은 "아무도 범인을 모른다"`,
  ],
}
// 건물이 한 동 무너질 때마다 뜨는 속보. k는 이번 판에서 몇 동째인지
const COLLAPSE: ((n: string, k: number) => string)[] = [
  (n, k) => `${n} 건물 ${k}동째 무너져… 구조대 급파`,
  (n, k) => `${n} ${k}번째 건물 붕괴… 현장 먼지구름 자욱`,
  (n, k) => `${n} 또 무너졌다… 벌써 ${k}동째`,
  (n, k) => `${n} 건물 ${k}동 주저앉아… 119 "출동 차량 부족"`,
  (n, k) => `${n} 붕괴 ${k}동째… 인근 부동산 "매물 문의 폭주"`,
  (n, k) => `[단독] ${n} ${k}동째 무너지는 순간 영상 입수`,
  (n, k) => `${n} ${k}동째 붕괴… 시민들 "이제 세는 것도 지쳐"`,
  (n, k) => `${n} ${k}개 동 잔해 산더미… 폐기물 업체 행복한 비명`,
  (n, k) => `${n} ${k}동째 붕괴… 맞은편 카페 창가석 예약 마감`,
  (n, k) => `${n} ${k}번째 건물 쓰러져… 유튜버들 삼각대 들고 집결`,
  (n, k) => `${n} ${k}동째… 동네 어르신 "재개발 소식은 못 들었는데"`,
  (n, k) => `${n} 붕괴 ${k}동째, 원무과 "진료비 영수증은 재발급 됩니다"`,
  (n, k) => `${n} ${k}동째 무너지자 맞은편 치킨집 "오늘 배달 안 갑니다"`,
]
// 민간 건물(병원이 아닌 건물)이 한 동 무너질 때 뜨는 속보. 민간 건물은 점수에 들어가지 않는다
// 세상은 현장 요원·상부 지시를 모른다. 정체불명 공격(테러·전쟁)으로 보도하고, 반응은 엉뚱하게 샌다
const CIVIL: ((n: string) => string)[] = [
  (n) => `${n} 인근 주택가도 피격… 정체불명 공격 확산`,
  (n) => `시민단체 "${n} 옆 민가까지 공격" 규탄 성명`,
  (n) => `민간 피해 확산… 국제사회 "${n} 사태 우려"`,
  (n) => `${n} 주변 상가 주저앉아… 상인들 "보상부터 하라"`,
  (n) => `${n} 일대 무차별 공격… 정부 "테러 가능성 무게"`,
  (n) => `${n} 일대 주민 대피 소동… 구청 "민원 전화 폭주"`,
  (n) => `유엔 인권 담당 "${n} 민간 피해 예의주시"`,
  (n) => `국방부 "${n} 인근 민가 피격, 적 도발 여부 확인 중"`,
  (n) => `${n} 옆 건물주 기자회견 "보험사가 약관만 읽고 있다"`,
  (n) => `${n} 인근 공습 사이렌… 시민들 "민방위 훈련인 줄"`,
  (n) => `[단독] ${n} 인근 피격 순간 CCTV 입수… "하늘에서 뭔가"`,
  (n) => `경찰 "${n} 일대 공격 주체 특정 못 해"… 수사 난항`,
  (n) => `${n} 옆 분식집 사라져… 단골들 "떡볶이는 죄가 없다"`,
  (n) => `${n} 인근 PC방 붕괴… 손님들 "저장은 했냐"`,
  (n) => `${n} 옆 교회 무너져… 목사 "주일 예배는 주차장에서"`,
  (n) => `${n} 인근 학원가 피해… 수험생들 "그래도 모의고사는 본다"`,
  (n) => `${n} 옆 빌라 주민 "관리비 낸 지 사흘 만에"`,
  (n) => `${n} 인근 편의점 피격… 점주 "알바가 먼저 도망갔다"`,
]
// 민간 건물이 무너질 때 상부(본부)가 보내는 질책. 플레이어는 병원 철거 지시를 받은 현장 요원이다
// [이 동 수부터, 문구들] 순서. 같은 판에서 민간 피해가 쌓일수록 아래 단계로 내려가 수위가 오른다
const BOSS: [number, string[]][] = [
  [1, [
    '방금 그거 민간 건물이다. 지시서 다시 읽어 봐',
    '거기 병원 아니다. 안경 챙겨 왔나?',
    '타깃은 병원이다. 옆 건물은 남의 집이야',
  ]],
  [2, [
    '또? 지금 뭐 하는 건가. 병원만 치라고 했다',
    '민간인 건드리지 말라고 몇 번 말하나',
    '이름표 켜 봐. "병원"이라고 써 있는 데가 병원이다',
  ]],
  [3, [
    '민간 피해 계속 올라온다. 경위서 써 놔',
    '본부 전화통 불난다. 손 좀 떼고 숨부터 쉬어',
    '이거 다 누가 보상하나. 자네 월급에서 나간다',
  ]],
  [5, [
    '시말서 양식 메일로 보냈다. 오늘 안에 제출',
    '이번 달 성과급은 없는 걸로 알아',
    '감사팀이 자네 이름 적어 갔다',
  ]],
  [8, [
    '인사팀 면담 잡혔다. 일단 병원부터 끝내고 와',
    '회장님이 뉴스 보셨다. 할 말 없다',
    '자네 사원증 반납 서류 결재 올라왔다',
  ]],
]
const bossLine = (n: number) => pick(BOSS.findLast(([at]) => n >= at)![1], null)
// 병원 건물이 무너질 때 상부가 가끔 보내는 칭찬. BOSS와 같은 [이 동 수부터, 문구들] 순서
const PRAISE: [number, string[]][] = [
  [1, ['좋아, 그거다. 그렇게만 해', '본부 모니터로 봤다. 깔끔하다', '이제야 일하는 것 같네']],
  [3, ['진도 괜찮다. 점심은 먹고 해', '팀장님이 고개 끄덕이셨다', '오늘 손이 좀 풀렸나 보군']],
  [6, ['이번 분기 우수 사원 후보 올린다', '보고서에 자네 이름 크게 써 둔다', '성과급 얘기 위에 꺼내 볼게']],
]
const PRAISE_ALL = ['전부 끝났나? 수고했다. 바로 다음 현장 간다', '완료 보고 받았다. 회장님이 박수 치셨다', '깔끔하다. 커피 한 잔 사 줄게']
// 병원 건물이 모두 무너진 순간 뜨는 속보. k는 병원 건물 전체 동 수
const ALL_DOWN: ((n: string, k: number) => string)[] = [
  (n, k) => `${n} 건물 ${k}동 전부 무너져… 남은 건 주차 정산기뿐`,
  (n) => `${n} 완전 붕괴… 보건소 "환자분들 저희 쪽으로 오세요"`,
  (n, k) => `${n} ${k}개 동 모두 쓰러져… 지도 앱 "폐업"으로 표시`,
  (n) => `${n} 건물 하나도 안 남아… 원무과 "수납은 계속합니다"`,
  (n, k) => `${n} ${k}동 전멸… 철거 업체 "우리 일거리가 사라졌다"`,
  (n) => `${n} 터 평지로… 인근 주민 "드디어 산이 보인다"`,
  (n) => `${n} 전 건물 붕괴, 개원 이래 처음… 병원 측 "임시 휴진"`,
  (n, k) => `건축학계 "${n} ${k}개 동 붕괴, 교과서에 실릴 사례"`,
  (n) => `${n} 전부 무너져… 국정원 "배후 단체 아직 오리무중"`,
  (n) => `${n} 사라진 자리에 푸드트럭 줄지어… "명당 자리"`,
  (n, k) => `${n} ${k}개 동 모두 붕괴… 병원 공식 SNS "잠시 쉬어 갑니다"`,
  (n) => `${n} 완전 소멸… 의료진 "드디어 퇴근" 환호`,
]
// 목록에서 하나를 고른다. 바로 앞에 띄운 문구는 되도록 피한다
const pick = <T,>(list: T[], last: T | null) => {
  const rest = list.length > 1 ? list.filter((x) => x !== last) : list
  return rest[Math.floor(Math.random() * rest.length)]
}
const NEWS_MS = 4500
// 이 폭부터 PC 배치(Tailwind lg). 더 좁으면 버튼을 위쪽 바로 올리고 점수판을 접는다
const WIDE = '(min-width: 1024px)'

// 병원별 최고 점수 읽기/쓰기. 사생활 모드 등에서 localStorage가 막혀도 게임은 계속된다
const bestKey = (id: string) => `smash-hospital:best:${id}`
function readBest(id: string) {
  try { return Number(localStorage.getItem(bestKey(id))) || 0 } catch { return 0 }
}
function writeBest(id: string, v: number) {
  try { localStorage.setItem(bestKey(id), String(v)) } catch { /* 저장 못 해도 화면 값은 유지 */ }
}

// 데이터 받기 → JSON 읽기. 실패 원인마다 다른 에러 코드로 던진다
async function fetchHospital(id: string, signal: AbortSignal) {
  const fail = (code: string, status: number | null, message: string): never => { throw { code, status, message } satisfies AppError }
  const list = await loadHospitals().catch((e: Error & { status?: number }) => fail('DATA_FETCH_FAILED', e.status ?? null, e.message))
  const info = list.find((h) => h.id === id) ?? fail('DATA_HOSPITAL_NOT_FOUND', 404, `id not in hospitals.json: ${id}`)
  const url = `/data/h/${encodeURIComponent(id)}.json`
  const r = await fetch(url, { signal }).catch((e: Error) => (e.name === 'AbortError' ? Promise.reject(e) : fail('DATA_FETCH_FAILED', null, e.message)))
  // 개발 서버는 없는 파일에 index.html(200)을 돌려주므로 HTML 응답도 '없음'으로 본다
  if (r.ok && r.headers.get('content-type')?.includes('text/html')) fail('DATA_HOSPITAL_NOT_FOUND', 404, `${url} returned HTML`)
  if (!r.ok) fail(r.status === 404 ? 'DATA_HOSPITAL_NOT_FOUND' : 'DATA_FETCH_FAILED', r.status, `${url} HTTP ${r.status}`)
  const text = await r.text()
  try {
    return { info, data: JSON.parse(text) }
  } catch (e) {
    return fail('DATA_PARSE_FAILED', r.status, (e as Error).message)
  }
}

// 게임 화면: 3D 장면 + HUD(칩, 점수, 랭크, 무기 바, 버튼) + 단축키 + 공유·후원
export default function GamePage({ id }: { id: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [name, setName] = useState({ name: '', short: '' })
  const [stats, setStats] = useState<GameStats>(EMPTY)
  const [best, setBest] = useState(() => readBest(id))
  const [canUndo, setCanUndo] = useState(false)
  const [weapon, setWeapon] = useState<WeaponId>('rifle')
  const [opts, setOpts] = useState({ labels: true, sound: true, music: true, top: false })
  const [volume, setVolume] = useState(100)
  const [shareOpen, setShareOpen] = useState(false)
  const [donateOpen, setDonateOpen] = useState(false)
  // 병원 건물을 전부 무너뜨리면 뜨는 임무 성공 창
  const [clearOpen, setClearOpen] = useState(false)
  // 처음 들어오면 설정을 열어 둔다. 패널은 게임 준비 뒤에 그려지므로 그때 열린다
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [peak, setPeak] = useState<Rank>('F')
  const [unlocked, setUnlocked] = useState<Rank>('F')
  // 설정의 "모든 무기 해금": 켜면 랭크와 상관없이 무기를 다 연다. 끄면 실제로 오른 랭크 기준으로 돌아간다
  const [allWeapons, setAllWeapons] = useState(false)
  const openRank = allWeapons ? RANK_THRESHOLDS[0][0] : unlocked
  const [news, setNews] = useState<{ n: number; text: string } | null>(null)
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches)
  // 점수판을 눌러 통계·최고 점수를 펼치고 접는다. PC·휴대폰 모두 "점수 + 랭크"만 보이게 접은 상태로 시작한다
  const [statsOpen, setStatsOpen] = useState(false)
  const peakRef = useRef<Rank>('F')
  const unlockedRef = useRef<Rank>('F')
  const downRef = useRef(0)
  const civilRef = useRef(0)
  const lastCollapseRef = useRef<(typeof COLLAPSE)[number] | null>(null)

  // 이번 판 최고 랭크를 갱신하고 속보를 고른다. 점수가 0으로 돌아가면(전부 복구 등) 처음부터 다시 센다
  // 무기 해금용 최고 랭크(unlocked)는 이 리셋에도 내려가지 않는다. 해금 알림은 띄우지 않는다(무기 바 칸이 열리는 것으로 충분)
  // 엔진 콜백 안에서 불리므로 ref와 setter만 쓴다
  const trackPeak = (st: GameStats, hospital: string) => {
    if (rankIdx(st.rank) < rankIdx(unlockedRef.current)) {
      unlockedRef.current = st.rank
      setUnlocked(st.rank)
    }
    // 민간 건물만 부수면 점수가 0이어도 경고는 떠야 하므로 민간 피해가 없을 때만 처음으로 돌린다
    if (st.score === 0 && st.civilDown === 0) {
      peakRef.current = 'F'
      downRef.current = 0
      civilRef.current = 0
      setPeak('F')
      return
    }
    let text = ''
    if (st.buildingsDown > downRef.current) {
      lastCollapseRef.current = pick(COLLAPSE, lastCollapseRef.current)
      text = lastCollapseRef.current(hospital, st.buildingsDown)
    }
    // 마지막 병원 건물이 무너진 순간에는 전부 붕괴 속보를 띄운다
    const allDown = st.buildingsTotal > 0 && st.buildingsDown >= st.buildingsTotal && downRef.current < st.buildingsTotal
    if (allDown) {
      text = pick(ALL_DOWN, null)(hospital, st.buildingsTotal)
      // 마지막 동이 쓰러지는 모습을 잠깐 본 뒤 띄운다
      setTimeout(() => setClearOpen(true), 1500)
    }
    // 칭찬은 첫 동·전부 붕괴 때는 꼭, 그 사이엔 세 번에 한 번꼴로만 띄워 질책보다 드물게 한다
    if (allDown || (st.buildingsDown > downRef.current && (downRef.current === 0 || Math.random() < 0.33))) {
      const line = allDown ? pick(PRAISE_ALL, null) : pick(PRAISE.findLast(([at]) => st.buildingsDown >= at)![1], null)
      toast(`[상부] ${line}`, { id: 'boss', icon: <MessageSquareText className="size-4" /> })
    }
    downRef.current = st.buildingsDown
    // 같은 순간에 둘 다 생기면 랭크 속보가 이긴다. 전부 붕괴 속보는 랭크 속보보다 앞선다
    // 속보는 글자 단계(B-·B·B+ = B)가 처음 오를 때만 띄운다. 같은 글자 안에서 +/-만 오르면 최고 랭크만 갱신한다
    if (rankIdx(st.rank) < rankIdx(peakRef.current)) {
      const tierUp = rankTier(st.rank) > rankTier(peakRef.current)
      peakRef.current = st.rank
      setPeak(st.rank)
      const list = HEADLINES[st.rank.replace(/[+-]$/, '') as Rank]
      if (list && tierUp && !allDown) text = pick(list, null)(hospital)
    }
    // 민간 건물이 새로 무너지면 경고 알림과 속보를 띄운다. 칭찬과 같은 id라 같은 순간이면 질책이 덮어쓴다
    if (st.civilDown > civilRef.current) {
      toast(`[상부] ${bossLine(st.civilDown)}`, { id: 'boss', icon: <MessageSquareText className="size-4" /> })
      if (!text) text = pick(CIVIL, null)(hospital)
    }
    civilRef.current = st.civilDown
    if (text) setNews((v) => ({ n: (v?.n ?? 0) + 1, text }))
  }

  // 데이터를 받아 엔진을 만든다. id가 바뀌거나 "다시 시도"하면 처음부터
  useEffect(() => {
    const ctl = new AbortController()
    let game: Game | null = null
    const slowTimer = setTimeout(() => setSlow(true), 1000)
    const showError = (err: AppError, op: string, cause?: unknown) => {
      logAppError(err, op, { id }, cause)
      setError(err)
      setPhase('error')
    }
    fetchHospital(id, ctl.signal)
      .then(({ info, data }) => {
        if (ctl.signal.aborted) return
        setName({ name: info.name, short: info.short })
        game = createGame(stageRef.current!, data, {
          onReady: () => setPhase((p) => (p === 'error' ? p : 'ready')),
          onStats: (st) => {
            setStats(st)
            // 최고 점수 갱신 (같은 값을 두 번 써도 결과가 같아 StrictMode 이중 호출에 안전)
            setBest((b) => (st.score > b ? (writeBest(id, st.score), st.score) : b))
            trackPeak(st, info.name)
          },
          onCanUndo: setCanUndo,
          onError: (e) => showError({ code: e.code, status: null, message: e.message }, 'engine'),
        })
        gameRef.current = game
      })
      .catch((e) => {
        if (ctl.signal.aborted) return
        if (e && typeof e === 'object' && 'code' in e) showError(e as AppError, 'fetchHospital')
        else showError({ code: 'APP_UNEXPECTED', status: null, message: String((e as Error)?.message ?? e) }, 'createGame', e)
      })
    return () => {
      ctl.abort()
      clearTimeout(slowTimer)
      game?.dispose()
      gameRef.current = null
    }
  }, [id, attempt])

  // 엔진이 새로 만들어지면 지금 고른 무기와 설정을 다시 알려 준다
  useEffect(() => {
    const g = gameRef.current
    if (phase !== 'ready' || !g) return
    g.setWeapon(weapon)
    g.setLabels(opts.labels)
    g.setSound(opts.sound)
    g.setMusic(opts.music)
  }, [phase, weapon, opts])

  // 시점은 '위에서 보기'를 바꿀 때만 움직인다. 무기를 바꿀 때마다 각도가 돌아가지 않게 따로 둔다
  useEffect(() => {
    if (phase === 'ready') gameRef.current?.setTopView(opts.top)
  }, [phase, opts.top])

  // 음량은 끄는 동안 자주 바뀌므로 다른 설정(시점 애니메이션 등)을 다시 부르지 않게 따로 보낸다
  useEffect(() => {
    if (phase === 'ready') gameRef.current?.setVolume(volume / 100)
  }, [phase, volume])

  // 단축키: 1~9·0·- 무기. 입력 칸이나 열린 패널 안에서는 무시 (Esc는 패널이 직접 닫는다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (shareOpen || donateOpen || settingsOpen || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const w = WEAPONS.find((x) => x.key === e.key)
      if (w && rankIdx(openRank) <= rankIdx(w.unlock)) setWeapon(w.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shareOpen, donateOpen, settingsOpen, openRank])

  // 화면 폭이 PC 기준을 넘나들면 HUD 배치를 바꾼다
  useEffect(() => {
    const m = matchMedia(WIDE)
    const f = () => setWide(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])

  // 속보는 정해진 시간 뒤 내려간다 (움직임 줄이기 사용자도 이 타이머로 사라진다)
  useEffect(() => {
    if (!news) return
    const t = setTimeout(() => setNews(null), NEWS_MS)
    return () => clearTimeout(t)
  }, [news])

  const pct = stats.total ? (stats.destroyed / stats.total) * 100 : 0
  const ready = phase === 'ready'
  const showStats = statsOpen

  // 복구·공유·후원·설정. PC는 무기 바 오른쪽, 휴대폰은 위쪽 얇은 바에 글자로 둔다
  const actions = (
    <>
      <HudButton icon={RotateCcw} label="전부 복구" disabled={!canUndo && stats.destroyed === 0} onClick={() => gameRef.current?.restoreAll()} />
      <HudButton icon={Share2} label="공유" onClick={() => setShareOpen(true)} />
      <HudButton icon={Coffee} label="후원" onClick={() => setDonateOpen(true)} />
      <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
        <PopoverTrigger asChild>
          <HudButton icon={Settings2} label="설정" />
        </PopoverTrigger>
        <PopoverContent side={wide ? 'top' : 'bottom'} align={wide ? 'end' : 'start'} className="w-60 gap-1 bg-card p-2">
          <SettingRow label="건물 이름표" checked={opts.labels} onChange={(v) => setOpts((o) => ({ ...o, labels: v }))} />
          <SettingRow label="소리" checked={opts.sound} onChange={(v) => setOpts((o) => ({ ...o, sound: v }))} />
          <div className="flex items-center gap-3 px-2 text-sm font-medium">
            <span className="shrink-0">음량</span>
            <Slider aria-label="음량" min={0} max={100} step={1} value={[volume]} onValueChange={([v]) => setVolume(v)} disabled={!opts.sound} />
            <span className="w-8 shrink-0 text-right tabular-nums">{volume}</span>
          </div>
          <SettingRow label="배경음악" checked={opts.music} onChange={(v) => setOpts((o) => ({ ...o, music: v }))} />
          <SettingRow label="위에서 보기" checked={opts.top} onChange={(v) => setOpts((o) => ({ ...o, top: v }))} />
          <SettingRow
            label="모든 무기 해금"
            checked={allWeapons}
            onChange={(v) => {
              setAllWeapons(v)
              // 끌 때 아직 안 열린 무기를 들고 있으면 소총으로 돌린다
              if (!v && rankIdx(unlocked) > rankIdx(WEAPONS.find((w) => w.id === weapon)!.unlock)) setWeapon('rifle')
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  )

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#9cc3e0]">
      <div ref={stageRef} className="game-stage absolute inset-0" />

      {phase === 'loading' && slow && (
        <div role="status" className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg bg-panel px-4 py-3 text-sm font-medium">
            <Loader2 aria-hidden className="size-4 animate-spin text-primary" /> 병원 불러오는 중…
          </div>
        </div>
      )}

      {phase === 'error' && error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-md">
            <ErrorBox err={error} onRetry={() => { setPhase('loading'); setSlow(false); setStats(EMPTY); setAttempt((a) => a + 1) }} onHome={() => navigate('/')} />
          </div>
        </div>
      )}

      {/* HUD 겹: 빈 곳은 클릭이 3D로 통과하고, 패널만 클릭을 받는다 */}
      {/* 휴대폰은 위·아래 여백 없이 화면 끝에 붙여 3D 화면을 넓힌다 (노치·홈 막대 몫만 남김) */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:pt-[max(1rem,env(safe-area-inset-top))] lg:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {/* 휴대폰은 HUD 좌우 여백까지 덮어 화면 가로를 꽉 채우는 메뉴 바(버튼은 글자 폭, 양 끝 포함 여섯 간격이 같다), PC는 제목 + 버튼 */}
          <div className="pointer-events-auto -mx-[max(1rem,env(safe-area-inset-left))] flex w-[calc(100%_+_2*max(1rem,env(safe-area-inset-left)))] items-center justify-evenly bg-panel lg:mx-0 lg:w-auto lg:justify-start lg:gap-3 lg:rounded-xl lg:py-1.5 lg:pr-1.5 lg:pl-4">
            <span className="hidden text-subtitle -skew-x-6 lg:inline">SMASH {name.short}</span>
            <Button variant="secondary" className="relative h-8 min-w-0 px-2.5 after:absolute after:inset-x-0 after:-inset-y-1.5 lg:h-11 lg:gap-1.5 lg:px-3 lg:after:hidden" onClick={() => navigate('/')}>
              <Home aria-hidden className="hidden lg:block" /> 다른 병원
            </Button>
            {ready && !wide && actions}
          </div>

          {ready && (
            <div className="flex w-full flex-col items-start gap-2 lg:ml-auto lg:w-auto lg:items-end">
              {/* 휴대폰은 왼쪽 위, PC는 오른쪽 위에 "924,138점 랭크 A+" 한 줄. 판 없이 테두리 글자로 두고, 기록을 펼쳤을 때만 판을 깐다 */}
              <div className="flex items-baseline gap-4">
                <button
                  type="button"
                  aria-expanded={statsOpen}
                  aria-label={`점수 ${stats.score.toLocaleString('ko-KR')}, 눌러서 기록 ${statsOpen ? '접기' : '보기'}`}
                  onClick={() => setStatsOpen((v) => !v)}
                  className={`pointer-events-auto flex min-h-11 flex-col items-start gap-1 rounded-xl lg:items-end text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${showStats ? 'bg-panel px-3 py-1.5' : ''}`}
                  aria-live="polite"
                >
                  <span className="flex items-baseline gap-1">
                    <span
                      className="text-brand text-white tabular-nums [paint-order:stroke] [-webkit-text-stroke:6px_#161616]"
                      style={{ fontSize: scoreSize(stats.score.toLocaleString('ko-KR'), stats.rank, wide ? 56 : 48) }}
                    >
                      {stats.score.toLocaleString('ko-KR')}
                    </span>
                    <span className="text-title text-white [paint-order:stroke] [-webkit-text-stroke:4px_#161616]">점</span>
                  </span>
                  {/* 콤보는 초당 여러 번 바뀌어 화면 읽기에서 뺀다. 자주 바뀌어 움직임 없이 숫자만 바꾼다 */}
                  {stats.combo >= 2 && (
                    <span aria-hidden className="whitespace-nowrap text-title text-white tabular-nums [paint-order:stroke] [-webkit-text-stroke:4px_#161616]">
                      {stats.combo} 콤보 <span className="text-primary">×{stats.comboMul.toFixed(1)}</span>
                    </span>
                  )}
                  {showStats && (
                    <>
                      {/* 민간 피해는 기본 화면을 깔끔하게 두려고 펼친 기록 안에만 보인다 */}
                      {stats.civilDown > 0 && (
                        <span className="whitespace-nowrap text-sm font-medium tabular-nums text-primary">
                          민간 피해 {stats.civilDown}동 · 점수 제외
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground tabular-nums">
                        부서진 블록 {pct.toFixed(1)}% · 무너진 건물 {stats.buildingsDown}동 · 주변 {stats.nearbyDown}채
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">최고 {best.toLocaleString('ko-KR')}</span>
                    </>
                  )}
                </button>
                <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
                  <span aria-hidden className="text-title text-white [paint-order:stroke] [-webkit-text-stroke:4px_#161616]">랭크</span>
                  <span
                    key={stats.rank}
                    aria-label={`랭크 ${stats.rank}`}
                    className="text-brand -skew-x-12 pr-2 text-primary [paint-order:stroke] [-webkit-text-stroke:6px_#161616] motion-safe:animate-[rank-pop_180ms_var(--ease-out)]"
                  >
                    {stats.rank}
                  </span>
                </span>
              </div>
              {news && (
                <div
                  key={news.n}
                  role="status"
                  style={{ animationDuration: `${NEWS_MS}ms` }}
                  className="flex w-full items-stretch overflow-hidden rounded-md lg:w-auto lg:max-w-[26rem] motion-safe:animate-[news-life_var(--ease-out)_both]"
                >
                  <span className="flex shrink-0 items-center bg-[#d7263d] px-2.5 text-base font-bold text-white lg:text-sm">속보</span>
                  <span className="flex min-w-0 flex-col bg-[#f5f5f4] px-3 py-1.5 text-[#161616]">
                    <span className="hidden text-xs font-medium text-[#5f5f5f] lg:block">SMASH 뉴스</span>
                    {/* 속보는 재미의 중심이라 자르지 않고 줄바꿈해 끝까지 보인다 */}
                    <span className="text-base font-bold lg:text-sm">{news.text}</span>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {ready && (
          <div className="flex flex-col items-center gap-1">
            {/* 휴대폰은 바깥 여백을 4px로 줄이고(-mx-3) 11칸을 6칸 × 2줄로, PC는 고정 폭(넘치면 바 안에서 가로 스크롤).
                375px 폭: (375 - 4×2 바깥 - 2×2 안쪽 - 1×5 칸 사이) ÷ 6 = 59.7px, 높이 48px라 터치 영역 44px 이상 */}
            <div className="pointer-events-auto -mx-3 flex w-[calc(100%_+_1.5rem)] max-w-md flex-col gap-1 rounded-2xl bg-panel p-0.5 lg:mx-0 lg:w-auto lg:max-w-full lg:flex-row lg:p-1.5">
              <div role="radiogroup" aria-label="무기" className="grid grid-cols-6 gap-px lg:flex lg:gap-1 lg:overflow-x-auto lg:overscroll-x-contain">
                {WEAPONS.map((w) => {
                  const locked = rankIdx(openRank) > rankIdx(w.unlock)
                  const Icon = locked ? Lock : ICONS[w.id]
                  const on = w.id === weapon
                  return (
                    <button
                      key={w.id}
                      role="radio"
                      aria-checked={on}
                      aria-label={locked ? `${w.name}, ${w.unlock} 랭크에서 열림` : undefined}
                      disabled={locked}
                      onClick={() => setWeapon(w.id)}
                      className={`relative flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 outline-none lg:px-1 transition-transform duration-120 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 motion-safe:active:scale-[0.97] lg:h-[76px] lg:w-[100px] lg:shrink-0 disabled:pointer-events-none disabled:opacity-40 ${on ? 'bg-primary text-primary-foreground' : 'hover:bg-white/10'}`}
                    >
                      {/* 단축키 번호는 키보드가 있는 PC에서만 */}
                      <span className="absolute top-1 left-2 hidden text-xs font-medium tabular-nums lg:block">{w.key}</span>
                      {/* 잠긴 무기는 자물쇠 옆에 여는 랭크를 붙인다 (설명 칸이 숨는 좁은 화면에서도 보이게) */}
                      <span className="flex items-center gap-0.5">
                        <Icon aria-hidden className="size-5" />
                        {locked && <span className="text-xs font-bold">{w.unlock}</span>}
                      </span>
                      <span className="text-xs font-medium lg:hidden">{w.short ?? w.name}</span>
                      <span className="hidden text-sm font-medium lg:inline">{w.name}</span>
                      <span className={`hidden max-w-full truncate text-xs lg:block ${on ? '' : 'text-muted-foreground'}`}>{locked ? `${w.unlock} 랭크에서 열림` : w.desc}</span>
                    </button>
                  )
                })}
              </div>
              {wide && <div className="grid grid-cols-4 gap-1 border-l border-white/10 pl-1">{actions}</div>}
            </div>
            {/* 표기가 꼭 필요한 출처만 짧게 늘 보인다 (VWorld 건물, OSM ODbL 도로, CC BY·BY-NC 효과음 2개). OSM 표기는 지우지 않는다 */}
            <p className="pointer-events-auto rounded-md bg-panel px-2 text-xs text-muted-foreground">
              ©{' '}
              <a className="underline underline-offset-2" href="https://www.vworld.kr" target="_blank" rel="noreferrer">VWorld</a> · ©{' '}
              <a className="underline underline-offset-2" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> ·{' '}
              <a className="underline underline-offset-2" href="/sfx/CREDITS.md" target="_blank" rel="noreferrer">효과음</a>
            </p>
          </div>
        )}
      </div>

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        capture={() => gameRef.current?.capture() ?? Promise.reject(new Error('game not ready'))}
        info={{ id, name: name.name, score: stats.score, rank: peak }}
      />
      <DonateDialog open={donateOpen} onOpenChange={setDonateOpen} />
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent showCloseButton={false} className="justify-items-center gap-3 bg-card text-center sm:max-w-sm">
          <DialogTitle className="text-title">임무 성공!</DialogTitle>
          <DialogDescription className="text-sm">{name.name} 건물 {stats.buildingsTotal}동을 모두 철거했습니다</DialogDescription>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" className="h-11" onClick={() => setClearOpen(false)}>계속 플레이하기</Button>
            <Button className="h-11" onClick={() => navigate('/')}>다음 병원으로</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// 무기 바 오른쪽(휴대폰은 위쪽 바)의 아이콘+글자 버튼 (Popover 트리거로도 쓰려고 나머지 props를 그대로 넘긴다)
// 점수 글자 크기: max(휴대폰 48, PC 56)px을 넘지 않고, "점 랭크 SSS"까지 한 줄(화면 폭 - 좌우 여백 2rem)에 들어가게 줄인다
// 숫자·쉼표 평균 폭 0.57em, 랭크 글자 하나 30px, 나머지("점"·"랭크"·간격·테두리) 85px은 375px 화면에서 잰 근사치
function scoreSize(score: string, rank: string, max: number) {
  return `min(${max}px, calc((100vw - 2rem - ${85 + rank.length * 30}px) / ${(score.length * 0.57).toFixed(2)}))`
}

function HudButton({ icon: Icon, label, ...rest }: { icon: LucideIcon; label: string } & ComponentProps<'button'>) {
  return (
    <button
      {...rest}
      className="relative flex h-8 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-2.5 outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 lg:h-[76px] lg:shrink-0 lg:after:hidden lg:w-auto lg:min-w-16 lg:px-1 transition-transform duration-120 ease-out hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-ring/50 motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-white/10"
    >
      <Icon aria-hidden className="hidden size-5 lg:block" />
      {/* 휴대폰은 얇은 바에 글자만 둔다. 높이는 32px이고 after로 누르는 곳을 44px까지 늘린다 */}
      <span className="truncate text-sm font-medium lg:text-xs">{label}</span>
    </button>
  )
}

// 설정 패널의 한 줄: 이름 + 켜고 끄는 스위치
function SettingRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm font-medium hover:bg-white/5">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
