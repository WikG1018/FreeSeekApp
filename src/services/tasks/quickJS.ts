import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm'
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core'

const instantiate = (variant: unknown, wasmLocation: string) =>
  newQuickJSWASMModuleFromVariant(
    newVariant(variant as Extract<Parameters<typeof newVariant>[0], { type: 'sync' }>, {
      wasmLocation,
    })
  )

export const loadQuickJS = async () => {
  // The empty DataCount section identifies bulk-memory support. WebView 74 needs
  // the compatible WASM built before QuickJS switched to Emscripten 5.
  const bulkMemory = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 12, 1, 0)
  if (WebAssembly.validate(bulkMemory)) {
    return instantiate(RELEASE_SYNC, wasmUrl)
  }
  const [{ default: legacy }, { default: legacyWasm }] = await Promise.all([
    import('@jitl/quickjs-wasmfile-release-sync-legacy'),
    import('@jitl/quickjs-wasmfile-release-sync-legacy/wasm'),
  ])
  return instantiate(legacy, legacyWasm)
}
