import { createModel, exportProject, importProject, projectTools } from './creatorTools.js'

export const defaultAgentTools = {
  search: true,
  web: true,
  github: true,
  attachment: true,
  table: true,
  output: true,
  code: true,
  model3d: true,
  review: true,
}

export type AgentTool = keyof typeof defaultAgentTools
export type AgentToolPolicy = Record<AgentTool, boolean>

const ordered: AgentTool[] = [
  'search',
  'web',
  'github',
  'attachment',
  'table',
  'output',
  'code',
  'model3d',
  'review',
]

export const agentToolMask = (policy: AgentToolPolicy) =>
  ordered.reduce((mask, name, index) => mask + (policy[name] ? 1 << index : 0), 0)

export const agentToolAllowed = (policy: AgentToolPolicy, name: string) => {
  if (name === createModel.name) {
    return policy.model3d && policy.output
  }
  if (projectTools.some((tool) => tool.name === name)) {
    return (
      policy.code &&
      (name !== importProject.name || policy.attachment) &&
      (name !== exportProject.name || policy.output)
    )
  }
  if (name.startsWith('browser_') || name === 'read_web_page') {
    return policy.web
  }
  if (name === 'browse_github_repository') {
    return policy.github
  }
  if (name === 'read_selected_attachment' || name === 'list_task_files') {
    return policy.attachment
  }
  if (name === 'calculate' || name === 'analyze_table') {
    return policy.table && (name === 'calculate' || policy.attachment)
  }
  if (name.startsWith('create_')) {
    return policy.output
  }
  return true
}
