import { Button } from '@/components/ui/button'
import { userErrorLines, type AppError } from '@/lib/errors'

// 에러 화면 상자: ERROR.md 5절 형식의 안전한 문구와 "다시 시도"·"다른 병원" 버튼
export function ErrorBox({ err, onRetry, onHome }: { err: AppError; onRetry?: () => void; onHome?: () => void }) {
  const { lines, retry } = userErrorLines(err)
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl bg-card p-4">
      <p className="text-subtitle">{lines[0]}</p>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {lines.slice(1).map((l) => <li key={l}>{l}</li>)}
      </ul>
      <div className="flex gap-2">
        {retry && onRetry && <Button className="h-11 px-4" onClick={onRetry}>다시 시도</Button>}
        {onHome && <Button variant="secondary" className="h-11 px-4" onClick={onHome}>다른 병원</Button>}
      </div>
    </div>
  )
}
