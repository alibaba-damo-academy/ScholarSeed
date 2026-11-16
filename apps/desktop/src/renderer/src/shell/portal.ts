export async function preparePortalDocument(popup: Window): Promise<() => void> {
  popup.opener = null
  const target = popup.document
  target.title = document.title
  target.body.className = '!bg-transparent opacity-0'
  target.body.inert = true
  const policy = target.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "script-src 'none'; object-src 'none'; base-uri 'none'"
  target.head.append(policy)
  const synchronizeTheme = (): void => {
    target.documentElement.className = document.documentElement.className
    target.documentElement.classList.add('!bg-transparent')
    target.documentElement.lang = document.documentElement.lang
    target.documentElement.dataset.theme = document.documentElement.dataset.theme
    target.documentElement.style.cssText = document.documentElement.style.cssText
  }
  synchronizeTheme()
  const loads: Promise<void>[] = []
  for (const source of document.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
    'style, link[rel="stylesheet"]'
  )) {
    const clone = target.importNode(source, true)
    if (clone.tagName === 'LINK') {
      ;(clone as HTMLLinkElement).href = (source as HTMLLinkElement).href
      loads.push(
        new Promise((resolve, reject) => {
          clone.onload = () => resolve()
          clone.onerror = () => reject(new Error('native_portal_stylesheet_failed'))
        })
      )
    }
    target.head.append(clone)
  }
  await Promise.all(loads)
  await target.fonts.ready
  const observer = new MutationObserver(synchronizeTheme)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'lang', 'data-theme'],
  })
  return () => observer.disconnect()
}
