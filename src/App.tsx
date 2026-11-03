import { lazy, Suspense } from 'react'
import { Toaster } from '@/components/ui/sonner'
import Landing from '@/pages/Landing'
import { usePath } from '@/lib/route'

// 게임 화면은 three.js를 포함해 크므로 들어갈 때만 불러온다 (랜딩 첫 화면을 가볍게)
const GamePage = lazy(() => import('@/pages/GamePage'))

// 경로에 따라 랜딩('/') 또는 게임('/h/:id')을 보여 준다
export default function App() {
  const path = usePath()
  const m = path.match(/^\/h\/([^/]+)\/?$/)
  return (
    <>
      {m ? (
        <Suspense fallback={<div className="fixed inset-0 bg-[#9cc3e0]" />}>
          <GamePage key={m[1]} id={decodeURIComponent(m[1])} />
        </Suspense>
      ) : (
        <Landing />
      )}
      <Toaster position="top-center" />
    </>
  )
}
