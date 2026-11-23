// 旧浏览器才需要的重量级补丁：core-js 覆盖数百个标准 API，abortcontroller 改写 fetch。
// 现代内核（iOS 15+、Chrome 90+）原生就有这些能力，加载它们纯属浪费首屏带宽——
// 国内直连慢时，多下载几十 KB 就可能让启动超出等待时间。由 bootstrap 按能力判断后再引入。
import 'core-js/stable'
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
