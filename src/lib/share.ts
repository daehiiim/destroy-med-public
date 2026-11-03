// 공유 카드 합성과 SNS 공유 주소

export interface ShareInfo { name: string; score: number; rank: string; url: string }

// 공유 문구: "<병원> 부수기 — <점수>점 <랭크>"
export const shareTitle = (s: ShareInfo) => `${s.name} 부수기 — ${s.score.toLocaleString('ko-KR')}점 ${s.rank}`

export const xUrl = (s: ShareInfo) =>
  `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareTitle(s))}&url=${encodeURIComponent(s.url)}`
export const facebookUrl = (s: ShareInfo) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(s.url)}`

// 게임 화면 캡처 위에 병원 이름·점수·랭크를 얹은 1200×630 PNG를 만든다
export async function composeCard(shot: Blob, s: ShareInfo): Promise<Blob> {
  const W = 1200, H = 630
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const img = await createImageBitmap(shot)
  // 캡처를 카드 비율에 맞춰 가운데를 잘라 채운다
  const k = Math.max(W / img.width, H / img.height)
  ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k)
  img.close()
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H)
  g.addColorStop(0, 'rgba(22,22,22,0)')
  g.addColorStop(1, 'rgba(22,22,22,0.92)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  await document.fonts.ready
  const font = "'Pretendard GOV Variable', 'Pretendard GOV', sans-serif"
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#f5f5f4'
  ctx.font = `700 44px ${font}`
  ctx.fillText(s.name, 56, H - 150)
  ctx.font = `700 96px ${font}`
  ctx.fillText(`${s.score.toLocaleString('ko-KR')}점`, 56, H - 56)
  // 랭크 글자는 오른쪽 아래에 주황으로 기울여 그린다
  ctx.save()
  ctx.translate(W - 56, H - 56)
  ctx.transform(1, 0, -0.18, 1, 0, 0)
  ctx.textAlign = 'right'
  ctx.fillStyle = '#f26b3a'
  ctx.font = `700 160px ${font}`
  ctx.fillText(s.rank, 0, 0)
  ctx.restore()
  // 왼쪽 위 로고 칩: 글자 폭에 맞춘 어두운 상자
  ctx.font = `700 32px ${font}`
  ctx.fillStyle = 'rgba(22,22,22,0.9)'
  ctx.fillRect(40, 40, ctx.measureText('SMASH 병원').width + 40, 64)
  ctx.fillStyle = '#f5f5f4'
  ctx.fillText('SMASH', 60, 84)
  ctx.fillStyle = '#f26b3a'
  ctx.fillText('병원', 60 + ctx.measureText('SMASH ').width, 84)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('card toBlob failed'))), 'image/png'))
}
