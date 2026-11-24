import { validateProviderUrl, type ProviderProfile } from '../providers.js'
import type { RoleVoiceSettings } from '../settings.js'
import type { MiMoSpeechProfile } from '../api/speech.js'

const usesMiMoHost = (profile: ProviderProfile) => {
  try {
    const host = new URL(profile.url).hostname
    return host === 'xiaomimimo.com' || host.endsWith('.xiaomimimo.com')
  } catch {
    return false
  }
}

export const reusableVoiceProfiles = (profiles: ReadonlyArray<ProviderProfile>) =>
  profiles.filter((profile) => profile.apiKey.trim() && profile.url && (
    profile.preset?.id === 'xiaomimimo' || usesMiMoHost(profile)
  ) && (profile.protocol === 'openai' || profile.protocol === 'responses'))

/**
 * 角色配音用哪套 TTS 配置。
 *
 * - source=follow：用已配置的供应商里的 MiMo（同一个 Key 能聊天也能朗读）
 * - source=custom：用设置里单独填写的语音服务，适用于只提供 TTS 的服务或想分开计费
 *
 * 找不到可用配置时返回 null，界面据此提示去配置。
 */
export const roleVoiceProfile = (
  profiles: ReadonlyArray<ProviderProfile>,
  roleVoice: Pick<RoleVoiceSettings, 'source' | 'providerId' | 'custom'>
): MiMoSpeechProfile | null => {
  if (roleVoice.source === 'custom') {
    const { url, apiKey, model, designModel } = roleVoice.custom
    if (!url.trim() || !apiKey.trim()) {
      return null
    }
    // 单独配置的语音服务不落进供应商列表：每次按需合成一个临时 profile
    try {
      validateProviderUrl(url)
    } catch {
      return null
    }
    return {
      id: 'role-voice-custom',
      revision: 'role-voice-custom',
      name: 'Role voice',
      url: url.trim(),
      apiKey: apiKey.trim(),
      protocol: 'openai',
      model: model.trim() || 'mimo-v2.5-tts',
      speechModel: model.trim() || undefined,
      speechDesignModel: designModel?.trim(),
      models: [],
      modelListUrl: '',
      headers: {},
      extraBody: {},
    }
  }
  const usable = reusableVoiceProfiles(profiles)
  if (roleVoice.providerId) {
    return usable.find((profile) => profile.id === roleVoice.providerId) ?? null
  }
  return (
    usable.find((profile) => profile.preset?.id === 'xiaomimimo') ??
    usable.find(usesMiMoHost) ??
    null
  )
}
