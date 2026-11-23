import {
  Fragment,
  createElement,
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { ArtifactReading, DocumentPart } from '../../services/tasks/preview.js'
import type { PreviewSheet } from '../../services/tasks/attachments.js'
import { PagedLayoutReader, ReaderToolbar, WordLayoutReader } from './LayoutReader.js'
import { toMdAst } from '../../services/markdown/parse.js'
import {
  IconChevronLeftOutline16,
  IconChevronRightOutline14,
  IconSearchOutline16,
} from '../base/icons.js'
import { Select } from '../base/Select.js'
import { MarkdownAstRenderer } from '../markdown/MarkdownAstRenderer.js'
import styles from './ArtifactReader.module.css'

const ROWS_PER_PAGE = 40
const COLUMNS_PER_PAGE = 12
const ModelReader = lazy(() =>
  import('./ModelReader.js').then(({ ModelReader }) => ({ default: ModelReader }))
)

const StyledSheetRows = ({
  sheet,
  rowIndexes,
  columns,
  needle,
  hit,
  showFormula,
}: {
  sheet: PreviewSheet
  rowIndexes: number[]
  columns: number[]
  needle: string
  hit: (row: number, column: number) => boolean
  showFormula: (formula?: string) => void
}) => {
  const layout = sheet.layout
  if (!layout) {
    return null
  }
  const physical = (row: number) => sheet.rowNumbers?.[row] ?? row + 1
  const width = (column: number) => layout.columns[column] ?? 76
  const merges = new Map<
    string,
    { rows: number; columns: number; sourceRow: number; sourceColumn: number } | null
  >()
  const rowMap = new Map(sheet.rowNumbers?.map((row, index) => [row, index]))
  for (const merge of layout.merges) {
    const partRows = rowIndexes.filter(
      (row) => physical(row) >= merge.first.row && physical(row) <= merge.last.row
    )
    const partCols = columns.filter(
      (column) => column >= merge.first.column && column <= merge.last.column
    )
    for (const row of partRows) {
      for (const column of partCols) {
        const key = row + ':' + column
        merges.set(
          key,
          row === partRows[0] && column === partCols[0]
            ? {
                rows: partRows.length,
                columns: partCols.length,
                sourceRow: merge.first.row,
                sourceColumn: merge.first.column,
              }
            : null
        )
      }
    }
  }
  return (
    <>
      <colgroup>
        <col style={{ width: 46 }} />
        {columns.map((column) => (
          <col key={column} style={{ width: width(column) }} />
        ))}
      </colgroup>
      <tbody>
        {rowIndexes.map((row) => {
          const number = physical(row)
          const top =
            number <= layout.freezeRows
              ? rowIndexes
                  .slice(0, rowIndexes.indexOf(row))
                  .reduce((height, id) => height + (layout.heights[physical(id)] ?? 27), 0)
              : undefined
          return (
            <tr key={row} style={{ height: layout.heights[number] ?? 27 }}>
              <th className={styles.rowNumber} scope="row" style={{ top }}>
                {number}
              </th>
              {columns.map((column, position) => {
                const merge = merges.get(row + ':' + column)
                if (merge === null) {
                  return null
                }
                const fromRow = merge ? rowMap.get(merge.sourceRow) : row
                const fromColumn = merge?.sourceColumn ?? column
                const cell = layout.cells.get((merge?.sourceRow ?? number) + ':' + fromColumn)
                const value = fromRow === undefined ? '' : (sheet.rows[fromRow]?.[fromColumn] ?? '')
                const left =
                  column < layout.freezeColumns
                    ? 46 +
                      columns.slice(0, position).reduce((value, item) => value + width(item), 0)
                    : undefined
                const Tag = row === 0 ? 'th' : 'td'
                return (
                  <Tag
                    key={column}
                    scope={row === 0 ? 'col' : undefined}
                    rowSpan={merge?.rows}
                    colSpan={merge?.columns}
                    data-reader-hit={hit(row, column)}
                    data-frozen={top !== undefined || left !== undefined || undefined}
                    data-formula={cell?.formula ? '' : undefined}
                    style={{
                      ...cell?.style,
                      top,
                      left,
                      position: top !== undefined || left !== undefined ? 'sticky' : undefined,
                      zIndex:
                        top !== undefined && left !== undefined
                          ? 3
                          : top !== undefined || left !== undefined
                            ? 2
                            : undefined,
                    }}
                    tabIndex={cell?.formula ? 0 : undefined}
                    onClick={() => showFormula(cell?.formula)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && cell?.formula) {
                        showFormula(cell.formula)
                      }
                    }}
                  >
                    {highlight(value, needle)}
                  </Tag>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </>
  )
}
const LINES_PER_PAGE = 90
const PARTS_PER_PAGE = 20
const ignoreResize = () => {}

const queryText = (value: string) => value.trim().toLowerCase()
const matches = (value: string, query: string) => value.toLowerCase().includes(query)

const highlight = (value: string, query: string): ReactNode => {
  if (!query) {
    return value
  }
  const at = value.toLowerCase().indexOf(query)
  if (at < 0) {
    return value
  }
  return (
    <>
      {value.slice(0, at)}
      <mark>{value.slice(at, at + query.length)}</mark>
      {value.slice(at + query.length)}
    </>
  )
}

const useFileSearch = <T,>(find: (query: string) => T[], reveal: (match: T) => void) => {
  const [state, setState] = useState<{ query: string; index: number; results: T[] }>({
    query: '',
    index: 0,
    results: [],
  })
  return {
    query: state.query,
    needle: queryText(state.query),
    index: state.index,
    count: state.results.length,
    change: (query: string) => {
      const needle = queryText(query)
      const results = needle ? find(needle) : []
      setState({ query, index: 0, results })
      if (results.length) {
        reveal(results[0])
      }
    },
    move: (offset: number) => {
      if (!state.results.length) {
        return
      }
      const index = (state.index + offset + state.results.length) % state.results.length
      setState({ ...state, index })
      reveal(state.results[index])
    },
  }
}

const FindBar = ({
  query,
  index,
  count,
  change,
  move,
}: {
  query: string
  index: number
  count: number
  change: (query: string) => void
  move: (offset: number) => void
}) => {
  const t = useTranslate()
  const label = t('agentFileSearch')
  return (
    <div className={styles.find}>
      <div className={styles.findInput}>
        <IconSearchOutline16 />
        <input
          type="search"
          enterKeyHint="search"
          aria-label={label}
          placeholder={label}
          value={query}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              count &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault()
              move(event.shiftKey ? -1 : 1)
            }
          }}
        />
      </div>
      {queryText(query) && (
        <div className={styles.findControls}>
          <span role="status">
            {count
              ? t('agentFileSearchMatches', { current: index + 1, total: count })
              : t('agentFileSearchEmpty')}
          </span>
          {count > 1 && (
            <>
              <button
                type="button"
                aria-label={t('agentFileSearchPrevious')}
                onClick={() => move(-1)}
              >
                <IconChevronLeftOutline16 />
              </button>
              <button type="button" aria-label={t('agentFileSearchNext')} onClick={() => move(1)}>
                <IconChevronRightOutline14 />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const PageBar = ({
  label,
  page,
  pages,
  change,
  columns,
}: {
  label: string
  page: number
  pages: number
  change: (page: number) => void
  columns?: boolean
}) => {
  const t = useTranslate()
  return (
    <div className={styles.pageBar} role="group" aria-label={label}>
      <button
        type="button"
        aria-label={t(columns ? 'agentFilePreviousColumns' : 'agentFilePrevious')}
        disabled={page === 0}
        onClick={() => change(page - 1)}
      >
        <IconChevronLeftOutline16 />
      </button>
      <span aria-live="polite">{label}</span>
      <button
        type="button"
        aria-label={t(columns ? 'agentFileNextColumns' : 'agentFileNext')}
        disabled={page + 1 >= pages}
        onClick={() => change(page + 1)}
      >
        <IconChevronRightOutline14 />
      </button>
    </div>
  )
}

const TableReader = ({
  sheets,
}: {
  sheets: Extract<ArtifactReading, { kind: 'table' }>['sheets']
}) => {
  const t = useTranslate()
  const [sheet, setSheet] = useState(0)
  const [page, setPage] = useState(0)
  const [columnPage, setColumnPage] = useState(0)
  const [formula, setFormula] = useState<string>()
  const [anchor, setAnchor] = useState<{ sheet: number; row: number; column: number }>()
  const contentRef = useRef<HTMLDivElement>(null)
  const current = sheets[sheet]
  const layout = current.layout
  const headers = current.rows[0] ?? []
  const headCount = layout
    ? Math.max(1, current.rowNumbers?.filter((number) => number <= layout.freezeRows).length ?? 0)
    : 1
  const bodyCount = Math.max(0, current.rows.length - headCount)
  const columns = useMemo(
    () => current.rows.reduce((longest, row) => Math.max(longest, row.length), 0),
    [current]
  )
  const pages = Math.max(1, Math.ceil(bodyCount / ROWS_PER_PAGE))
  const pinned = Math.min(columns, layout?.freezeColumns ?? 0)
  const pageColumns = COLUMNS_PER_PAGE - pinned
  const columnPages = Math.max(1, Math.ceil((columns - pinned) / pageColumns))
  const fromRow = headCount + page * ROWS_PER_PAGE
  const toRow = Math.min(fromRow + ROWS_PER_PAGE, current.rows.length)
  const fromColumn = pinned + columnPage * pageColumns
  const columnIndexes = [
    ...Array.from({ length: pinned }, (_, index) => index),
    ...Array.from(
      { length: Math.min(pageColumns, Math.max(0, columns - fromColumn)) },
      (_, index) => fromColumn + index
    ),
  ]

  const find = (query: string) =>
    sheets.flatMap((item, sheetIndex) =>
      item.rows.flatMap((row, index) =>
        row.flatMap((value, column) =>
          matches(value, query) ? [{ sheet: sheetIndex, row: index, column }] : []
        )
      )
    )
  const search = useFileSearch(find, (target) => {
    setSheet(target.sheet)
    const destination = sheets[target.sheet]
    const freezes = destination.layout
    const heads = Math.max(
      1,
      destination.rowNumbers?.filter((number) => number <= (freezes?.freezeRows ?? 0)).length ?? 0
    )
    const pins = freezes?.freezeColumns ?? 0
    setPage(Math.floor(Math.max(0, target.row - heads) / ROWS_PER_PAGE))
    setColumnPage(Math.floor(Math.max(0, target.column - pins) / (COLUMNS_PER_PAGE - pins)))
    setAnchor(target)
    requestAnimationFrame(() => {
      const cell = contentRef.current?.querySelector<HTMLElement>('[data-reader-hit="true"]')
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  })
  const resetScroll = () => {
    setFormula(undefined)
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
      contentRef.current.scrollLeft = 0
    }
  }
  const hit = (row: number, column: number) =>
    Boolean(
      search.needle && anchor?.sheet === sheet && anchor.row === row && anchor.column === column
    )

  return (
    <div className={styles.reader}>
      <ReaderToolbar
        navigation={
          sheets.length > 1 ? (
            <Select
              pill
              ariaLabel={t('taskFileSheetsLabel')}
              value={String(sheet)}
              options={sheets.map(({ name }, index) => ({ value: String(index), label: name }))}
              onChange={(value) => {
                setSheet(Number(value))
                setPage(0)
                setColumnPage(0)
                resetScroll()
              }}
            />
          ) : (
            <span className={styles.sheetName} title={current.name}>
              {current.name}
            </span>
          )
        }
        search={<FindBar {...search} />}
      />
      {formula && (
        <div className={styles.formula} role="status">
          {t('readerFormula')} · ={formula}
        </div>
      )}
      <div
        className={styles.body}
        ref={contentRef}
        data-scroll-edge=""
        role="region"
        aria-label={current.name}
        tabIndex={0}
      >
        <table
          className={styles.table}
          aria-label={current.name}
          data-scroll-edge-content=""
          data-sheet-layout={layout ? '' : undefined}
          style={
            layout
              ? {
                  tableLayout: 'fixed',
                  width:
                    46 + columnIndexes.reduce((sum, col) => sum + (layout.columns[col] ?? 76), 0),
                }
              : undefined
          }
        >
          {layout ? (
            <StyledSheetRows
              sheet={current}
              columns={columnIndexes}
              rowIndexes={[
                ...Array.from({ length: Math.min(headCount, current.rows.length) }, (_, i) => i),
                ...Array.from({ length: Math.max(0, toRow - fromRow) }, (_, i) => fromRow + i),
              ]}
              needle={search.needle}
              hit={hit}
              showFormula={setFormula}
            />
          ) : (
            <>
              <thead>
                <tr>
                  <th scope="col" className={styles.rowNumber}>
                    {t('agentFileRow')}
                  </th>
                  {columnIndexes.map((column) => (
                    <th scope="col" key={column} data-reader-hit={Boolean(hit(0, column))}>
                      {highlight(
                        headers[column] || t('agentFileColumn', { column: column + 1 }),
                        search.needle
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.rows.slice(fromRow, toRow).map((row, index) => {
                  const rowIndex = fromRow + index
                  return (
                    <tr key={rowIndex}>
                      <th scope="row" className={styles.rowNumber}>
                        {rowIndex + 1}
                      </th>
                      {columnIndexes.map((column) => (
                        <td key={column} data-reader-hit={Boolean(hit(rowIndex, column))}>
                          {highlight(row[column] ?? '', search.needle)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </>
          )}
        </table>
      </div>
      {current.rows.length > 0 && (
        <div className={styles.pagination}>
          {pages > 1 ? (
            <PageBar
              label={t('agentFileRows', {
                from: bodyCount ? fromRow + 1 : 1,
                to: bodyCount ? toRow : 1,
                total: current.rows.length,
              })}
              page={page}
              pages={pages}
              change={(next) => {
                setPage(next)
                resetScroll()
              }}
            />
          ) : (
            <span className={styles.rowTotal}>
              {t('agentFileRowTotal', { total: current.rows.length })}
            </span>
          )}
          {columnPages > 1 && (
            <PageBar
              columns
              label={t('agentFileColumns', {
                from: fromColumn + 1,
                to: fromColumn + columnIndexes.length,
              })}
              page={columnPage}
              pages={columnPages}
              change={(next) => {
                setColumnPage(next)
                resetScroll()
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

const sectionMatches = (part: DocumentPart, query: string) =>
  part.type === 'table'
    ? part.rows.some((row) => row.some((value) => matches(value, query)))
    : matches(part.text, query)

const DocumentReader = ({ sections }: { sections: DocumentPart[] }) => {
  const t = useTranslate()
  const [page, setPage] = useState(0)
  const [anchor, setAnchor] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)
  const pages = Math.max(1, Math.ceil(sections.length / PARTS_PER_PAGE))
  const start = page * PARTS_PER_PAGE
  const headings = useMemo(
    () =>
      sections.flatMap((part, index) =>
        part.type === 'heading' ? [{ index, title: part.text }] : []
      ),
    [sections]
  )
  const jump = (index: number) => {
    setPage(Math.floor(index / PARTS_PER_PAGE))
    setAnchor(index)
    requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector('[data-reader-hit="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    })
  }
  const search = useFileSearch(
    (query) => sections.flatMap((part, index) => (sectionMatches(part, query) ? [index] : [])),
    jump
  )
  const visible = sections.slice(start, start + PARTS_PER_PAGE)
  const parts: ReactNode[] = []
  for (let index = 0; index < visible.length; index++) {
    const part = visible[index]
    const key = start + index
    const active = key === anchor
    if (part.type === 'heading') {
      parts.push(
        createElement(
          'h' + part.level,
          { key, 'data-reader-hit': active },
          highlight(part.text, search.needle)
        )
      )
    } else if (part.type === 'table') {
      parts.push(
        <div className={styles.documentTable} data-reader-hit={active} key={key}>
          <table className={styles.table}>
            <tbody>
              {part.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((value, column) => (
                    <td key={column}>{highlight(value, search.needle)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    } else if (part.type === 'list') {
      const items = [
        <li key={key} data-reader-hit={active}>
          {highlight(part.text, search.needle)}
        </li>,
      ]
      while (visible[index + 1]?.type === 'list') {
        index++
        const next = visible[index] as Extract<DocumentPart, { text: string }>
        items.push(
          <li key={start + index} data-reader-hit={start + index === anchor}>
            {highlight(next.text, search.needle)}
          </li>
        )
      }
      parts.push(<ul key={key}>{items}</ul>)
    } else {
      parts.push(
        <p key={key} data-reader-hit={active}>
          {highlight(part.text, search.needle)}
        </p>
      )
    }
  }
  return (
    <div className={styles.reader}>
      <ReaderToolbar
        navigation={
          headings.length > 0 && (
            <Select
              pill
              ariaLabel={t('agentFileOutline')}
              placeholder={t('agentFileOutline')}
              value={sections[anchor]?.type === 'heading' ? String(anchor) : ''}
              options={headings.map(({ index, title }) => ({
                value: String(index),
                label: title.slice(0, 160),
              }))}
              onChange={(value) => jump(Number(value))}
            />
          )
        }
        search={<FindBar {...search} />}
      />
      <div
        ref={contentRef}
        className={clsx(styles.body, styles.document)}
        data-testid="task-document-preview"
        tabIndex={0}
      >
        {parts}
      </div>
      {pages > 1 && (
        <PageBar
          label={t('agentFilePage', { page: page + 1, pages })}
          page={page}
          pages={pages}
          change={(next) => {
            setPage(next)
            setAnchor(-1)
            if (contentRef.current) {
              contentRef.current.scrollTop = 0
            }
          }}
        />
      )}
    </div>
  )
}

const JsonValue = ({
  label,
  value,
  root = false,
}: {
  label?: string
  value: unknown
  root?: boolean
}) => {
  const [open, setOpen] = useState(root)
  const [page, setPage] = useState(0)
  const t = useTranslate()
  const members = useMemo(
    () => (value !== null && typeof value === 'object' ? Object.entries(value) : null),
    [value]
  )
  const name = label === undefined ? null : <span className={styles.jsonKey}>{label}: </span>
  if (!members) {
    return (
      <div className={styles.jsonPrimitive}>
        {name}
        <code>{JSON.stringify(value)}</code>
      </div>
    )
  }
  const size = Array.isArray(value) ? '[' + members.length + ']' : '{' + members.length + '}'
  const pages = Math.max(1, Math.ceil(members.length / ROWS_PER_PAGE))
  return (
    <details
      className={styles.jsonBranch}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {name}
        {size}
      </summary>
      {open && (
        <div className={styles.jsonChildren}>
          {members.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE).map(([key, child]) => (
            <JsonValue key={key} label={key} value={child} />
          ))}
          {pages > 1 && (
            <PageBar
              label={t('agentFilePage', { page: page + 1, pages })}
              page={page}
              pages={pages}
              change={setPage}
            />
          )}
        </div>
      )}
    </details>
  )
}

const TextReader = ({
  text,
  format,
  navigation,
}: Pick<Extract<ArtifactReading, { kind: 'text' }>, 'text' | 'format'> & {
  navigation?: ReactNode
}) => {
  const t = useTranslate()
  const [source, setSource] = useState(format === 'txt')
  const [page, setPage] = useState(0)
  const [anchor, setAnchor] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => text.split(/\r\n?|\n/), [text])
  const ast = useMemo(
    () =>
      format === 'md' && !source ? toMdAst(text, { disableLink: true, sources: undefined }) : null,
    [format, source, text]
  )
  const json = useMemo(() => {
    if (source || format !== 'json') {
      return undefined
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }, [format, source, text])
  const viewingStructure = !source && (ast !== null || json !== undefined)
  const perPage = viewingStructure ? PARTS_PER_PAGE : LINES_PER_PAGE
  const entries = viewingStructure ? (ast?.children.length ?? 0) : lines.length
  const pages = Math.max(1, Math.ceil(entries / perPage))
  const first = page * perPage
  const search = useFileSearch(
    (needle) => lines.flatMap((line, index) => (matches(line, needle) ? [index] : [])),
    (target) => {
      setSource(true)
      setPage(Math.floor(target / LINES_PER_PAGE))
      setAnchor(target)
      requestAnimationFrame(() => {
        contentRef.current
          ?.querySelector('[data-reader-hit="true"]')
          ?.scrollIntoView({ block: 'nearest' })
      })
    }
  )
  const changePage = useCallback((next: number) => {
    setPage(next)
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [])

  return (
    <div className={styles.reader}>
      <ReaderToolbar
        search={<FindBar {...search} />}
        navigation={
          navigation ??
          (format !== 'txt' && (
            <div className={styles.tabs}>
              <button
                type="button"
                aria-pressed={!source}
                onClick={() => {
                  setSource(false)
                  changePage(0)
                }}
              >
                {t(format === 'json' ? 'agentFileJson' : 'agentFileRich')}
              </button>
              <button
                type="button"
                aria-pressed={source}
                onClick={() => {
                  setSource(true)
                  changePage(0)
                }}
              >
                {t('agentFileSource')}
              </button>
            </div>
          ))
        }
      />
      <div
        className={styles.body}
        ref={contentRef}
        data-testid="task-document-preview"
        tabIndex={0}
      >
        {ast ? (
          <MarkdownAstRenderer
            className={styles.document}
            ast={{ ...ast, children: ast.children.slice(first, first + perPage) }}
            loading={false}
            onUpdate={ignoreResize}
          />
        ) : json !== undefined ? (
          <div className={styles.json}>
            <JsonValue root value={json} />
          </div>
        ) : (
          <div className={styles.source}>
            {lines.slice(first, first + perPage).map((line, index) => (
              <Fragment key={first + index}>
                <span aria-hidden="true" className={styles.lineNumber}>
                  {first + index + 1}
                </span>
                <span className={styles.line} data-reader-hit={first + index === anchor}>
                  {highlight(line, search.needle)}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {pages > 1 && (
        <PageBar
          label={t('agentFilePage', { page: page + 1, pages })}
          page={page}
          pages={pages}
          change={changePage}
        />
      )}
    </div>
  )
}

const ProjectReader = ({ files }: Pick<Extract<ArtifactReading, { kind: 'project' }>, 'files'>) => {
  const t = useTranslate()
  const [index, setIndex] = useState(0)
  const file = files[index] ?? files[0]
  return (
    <TextReader
      key={file.path}
      format="txt"
      text={file.text}
      navigation={
        <Select
          pill
          ariaLabel={t('agentProjectFiles')}
          value={String(index)}
          options={files.map(({ path }, index) => ({ value: String(index), label: path }))}
          onChange={(next) => setIndex(Number(next))}
        />
      }
    />
  )
}

export const ArtifactReader = ({
  value,
  fileId,
  fileName,
}: {
  value: ArtifactReading
  fileId: string
  fileName?: string
}) => {
  const t = useTranslate()
  if (value.kind === 'pages') {
    return <PagedLayoutReader document={value.document} fileId={fileId} />
  }
  if (value.kind === 'word-layout') {
    return <WordLayoutReader document={value.document} fileId={fileId} />
  }
  if (value.kind === 'document') {
    return <DocumentReader sections={value.sections} />
  }
  if (value.kind === 'table') {
    return <TableReader sheets={value.sheets} />
  }
  if (value.kind === 'project') {
    return <ProjectReader files={value.files} />
  }
  if (value.kind === 'model') {
    return (
      <Suspense fallback={<p role="status">{t('taskFileLoading')}</p>}>
        <ModelReader buffer={value.buffer} format={value.format} fileName={fileName ?? 'model'} />
      </Suspense>
    )
  }
  return <TextReader {...value} />
}
