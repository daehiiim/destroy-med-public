// 앱 에러를 한 곳에서 정의하고, 진단 로그를 남기고, 사용자 문구를 만든다 (ERROR.md 형식)

export interface AppError {
  code: string // {DOMAIN}_{CAUSE}
  status: number | null // HTTP 상태. 네트워크를 거치지 않은 에러는 null
  message: string // 개발자용 원문 메시지
}

interface ErrorDef {
  where: string // 실패 위치 (계층/컴포넌트)
  cause: string // 사용자에게 보여도 안전한 원인
  check: string // 확인할 값
  action: string // 다음 조치
  retry: boolean
}

// 예측 가능한 에러 정의 표. 엔진 코드(RENDER_*)도 여기서 사용자 문구를 찾는다
const DEFS: Record<string, ErrorDef> = {
  DATA_FETCH_FAILED: { where: '데이터 불러오기', cause: '병원 데이터를 받지 못했습니다', check: '인터넷 연결', action: '연결을 확인하고 다시 시도하세요', retry: true },
  DATA_PARSE_FAILED: { where: '데이터 읽기', cause: '병원 데이터 형식이 올바르지 않습니다', check: '병원 데이터 파일', action: '다른 병원을 고르거나 잠시 뒤 다시 시도하세요', retry: true },
  DATA_HOSPITAL_NOT_FOUND: { where: '병원 찾기', cause: '주소에 맞는 병원이 없습니다', check: '주소의 병원 이름', action: '다른 병원을 고르세요', retry: false },
  RENDER_WEBGL_UNAVAILABLE: { where: '3D 화면', cause: '이 브라우저에서 3D 그래픽을 켤 수 없습니다', check: '브라우저 하드웨어 가속 설정', action: '하드웨어 가속을 켜거나 다른 브라우저로 여세요', retry: true },
  SHARE_CARD_FAILED: { where: '공유 카드', cause: '결과 카드 이미지를 만들지 못했습니다', check: '게임 화면이 떠 있는지', action: '창을 닫았다가 다시 공유를 누르세요', retry: true },
  SHARE_CLIPBOARD_FAILED: { where: '링크 복사', cause: '브라우저가 복사를 막았습니다', check: '브라우저 클립보드 권한', action: '주소창의 주소를 직접 복사하세요', retry: false },
  RENDER_CONTEXT_LOST: { where: '3D 화면', cause: '3D 그래픽이 중간에 끊겼습니다', check: '열린 탭 수와 기기 메모리', action: '다른 탭을 닫고 다시 시도하세요', retry: true },
}
const UNKNOWN: ErrorDef = { where: '게임', cause: '예상하지 못한 문제가 생겼습니다', check: '브라우저 콘솔의 APP_ERROR_DIAGNOSTIC 로그', action: '다시 시도하세요', retry: true }

// 비밀값처럼 보이는 키를 가린다 (카카오 키 등)
function mask(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /key|token|secret/i.test(k) ? '***' : mask(x)]))
}

// 에러를 APP_ERROR_DIAGNOSTIC 한 줄 JSON으로 콘솔에 남긴다. 직렬화가 실패해도 한 줄은 꼭 남긴다
export function logAppError(err: AppError, operation: string, input: unknown = null, cause?: unknown, upstream: unknown = null) {
  const stack = cause instanceof Error ? cause.stack ?? null : new Error(err.message).stack ?? null
  try {
    console.error('APP_ERROR_DIAGNOSTIC ' + JSON.stringify({
      code: err.code,
      status: err.status,
      operation,
      input: mask(input),
      output: null,
      errormessage: err.message,
      error_message: err.message,
      stacktrace: stack,
      diagnostic: { def: DEFS[err.code] ? 'known' : 'unknown', url: location.pathname },
      exception: cause instanceof Error ? cause.name : null,
      upstream,
    }))
  } catch {
    console.error(`APP_ERROR_DIAGNOSTIC {"code":"${err.code}","operation":"${operation}","note":"serialize failed"}`)
  }
}

// 화면에 보여 줄 안전한 문구 줄 목록을 만든다 (ERROR.md 5절 순서)
export function userErrorLines(err: AppError): { lines: string[]; retry: boolean } {
  const d = DEFS[err.code] ?? UNKNOWN
  return {
    retry: d.retry,
    lines: [
      '요청을 처리하지 못했습니다.',
      `에러 코드: ${err.code}`,
      `HTTP 상태: ${err.status ?? '없음'}`,
      `실패 위치: ${d.where}`,
      `원인: ${d.cause}`,
      `확인할 값: ${d.check}`,
      `다음 조치: ${d.action}`,
    ],
  }
}
