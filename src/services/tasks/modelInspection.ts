import { Box3, Mesh, Vector3, type Object3D } from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'

export type Millimetres = [number, number, number]
type Part = { name: string; size: Millimetres }

export const modelMeshes = (root: Object3D) => {
  const meshes: Mesh[] = []
  root.traverse((item) => {
    if ((item as Mesh).isMesh) {
      meshes.push(item as Mesh)
    }
  })
  return meshes
}

const mm = (size: Vector3): Millimetres => [size.x * 1000, size.y * 1000, size.z * 1000]

export const inspectModel = (root: Object3D) => {
  root.updateMatrixWorld(true)
  return {
    size: mm(new Box3().setFromObject(root, true).getSize(new Vector3())),
    parts: modelMeshes(root).map((mesh): Part => {
      mesh.geometry.computeBoundingBox()
      const size = mesh.geometry.boundingBox?.getSize(new Vector3()) ?? new Vector3()
      size.multiply(mesh.getWorldScale(new Vector3()))
      return { name: mesh.name, size: mm(size) }
    }),
  }
}

export const resizeModelPart = (root: Object3D, index: number, dimensions: Millimetres) => {
  const before = inspectModel(root).parts[index]
  if (
    !before ||
    before.size.some((value) => value <= 0 || !Number.isFinite(value)) ||
    dimensions.some((value) => !Number.isFinite(value) || value <= 0 || value > 1e9)
  ) {
    throw new Error('Part dimensions are unavailable or invalid')
  }
  const updated = root.clone(true)
  const part = modelMeshes(updated)[index]
  part.scale.multiply(
    new Vector3(
      dimensions[0] / before.size[0],
      dimensions[1] / before.size[1],
      dimensions[2] / before.size[2]
    )
  )
  return updated
}

export const exportModelStl = (root: Object3D) => {
  const scene = root.clone(true)
  scene.position.multiplyScalar(1000)
  scene.scale.multiplyScalar(1000)
  scene.updateMatrixWorld(true)
  const stl = new STLExporter().parse(scene, { binary: true })
  return new Blob(
    [new Uint8Array(stl.buffer, stl.byteOffset, stl.byteLength) as Uint8Array<ArrayBuffer>],
    {
      type: 'model/stl',
    }
  )
}

export const checkModelMesh = (root: Object3D) => {
  let open = 0,
    nonManifold = 0,
    degenerate = 0
  for (const mesh of modelMeshes(root)) {
    const position = mesh.geometry.getAttribute('position')
    const indexed = mesh.geometry.index
    if (!position) {
      continue
    }
    const vertices: string[] = []
    for (let index = 0; index < position.count; index++) {
      vertices.push(
        [position.getX(index), position.getY(index), position.getZ(index)]
          .map((value) => Math.round(value * 1_000_000))
          .join(',')
      )
    }
    const edges = new Map<string, number>()
    for (let index = 0; index + 2 < (indexed?.count ?? position.count); index += 3) {
      const a = vertices[indexed?.getX(index) ?? index]
      const b = vertices[indexed?.getX(index + 1) ?? index + 1]
      const c = vertices[indexed?.getX(index + 2) ?? index + 2]
      if (a === b || b === c || c === a) {
        degenerate++
        continue
      }
      for (const [left, right] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = left < right ? left + ':' + right : right + ':' + left
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    }
    for (const faces of edges.values()) {
      open += Number(faces === 1)
      nonManifold += Number(faces > 2)
    }
  }
  return { open, nonManifold, degenerate }
}
