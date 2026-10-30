export function beginDetailRead<Result>(
  request: () => Promise<Result>,
  loaded: (result: Result) => void,
  failed: (reason: unknown) => void
): () => void {
  let active = true
  void Promise.resolve()
    .then(request)
    .then((result) => {
      if (active) loaded(result)
    })
    .catch((reason: unknown) => {
      if (active) failed(reason)
    })
  return () => {
    active = false
  }
}
