import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorBox } from '@/components/ErrorBox'
import { GROUP_LABEL, loadHospitals, type HospitalInfo } from '@/lib/hospitals'
import { logAppError, type AppError } from '@/lib/errors'
import { navigate } from '@/lib/route'

type Filter = 'all' | HospitalInfo['group']

// 랜딩: 제목, 검색, 묶음 필터, 병원 카드 목록, 고지
export default function Landing() {
  const [list, setList] = useState<HospitalInfo[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    let alive = true
    loadHospitals()
      .then((l) => alive && setList(l))
      .catch((e: Error & { status?: number }) => {
        const err: AppError = { code: e instanceof SyntaxError ? 'DATA_PARSE_FAILED' : 'DATA_FETCH_FAILED', status: e.status ?? null, message: e.message }
        logAppError(err, 'loadHospitals', { url: '/data/hospitals.json' }, e)
        if (alive) setError(err)
      })
    return () => { alive = false }
  }, [attempt])

  // 이름·short·지역에 검색어가 들어간 병원만, 고른 묶음 안에서
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list ?? []).filter(
      (h) => (filter === 'all' || h.group === filter) && (!q || [h.name, h.short, h.region].some((v) => v.toLowerCase().includes(q))),
    )
  }, [list, query, filter])

  return (
    <main className="mx-auto flex min-h-svh max-w-5xl flex-col gap-8 px-[max(1rem,env(safe-area-inset-left))] pt-[max(3rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-brand -skew-x-6 origin-bottom-left">
            SMASH <span className="text-primary">병원</span>
          </h1>
          <p className="text-title">우리 병원을 부숴 봐</p>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-primary" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="병원 이름이나 지역 (예: 서울대, 부산)"
            aria-label="병원 검색"
            className="h-14 rounded-xl bg-card pl-12 text-base md:text-base"
          />
        </div>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          aria-label="병원 묶음"
          className="flex-wrap gap-2"
        >
          {(['all', 'top10', 'capital', 'national'] as const).map((g) => (
            <ToggleGroupItem
              key={g}
              value={g}
              className="h-11 rounded-full bg-card px-4 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {g === 'all' ? '전체' : GROUP_LABEL[g]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {error ? (
        <ErrorBox err={error} onRetry={() => { setError(null); setAttempt((a) => a + 1) }} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((h) => <HospitalCard key={h.id} h={h} />)}
          {list && shown.length === 0 && <li className="text-sm text-muted-foreground">찾는 병원이 없습니다.</li>}
        </ul>
      )}

      <footer className="mt-auto flex flex-col gap-1 text-sm text-muted-foreground">
        <p>실제 병원과 관계없는 비공식 팬 게임입니다. 병원 로고와 상징은 쓰지 않습니다.</p>
        <p>
          ©{' '}
          <a className="underline underline-offset-2" href="https://www.vworld.kr" target="_blank" rel="noreferrer">VWorld</a> · ©{' '}
          <a className="underline underline-offset-2" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        </p>
      </footer>
    </main>
  )
}

// 병원 카드 하나: 위는 글자 미리보기, 아래는 이름과 "부수러 가기" 버튼
function HospitalCard({ h }: { h: HospitalInfo }) {
  const href = `/h/${h.id}`
  return (
    <li>
      <a
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          navigate(href)
        }}
        className="group flex flex-col overflow-hidden rounded-xl bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="relative flex aspect-[2/1] flex-col justify-center gap-3 bg-gradient-to-b from-[#9cc3e0] to-[#d9e4ea] px-6">
          <p className="text-brand -skew-x-12 origin-bottom-left break-all text-white [paint-order:stroke] [-webkit-text-stroke:6px_#161616]">
            SMASH
            <br />
            {h.short}
          </p>
          <span className="self-start rounded-md bg-panel px-2 py-1 text-sm font-medium">{h.region}</span>
        </div>
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="text-subtitle">{h.name}</span>
          <span className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-transform duration-120 ease-out motion-safe:group-active:scale-[0.97]">
            부수러 가기 <ArrowRight aria-hidden className="size-4" />
          </span>
        </div>
      </a>
    </li>
  )
}
