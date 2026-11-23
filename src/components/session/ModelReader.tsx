import { useEffect, useRef, useState } from 'react'
import {
  Box3,
  BufferGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoadingManager,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { saveBackup } from '../../services/saveBackup.js'
import { taskFileName } from '../../services/tasks/artifacts.js'
import {
  checkModelMesh,
  exportModelStl,
  inspectModel,
  resizeModelPart,
  type Millimetres,
} from '../../services/tasks/modelInspection.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { makeModelCanvas } from './ModelCanvas.js'
import styles from './ArtifactReader.module.css'

const validateModel = (buffer: ArrayBuffer) => {
  if (buffer.byteLength < 24 || buffer.byteLength > 2 * 1024 * 1024) {
    throw new Error('Model is outside the preview size limit')
  }
  const view = new DataView(buffer)
  const size = view.getUint32(12, true)
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    size > 160_000 ||
    size + 28 > buffer.byteLength
  ) {
    throw new Error('Invalid GLB header')
  }
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, size)))
  if (
    !model ||
    model.buffers?.length !== 1 ||
    model.buffers[0].uri !== undefined ||
    model.extensionsUsed?.length ||
    model.images?.length ||
    model.skins?.length ||
    model.animations?.length ||
    model.textures?.length ||
    !Array.isArray(model.nodes) ||
    model.nodes.length > 64 ||
    !Array.isArray(model.meshes) ||
    model.meshes.length > 40 ||
    !Array.isArray(model.accessors) ||
    model.accessors.length > 300 ||
    model.accessors.some(
      (entry: { count: number; sparse?: unknown }) =>
        entry.sparse ||
        !Number.isSafeInteger(entry.count) ||
        entry.count < 1 ||
        entry.count > 90_000
    )
  ) {
    throw new Error('This preview uses self-contained meshes')
  }
  const children = new Set<number>()
  for (const [index, node] of model.nodes.entries()) {
    // The exporter writes children first. This also rules out loops in imported files.
    for (const child of node.children ?? []) {
      if (!Number.isInteger(child) || child < 0 || child >= index || children.has(child)) {
        throw new Error('Invalid model hierarchy')
      }
      children.add(child)
    }
  }
  if (
    !Array.isArray(model.scenes) ||
    model.scenes.length !== 1 ||
    !Array.isArray(model.scenes[0].nodes) ||
    model.scenes[0].nodes.length > model.nodes.length ||
    model.scenes[0].nodes.some(
      (index: number) =>
        !Number.isInteger(index) || index < 0 || index >= model.nodes.length || children.has(index)
    ) ||
    new Set(model.scenes[0].nodes).size !== model.scenes[0].nodes.length
  ) {
    throw new Error('Invalid model scene')
  }
}

const releaseMeshes = (object: Object3D) =>
  object.traverse((item) => {
    const mesh = item as Mesh<BufferGeometry, Material | Material[]>
    if (mesh.isMesh) {
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.dispose()
      }
    }
  })

const legacyChromium = () => {
  const version = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1]
  return version !== undefined && Number(version) < 85
}

const readStl = (buffer: ArrayBuffer) => {
  if (
    buffer.byteLength < 84 ||
    buffer.byteLength > 2 * 1024 * 1024 ||
    84 + 50 * new DataView(buffer).getUint32(80, true) !== buffer.byteLength
  ) {
    throw new Error('Invalid binary STL')
  }
  const mesh = new Mesh(
    new STLLoader().parse(buffer),
    new MeshStandardMaterial({ color: '#8299bd' })
  )
  const root = new Group()
  root.add(mesh)
  root.scale.setScalar(0.001)
  return root
}

const formatSize = (size: readonly number[]) =>
  size.map((value) => Number(value.toFixed(2))).join(' × ')
export const ModelReader = ({
  buffer,
  format,
  fileName,
}: {
  buffer: ArrayBuffer
  format: 'glb' | 'stl'
  fileName: string
}) => {
  const t = useTranslate()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const resetRef = useRef<() => void>()
  const modelRef = useRef<Object3D>()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [activeBuffer, setActiveBuffer] = useState(buffer)
  const [dimensionsOpen, setDimensionsOpen] = useState(false)
  const [inspection, setInspection] = useState<ReturnType<typeof inspectModel>>()
  const [selected, setSelected] = useState(0)
  const [dimensions, setDimensions] = useState<string[]>([])
  const [meshStatus, setMeshStatus] = useState<ReturnType<typeof checkModelMesh>>()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<TranslationKey>()
  const edited = activeBuffer !== buffer

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) {
      return
    }
    setState('loading')
    let closed = false
    let disposeView: (() => void) | undefined
    const manager = new LoadingManager()
    manager.setURLModifier(() => {
      throw new Error('External model resources are unavailable')
    })
    const render = async () => {
      let source: Object3D
      if (format === 'stl' && !edited) {
        source = readStl(activeBuffer)
      } else {
        validateModel(activeBuffer)
        source = (await new GLTFLoader(manager).parseAsync(activeBuffer, '')).scene
      }
      if (closed) {
        releaseMeshes(source)
        return
      }
      const data = inspectModel(source)
      modelRef.current = source
      setInspection(data)
      setMeshStatus(undefined)
      const model = source.clone(true)
      disposeView = () => releaseMeshes(model)
      const bounds = new Box3().setFromObject(model)
      const pivot = bounds.getCenter(new Vector3())
      const longest = bounds.getSize(new Vector3()).length()
      if (longest <= 0 || !Number.isFinite(longest)) {
        throw new Error('Model has no finite bounds')
      }
      model.scale.multiplyScalar(2 / longest)
      model.position.sub(pivot.multiplyScalar(2 / longest))
      const scene = new Scene()
      scene.add(model)
      scene.add(new HemisphereLight(0xdbe7ff, 0x646167, 2.8))
      const key = new DirectionalLight(0xfff6ea, 2.3)
      key.position.set(3, 5, 4)
      scene.add(key)
      const camera = new PerspectiveCamera(37, 1, 0.05, 40)
      const angle = new Vector3(2.5, 1.65, 3.05).normalize()
      camera.position.copy(angle).multiplyScalar(3.75)
      const software = legacyChromium() ? makeModelCanvas(canvas, model) : undefined
      const renderer = software
        ? undefined
        : new WebGLRenderer({ canvas, alpha: true, antialias: true })
      renderer?.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7))
      const controls = new OrbitControls(camera, canvas)
      controls.minDistance = 1.15
      controls.maxDistance = 10
      controls.zoomSpeed = 0.8
      controls.update()
      let frame = 0
      let rendered = false
      const draw = () => {
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0
            try {
              if (software) {
                software.render(camera)
              } else {
                renderer?.render(scene, camera)
              }
              if (!rendered) {
                rendered = true
                setState('ready')
              }
            } catch {
              disposeView?.()
              disposeView = undefined
              setState('error')
            }
          })
        }
      }
      let fitted = false
      const resize = () => {
        const { clientWidth, clientHeight } = stage
        if (clientWidth && clientHeight) {
          camera.aspect = clientWidth / clientHeight
          if (!fitted) {
            const viewAngle = Math.atan(
              Math.tan((Math.PI * camera.fov) / 360) * Math.min(1, camera.aspect)
            )
            camera.position.copy(angle).multiplyScalar(1.08 / Math.sin(viewAngle))
            controls.maxDistance = Math.max(8, camera.position.length() * 2)
            controls.update()
            controls.saveState()
            fitted = true
          }
          camera.updateProjectionMatrix()
          software?.resize(clientWidth, clientHeight)
          renderer?.setSize(clientWidth, clientHeight, false)
          draw()
        }
      }
      const observer = new ResizeObserver(resize)
      controls.addEventListener('change', draw)
      observer.observe(stage)
      const lost = () => setState('error')
      canvas.addEventListener('webglcontextlost', lost)
      resetRef.current = () => controls.reset()
      disposeView = () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        canvas.removeEventListener('webglcontextlost', lost)
        controls.dispose()
        releaseMeshes(model)
        renderer?.dispose()
      }
      resize()
    }
    void render().catch(() => {
      if (!closed) {
        disposeView?.()
        disposeView = undefined
        setState('error')
      }
    })
    return () => {
      closed = true
      resetRef.current = undefined
      disposeView?.()
    }
  }, [activeBuffer, edited, format])

  useEffect(() => {
    const part = inspection?.parts[selected]
    setDimensions(part?.size.map((value) => String(Number(value.toFixed(4)))) ?? [])
  }, [inspection, selected])

  const convert = async (action: () => Promise<void>) => {
    if (saving) {
      return
    }
    setSaving(true)
    setNotice(undefined)
    try {
      await action()
    } catch {
      setNotice('modelOperationFailed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.reader}>
      <div className={styles.modelStage} ref={stageRef} data-preview-state={state}>
        <canvas ref={canvasRef} role="img" aria-label={t('agentModelPreview')} />
        {state !== 'ready' && (
          <p role="status">
            {t(state === 'error' ? 'agentModelPreviewFailed' : 'taskFileLoading')}
          </p>
        )}
      </div>
      {state === 'ready' && (
        <div className={styles.modelActions}>
          <span>{t('agentModelGestures')}</span>
          <Button
            variant="outlined"
            size="s"
            onClick={() => setDimensionsOpen(!dimensionsOpen)}
            aria-expanded={dimensionsOpen}
          >
            {t('modelDimensions')}
          </Button>
          <Button variant="outlined" size="s" onClick={() => resetRef.current?.()}>
            {t('agentModelReset')}
          </Button>
        </div>
      )}
      {dimensionsOpen && inspection && state === 'ready' && (
        <section className={styles.modelDetails} aria-label={t('modelDimensions')}>
          <p>
            {t('modelOverall')} <strong>{formatSize(inspection.size)} mm</strong>
          </p>
          {inspection.parts.length > 0 && (
            <>
              <Select
                pill
                value={String(selected)}
                ariaLabel={t('modelSelectPart')}
                options={inspection.parts.map((part, index) => ({
                  value: String(index),
                  label: part.name.trim() || t('modelPart', { number: index + 1 }),
                }))}
                onChange={(value) => setSelected(Number(value))}
              />
              {dimensions.length === 3 && (
                <div className={styles.modelFields}>
                  {dimensions.map((value, index) => (
                    <label key={index}>
                      <span>{['X', 'Y', 'Z'][index]} mm</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={value}
                        onChange={(event) =>
                          setDimensions(
                            dimensions.map((previous, item) =>
                              item === index ? event.target.value : previous
                            )
                          )
                        }
                      />
                    </label>
                  ))}
                  <Button
                    variant="outlined"
                    size="s"
                    disabled={saving}
                    onClick={() =>
                      void convert(async () => {
                        if (!modelRef.current) {
                          return
                        }
                        const updated = resizeModelPart(
                          modelRef.current,
                          selected,
                          dimensions.map(Number) as Millimetres
                        )
                        const revised = await new GLTFExporter().parseAsync(updated, {
                          binary: true,
                        })
                        if (
                          !(revised instanceof ArrayBuffer) ||
                          revised.byteLength > 2 * 1024 * 1024
                        ) {
                          throw new Error('Revised model exceeds the file limit')
                        }
                        setActiveBuffer(revised)
                        setNotice('modelChanged')
                      })
                    }
                  >
                    {t('modelResize')}
                  </Button>
                </div>
              )}
            </>
          )}
          <div className={styles.modelActions}>
            <Button
              variant="outlined"
              size="s"
              disabled={saving}
              onClick={() => modelRef.current && setMeshStatus(checkModelMesh(modelRef.current))}
            >
              {t('modelCheckMesh')}
            </Button>
            <Button
              variant="outlined"
              size="s"
              disabled={saving}
              onClick={() =>
                void convert(async () => {
                  if (!modelRef.current) {
                    return
                  }
                  const blob = exportModelStl(modelRef.current)
                  if (await saveBackup(taskFileName(fileName, 'stl'), blob, 'chat')) {
                    setNotice('projectSaved')
                  }
                })
              }
            >
              {t('modelExportStl')}
            </Button>
            {edited && (
              <Button
                variant="outlined"
                size="s"
                disabled={saving}
                onClick={() =>
                  void convert(async () => {
                    const name = taskFileName(fileName.replace(/\.(glb|stl)$/i, '') + '-v2', 'glb')
                    if (
                      await saveBackup(
                        name,
                        new Blob([activeBuffer], { type: 'model/gltf-binary' }),
                        'chat'
                      )
                    ) {
                      setNotice('projectSaved')
                    }
                  })
                }
              >
                {t('modelSaveVariant')}
              </Button>
            )}
          </div>
          {meshStatus && <p role="status">{t('modelMeshReport', meshStatus)}</p>}
          {notice && <p role="status">{t(notice)}</p>}
        </section>
      )}
    </div>
  )
}
