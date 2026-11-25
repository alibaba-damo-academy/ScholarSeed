const VERSION = /^([a-z0-9][a-z0-9.-]{0,62})-r[1-9][0-9]*$/

// A private registry revision can move independently of the client-facing component.
function ciCacheVersion(target, kind, defaultVersion, environment = process.env) {
  const suffix = (target + '_' + kind).replaceAll('-', '_').toUpperCase()
  const version = environment['SCHOLARSEED_CI_CACHE_VERSION_' + suffix] ?? defaultVersion
  const upstream = typeof defaultVersion === 'string' && VERSION.exec(defaultVersion)?.[1]
  if (!upstream || typeof version !== 'string' || version.length > 255 || VERSION.exec(version)?.[1] !== upstream ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(version))
    throw new Error('Invalid private CI cache version for ' + target + '/' + kind)
  return version
}

module.exports = {ciCacheVersion}
