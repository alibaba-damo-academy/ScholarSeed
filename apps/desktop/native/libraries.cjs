// Exact platform-specific native closure; Windows includes the pinned Velopack SDK.
function libraries(platform = process.platform) {
  return Object.freeze([
    'lease.node',
    'fonts.node',
    ...(platform === 'win32' ? ['notification.node', 'velopack.node'] : []),
    ...(platform === 'darwin' ? ['notarization.node', 'repair.node'] : []),
  ])
}
const LIBRARIES = libraries()
const BUNDLED_LIBRARIES = Object.freeze(LIBRARIES.map((name) => `out/main/${name}`))
module.exports = { LIBRARIES, BUNDLED_LIBRARIES, libraries }
