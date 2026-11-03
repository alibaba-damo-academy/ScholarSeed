// Exact native inputs frozen into each signed product's build receipt.
const SHIPIT_OVERLAYS = [
  'cleanup.h', 'cleanup.m', 'cleanup.patch',
  'preparation.h', 'preparation.m', 'preparation.patch',
  'readiness.h', 'readiness.m',
  'admission.h', 'admission.patch',
  'binding.h', 'binding.patch', 'authorization.patch', 'recovery.patch',
]
const SQUIRREL_OVERLAYS = ['readiness.h', 'readiness.m', 'readinesswait.h', 'readiness.patch', 'binding.h', 'binding.patch', 'transfer.patch']
module.exports = { SHIPIT_OVERLAYS, SQUIRREL_OVERLAYS }
