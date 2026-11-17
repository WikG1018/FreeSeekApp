import { fail } from './errors.js'
import { readEntry, type ArchiveEntry } from './zipReader.js'

/** 只约束一次性 JSON 解析，附件仍流式读取。避免压缩小包展开巨型 JSON 耗尽旧机内存。 */
export const MAX_JSON_BYTES = 32 * 1024 * 1024
export const readJsonEntry = async (entry: ArchiveEntry): Promise<unknown> => {
  if (entry.size > MAX_JSON_BYTES) {
    fail('backupJsonTooLarge')
  }
  try {
    return JSON.parse(await (await readEntry(entry)).text())
  } catch {
    return fail('backupInvalidJson')
  }
}
