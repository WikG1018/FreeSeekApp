import { strToU8, zipSync } from 'fflate'

export const taskFileMime = {
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  glb: 'model/gltf-binary',
  stl: 'model/stl',
} as const
export type TaskFileKind = Exclude<
  keyof typeof taskFileMime,
  'pdf' | 'pptx' | 'zip' | 'glb' | 'stl'
>
export const taskFileKind = (name: string) =>
  (Object.keys(taskFileMime) as (keyof typeof taskFileMime)[]).find((kind) =>
    name.toLowerCase().endsWith('.' + kind)
  )
export const taskFileLabel = (name: string) =>
  ({
    xlsx: 'Excel',
    docx: 'Word',
    pdf: 'PDF',
    pptx: 'PowerPoint',
    md: 'Markdown',
    csv: 'CSV',
    json: 'JSON',
    txt: 'TXT',
    zip: 'ZIP',
    glb: 'GLB',
    stl: 'STL',
  })[taskFileKind(name) ?? 'txt']

const office = 'http://schemas.openxmlformats.org/'
const packageNs = office + 'package/2006/'
const relationshipNs = office + 'officeDocument/2006/relationships'
const sheetNs = office + 'spreadsheetml/2006/main'
const wordNs = office + 'wordprocessingml/2006/main'
const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const escapeXml = (value: string) =>
  value
    // oxlint-disable-next-line no-control-regex -- Match XML-invalid characters without Unicode regex flags in Rhino.
    .replace(/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, (char) =>
      '\t\r\n'.includes(char) ? char : ''
    )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const invalid = (): never => {
  throw new Error('Invalid task file data')
}
const object = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid()
const text = (value: unknown, limit: number, required = true): string =>
  typeof value === 'string' && value.length <= limit && (!required || value.trim())
    ? value
    : invalid()

export const taskFileName = (value: unknown, kind: TaskFileKind | 'zip' | 'glb' | 'stl') => {
  const base = text(value, 100)
    .replace(/\.(xlsx|docx|md|csv|json|txt|zip|glb|stl)$/i, '')
    // oxlint-disable-next-line no-control-regex -- Remove filename control characters on every runtime.
    .replace(/[\u0000-\u001F\u007F-\u009F<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
  if (!base) {
    return invalid()
  }
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)
  return (reserved ? '_' + base : base) + '.' + kind
}

const types = (parts: { path: string; contentType: string }[]) =>
  '<Types xmlns="' +
  packageNs +
  'content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  parts
    .map(
      ({ path, contentType }) =>
        '<Override ContentType="' + contentType + '" PartName="/' + path + '"/>'
    )
    .join('') +
  '</Types>'

const rels = (entries: { target: string; type: string }[]) =>
  '<Relationships xmlns="' +
  packageNs +
  'relationships">' +
  entries
    .map(
      ({ target, type }, index) =>
        '<Relationship Id="rId' +
        (index + 1) +
        '" Type="' +
        relationshipNs +
        '/' +
        type +
        '" Target="' +
        target +
        '"/>'
    )
    .join('') +
  '</Relationships>'

const partMime = (kind: string) => 'application/vnd.openxmlformats-officedocument.' + kind + '+xml'
type Cell = string | number | boolean | null
type Sheet = { name: string; rows: Cell[][] }

const readSheets = (value: unknown): Sheet[] => {
  if (!Array.isArray(value) || !value.length || value.length > 4) {
    return invalid()
  }
  const names = new Set<string>()
  let cells = 0
  let characters = 0
  return value.map((item) => {
    const sheet = object(item)
    const name = text(sheet.name, 31).trim()
    if (
      /[\\/?*[\]:]/.test(name) ||
      /^'|'$/.test(name) ||
      names.has(name.toLowerCase()) ||
      !Array.isArray(sheet.rows) ||
      !sheet.rows.length ||
      sheet.rows.length > 500
    ) {
      return invalid()
    }
    names.add(name.toLowerCase())
    const rows = sheet.rows.map((row: unknown): Cell[] => {
      if (!Array.isArray(row) || row.length > 32) {
        return invalid()
      }
      cells += row.length
      return row.map((cell: unknown): Cell => {
        if (typeof cell === 'string' && cell.length <= 2000) {
          characters += cell.length
          return cell
        }
        if (
          cell === null ||
          typeof cell === 'boolean' ||
          (typeof cell === 'number' && Number.isFinite(cell))
        ) {
          return cell
        }
        return invalid()
      })
    })
    if (cells > 6000 || characters > 120_000) {
      return invalid()
    }
    return { name, rows }
  })
}

// Named inline strings keep leading zeros and formula-like user data as literal text.
const colName = (index: number) =>
  index < 26 ? String.fromCharCode(65 + index) : 'A' + String.fromCharCode(65 + index - 26)

const worksheet = ({ rows }: Sheet) => {
  const widths: number[] = []
  const body = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, col) => {
        const ref = colName(col) + (rowIndex + 1)
        const style = rowIndex === 0 ? ' s="1"' : ''
        if (value !== null) {
          const width = String(value).replace(/[^\x20-\x7E]/g, 'XX').length
          widths[col] = Math.max(widths[col] ?? 12, Math.min(44, width + 3))
        }
        if (typeof value === 'string') {
          return (
            '<c r="' +
            ref +
            '"' +
            style +
            ' t="inlineStr"><is><t xml:space="preserve">' +
            escapeXml(value) +
            '</t></is></c>'
          )
        }
        if (typeof value === 'boolean') {
          return '<c r="' + ref + '"' + style + ' t="b"><v>' + Number(value) + '</v></c>'
        }
        return value === null ? '' : '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>'
      })
      return '<row r="' + (rowIndex + 1) + '">' + cells.join('') + '</row>'
    })
    .join('')
  return (
    '<worksheet xmlns="' +
    sheetNs +
    '"><sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    (widths.length
      ? '<cols>' +
        widths
          .map(
            (width, i) =>
              '<col min="' +
              (i + 1) +
              '" max="' +
              (i + 1) +
              '" width="' +
              width +
              '" customWidth="1"/>'
          )
          .join('') +
        '</cols>'
      : '') +
    '<sheetData>' +
    body +
    '</sheetData></worksheet>'
  )
}

const sheetStyles =
  '<styleSheet xmlns="' +
  sheetNs +
  '">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF345DCC"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1" applyFill="1" applyFont="1"><alignment wrapText="1" vertical="top"/></xf>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

const spreadsheet = (input: Record<string, unknown>) => {
  const sheets = readSheets(input.sheets)
  const entries = sheets.map((sheet, i) => ({
    name: sheet.name,
    path: 'xl/worksheets/sheet' + (i + 1) + '.xml',
    xml: worksheet(sheet),
  }))
  return {
    '[Content_Types].xml': types([
      { path: 'xl/workbook.xml', contentType: partMime('spreadsheetml.sheet.main') },
      { path: 'xl/styles.xml', contentType: partMime('spreadsheetml.styles') },
      ...entries.map(({ path }) => ({ path, contentType: partMime('spreadsheetml.worksheet') })),
    ]),
    '_rels/.rels': rels([{ target: 'xl/workbook.xml', type: 'officeDocument' }]),
    'xl/_rels/workbook.xml.rels': rels([
      ...entries.map(({ path }) => ({ target: path.slice(3), type: 'worksheet' })),
      { target: 'styles.xml', type: 'styles' },
    ]),
    'xl/workbook.xml':
      '<workbook xmlns="' +
      sheetNs +
      '" xmlns:r="' +
      relationshipNs +
      '">' +
      '<bookViews><workbookView/></bookViews><sheets>' +
      entries
        .map(
          ({ name }, i) =>
            '<sheet name="' +
            escapeXml(name) +
            '" sheetId="' +
            (i + 1) +
            '" r:id="rId' +
            (i + 1) +
            '"/>'
        )
        .join('') +
      '</sheets></workbook>',
    'xl/styles.xml': sheetStyles,
    ...Object.fromEntries(entries.map(({ path, xml }) => [path, xml])),
  }
}

const paragraph = (line: string, style?: string) =>
  '<w:p>' +
  (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') +
  '<w:r><w:t xml:space="preserve">' +
  escapeXml(line) +
  '</w:t></w:r></w:p>'

const wordStyles =
  '<w:styles xmlns:w="' +
  wordNs +
  '">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="280"/></w:pPr><w:rPr><w:b/><w:color w:val="345DCC"/><w:sz w:val="36"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
  '</w:styles>'

const document = (input: Record<string, unknown>) => {
  const title = text(input.title, 160)
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 40) {
    return invalid()
  }
  let size = 0
  const content = input.sections
    .map((item) => {
      const section = object(item)
      const heading = section.heading === undefined ? '' : text(section.heading, 160, false)
      const body = text(section.text, 32_000)
      size += body.length
      if (size > 120_000) {
        return invalid()
      }
      return (
        (heading ? paragraph(heading, 'Heading1') : '') +
        body
          .split(/\r\n?|\n/)
          .map((line) => paragraph(line))
          .join('')
      )
    })
    .join('')
  return {
    '[Content_Types].xml': types([
      { path: 'word/document.xml', contentType: partMime('wordprocessingml.document.main') },
      { path: 'word/styles.xml', contentType: partMime('wordprocessingml.styles') },
    ]),
    '_rels/.rels': rels([{ target: 'word/document.xml', type: 'officeDocument' }]),
    'word/_rels/document.xml.rels': rels([{ target: 'styles.xml', type: 'styles' }]),
    'word/styles.xml': wordStyles,
    'word/document.xml':
      '<w:document xmlns:w="' +
      wordNs +
      '"><w:body>' +
      paragraph(title, 'Title') +
      content +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>',
  }
}

const dataFileText = (kind: 'csv' | 'json' | 'txt' | 'md', input: Record<string, unknown>) => {
  if (kind === 'csv') {
    const sheets = readSheets([{ name: 'CSV', rows: input.rows }])
    return (
      '\uFEFF' +
      sheets[0].rows
        .map((row) =>
          row
            .map((value) => {
              if (typeof value !== 'string') {
                return value ?? ''
              }
              const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value
              return '"' + safe.replaceAll('"', '""') + '"'
            })
            .join(',')
        )
        .join('\r\n')
    )
  }
  const content = text(input.content, 80_000).replaceAll('\0', '').trimEnd()
  if (kind === 'json') {
    const json: unknown = JSON.parse(content)
    const formatted = JSON.stringify(json, null, 2)
    if (formatted.length > 160_000) {
      return invalid()
    }
    return formatted
  }
  return content
}

export const makeTaskFileBytes = (kind: TaskFileKind, input: Record<string, unknown>) => {
  const name = taskFileName(input.file_name, kind)
  if (kind !== 'xlsx' && kind !== 'docx') {
    const content = dataFileText(kind, input)
    return { name, bytes: strToU8(content + '\n'), type: taskFileMime[kind] }
  }
  const parts = kind === 'xlsx' ? spreadsheet(input) : document(input)
  const bytes = zipSync(
    Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xmlHead + xml)])),
    { level: 3, mtime: new Date(2020, 0, 1) }
  )
  return { name, bytes, type: taskFileMime[kind] }
}

export const makeTaskFile = (kind: TaskFileKind, input: Record<string, unknown>) => {
  const { name, bytes, type } = makeTaskFileBytes(kind, input)
  return { name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type }) }
}
