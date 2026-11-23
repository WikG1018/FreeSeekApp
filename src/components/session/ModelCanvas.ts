import { Color, Vector3, type Mesh, type Object3D, type PerspectiveCamera } from 'three'

type Triangle = {
  vertices: [number, number, number]
  color: number
}

/** Render the same mesh without using legacy Android's synchronous WebGL compositor. */
export const makeModelCanvas = (canvas: HTMLCanvasElement, model: Object3D) => {
  const surface = canvas.getContext('2d')
  if (!surface) {
    throw new Error('Canvas is unavailable')
  }
  const positions: Vector3[] = []
  const faces: Triangle[] = []
  const lamp = new Vector3(0.5, 0.85, 0.7).normalize()
  const normal = new Vector3()
  const side = new Vector3()
  model.updateMatrixWorld(true)
  model.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) {
      return
    }
    const attribute = mesh.geometry.getAttribute('position')
    const index = mesh.geometry.getIndex()
    const count = index?.count ?? attribute.count
    if (faces.length + count / 3 > 18_000) {
      throw new Error('The mesh is too large for this preview renderer')
    }
    const offset = positions.length
    for (let vertex = 0; vertex < attribute.count; vertex++) {
      positions.push(
        new Vector3().fromBufferAttribute(attribute, vertex).applyMatrix4(mesh.matrixWorld)
      )
    }
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color =
      'color' in material && material.color instanceof Color ? material.color : new Color(0x5674b8)
    const lit = new Color()
    for (let i = 0; i + 2 < count; i += 3) {
      const a = offset + (index?.getX(i) ?? i)
      const b = offset + (index?.getX(i + 1) ?? i + 1)
      const c = offset + (index?.getX(i + 2) ?? i + 2)
      normal
        .subVectors(positions[b], positions[a])
        .cross(side.subVectors(positions[c], positions[a]))
      if (normal.lengthSq() > 0) {
        const light = 0.53 + Math.max(0, normal.normalize().dot(lamp)) * 0.57
        faces.push({
          vertices: [a, b, c],
          color: lit.copy(color).multiplyScalar(light).getHex(),
        })
      }
    }
  })
  const projected = positions.map(() => new Vector3())
  let image: ImageData | undefined
  let depths: Float32Array
  return {
    resize(width: number, height: number) {
      const scale = Math.min(1.5, Math.sqrt(250_000 / (width * height)))
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      image = surface.createImageData(canvas.width, canvas.height)
      depths = new Float32Array(canvas.width * canvas.height)
    },
    render(camera: PerspectiveCamera) {
      if (!image) {
        return
      }
      camera.updateMatrixWorld()
      const { width, height, data } = image
      data.fill(0)
      depths.fill(1)
      for (const [index, value] of positions.entries()) {
        const point = projected[index].copy(value).project(camera)
        point.x = ((1 + point.x) * width) / 2
        point.y = ((1 - point.y) * height) / 2
      }
      let fragments = 0
      for (const face of faces) {
        const a = projected[face.vertices[0]]
        const b = projected[face.vertices[1]]
        const c = projected[face.vertices[2]]
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        if (a.z < -1 || b.z < -1 || c.z < -1 || !Number.isFinite(area) || area >= 0) {
          continue
        }
        const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
        const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
        const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
        const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
        if (left > right || top > bottom) {
          continue
        }
        fragments += (right - left + 1) * (bottom - top + 1)
        if (fragments > 8_000_000) {
          throw new Error('The model is too detailed for the legacy preview renderer')
        }
        const stepA = (b.y - c.y) / area
        const stepB = (c.y - a.y) / area
        const red = face.color >> 16
        const green = (face.color >> 8) & 255
        const blue = face.color & 255
        // Depth per pixel keeps overlapping parts correctly occluded, including large faces.
        for (let y = top; y <= bottom; y++) {
          let u = ((c.x - b.x) * (y + 0.5 - b.y) - (c.y - b.y) * (left + 0.5 - b.x)) / area
          let v = ((a.x - c.x) * (y + 0.5 - c.y) - (a.y - c.y) * (left + 0.5 - c.x)) / area
          let pixel = y * width + left
          for (let x = left; x <= right; x++, pixel++, u += stepA, v += stepB) {
            const w = 1 - u - v
            if (u < 0 || v < 0 || w < 0) {
              continue
            }
            const depth = a.z * u + b.z * v + c.z * w
            if (depth >= depths[pixel]) {
              continue
            }
            depths[pixel] = depth
            const byte = pixel * 4
            data[byte] = red
            data[byte + 1] = green
            data[byte + 2] = blue
            data[byte + 3] = 255
          }
        }
      }
      surface.putImageData(image, 0, 0)
    },
  }
}
