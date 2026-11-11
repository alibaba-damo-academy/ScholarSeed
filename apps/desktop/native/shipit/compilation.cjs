const SUPPORT_UNITS = Object.freeze(['cleanup.m', 'preparation.m', 'readiness.m'])
const REPAIR_FRAMEWORKS = Object.freeze(['Foundation', 'AppKit', 'Security', 'ServiceManagement'])
const REPAIR_FLAGS = Object.freeze([
  '-fobjc-arc', '-fblocks', '-Wno-deprecated-declarations',
  ...REPAIR_FRAMEWORKS.flatMap(name => ['-framework', name]),
])

module.exports = { SUPPORT_UNITS, REPAIR_FRAMEWORKS, REPAIR_FLAGS }
