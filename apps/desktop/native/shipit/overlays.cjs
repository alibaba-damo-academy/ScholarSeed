// Exact native inputs frozen into each signed product's build receipt.
const SHIPIT_OVERLAYS = [
  'cleanup.h', 'cleanup.m', 'cleanup.patch',
  'preparation.h', 'preparation.m', 'preparation.patch',
  'readiness.h', 'readiness.m',
  'observation.h',
  'retirement.h',
  'admission.h', 'admission.patch',
  'binding.h', 'binding.patch', 'authorization.patch', 'recovery.patch',
  'succession.h', 'metadata.patch',
]
const SQUIRREL_OVERLAYS = [
  'readiness.h', 'readiness.m', 'readinesswait.h', 'readiness.patch',
  'observation.h',
  'binding.h', 'binding.patch', 'transfer.patch', 'interaction.patch',
  'successor.h', 'successor.m', 'successor.patch',
]
module.exports = { SHIPIT_OVERLAYS, SQUIRREL_OVERLAYS }
