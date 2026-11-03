import { useSyncExternalStore } from 'react'

// 주소창 경로를 구독한다. '/' 는 랜딩, '/h/:id' 는 게임 화면
const subscribe = (fn: () => void) => {
  window.addEventListener('popstate', fn)
  return () => window.removeEventListener('popstate', fn)
}

// 현재 경로를 돌려주는 훅
export function usePath() {
  return useSyncExternalStore(subscribe, () => location.pathname)
}

// 새로고침 없이 경로를 바꾸고 구독자에게 알린다
export function navigate(to: string) {
  if (to === location.pathname) return
  history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}
