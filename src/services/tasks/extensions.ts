import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { publicWebUrl } from './publicWeb.js'

export type AgentSkill = { id: string; name: string; description: string; text: string }
export type McpTool = {
  name: string
  description: string
  schema?: Record<string, unknown>
}
export type McpConnection = {
  endpoint: string
  key: string
  tools: McpTool[]
  enabled: string[]
}
type Extensions = { skills: AgentSkill[]; skillId?: string; mcp?: McpConnection }
const STORAGE = 'freeseek:agent-extensions'

export const validMcpEndpoint = (address: string) => {
  const url = publicWebUrl(address.trim())
  return url?.protocol === 'https:' && !url.hash ? url.href : undefined
}

const stored = (): Extensions => {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Extensions>
    const skills = Array.isArray(data.skills)
      ? data.skills
          .filter(
            (item) =>
              typeof item?.id === 'string' &&
              typeof item.name === 'string' &&
              typeof item.description === 'string' &&
              typeof item.text === 'string' &&
              item.text.length <= 12_000
          )
          .slice(0, 30)
      : []
    const mcp = data.mcp
    return {
      skills,
      skillId: skills.some(({ id }) => id === data.skillId) ? data.skillId : undefined,
      mcp:
        mcp &&
        typeof mcp.endpoint === 'string' &&
        validMcpEndpoint(mcp.endpoint) &&
        typeof mcp.key === 'string' &&
        Array.isArray(mcp.tools) &&
        Array.isArray(mcp.enabled)
          ? mcp
          : undefined,
    }
  } catch {
    return { skills: [] }
  }
}

export const useAgentExtensions = create<Extensions>(stored)
export const saveAgentExtensions = (patch: Partial<Extensions>) => {
  const next = { ...useAgentExtensions.getState(), ...patch }
  try {
    localStorage.setItem(STORAGE, JSON.stringify(next))
    useAgentExtensions.setState(next)
    return true
  } catch {
    return false
  }
}

export const readAgentSkill = async (file: File): Promise<AgentSkill> => {
  if (file.size > 48 * 1024) {
    throw new Error('Skill too long')
  }
  const contents = (await file.text())
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(contents)
  const meta = (key: string) =>
    new RegExp('^' + key + ':[ \\t]*(.*)$', 'm')
      .exec(front?.[1] ?? '')?.[1]
      .trim()
      .replace(/^['"]|['"]$/g, '')
  const text = contents.slice(front?.[0].length ?? 0).trim()
  if (!text || text.length > 12_000 || text.includes('\0')) {
    throw new Error('Invalid skill')
  }
  const name = (meta('name') || file.name.replace(/\.md$/i, '')).slice(0, 60)
  return { id: createId(), name, description: (meta('description') || '').slice(0, 220), text }
}

export const selectedSkill = () => {
  const { skills, skillId } = useAgentExtensions.getState()
  return skills.find(({ id }) => id === skillId)
}

type ToolApproval = {
  id: string
  sessionId: string
  tool: string
  endpoint: string
  arguments: string
}
export const useToolApprovals = create<{ requests: ToolApproval[] }>(() => ({ requests: [] }))
const decisions = new Map<string, (allow: boolean) => void>()
export const chooseToolApproval = (id: string, allow: boolean) => decisions.get(id)?.(allow)

export const requestToolApproval = (
  sessionId: string,
  tool: string,
  endpoint: string,
  args: Record<string, unknown>,
  signal: AbortSignal
) => {
  signal.throwIfAborted()
  const id = createId()
  return new Promise<boolean>((resolve) => {
    const complete = (allow: boolean) => {
      decisions.delete(id)
      signal.removeEventListener('abort', abort)
      useToolApprovals.setState(({ requests }) => ({
        requests: requests.filter((item) => item.id !== id),
      }))
      resolve(allow)
    }
    const abort = () => complete(false)
    decisions.set(id, complete)
    signal.addEventListener('abort', abort, { once: true })
    const request = {
      id,
      sessionId,
      tool,
      endpoint: new URL(endpoint).host,
      arguments: JSON.stringify(args, null, 2),
    }
    useToolApprovals.setState(({ requests }) => ({ requests: [...requests, request] }))
  })
}
