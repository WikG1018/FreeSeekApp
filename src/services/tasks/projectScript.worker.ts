import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core'
import { loadQuickJS } from './quickJS.js'
import type { SourceProject } from './projectFiles.js'

const bootstrap = `
(() => {
  let output = '';
  let model = '';
  let assertions = 0;
  const log = (...values) => {
    const parts = values.map(value => {
      try { return typeof value === 'string' ? value : JSON.stringify(value); }
      catch { return String(value); }
    });
    output = (output + parts.join(' ') + '\\n').slice(0, 8000);
  };
  globalThis.console = { log, warn: log, error: log, info: log, assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
    assertions++;
  }};
  Object.defineProperty(globalThis, '__projectOutput', { value: () => output });
  Object.defineProperty(globalThis, '__projectAssertions', { value: () => assertions });
  Object.defineProperty(globalThis, 'emitModel', { value: scene => {
    const json = JSON.stringify(scene);
    if (typeof json !== 'string' || json.length > 500000) {
      throw new Error('The scene is too large to export.');
    }
    model = json;
  }});
  Object.defineProperty(globalThis, '__projectModel', { value: () => model });
})();
`

const describeError = (context: QuickJSContext, error: QuickJSHandle) =>
  error.consume((handle) => {
    if (context.typeof(handle) !== 'object') {
      return context.getString(handle).slice(0, 2_000)
    }
    const message = context.getProp(handle, 'message').consume((value) => context.getString(value))
    const stack = context.getProp(handle, 'stack').consume((value) => context.getString(value))
    return (message + '\n' + stack).trim().slice(0, 2_000)
  })

const execute = async (files: SourceProject, entry: string, captureModel: boolean) => {
  const vm = await loadQuickJS()
  const runtime = vm.newRuntime({
    memoryLimitBytes: 24 * 1024 * 1024,
    maxStackSizeBytes: 256 * 1024,
  })
  const deadline = Date.now() + 1_800
  runtime.setInterruptHandler(() => Date.now() >= deadline)
  const sources = new Map(files.map(({ path, text }) => [path, text]))
  runtime.setModuleLoader(
    (name) => sources.get(name) ?? { error: new Error('Project module not found: ' + name) },
    (base, name) => {
      if ((!name.startsWith('./') && !name.startsWith('../')) || /[\\\\?#%]/.test(name)) {
        return { error: new Error('Use relative imports between project files.') }
      }
      const path = decodeURIComponent(
        new URL(name, 'https://project.invalid/' + base).pathname.slice(1)
      )
      return /\.(?:m?js)$/i.test(path) && sources.has(path)
        ? path
        : { error: new Error('Project module not found: ' + name) }
    }
  )
  const context = runtime.newContext()
  try {
    context.unwrapResult(context.evalCode(bootstrap, 'console.js')).dispose()
    const result = context.evalCode(sources.get(entry) ?? '', entry, { type: 'module' })
    let error: string | undefined
    if (result.error) {
      error = describeError(context, result.error)
    } else {
      result.value.consume((value) => {
        const jobs = runtime.executePendingJobs(128)
        if (jobs.error) {
          error = describeError(context, jobs.error)
        } else {
          const state = context.getPromiseState(value)
          if (state.type === 'rejected') {
            error = describeError(context, state.error)
          } else if (state.type === 'pending') {
            error = 'The script is waiting for a promise that did not finish.'
          } else if (!state.notAPromise) {
            state.value.dispose()
          }
        }
      })
    }
    if (Date.now() >= deadline) {
      return {
        success: false,
        reason: 'project-timeout' as const,
        text: 'The script ran out of execution time.',
      }
    }
    const read = context.evalCode('__projectOutput()', 'console.js')
    let log = ''
    if (read.error) {
      read.error.dispose()
    } else {
      log = read.value.consume((value) => context.getString(value))
    }
    let model: string | undefined
    if (captureModel && error === undefined) {
      const scene = context.evalCode('__projectModel()', 'console.js')
      if (scene.error) {
        scene.error.dispose()
      } else {
        model = scene.value.consume((value) => context.getString(value)) || undefined
      }
    }
    const checks = context.evalCode('__projectAssertions()', 'console.js')
    let assertions = 0
    if (checks.error) {
      checks.error.dispose()
    } else {
      assertions = checks.value.consume((value) => context.getNumber(value))
    }
    return {
      success: error === undefined,
      assertions: error === undefined ? assertions : 0,
      reason: error === undefined ? undefined : ('project-script-error' as const),
      text: [log.trimEnd(), error].filter(Boolean).join('\n'),
      model,
    }
  } finally {
    context.dispose()
    runtime.dispose()
  }
}

self.onmessage = ({
  data,
}: MessageEvent<{ files: SourceProject; entry: string; captureModel: boolean }>) => {
  void execute(data.files, data.entry, data.captureModel).then(
    (result) => self.postMessage(result),
    () =>
      self.postMessage({
        success: false,
        reason: 'project-runtime-unavailable',
        text: 'The local JavaScript runtime could not start.',
      })
  )
}
