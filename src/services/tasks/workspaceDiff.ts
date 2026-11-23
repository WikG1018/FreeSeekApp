import { createTwoFilesPatch, structuredPatch } from 'diff'
import { taskFileName } from './artifacts.js'
import type { WorkspaceChange } from './workspaces.js'

const names = ({ path, before, after }: WorkspaceChange) => ({
  oldName: before === null ? '/dev/null' : 'a/' + path,
  newName: after === null ? '/dev/null' : 'b/' + path,
})

export const workspaceDiff = (change: WorkspaceChange) => {
  const { oldName, newName } = names(change)
  return structuredPatch(oldName, newName, change.before ?? '', change.after ?? '', '', '', {
    context: 3,
    timeout: 90,
    maxEditLength: 5_000,
  })
}

export const exportWorkspaceDiff = (name: string, changes: WorkspaceChange[]) => {
  const deadline = performance.now() + 750
  const parts = changes.map((change) => {
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error('Timed out while preparing the patch')
    }
    const { oldName, newName } = names(change)
    const diff = createTwoFilesPatch(
      oldName,
      newName,
      change.before ?? '',
      change.after ?? '',
      '',
      '',
      {
        context: 3,
        timeout: remaining,
      }
    )
    if (!diff) {
      throw new Error('Timed out while preparing the patch')
    }
    // Git needs an explicit mode change when adding or removing a zero-byte file.
    const header = 'diff --git a/' + change.path + ' b/' + change.path + '\n'
    const mode =
      change.before === null
        ? 'new file mode 100644\n'
        : change.after === null
          ? 'deleted file mode 100644\n'
          : ''
    return header + mode + (diff.includes('\n@@ ') ? diff.substring(diff.indexOf('--- ')) : '')
  })
  return {
    name: taskFileName(name, 'txt').replace(/\.txt$/, '.patch'),
    blob: new Blob(parts, { type: 'text/x-diff' }),
  }
}
