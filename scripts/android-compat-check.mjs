// Run against an isolated emulator with the test-harness APK installed.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const serial = process.env.ANDROID_SERIAL
if (!serial?.startsWith('emulator-')) throw Error('Set ANDROID_SERIAL to an isolated test emulator')
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true })
const port = Number(process.env.FREESEEK_CDP_PORT || 9240),
  folder = process.env.FREESEEK_EVIDENCE_DIR || 'tmp/android-compat'
await mkdir(folder, { recursive: true })
const pid = adb('shell', 'pidof', 'app.freeseek.chat').trim()
adb('forward', 'tcp:' + port, 'localabstract:webview_devtools_remote_' + pid)
const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl),
  pending = new Map(),
  errors = []
let id = 0
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
ws.addEventListener('message', (event) => {
  const r = JSON.parse(event.data)
  if (r.id) {
    const t = pending.get(r.id)
    pending.delete(r.id)
    r.error ? t?.reject(Error(JSON.stringify(r.error))) : t?.resolve(r.result)
  } else if (r.method === 'Runtime.exceptionThrown') {
    errors.push(r.params.exceptionDetails)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    ws.send(JSON.stringify({ id: next, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const waitReady = async () => {
  for (let i = 0; i < 200; i++) {
    try {
      if (await evaluate(`!!(window.__audit&&window.__audit.store.useChatStore.getState().ready)`))
        return
    } catch (error) {
      if (!/context|Cannot find/i.test(String(error))) throw error
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Harness not ready')
}
try {
  await send('Runtime.enable')
  await send('Page.enable')
  await waitReady()
  const result = await evaluate(`(async function(){
 var a=window.__audit,f=a.fixtures;a.settings.setLocale('zh-CN');a.settings.setApiKey('sk-MATRIX_PRIVATE_CANARY_123');
 var file={id:'matrix-file',serverId:'file-api-test',name:'matrix.txt',size:8,mimeType:'text/plain',isImage:false};
 var session=f.session({title:'系统兼容验收',messages:[f.user('u','历史内容',{files:[file]}),f.assistant('a','历史回复')]});
 await a.seed([session],[{id:file.id,blob:new Blob(['ORIGINAL'],{type:'text/plain'})}]);var originalFetch=window.fetch;
 window.fetch=async function(url,init){return String(url).endsWith('/messages')?a.response('兼容对话成功'):originalFetch(url,init);};
 a.drafts.setDraftText(session.id,'继续');a.store.sendMessage(session.id);await a.waitIdle();
 var chatStatus=a.store.useChatStore.getState().sessionCache[session.id].messages.at(-1).status;
 var pack=await a.backup.exportHistory();await a.backup.importHistory(new File([pack.blob],pack.name));
 var original=await(await a.db.loadFile(file.id)).text();
 var broken=false;try{await a.backup.importHistory(new File(['bad'],'bad.zip'));}catch(error){broken=true;}
 var afterBroken=(await a.db.loadAllSessions()).length;
 var diagnostic=await a.diagnosticBundle.createDiagnosticBundle(),entries={},archive=new File([diagnostic.blob],diagnostic.name);
 for await(var entry of a.readArchive(archive)){entries[entry.path]=await(await a.readEntry(entry)).text();}
 var native=await Capacitor.nativePromise('Diagnostics','snapshot',{}),microphone=await Capacitor.nativePromise('MicPermission','check',{});
 var blob=new Blob(['x']);var uploadAborted=false;var controller=new AbortController();controller.abort();
 try{await a.client.uploadFile('fake',new File([blob],'a.txt'),'user_data',controller.signal);}catch(error){uploadAborted=error.name==='AbortError';}
 a.settings.setShowUsage(false);a.drafts.setDraftText(null,'重启恢复草稿');a.drafts.flushDraftTexts();
 a.settingsDialog.openSettings('home');
 return{sdk:native.environment.sdk,android:native.environment.androidVersion,webview:native.environment.webviewVersion,pageSize:native.environment.pageSizeBytes,
 chatStatus:chatStatus,original:original,brokenRejected:broken,afterBroken:afterBroken,zipEntries:Object.keys(entries).length,
 privacy:JSON.stringify(entries).indexOf('MATRIX_PRIVATE_CANARY')<0,microphone:Boolean(microphone.granted),uploadAborted:uploadAborted,backupBytes:pack.blob.size,diagnosticBytes:diagnostic.blob.size};
 }())`)
  assert.equal(result.chatStatus, 'done')
  assert.equal(result.original, 'ORIGINAL')
  assert.equal(result.brokenRejected, true)
  assert.equal(result.afterBroken, 1)
  assert.equal(result.zipEntries, 6)
  assert.equal(result.privacy, true)
  assert.equal(result.uploadAborted, true)
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 1000))
  await waitReady()
  const restored = await evaluate(
    `(async function(){for(var i=0;i<150;i++){if(window.__audit&&window.__audit.store.useChatStore.getState().ready)break;await new Promise(function(r){setTimeout(r,100);});}var a=window.__audit;return{draft:a.drafts.getDraft(null).text,showUsage:a.settings.useSettings.getState().showUsage,overflow:document.documentElement.scrollWidth>innerWidth+1,sessions:(await a.db.loadAllSessions()).length};}())`
  )
  assert.equal(restored.draft, '重启恢复草稿')
  assert.equal(restored.showUsage, false)
  assert.equal(restored.overflow, false)
  assert.equal(restored.sessions, 1)
  adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1')
  const point = await evaluate(
    `(function(){var r=document.querySelector('textarea').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth};}())`
  )
  adb('shell', 'uiautomator', 'dump', '/sdcard/freeseek-ui.xml')
  const tree = adb('shell', 'cat', '/sdcard/freeseek-ui.xml'),
    bounds = /class="android.webkit.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tree)
  if (!bounds) throw Error('WebView bounds missing')
  const scale = (Number(bounds[3]) - Number(bounds[1])) / point.width
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round(Number(bounds[1]) + point.x * scale)),
    String(Math.round(Number(bounds[2]) + point.y * scale))
  )
  await new Promise((r) => setTimeout(r, 600))
  adb('shell', 'input', 'text', 'keyboard-check')
  for (let i = 0; i < 30; i++) {
    if (await evaluate(`document.querySelector('textarea').value.indexOf('keyboard-check')>=0`))
      break
    await new Promise((r) => setTimeout(r, 100))
  }
  const keyboard = await evaluate(
    `(function(){var area=document.querySelector('textarea'),rect=area.getBoundingClientRect(),view=window.visualViewport;return{typed:area.value.indexOf('keyboard-check')>=0,visible:rect.bottom<=(view?view.height+view.offsetTop:innerHeight)+2};}())`
  )
  console.log(JSON.stringify({ point, bounds: bounds.slice(1), keyboard }))
  assert.equal(keyboard.typed, true)
  assert.equal(keyboard.visible, true)
  adb('shell', 'input', 'keyevent', '4')
  assert.deepEqual(errors, [])
  await writeFile(
    folder + '/api' + result.sdk + '.json',
    JSON.stringify({ ...result, restored, keyboard, uncaughtErrors: errors.length }, null, 2)
  )
  console.log(JSON.stringify({ ...result, restored }))
  adb('shell', 'screencap', '-p', '/sdcard/freeseek-compat.png')
  adb('pull', '/sdcard/freeseek-compat.png', folder + '/api' + result.sdk + '.png')
} finally {
  ws.close()
  adb('forward', '--remove', 'tcp:' + port)
}
