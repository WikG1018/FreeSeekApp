// 旧浏览器才需要的重量级补丁：core-js 覆盖数百个标准 API，abortcontroller 改写 fetch。
// bootstrap 根据应用实际使用的 API 判断是否需要加载，支持这些能力的内核直接启动。
import 'core-js/stable'
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
