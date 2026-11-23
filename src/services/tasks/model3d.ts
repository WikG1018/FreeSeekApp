import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { taskFileMime, taskFileName } from './artifacts.js'
import { exportModelStl, inspectModel } from './modelInspection.js'

export const MODEL_LIMIT = 2 * 1024 * 1024
const vector = (value: unknown, limit: number): [number, number, number] => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((number) => typeof number === 'number' && Math.abs(number) <= limit)
  ) {
    throw new Error('Use three finite coordinates in a supported range.')
  }
  return [value[0], value[1], value[2]]
}

const customGeometry = (vertices: unknown, triangles: unknown) => {
  if (
    !Array.isArray(vertices) ||
    vertices.length < 3 ||
    vertices.length > 6_000 ||
    !Array.isArray(triangles) ||
    triangles.length < 1 ||
    triangles.length > 10_000
  ) {
    throw new Error('A mesh needs 3–6,000 vertices and 1–10,000 triangles.')
  }
  const coordinates = vertices.flatMap((vertex) => vector(vertex, 1_000_000))
  const indices = triangles.flatMap((triangle) => {
    const indices = vector(triangle, vertices.length - 1)
    if (
      !indices.every((number) => Number.isInteger(number) && number >= 0) ||
      new Set(indices).size !== 3
    ) {
      throw new Error('Triangle indices must point to three different vertices.')
    }
    return indices
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(coordinates, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export const makeModelFile = async (input: Record<string, unknown>, signal: AbortSignal) => {
  const format = input.format === 'stl' ? 'stl' : 'glb'
  const name = taskFileName(input.file_name, format)
  const scale = input.units === 'm' ? 1 : input.units === 'cm' ? 0.01 : 0.001
  if (
    !['mm', 'cm', 'm'].includes(String(input.units)) ||
    !Array.isArray(input.parts) ||
    !input.parts.length ||
    input.parts.length > 40
  ) {
    throw new Error('Choose mm, cm or m and provide 1–40 model parts.')
  }
  const model = new Group()
  // glTF specifies metres and a Y-up coordinate system.
  model.scale.setScalar(scale)
  let totalVertices = 0
  try {
    for (const part of input.parts) {
      signal.throwIfAborted()
      if (!part || typeof part !== 'object') {
        throw new Error('Give each part a shape and dimensions.')
      }
      const center = vector(part.center ?? [0, 0, 0], 1_000_000)
      const rotation = vector(part.rotation ?? [0, 0, 0], 3600)
      const color = part.color ?? '#5674b8'
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
        throw new Error('Use a hex color such as #5674b8.')
      }
      let geometry: BufferGeometry
      if (part.shape === 'mesh') {
        geometry = customGeometry(part.vertices, part.triangles)
      } else {
        const dimensions = vector(part.dimensions, 1_000_000)
        if (dimensions.some((size) => size <= 0)) {
          throw new Error('Each dimension must be greater than zero.')
        }
        if (part.shape === 'box') {
          geometry = new BoxGeometry(1, 1, 1)
        } else if (part.shape === 'cylinder') {
          geometry = new CylinderGeometry(0.5, 0.5, 1, 32)
        } else if (part.shape === 'sphere') {
          geometry = new SphereGeometry(0.5, 24, 16)
        } else {
          throw new Error('Choose box, cylinder, sphere or mesh.')
        }
        geometry.scale(...dimensions)
      }
      const mesh = new Mesh(geometry, new MeshStandardMaterial({ color, roughness: 0.75 }))
      mesh.name = typeof part.name === 'string' ? part.name.trim().slice(0, 80) : ''
      mesh.position.set(...center)
      const radians = Math.PI / 180
      mesh.rotation.set(rotation[0] * radians, rotation[1] * radians, rotation[2] * radians)
      model.add(mesh)
      totalVertices += geometry.getAttribute('position').count
      if (totalVertices > 40_000) {
        throw new Error('Simplify the scene to at most 40,000 vertices.')
      }
    }
    const buffer =
      format === 'glb' ? await new GLTFExporter().parseAsync(model, { binary: true }) : undefined
    const blob =
      format === 'stl'
        ? exportModelStl(model)
        : buffer instanceof ArrayBuffer
          ? new Blob([buffer], { type: taskFileMime.glb })
          : undefined
    signal.throwIfAborted()
    if (!blob || blob.size > MODEL_LIMIT) {
      throw new Error('The model exceeds 2 MiB. Simplify the model and try again.')
    }
    return {
      name,
      blob,
      parts: model.children.length,
      vertices: totalVertices,
      sizeMm: inspectModel(model).size,
    }
  } finally {
    for (const mesh of model.children as Mesh<BufferGeometry, MeshStandardMaterial>[]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
}
