import { recordSchema } from './toolSchema.js'
import { readPosition } from './readerRange.js'

const string = { type: 'string' }
const integer = { type: 'integer', minimum: 1 }
const vector = {
  type: 'array',
  minItems: 3,
  maxItems: 3,
  items: { type: 'number' },
}

export const inspectProject = {
  name: 'inspect_project',
  description:
    'List files in the current project, optionally under a folder, find text across the project, or read part of one file. Use before editing. Follow next_offset to continue listing or reading.',
  parameters: recordSchema({ path: string, folder: string, ...readPosition }, []),
}
export const importProject = {
  name: 'import_project',
  description:
    'Use a text-only ZIP explicitly attached or referenced in the task inventory as the conversation’s project. The original archive is preserved.',
  parameters: recordSchema({ file: integer }, ['file']),
}
export const applyProjectPatch = {
  name: 'apply_project_patch',
  description:
    'Apply an atomic patch to this chat’s local project and save it across turns. Use relative paths. Patch syntax: *** Begin Patch, *** Add File: path with + lines, *** Update File: path with @@ then context/ - / + lines, or *** Delete File: path, then *** End Patch.',
  parameters: recordSchema({ patch: string }, ['patch']),
}
export const runProject = {
  name: 'run_project_script',
  description:
    'Run a saved .js or .mjs file in the device’s isolated JavaScript runtime. Supports relative JS imports, console.log and console.assert. No shell, external packages, network or device files. Use this to check the program and fix failures before delivery.',
  parameters: recordSchema({ path: string }, ['path']),
}
export const exportProject = {
  name: 'export_project',
  description: 'Publish the current multi-file source project as a downloadable ZIP.',
  parameters: recordSchema({ file_name: string }, ['file_name']),
}
export const createModel = {
  name: 'create_3d_model',
  description:
    'Build a downloadable GLB or binary STL model. GLB preserves assemblies and colors. STL uses millimetres and carries triangles only. Coordinates and dimensions use the supplied units with Y up. Mesh parts use vertices and zero-based triangles.',
  parameters: recordSchema(
    {
      file_name: string,
      format: { type: 'string', enum: ['glb', 'stl'] },
      from_script: {
        ...string,
        description:
          'Instead of units and parts, run this saved JavaScript project file. It must call emitModel({ units, parts }) with the same 3D scene fields.',
      },
      units: { type: 'string', enum: ['mm', 'cm', 'm'] },
      parts: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: recordSchema(
          {
            shape: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'mesh'] },
            name: string,
            dimensions: vector,
            center: vector,
            rotation: { ...vector, description: 'Rotation around X, Y, Z in degrees.' },
            color: { ...string, description: 'A six-digit hex color such as #5674b8.' },
            vertices: { type: 'array', maxItems: 6000, items: vector },
            triangles: { type: 'array', maxItems: 10000, items: vector },
          },
          ['shape']
        ),
      },
    },
    ['file_name']
  ),
}

export const projectTools = [
  inspectProject,
  importProject,
  applyProjectPatch,
  runProject,
  exportProject,
]
export const runTaskReview = {
  name: 'run_task_review',
  description:
    'Ask a separate review worker to research admitted sources, review project files, or check an existing result. Use only when independent review improves the task. The worker gives a report; the main Agent makes changes.',
  parameters: recordSchema(
    {
      role: { type: 'string', enum: ['research', 'code-review', 'verification'] },
      question: string,
      paths: { type: 'array', maxItems: 6, items: string },
    },
    ['role', 'question']
  ),
}
export const callMcpTool = {
  name: 'call_mcp_tool',
  description: 'Invoke an external MCP tool chosen by the user. Send only the arguments needed.',
  parameters: recordSchema({ name: string, arguments: { type: 'object' } }, ['name', 'arguments']),
}
export const foregroundTools = new Set(
  [...projectTools, createModel, runTaskReview, callMcpTool].map(({ name }) => name)
)
