const URL_CONTROL_CHARACTERS = /\p{Cc}/u

export function citationDisplay(source: { title: string; url: string }): {
  title: string
  url: string
} {
  let url = source.url
  try {
    const decoded = decodeURI(url)
    if (!URL_CONTROL_CHARACTERS.test(decoded)) url = decoded
  } catch {
    url = source.url
  }
  return {
    title: source.title.trim() === source.url.trim() ? url : source.title,
    url,
  }
}
