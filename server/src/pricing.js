/**
 * 计价：与客户端一致的官方刊例价（元 / 百万 tokens），乘上服务端配置的加价倍率。
 * 以「微元」（1e-6 元）为整数单位记账，避免浮点误差。
 */
export const OFFICIAL_RATES = {
  offPeak: { hit: 0.02, miss: 1, out: 4 },
  peak: { hit: 0.04, miss: 2, out: 8 },
  /** 元 / 千次搜索 */
  searchPer1k: 5,
}

/** 北京时间工作日 9–12、14–18 为高峰（官方调休未计入，估算口径） */
export const isPeak = (timestamp) => {
  const beijing = new Date(timestamp + 8 * 3600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * 单次请求费用（元）。
 * input 不含缓存命中；cacheRead 是命中读取；cacheWrite 是写入缓存（按未命中计）。
 */
export const costCny = ({ input, cacheRead, cacheWrite, output, searches, at, markup }) => {
  const rate = isPeak(at) ? OFFICIAL_RATES.peak : OFFICIAL_RATES.offPeak
  const miss = (input ?? 0) + (cacheWrite ?? 0)
  const raw =
    ((cacheRead ?? 0) * rate.hit + miss * rate.miss + (output ?? 0) * rate.out) / 1_000_000 +
    ((searches ?? 0) * OFFICIAL_RATES.searchPer1k) / 1000
  return raw * markup
}

export const toMicro = (cny) => Math.max(0, Math.round(cny * 1_000_000))

export const microToYuan = (micro) => micro / 1_000_000

/** 账本展示用：保留合适精度 */
export const formatYuan = (micro) => {
  const yuan = microToYuan(micro)
  if (yuan === 0) return '0.00'
  if (Math.abs(yuan) >= 1) return yuan.toFixed(2)
  return yuan.toFixed(4)
}
