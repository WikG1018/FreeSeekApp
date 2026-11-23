import { publicWebUrl } from './publicWeb.js'

export type BrowserLink = { id: number; label: string; url: string }
export type BrowserPage = {
  url: string
  title: string
  text: string
  html: string
  links: BrowserLink[]
  headings: string[]
  truncated: boolean
}

const layout = new Set(
  'a article blockquote br caption code dd details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr li main mark ol p pre s section small strong sub summary sup table tbody td th thead tr ul'.split(
    ' '
  )
)
const skip =
  'script,style,iframe,object,embed,noscript,template,canvas,svg,video,audio,form,input,select,textarea,button,meta,link,base,[hidden],[aria-hidden=true]'
const MAX_LINKS = 80
const MAX_TEXT = 150_000

export const readerPage = (
  source: string,
  url: URL,
  contentType: string,
  truncated: boolean
): BrowserPage => {
  const input = document.createElement('template')
  const html = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
  if (html) {
    input.innerHTML = source
  } else {
    const pre = document.createElement('pre')
    pre.textContent = source.slice(0, MAX_TEXT)
    input.content.append(pre)
  }
  const title =
    input.content.querySelector('title')?.textContent?.trim().slice(0, 240) || url.hostname
  input.content.querySelectorAll('title,' + skip).forEach((node) => node.remove())
  const body = input.content.querySelector('main, [role=main], article') || input.content
  const output = document.createElement('article')
  const links: BrowserLink[] = []
  const headings: string[] = []
  let count = 0
  let characters = 0
  // Copy a bounded subset of page layout. The preview uses only these created nodes.
  const append = (node: Node, target: Element, depth: number) => {
    if (depth > 48 || count++ >= 4500 || characters >= MAX_TEXT) {
      truncated = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue?.slice(0, MAX_TEXT - characters) ?? ''
      target.append(document.createTextNode(text))
      characters += text.length
      return
    }
    if (!(node instanceof Element)) {
      return
    }
    const tag = node.localName
    let next = target
    if (layout.has(tag)) {
      next = document.createElement(tag === 'a' ? 'span' : tag)
      target.append(next)
    }
    if (tag === 'a' && links.length < MAX_LINKS) {
      const href = publicWebUrl(node.getAttribute('href'), url)
      const label = node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160)
      if (
        href &&
        label &&
        url.href !== href.href &&
        !links.some((link) => link.url === href.href)
      ) {
        const id = links.length + 1
        links.push({ id, label, url: href.href })
        next.className = 'source-link'
        next.setAttribute('data-link', String(id))
      }
    }
    if (/^h[1-6]$/.test(tag) && headings.length < 28) {
      const label = node.textContent?.trim().slice(0, 180)
      if (label) {
        headings.push(label)
      }
    }
    for (const child of Array.from(node.childNodes)) {
      if (characters >= MAX_TEXT || count >= 4500) {
        truncated = true
        break
      }
      append(child, next, depth + 1)
    }
  }
  for (const node of Array.from(body.childNodes)) {
    if (characters >= MAX_TEXT || count >= 4500) {
      truncated = true
      break
    }
    append(node, output, 0)
  }
  const preview = output.outerHTML
  output
    .querySelectorAll('p,li,div,pre,tr,th,td,h1,h2,h3,h4,h5,h6,br,section')
    .forEach((node) => node.after(document.createTextNode('\n')))
  const text = (output.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, url: url.href, text, html: preview, links, headings, truncated }
}

export const readerDocument = (page: BrowserPage, dark: boolean) =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \x27none\x27; style-src \x27unsafe-inline\x27; base-uri \x27none\x27; form-action \x27none\x27">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>:root{color-scheme:' +
  (dark ? 'dark' : 'light') +
  '}body{margin:0;padding:18px;background:Canvas;color:CanvasText;' +
  'font:15px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap;' +
  'padding:10px;border-radius:8px;background:color-mix(in srgb,CanvasText 7%,Canvas)}table{border-collapse:collapse}' +
  'td,th{padding:4px 8px;border:1px solid GrayText}.source-link{color:LinkText;text-decoration:underline;cursor:pointer}</style>' +
  '</head><body>' +
  page.html +
  '</body></html>'
