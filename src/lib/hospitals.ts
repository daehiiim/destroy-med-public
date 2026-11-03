// hospitals.json 한 항목 (01-data.md)
export interface HospitalInfo {
  id: string
  name: string
  short: string
  group: 'top10' | 'capital' | 'national'
  region: string
  lat: number
  lon: number
  buildings: number
}

export const GROUP_LABEL: Record<HospitalInfo['group'], string> = { top10: '의대 TOP10', capital: '수도권', national: '지거국' }

let cache: Promise<HospitalInfo[]> | null = null

// 병원 목록을 한 번만 받아 둔다. 실패하면 다음 호출에서 다시 받는다
export function loadHospitals(): Promise<HospitalInfo[]> {
  cache ??= fetch('/data/hospitals.json')
    .then(async (r) => {
      if (!r.ok) throw Object.assign(new Error(`hospitals.json HTTP ${r.status}`), { status: r.status })
      return (await r.json()) as HospitalInfo[]
    })
    .catch((e) => {
      cache = null
      throw e
    })
  return cache
}
