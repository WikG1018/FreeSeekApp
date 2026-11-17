import './compatibility.js'

// 延迟加载应用，静态页面和启动守卫先就绪，模块加载或初始化失败也能报告与导出诊断。
void import('./main.js').catch((error) => {
  window.__FreeSeekStartup?.fail('bootstrap', error)
})
