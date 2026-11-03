import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Download, Link, Loader2, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { composeCard, facebookUrl, shareTitle, xUrl, type ShareInfo } from '@/lib/share'
import { logAppError } from '@/lib/errors'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  capture: () => Promise<Blob>
  info: { id: string; name: string; score: number; rank: string }
}

// 공유 창: 결과 카드 미리보기와 인스타그램·X·페이스북·링크 복사·이미지 저장 버튼
export default function ShareDialog({ open, onOpenChange, capture, info }: Props) {
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null)
  const s: ShareInfo = { ...info, url: `${location.origin}/h/${info.id}` }

  // 창이 열릴 때마다 지금 화면으로 카드를 새로 만든다
  useEffect(() => {
    if (!open) return
    let url = ''
    let alive = true
    capture()
      .then((shot) => composeCard(shot, s))
      .then((blob) => {
        url = URL.createObjectURL(blob)
        if (alive) setCard({ blob, url })
        else URL.revokeObjectURL(url)
      })
      .catch((e) => {
        logAppError({ code: 'SHARE_CARD_FAILED', status: null, message: String(e?.message ?? e) }, 'composeCard', { id: info.id }, e)
        if (alive) toast.error('결과 카드를 만들지 못했습니다. (SHARE_CARD_FAILED)')
      })
    return () => {
      alive = false
      setCard(null)
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창을 열 때의 점수로 한 번만 만든다
  }, [open])

  // 링크를 클립보드에 넣는다. 성공하면 true
  const copyLink = async (okMsg = '링크를 복사했습니다') => {
    try {
      await navigator.clipboard.writeText(s.url)
      toast.success(okMsg)
      return true
    } catch (e) {
      logAppError({ code: 'SHARE_CLIPBOARD_FAILED', status: null, message: String((e as Error)?.message ?? e) }, 'copyLink', { url: s.url }, e)
      toast.error('링크를 복사하지 못했습니다. 주소창의 주소를 복사하세요. (SHARE_CLIPBOARD_FAILED)')
      return false
    }
  }

  // 다른 앱으로 공유: 이미지 파일을 같이 보낼 수 있으면 같이 보낸다. 사용자가 취소한 경우는 조용히 넘긴다
  const nativeShare = async () => {
    const file = card && new File([card.blob], `smash-${info.id}.png`, { type: 'image/png' })
    const data: ShareData = { title: shareTitle(s), text: shareTitle(s), url: s.url }
    if (file && navigator.canShare?.({ files: [file] })) data.files = [file]
    try { await navigator.share(data) } catch (e) { if ((e as Error).name !== 'AbortError') throw e }
  }

  // 인스타그램: 웹에서 바로 올리는 주소가 없어 이미지 파일만 공유 창으로 넘긴다(글·링크를 붙이면 인스타그램이 게시물·스토리로 받지 않음)
  // 파일 공유가 안 되는 곳은 카드 이미지를 저장하고 instagram.com을 열어 직접 올리게 한다
  const instagram = async () => {
    if (!card) return
    const file = new File([card.blob], `smash-${info.id}.png`, { type: 'image/png' })
    // PC(맥 등)도 파일 공유 창은 열리지만 인스타그램 앱이 없어 휴대폰에서만 쓴다
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }) } catch (e) { if ((e as Error).name !== 'AbortError') toast.error('공유를 열지 못했습니다') }
      return
    }
    const a = document.createElement('a')
    a.href = card.url
    a.download = file.name
    a.click()
    toast.info('카드 이미지를 저장했습니다. 인스타그램에서 이 이미지를 올려 주세요')
    open2('https://www.instagram.com/')
  }

  const open2 = (u: string) => window.open(u, '_blank', 'noopener,noreferrer')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-title">결과 공유</DialogTitle>
          <DialogDescription className="text-sm">{shareTitle(s)}</DialogDescription>
        </DialogHeader>
        <div className="flex aspect-[1200/630] items-center justify-center overflow-hidden rounded-lg bg-muted">
          {card ? (
            <img src={card.url} alt={`${shareTitle(s)} 결과 카드`} className="size-full object-cover" />
          ) : (
            <Loader2 aria-label="카드 만드는 중" className="size-5 animate-spin text-primary" />
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button variant="secondary" className="h-11" disabled={!card} onClick={instagram}>인스타그램</Button>
          <Button variant="secondary" className="h-11" onClick={() => open2(xUrl(s))}>X</Button>
          <Button variant="secondary" className="h-11" onClick={() => open2(facebookUrl(s))}>페이스북</Button>
          <Button variant="secondary" className="h-11" onClick={() => copyLink()}>
            <Link aria-hidden /> 링크 복사
          </Button>
          <Button variant="secondary" className="h-11" disabled={!card} asChild={!!card}>
            {card ? (
              <a href={card.url} download={`smash-${info.id}.png`}>
                <Download aria-hidden /> 이미지 저장
              </a>
            ) : (
              <span><Download aria-hidden /> 이미지 저장</span>
            )}
          </Button>
          {typeof navigator.share === 'function' && (
            <Button variant="secondary" className="h-11" onClick={() => nativeShare().catch(() => toast.error('공유를 열지 못했습니다'))}>
              <Share2 aria-hidden /> 다른 앱으로 공유
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
