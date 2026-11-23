import type { SearchOutput } from '../api/searchTool.js'
import type { TaskEvidence, TaskReadResult } from './evidence.js'
const error = (text: string): SearchOutput => ({ isError: true, text })
export const operations = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'power',
  'percent',
  'round',
  'average',
] as const
type Calculation = (typeof operations)[number]

const apply: Record<Calculation, (values: number[]) => number> = {
  add: (values) => values.reduce((sum, value) => sum + value, 0),
  subtract: (values) => values.reduce((difference, value) => difference - value),
  multiply: (values) => values.reduce((product, value) => product * value, 1),
  divide: (values) => values.reduce((quotient, value) => quotient / value),
  power: ([base, exponent]) => base ** exponent,
  percent: ([value, total]) => (value / total) * 100,
  round: ([value, places]) =>
    Number.isInteger(places) && places >= 0 && places <= 12
      ? Number(value.toFixed(places))
      : Number.NaN,
  average: (values) => values.reduce((sum, value) => sum + value / values.length, 0),
}

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const calculate = (input: unknown): SearchOutput => {
  const { calculations } = record(input)
  if (!Array.isArray(calculations) || !calculations.length || calculations.length > 16) {
    return error('Provide one to sixteen calculations.')
  }
  const results = []
  for (const item of calculations) {
    const { operation, values } = record(item)
    const op = operations.find((known) => known === operation)
    if (
      !op ||
      !Array.isArray(values) ||
      values.length < 2 ||
      values.length > 30 ||
      !values.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      (['power', 'percent', 'round'].includes(op) && values.length !== 2)
    ) {
      return error('Use a supported calculator operation with the required finite numbers.')
    }
    const result = apply[op](values)
    results.push(Number.isFinite(result) ? { result } : { error: 'Undefined result' })
  }
  return { text: JSON.stringify({ results }) }
}

const MAX_ROWS = 12_000
const MAX_COLUMNS = 128
export const parseCsv = (value: string): string[][] => {
  const rows: string[][] = []
  let cells: string[] = []
  let field = ''
  let quoted = false
  let afterQuote = false
  const push = () => {
    if (cells.length >= MAX_COLUMNS) {
      throw new Error('Too many CSV columns')
    }
    cells.push(field)
    field = ''
    afterQuote = false
  }
  const end = () => {
    push()
    if (rows.length >= MAX_ROWS) {
      throw new Error('Too many CSV rows')
    }
    rows.push(cells)
    cells = []
  }
  const text = value.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') {
        quoted = false
        afterQuote = true
      } else {
        field += char
      }
    } else if (char === ',') {
      push()
    } else if (char === '\r' || char === '\n') {
      end()
      if (char === '\r' && text[index + 1] === '\n') {
        index++
      }
    } else if (afterQuote) {
      if (char !== ' ' && char !== '\t') {
        throw new Error('Invalid CSV quoting')
      }
    } else if (char === '"' && !field) {
      quoted = true
    } else {
      field += char
    }
  }
  if (quoted) {
    throw new Error('Unclosed CSV field')
  }
  if (cells.length || field || afterQuote) {
    end()
  }
  return rows
}

export const analysis = ['count', 'sum', 'average', 'min', 'max'] as const
type Measure = (typeof analysis)[number]
const getColumn = (headers: string[], value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= headers.length
    ? value - 1
    : typeof value === 'string'
      ? headers.findIndex((field) => field.trim().toLowerCase() === value.trim().toLowerCase())
      : -1

const numericCell = (value: string) => {
  const cell = value.trim()
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell) ? Number(cell) : Number.NaN
}

const summarize = (rows: string[][], operation: Measure, col: number) => {
  if (operation === 'count') {
    return col < 0 ? rows.length : rows.filter((row) => row[col]?.trim()).length
  }
  const values = rows.map((row) => numericCell(row[col] ?? '')).filter(Number.isFinite)
  if (!values.length) {
    return null
  }
  if (operation === 'min') {
    return values.reduce((current, value) => Math.min(current, value))
  }
  if (operation === 'max') {
    return values.reduce((current, value) => Math.max(current, value))
  }
  const result = values.reduce(
    (sum, value) => sum + value / (operation === 'average' ? values.length : 1),
    0
  )
  return Number.isFinite(result) ? result : null
}

export const analyzeTableData = (
  sheets: { name: string; rows: string[][] }[],
  args: Record<string, unknown>,
  reference: Omit<TaskEvidence, 'partial'>
): TaskReadResult => {
  const sheet =
    typeof args.sheet === 'string' ? sheets.find(({ name }) => name === args.sheet) : sheets[0]
  if (!sheet || sheet.rows.length < 1) {
    return error('The selected sheet does not exist or contains no rows.')
  }
  const [headers, ...rows] = sheet.rows
  const groupBy = args.group_by === undefined ? -1 : getColumn(headers, args.group_by)
  if (args.group_by !== undefined && groupBy < 0) {
    return error('Use a column from the selected sheet for grouping.')
  }
  const specs = args.measures ?? []
  if (!Array.isArray(specs) || specs.length > 8) {
    return error('Use at most eight measures.')
  }
  const measures: { operation: Measure; col: number }[] = []
  for (const spec of specs) {
    const { operation, column } = record(spec)
    const op = analysis.find((measure) => measure === operation)
    const col = getColumn(headers, column)
    if (!op || (col < 0 && (op !== 'count' || column !== undefined))) {
      return error('Choose a supported measure and an existing sheet column.')
    }
    measures.push({ operation: op, col })
  }
  const filter = record(args.filter)
  const filterColumn = getColumn(headers, filter.column)
  if (
    args.filter !== undefined &&
    (filterColumn < 0 || (typeof filter.equals !== 'string' && typeof filter.contains !== 'string'))
  ) {
    return error('Provide a filter column and an exact value or substring.')
  }
  const selected =
    filterColumn < 0
      ? rows
      : rows.filter((row) => {
          const value = row[filterColumn] ?? ''
          return typeof filter.equals === 'string'
            ? value === filter.equals
            : value.toLowerCase().includes(String(filter.contains).toLowerCase())
        })
  const calculateRows = (group: string[][]) =>
    measures.map(({ operation, col }) => ({
      operation,
      column: headers[col] ?? null,
      value: summarize(group, operation, col),
    }))
  const groups = new Map<string, string[][]>()
  if (groupBy >= 0) {
    for (const row of selected) {
      const key = row[groupBy] ?? ''
      const group = groups.get(key)
      if (group) {
        group.push(row)
      } else {
        groups.set(key, [row])
      }
    }
  }
  return {
    evidence: {
      ...reference,
      title: reference.title + ' · ' + sheet.name,
      partial: groups.size > 40,
    },
    text: JSON.stringify({
      sheet: sheet.name,
      sheets: sheets.map(({ name }) => name),
      columns: headers.map((name, index) => ({ column: index + 1, name: name.slice(0, 80) })),
      row_count: rows.length,
      matched_rows: selected.length,
      totals: calculateRows(selected),
      group_count: groups.size,
      groups_truncated: groups.size > 40,
      groups: [...groups].slice(0, 40).map(([value, rows]) => ({
        group: value.slice(0, 120),
        row_count: rows.length,
        measures: calculateRows(rows),
      })),
    }),
  }
}
