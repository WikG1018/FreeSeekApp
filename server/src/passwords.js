/**
 * 密码哈希：Node 内置 scrypt（内存硬，抗 GPU 暴力破解），无需第三方依赖。
 * 存储格式：scrypt$N$r$p$saltHex$hashHex
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEY_LEN = 32

export const hashPassword = (password) => {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('hex'), hash.toString('hex')].join('$')
}

export const verifyPassword = (password, stored) => {
  const parts = String(stored).split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false
  }
  const [, n, r, p, saltHex, hashHex] = parts
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** 注册时的密码规则：8–72 位，至少包含字母与数字各一 */
export const checkPasswordPolicy = (password) => {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return '密码需为 8–72 位'
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return '密码需同时包含字母和数字'
  }
  return ''
}

export const checkUsername = (username) => {
  if (typeof username !== 'string') {
    return '用户名无效'
  }
  const value = username.trim()
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,24}$/.test(value)) {
    return '用户名需为 3–24 位字母、数字、下划线或中文'
  }
  return ''
}
