import type { SearchOutput, ToolDefinition } from '../api/searchTool.js'
import type { FileAttachment } from '../chat/types.js'
import { loadTaskAttachmentSource, workbookSheets } from './attachments.js'
import { MAX_SOURCE_CHARS, sourceIdFor, type TaskReadResult } from './evidence.js'
import { recordSchema } from './toolSchema.js'

const error = (text: string): SearchOutput => ({ isError: true, text })
const string = { type: 'string' }
const scalar = { type: 'number' }
import { analysis, analyzeTableData, operations, parseCsv } from './dataOperations.js'
export { calculate, parseCsv } from './dataOperations.js'

export const calculationTool: ToolDefinition = {
  name: 'calculate',
  description:
    'Calculate numeric operations without guessing. Each entry takes 2 to 30 finite numbers; power, percent and round take exactly 2. Percent is the first value divided by the second multiplied by 100. Round takes a value and decimal places.',
  parameters: recordSchema(
    {
      calculations: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: recordSchema(
          {
            operation: { type: 'string', enum: operations },
            values: { type: 'array', minItems: 2, maxItems: 30, items: scalar },
          },
          ['operation', 'values']
        ),
      },
    },
    ['calculations']
  ),
}

const column = {
  description: 'Column header or 1-based column number',
  type: ['string', 'integer'],
}
export const tableTool: ToolDefinition = {
  name: 'analyze_table',
  description:
    'Analyze a selected CSV or Excel file from the task file inventory. Inspect columns first with no measures. Optionally filter by exact value or substring, group by a column, and compute row counts and numeric totals, averages, minima or maxima. Numeric statistics omit non-numeric cells.',
  parameters: recordSchema(
    {
      file: { type: 'integer', minimum: 1 },
      sheet: string,
      filter: recordSchema(
        {
          column,
          equals: string,
          contains: string,
        },
        ['column']
      ),
      group_by: column,
      measures: {
        type: 'array',
        maxItems: 8,
        items: recordSchema(
          {
            operation: { type: 'string', enum: analysis },
            column,
          },
          ['operation']
        ),
      },
    },
    ['file']
  ),
}

export const isTableFile = (file: FileAttachment) =>
  !file.isImage && /\.(xlsx|csv)$/i.test(file.name)

export const analyzeTaskTable = async (
  file: FileAttachment,
  blob: Blob,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<TaskReadResult> => {
  if (blob.size > 4 * 1024 * 1024 || !isTableFile(file)) {
    return error('Use a readable Excel or CSV file up to 4 MiB.')
  }
  let sheets
  try {
    if (/\.xlsx$/i.test(file.name)) {
      sheets = await workbookSheets(blob, signal, { textLimit: MAX_SOURCE_CHARS })
    } else {
      const source = await loadTaskAttachmentSource(file, blob, signal, 4 * 1024 * 1024)
      if (!source || source.sourceTruncated) {
        return {
          isError: true,
          reason: 'attachment-unreadable',
          text: 'The CSV file is empty or could not be decoded in full.',
        }
      }
      sheets = [{ name: 'CSV', rows: parseCsv(source.text) }]
    }
  } catch {
    signal.throwIfAborted()
    return {
      isError: true,
      reason: 'attachment-unreadable',
      text: 'The table could not be read completely. Check its format or split the input.',
    }
  }
  signal.throwIfAborted()
  return analyzeTableData(sheets, args, {
    sourceId: sourceIdFor('attachment', file.id),
    kind: 'attachment',
    title: file.name.replace(/[\r\n]/g, ' ').slice(0, 140),
    downloadedBytes: blob.size,
  })
}
