import { applyHunks, parsePatch } from '@deepseek-ai/dsh-fs-patch'
import { strToU8, zipSync } from 'fflate'
import { archiveSize, readArchive, readEntry } from '../chat/history/zipReader.js'
import { taskFileMime, taskFileName } from './artifacts.js'

export type ProjectFile = { path: string; text: string }
export type SourceProject = ProjectFile[]

export class ProjectSourceError extends Error {
  constructor(
    readonly reason: 'limits' | 'encoding' | 'paths',
    message: string
  ) {
    super(message)
    this.name = 'ProjectSourceError'
  }
}

const draftLimits = { files: 48, fileBytes: 96 * 1024, totalBytes: 512 * 1024 }
export const workspaceLimits = { files: 256, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024 }

export const validProjectPath = (path: string) =>
  path.length <= 150 &&
  path
    .split('/')
    .every(
      (part) =>
        /^[\p{L}\p{N}_.@+-]{1,64}$/u.test(part) &&
        !part.endsWith('.') &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) &&
  !path
    .split('/')
    .some((part) => ['node_modules', '.git', '__macosx', '__proto__'].includes(part.toLowerCase()))

export const validateProject = (files: SourceProject, limits = draftLimits): SourceProject => {
  if (files.length > limits.files) {
    throw new ProjectSourceError(
      'limits',
      'A project can contain up to ' + limits.files + ' source files.'
    )
  }
  const paths = new Set<string>()
  const directories = new Set<string>()
  let total = 0
  for (const file of files) {
    const key = file.path.normalize('NFC').toLowerCase()
    const parentParts = key.split('/').slice(0, -1)
    const parents = parentParts.map((_, index) => parentParts.slice(0, index + 1).join('/'))
    if (
      !validProjectPath(file.path) ||
      paths.has(key) ||
      directories.has(key) ||
      parents.some((parent) => paths.has(parent))
    ) {
      throw new ProjectSourceError(
        'paths',
        'Invalid or conflicting project path: ' + file.path.slice(0, 150)
      )
    }
    paths.add(key)
    parents.forEach((parent) => directories.add(parent))
    const bytes = strToU8(file.text).length
    total += bytes
    if (file.text.includes('\0')) {
      throw new ProjectSourceError('encoding', 'A source file contains binary content.')
    }
    if (bytes > limits.fileBytes || total > limits.totalBytes) {
      throw new ProjectSourceError('limits', 'The project exceeds its text size limit.')
    }
  }
  return files
}

export const patchProject = (
  source: SourceProject,
  patch: string,
  limits = draftLimits
): SourceProject => {
  const files = new Map(source.map(({ path, text }) => [path, text]))
  const operations = parsePatch(patch)
  if (operations.length > limits.files) {
    throw new Error('Split this patch into smaller groups of files.')
  }
  for (const operation of operations) {
    const { path, kind } = operation
    if (!validProjectPath(path)) {
      throw new Error('Use a relative project path: ' + path.slice(0, 150))
    }
    const current = files.get(path)
    if (kind === 'add' && current === undefined) {
      files.set(path, operation.content)
    } else if (kind === 'delete' && current !== undefined) {
      files.delete(path)
    } else if (kind === 'update' && current !== undefined) {
      const result = applyHunks(current, operation.hunks)
      if (!result.ok) {
        throw new Error(
          path + ' changed. Re-read it and check patch line ' + result.failure.hunkLineNumber + '.'
        )
      }
      const destination = operation.moveTo ?? path
      if (!validProjectPath(destination) || (destination !== path && files.has(destination))) {
        throw new Error('Invalid or existing destination: ' + destination.slice(0, 150))
      }
      files.delete(path)
      files.set(destination, result.after)
    } else {
      throw new Error('Check whether the project already contains ' + path + '.')
    }
  }
  return validateProject(
    [...files].map(([path, text]) => ({ path, text })),
    limits
  )
}

export const openProjectArchive = async (
  blob: Blob,
  signal: AbortSignal,
  limits = draftLimits,
  onProgress?: (read: number, total: number) => void,
  stripRoot = false
): Promise<SourceProject> => {
  const file = new File([blob], 'source.zip')
  const size = await archiveSize(file)
  if (size.expandedBytes > limits.totalBytes || size.total > limits.files * 2) {
    throw new ProjectSourceError('limits', 'This ZIP exceeds the project preview limits.')
  }
  const files: SourceProject = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const entry of readArchive(file)) {
    signal.throwIfAborted()
    if (entry.size > limits.fileBytes) {
      throw new ProjectSourceError('limits', 'A source file exceeds the project file size limit.')
    }
    const data = await readEntry(entry)
    signal.throwIfAborted()
    if (!entry.path.endsWith('/')) {
      const bytes = await data.arrayBuffer()
      signal.throwIfAborted()
      let text: string
      try {
        text = decoder.decode(bytes)
      } catch {
        throw new ProjectSourceError('encoding', 'The source file is not valid UTF-8.')
      }
      files.push({ path: entry.path, text })
      onProgress?.(files.length, size.total)
    }
  }
  if (stripRoot && files.length) {
    const root = files[0].path.split('/')[0] + '/'
    if (files.every(({ path }) => path.startsWith(root))) {
      for (const file of files) {
        file.path = file.path.slice(root.length)
      }
    }
  }
  return validateProject(files, limits)
}

export const exportProjectArchive = (name: unknown, files: SourceProject) => {
  if (!files.length) {
    throw new Error('Add code to the project before exporting it.')
  }
  const bytes = zipSync(Object.fromEntries(files.map(({ path, text }) => [path, strToU8(text)])), {
    level: 3,
    mtime: new Date(2020, 0, 1),
  })
  return {
    name: taskFileName(name, 'zip'),
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: taskFileMime.zip }),
  }
}
