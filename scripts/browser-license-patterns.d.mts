import type { StatsChunk } from '@rspack/core'

export function browserLicensePatterns(): { from: string; to: string; toType: 'file' }[]
export function bundledBrowserLicenses(chunks: StatsChunk[], root: string): Map<string, Buffer>
