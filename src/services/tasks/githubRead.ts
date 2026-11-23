import { publicWebUrl } from './publicWeb.js'

const PAGE_SIZE = 10
const MAX_PAGE = 1000
export const commitSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{40}$/i.test(value)

export type GithubRepo = { namespace: string; key: string; path: string[] }

export const githubRepo = (url: URL): GithubRepo | undefined => {
  if (
    !['github.com', 'www.github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(
      url.hostname
    )
  ) {
    return undefined
  }
  const path = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'api.github.com' && path.shift() !== 'repos') {
    return undefined
  }
  const [owner, slug, ...rest] = path
  const repo = slug?.replace(/\.git$/i, '')
  if (
    !owner ||
    !/^[\da-z][\da-z-]{0,38}$/i.test(owner) ||
    !repo ||
    !/^[\w.-]{1,100}$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return undefined
  }
  const namespace = owner + '/' + repo
  return { namespace, key: namespace.toLowerCase(), path: rest }
}

const actions = [
  'readme',
  'directory',
  'file',
  'issue',
  'pull',
  'issues',
  'pulls',
  'latest_release',
] as const
export const githubActions = actions
export type GithubAction = (typeof actions)[number]
type GithubListState = 'open' | 'closed' | 'all'
type GithubQuery = {
  action: GithubAction
  path: string
  ref?: string
  number?: number
  state: GithubListState
  page: number
}
export type GithubView = 'directory' | 'issue' | 'release' | 'issues' | 'pulls' | 'commit'
export type GithubRequest = {
  address: string
  source: string
  revision?: string
  path?: string
  raw?: boolean
  view?: GithubView
  repo: string
  page?: number
}

const githubRoot = ({ namespace }: GithubRepo) => 'https://github.com/' + namespace
const githubApi = ({ namespace }: GithubRepo) => 'https://api.github.com/repos/' + namespace
const githubRaw = ({ namespace }: GithubRepo) => 'https://raw.githubusercontent.com/' + namespace

const pathPart = (value: string) =>
  value && value !== '.' && value !== '..' && !/[\p{Cc}\\]/u.test(value)

export const githubQuery = (input: Record<string, unknown>): GithubQuery | undefined => {
  const { action: rawAction, path = '', ref, number, state = 'open', cursor } = input
  const action = actions.find((candidate) => candidate === rawAction)
  if (
    !action ||
    typeof path !== 'string' ||
    path.length > 512 ||
    (path && path.split('/').some((part) => !pathPart(part))) ||
    (ref !== undefined &&
      (typeof ref !== 'string' ||
        !ref ||
        ref.length > 160 ||
        ref.split('/').some((part) => !pathPart(part) || /[\s?#]/.test(part)))) ||
    (state !== 'open' && state !== 'closed' && state !== 'all')
  ) {
    return undefined
  }
  if (action === 'file' && !path) {
    return undefined
  }
  if (
    (action === 'issue' || action === 'pull') &&
    !(typeof number === 'number' && Number.isSafeInteger(number) && number > 0)
  ) {
    return undefined
  }
  const page =
    cursor === undefined
      ? 1
      : typeof cursor === 'string' && /^p\d{1,4}$/.test(cursor)
        ? Number(cursor.slice(1))
        : 0
  if (page < 1 || page > MAX_PAGE || (page > 1 && action !== 'issues' && action !== 'pulls')) {
    return undefined
  }
  return {
    action,
    path,
    ref: typeof ref === 'string' ? ref : undefined,
    number: typeof number === 'number' ? number : undefined,
    state,
    page,
  }
}

const linkState = (url: URL) => {
  const query = url.searchParams.get('q') ?? ''
  return /\bis:closed\b/.test(query) ? 'closed' : /\bis:open\b/.test(query) ? 'open' : 'all'
}

/** GitHub's raw and ordinary blob links are supported. Use explicit path and ref for nested branch names. */
export const githubLinkQuery = (repo: GithubRepo, url: URL): GithubQuery | undefined => {
  try {
    const [route, first, ...rest] = repo.path.map(decodeURIComponent)
    if (url.hostname === 'raw.githubusercontent.com' && route && first) {
      return githubQuery({ action: 'file', ref: route, path: [first, ...rest].join('/') })
    }
    if (!['github.com', 'www.github.com'].includes(url.hostname)) {
      return undefined
    }
    if (!route) {
      return githubQuery({ action: 'readme' })
    }
    if (route === 'blob' && first && rest.length) {
      return githubQuery({ action: 'file', path: rest.join('/'), ref: first })
    }
    if (route === 'tree' && first) {
      return githubQuery({ action: 'directory', path: rest.join('/'), ref: first })
    }
    if (route === 'issues' || route === 'pull' || route === 'pulls') {
      if (!first) {
        return githubQuery({
          action: route === 'issues' ? 'issues' : 'pulls',
          state: linkState(url),
        })
      }
      if (/^\d{1,12}$/.test(first)) {
        return githubQuery({ action: route === 'issues' ? 'issue' : 'pull', number: Number(first) })
      }
    }
    if (route === 'releases' && first === 'latest') {
      return githubQuery({ action: 'latest_release' })
    }
  } catch {
    // Invalid percent-encoding is handled as an ordinary URL read.
  }
  return undefined
}

export const needsGithubPin = ({ action }: GithubQuery) =>
  action === 'readme' || action === 'directory' || action === 'file'

export const githubPinKey = (repo: GithubRepo, ref?: string) => repo.key + ':' + (ref ?? 'HEAD')

export const githubPinRequests = (repo: GithubRepo, ref?: string): GithubRequest[] => {
  const api = githubApi(repo)
  const source = githubRoot(repo)
  const args = new URLSearchParams({ per_page: '1' })
  if (ref && ref !== 'HEAD') {
    args.set('sha', ref)
  }
  return [
    { address: api + '/commits?' + args, source, view: 'commit', repo: repo.key },
    ...(ref && ref !== 'HEAD'
      ? [
          {
            address: api + '/commits/' + encodeURIComponent(ref),
            source,
            view: 'commit' as const,
            repo: repo.key,
          },
        ]
      : []),
  ]
}

export const githubRequests = (
  repo: GithubRepo,
  { action, path, state, page, number }: GithubQuery,
  revision?: string
): GithubRequest[] => {
  const api = githubApi(repo)
  const site = githubRoot(repo)
  const scope = { repo: repo.key }
  if (revision) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    const tree = site + '/tree/' + revision
    const fixed = { ...scope, revision }
    if (action === 'readme') {
      return [
        {
          ...fixed,
          address: githubRaw(repo) + '/' + revision + '/README.md',
          source: site + '/blob/' + revision + '/README.md',
          path: 'README.md',
        },
        { ...fixed, address: api + '/readme?ref=' + revision, raw: true, source: tree },
      ]
    }
    if (action === 'file') {
      const source = site + '/blob/' + revision + '/' + encodedPath
      return [
        {
          ...fixed,
          path,
          address: githubRaw(repo) + '/' + revision + '/' + encodedPath,
          source,
        },
        {
          ...fixed,
          path,
          address: api + '/contents/' + encodedPath + '?ref=' + revision,
          raw: true,
          source,
        },
      ]
    }
    if (action === 'directory') {
      const suffix = encodedPath ? '/' + encodedPath : ''
      const source = tree + suffix
      return [
        {
          ...fixed,
          path,
          address: api + '/contents' + suffix + '?ref=' + revision,
          source,
          view: 'directory',
        },
      ]
    }
  }
  if (action === 'issue' || action === 'pull') {
    const source = site + '/' + (action === 'issue' ? 'issues/' : 'pull/') + number
    return [
      {
        ...scope,
        address: api + '/' + (action === 'issue' ? 'issues/' : 'pulls/') + number,
        source,
        view: 'issue',
      },
      { ...scope, address: source, source },
    ]
  }
  if (action === 'issues' || action === 'pulls') {
    const args = new URLSearchParams({
      state,
      sort: 'created',
      direction: 'desc',
      per_page: String(PAGE_SIZE),
      page: String(page),
    })
    const address = api + '/' + action + '?' + args
    return [{ ...scope, address, source: address, view: action, page }]
  }
  if (action === 'latest_release') {
    const source = site + '/releases/latest'
    return [
      { ...scope, address: api + '/releases/latest', source, view: 'release' },
      { ...scope, address: source, source },
    ]
  }
  return []
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const str = (value: unknown) => (typeof value === 'string' ? value : '')

const nextPage = (link: string | undefined, current: number) => {
  // Only use the page number from the provider header. Never follow a header-supplied destination.
  const match = /<([^>]+)>;\s*rel="next"/i.exec(link ?? '')
  const url = match && publicWebUrl(match[1])
  const page = url?.hostname === 'api.github.com' ? Number(url.searchParams.get('page')) : 0
  return Number.isSafeInteger(page) && page === current + 1 && page <= MAX_PAGE
    ? 'p' + page
    : undefined
}

type GithubPage = {
  title: string
  content: string
  source?: string
  links: string[]
  nextCursor?: string
  sourceTruncated?: boolean
}

export const parseGithubData = (
  value: unknown,
  request: GithubRequest,
  link?: string
): GithubPage | undefined => {
  const { view, repo, revision, page } = request
  if (view === 'commit') {
    const sha = object(Array.isArray(value) ? value[0] : value).sha
    return commitSha(sha)
      ? { title: 'Repository commit', content: sha.toLowerCase(), links: [] }
      : undefined
  }
  if (view === 'directory') {
    if (!Array.isArray(value) || !revision) {
      return undefined
    }
    const entries = value.slice(0, 1000).map(object)
    return {
      title: request.path || 'GitHub repository',
      content:
        entries
          .map(({ path, type, size }) =>
            [str(type), str(path), typeof size === 'number' ? size + ' B' : '']
              .filter(Boolean)
              .join('\t')
          )
          .join('\n') || 'Empty directory.',
      links: [],
      sourceTruncated: value.length >= 1000,
    }
  }
  if (view === 'issues' || view === 'pulls') {
    if (!Array.isArray(value)) {
      return undefined
    }
    const entries = value
      .slice(0, PAGE_SIZE)
      .map(object)
      .filter((item) => view === 'pulls' || !item.pull_request)
      .flatMap((item) => {
        if (
          typeof item.number !== 'number' ||
          !Number.isSafeInteger(item.number) ||
          item.number < 1
        ) {
          return []
        }
        const url =
          'https://github.com/' + repo + (view === 'issues' ? '/issues/' : '/pull/') + item.number
        return [
          {
            url,
            number: item.number,
            title: str(item.title).slice(0, 240),
            state: str(item.state).slice(0, 24),
            updatedAt: str(item.updated_at).slice(0, 40),
            description: str(item.body).slice(0, 480),
          },
        ]
      })
    return {
      title: view === 'issues' ? 'GitHub Issues' : 'GitHub pull requests',
      content: JSON.stringify(entries),
      links: entries.map((entry) => entry.url),
      nextCursor: nextPage(link, page ?? 1),
      sourceTruncated: value.length > PAGE_SIZE,
    }
  }
  const data = object(value)
  const title = str(data.title) || str(data.name) || str(data.tag_name)
  if (!title && !str(data.body)) {
    return undefined
  }
  const sourceUrl = publicWebUrl(data.html_url)
  const source =
    sourceUrl &&
    ['github.com', 'www.github.com'].includes(sourceUrl.hostname) &&
    githubRepo(sourceUrl)?.key === repo
      ? sourceUrl.href
      : undefined
  return {
    title: title.slice(0, 240),
    source,
    content: [
      title,
      str(data.tag_name),
      str(data.state),
      str(data.published_at) || str(data.updated_at),
      str(data.body),
    ]
      .filter(Boolean)
      .join('\n\n'),
    links: [],
  }
}
