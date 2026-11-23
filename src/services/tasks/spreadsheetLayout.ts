import { format } from 'ssf'
import type { CSSProperties } from 'react'

type CellLayout = { style?: CSSProperties; formula?: string }
type CellPosition = { row: number; column: number }
export type SheetLayout = {
  columns: Record<number, number>
  heights: Record<number, number>
  cells: Map<string, CellLayout>
  merges: { first: CellPosition; last: CellPosition }[]
  freezeRows: number
  freezeColumns: number
}

const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name))
const child = (node: Element | undefined, name: string) =>
  node && Array.from(node.children).find((item) => item.localName === name)
const numberAttr = (node: Element | undefined, key: string, fallback = 0) => {
  const attribute = node?.getAttribute(key)
  const value = attribute === null || attribute === undefined ? NaN : Number(attribute)
  return Number.isFinite(value) ? value : fallback
}
const rgb = (element: Element | undefined) => {
  const value = element?.getAttribute('rgb')
  return value && /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) ? '#' + value.slice(-6) : undefined
}
const cellPosition = (reference: string) => {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference)
  if (!match) {
    return undefined
  }
  return {
    column: [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1,
    row: Number(match[2]),
  }
}
const bound = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const stylesFromWorkbook = (document: Document | undefined) => {
  if (!document) {
    return []
  }
  const root = document.documentElement
  const fonts = Array.from(child(root, 'fonts')?.children ?? [])
  const fills = Array.from(child(root, 'fills')?.children ?? [])
  const borders = Array.from(child(root, 'borders')?.children ?? [])
  const formats = new Map(
    elements(document, 'numFmt').map((node) => [
      numberAttr(node, 'numFmtId'),
      node.getAttribute('formatCode') ?? '',
    ])
  )
  return Array.from(child(root, 'cellXfs')?.children ?? [])
    .slice(0, 6000)
    .map((record) => {
      const font = fonts[numberAttr(record, 'fontId')]
      const fill = child(fills[numberAttr(record, 'fillId')], 'patternFill')
      const border = borders[numberAttr(record, 'borderId')]
      const alignment = child(record, 'alignment')
      const face = child(font, 'name')?.getAttribute('val')
      const point = numberAttr(child(font, 'sz'), 'val', 11)
      const horizontal = alignment?.getAttribute('horizontal')
      const vertical = alignment?.getAttribute('vertical')
      const style: CSSProperties = {
        color: rgb(child(font, 'color')),
        backgroundColor:
          fill?.getAttribute('patternType') === 'solid' ? rgb(child(fill, 'fgColor')) : undefined,
        fontFamily:
          face && !/[;"{}\\]/u.test(face) && face.length < 80
            ? '"' + face + '", sans-serif'
            : undefined,
        fontSize: font ? bound(point, 6, 48) + 'pt' : undefined,
        fontWeight: child(font, 'b') ? 700 : undefined,
        fontStyle: child(font, 'i') ? 'italic' : undefined,
        textDecoration: child(font, 'u') ? 'underline' : undefined,
        textAlign:
          horizontal === 'left' || horizontal === 'right' || horizontal === 'center'
            ? horizontal
            : undefined,
        verticalAlign:
          vertical === 'center'
            ? 'middle'
            : vertical === 'top' || vertical === 'bottom'
              ? vertical
              : undefined,
        whiteSpace: alignment?.getAttribute('wrapText') === '1' ? 'pre-wrap' : undefined,
      }
      const line = (side: string) => {
        const edge = child(border, side)
        const kind = edge?.getAttribute('style')
        if (!kind) {
          return undefined
        }
        const width = kind === 'thick' ? 3 : kind.startsWith('medium') ? 2 : 1
        const pattern = kind === 'double' ? 'double' : /dash/i.test(kind) ? 'dashed' : 'solid'
        return width + 'px ' + pattern + ' ' + (rgb(child(edge, 'color')) ?? '#50565d')
      }
      style.borderTop = line('top')
      style.borderRight = line('right')
      style.borderBottom = line('bottom')
      style.borderLeft = line('left')
      const id = numberAttr(record, 'numFmtId')
      return { style, numberFormat: formats.get(id) || id }
    })
}

export const readSheetLayout = (
  document: Document,
  styles: ReturnType<typeof stylesFromWorkbook>,
  rows: string[][],
  rowNumbers: number[],
  date1904: boolean
): SheetLayout => {
  const columns: Record<number, number> = {}
  for (const item of elements(document, 'col').slice(0, 256)) {
    const first = bound(numberAttr(item, 'min', 1), 1, 256)
    const last = bound(numberAttr(item, 'max', first), first, 256)
    const width = bound(numberAttr(item, 'width', 8.43), 1, 130)
    for (let column = first; column <= last; column++) {
      columns[column - 1] = Math.round(width * 7 + 5)
    }
  }
  const heights: Record<number, number> = {}
  const cells = new Map<string, CellLayout>()
  const positions = new Map(rowNumbers.map((number, index) => [number, index]))
  const pane = elements(document, 'pane').find((node) =>
    node.getAttribute('state')?.startsWith('frozen')
  )
  for (const row of Array.from(elements(document, 'sheetData')[0]?.children ?? [])) {
    const y = numberAttr(row, 'r')
    const index = positions.get(y)
    if (index === undefined) {
      continue
    }
    if (row.hasAttribute('ht')) {
      heights[y] = bound((numberAttr(row, 'ht', 15) * 4) / 3, 8, 500)
    }
    for (const cell of Array.from(row.children)) {
      const position = cellPosition(cell.getAttribute('r') ?? '')
      if (!position || position.column >= (rows[index]?.length ?? 0)) {
        continue
      }
      const entry = styles[numberAttr(cell, 's', 0)]
      const formula = child(cell, 'f')?.textContent?.slice(0, 1024)
      if (entry || formula) {
        cells.set(y + ':' + position.column, { style: entry?.style, formula })
      }
      const value = child(cell, 'v')?.textContent
      if (
        entry?.numberFormat &&
        value &&
        (!cell.getAttribute('t') || cell.getAttribute('t') === 'n')
      ) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          try {
            rows[index][position.column] = format(entry.numberFormat, parsed, { date1904 }).slice(
              0,
              1024
            )
          } catch {
            /* Keep the stored value for unusual custom Excel formats. */
          }
        }
      }
    }
  }
  const merges = elements(document, 'mergeCell')
    .slice(0, 2000)
    .flatMap((node) => {
      const [start, end] = (node.getAttribute('ref') ?? '').split(':')
      const first = cellPosition(start)
      const last = cellPosition(end ?? '')
      return first && last && first.row <= last.row && first.column <= last.column
        ? [{ first, last }]
        : []
    })
  return {
    columns,
    heights,
    cells,
    merges,
    freezeRows: bound(numberAttr(pane, 'ySplit'), 0, 20),
    freezeColumns: bound(numberAttr(pane, 'xSplit'), 0, 6),
  }
}
