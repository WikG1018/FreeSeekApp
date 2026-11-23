declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

declare module '*.png' {
  const src: string
  export default src
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string
declare const __CURRENT_RELEASE_NOTES__: string
declare const __CURRENT_RELEASE_NOTES_EN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

declare module 'core-js/stable' {}
declare module 'abortcontroller-polyfill/dist/polyfill-patch-fetch' {}

interface Window {
  __FreeSeekNativeSplashDone?: boolean
  __FreeSeekStartup?: {
    mounted: () => void
    ready: (handoff?: (reveal: () => void) => void) => void
    fail: (phase: 'bootstrap' | 'render', error: unknown) => void
  }
}

declare module '*?agent-guest' {
  const source: string
  export default source
}

declare module '@jitl/quickjs-wasmfile-release-sync/wasm' {
  const url: string
  export default url
}
declare module '@jitl/quickjs-wasmfile-release-sync-legacy/wasm' {
  const url: string
  export default url
}
declare module 'pptx-browser' {
  export class PptxRenderer {
    slideCount: number
    slideSize: { cx: number; cy: number }
    load(
      source: ArrayBuffer,
      onProgress?: (progress: number, label: string) => void,
      options?: {
        files?: Record<string, Uint8Array>
        remoteFonts?: boolean
      }
    ): Promise<void>
    renderSlide(page: number, canvas: HTMLCanvasElement, width?: number): Promise<void>
    extractText(page: number): Promise<string>
    destroy(): void
  }
}
