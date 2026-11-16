import test from 'node:test'
import assert from 'node:assert/strict'
import { costCny, isPeak, toMicro } from '../src/pricing.js'

// 2026-11-17 是周二；北京时间 = UTC+8
const beijing = (iso) => new Date(iso).getTime()

test('高峰判定：工作日 9-12、14-18 为高峰，周末与夜间不是', () => {
  assert.equal(isPeak(beijing('2026-11-17T02:00:00Z')), true) // 北京 10:00 周二
  assert.equal(isPeak(beijing('2026-11-17T04:00:00Z')), false) // 北京 12:00 周二（午休）
  assert.equal(isPeak(beijing('2026-11-17T06:30:00Z')), true) // 北京 14:30 周二
  assert.equal(isPeak(beijing('2026-11-17T10:30:00Z')), false) // 北京 18:30 周二
  assert.equal(isPeak(beijing('2026-11-21T02:00:00Z')), false) // 周六 10:00
})

test('费用：命中/未命中/输出分别计价，并叠加加价倍率', () => {
  // 空闲时段 1M 输入 + 1M 输出 = 1 + 4 = 5 元，×1.1 = 5.5
  const offPeak = costCny({
    input: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 1_000_000,
    searches: 0,
    at: beijing('2026-11-17T10:30:00Z'),
    markup: 1.1,
  })
  assert.equal(offPeak.toFixed(2), '5.50')

  // 高峰时段 1M 输入 + 1M 输出 = 2 + 8 = 10 元，×1.1 = 11
  const peak = costCny({
    input: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 1_000_000,
    searches: 0,
    at: beijing('2026-11-17T02:00:00Z'),
    markup: 1.1,
  })
  assert.equal(peak.toFixed(2), '11.00')

  // 缓存命中按命中价：1M 命中 = 0.02 × 1.1
  const hit = costCny({
    input: 0,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    output: 0,
    searches: 0,
    at: beijing('2026-11-17T10:30:00Z'),
    markup: 1.1,
  })
  assert.equal(hit.toFixed(4), '0.0220')

  // 搜索 2 次 = 2 × 5 / 1000 × 1.1
  const search = costCny({
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    searches: 2,
    at: beijing('2026-11-17T10:30:00Z'),
    markup: 1.1,
  })
  assert.equal(search.toFixed(4), '0.0110')
})

test('微元换算：四舍五入到 1e-6 元，不出现浮点误差', () => {
  assert.equal(toMicro(0.0000004), 0)
  assert.equal(toMicro(0.0000006), 1)
  assert.equal(toMicro(5.5), 5_500_000)
  assert.equal(toMicro(-1), 0)
})
