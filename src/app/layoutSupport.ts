/** Chrome 74 接受 gap 的语法但只会在 grid 上生效。为旧 WebView 的实际 flex 布局提供间距。 */
export const detectFlexSpacing = () => {
  const box = document.createElement('div')
  box.style.cssText =
    'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px;top:0;left:0'
  box.append(document.createElement('i'), document.createElement('i'))
  document.body.appendChild(box)
  document.documentElement.toggleAttribute('data-legacy-spacing', box.scrollHeight !== 1)
  box.remove()
}
