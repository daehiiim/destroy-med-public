import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import mascotUrl from '@/assets/donate/coffee-mascot.png'
import tossQrUrl from '@/assets/donate/toss-qr-5000.webp'

// github.com/daehiiim/public_QR_Donate의 문구·QR·마스코트를 그대로 옮겼다.
// 계좌번호와 토스 링크는 그 QR 이미지를 해독한 값이다. QR을 바꾸면 이 두 값도 같이 바꾼다
const BANK_NAME = '토스뱅크'
const ACCOUNT_NUMBER = '1001-2786-7546'
const TOSS_TRANSFER_URL = 'supertoss://send?amount=5000&bank=%ED%86%A0%EC%8A%A4%EB%B1%85%ED%81%AC&accountNo=100127867546&origin=qr'

// 후원 창: 토스 송금 QR, 휴대폰용 토스 열기 버튼, 계좌번호 복사
export default function DonateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  // 계좌번호를 클립보드에 넣는다. 권한이 막히면 직접 적으라고 알린다
  const copyAccount = () =>
    navigator.clipboard.writeText(ACCOUNT_NUMBER).then(
      () => toast.success('계좌번호를 복사했습니다'),
      () => toast.error('복사하지 못했습니다. 계좌번호를 직접 적어 주세요'),
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="justify-items-center gap-3 bg-card text-center sm:max-w-sm">
        <DialogTitle className="text-title">개발자한테 커피 한 잔 쏘기!</DialogTitle>
        {/* 마스코트 PNG는 투명 배경에 검은 글씨라 어두운 창에서 글씨가 안 보인다. 흰 판을 깐다 */}
        <img src={mascotUrl} alt="" className="h-28 w-auto rounded-lg bg-white p-2" />
        <DialogDescription className="text-sm">작은 응원이 개발자에게는 큰 힘이 됩니다!!</DialogDescription>
        <img src={tossQrUrl} alt="토스 송금 QR 코드, 5,000원" className="w-[200px] rounded-lg bg-white" />
        {/* 휴대폰에서는 자기 화면의 QR을 찍을 수 없으니 토스 앱을 바로 연다. 터치 기기에서만 보인다 */}
        <Button asChild className="hidden h-11 w-full pointer-coarse:flex">
          <a href={TOSS_TRANSFER_URL}>토스 열기</a>
        </Button>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{BANK_NAME}</span>
          <strong className="text-base tabular-nums">{ACCOUNT_NUMBER}</strong>
          <Button variant="secondary" className="h-11" onClick={copyAccount}>
            <Copy aria-hidden /> 복사
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
