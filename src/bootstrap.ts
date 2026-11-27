import './compatibility.js'

// 启动过程分阶段上报：界面守卫的 10 秒超时只能说明「卡住了」，说不出卡在哪一步。
// 每一步都记一笔，下次导出诊断就能直接看到停在下载、求值还是挂载。
const step = (name: string) => {
  try {
    window.__FreeSeekStartup?.step(name)
  } catch {
    /* 守卫不存在时忽略：只是诊断信息。 */
  }
}

step('bundle')

/** 按应用的实际依赖判断。部分 WebView 支持启动所用的 API，但缺少聊天和导入用的数组方法。 */
const modernRuntime = () => {
  try {
    return (
      typeof Promise.allSettled === 'function' &&
      typeof Promise.any === 'function' &&
      typeof String.prototype.replaceAll === 'function' &&
      typeof String.prototype.matchAll === 'function' &&
      typeof Array.prototype.at === 'function' &&
      typeof Array.prototype.flat === 'function' &&
      typeof Array.prototype.flatMap === 'function' &&
      typeof Array.prototype.findLast === 'function' &&
      typeof Array.prototype.toReversed === 'function' &&
      typeof Array.prototype.toSorted === 'function' &&
      typeof Object.hasOwn === 'function' &&
      typeof Object.fromEntries === 'function' &&
      typeof queueMicrotask === 'function' &&
      typeof structuredClone === 'function'
    )
  } catch {
    return false
  }
}

const needsPolyfills = !modernRuntime()
step(needsPolyfills ? 'polyfills:load' : 'polyfills:skip')

// 延迟加载应用，静态页面和启动守卫先就绪，模块加载或初始化失败也能报告与导出诊断。
const polyfills = needsPolyfills
  ? import(/* webpackChunkName: 'polyfills' */ './polyfills.js')
  : Promise.resolve()

void polyfills
  .then(() => {
    step('app:importing')
    return import(/* webpackChunkName: 'app' */ './main.js')
  })
  .then(() => step('app:loaded'))
  .catch((error) => {
    window.__FreeSeekStartup?.fail('bootstrap', error)
  })
