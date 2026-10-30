// Generated from native/security.json; DO NOT EDIT.
const crypto = require('node:crypto')
const POLICY_HASH = "315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4"
const SIDS = Object.freeze({"system":"S-1-5-18","administrators":"S-1-5-32-544","trusted_installer":"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464","owner_rights":"S-1-3-4","everyone":"S-1-1-0","authenticated_users":"S-1-5-11"})
const LEASE_STATE = Object.freeze(["$user","S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"])
const LEASE_GRANT = Object.freeze(["$user","S-1-5-18","S-1-5-32-544"])
function recordDenial(error, profile, stage, resource) {
  try {
    if(error.permissionRecorded) return
    error.permissionIncidentId=error.permissionIncidentId||crypto.randomUUID()
    const code=typeof error.code==='string' && /^(?:ERR_[A-Z0-9_]{1,64}|EACCES|EPERM)$/.test(error.code) ? error.code : 'permission_denied'
    const system=Number.isInteger(error.systemCode)?error.systemCode:Number.isInteger(error.errno)?error.errno:0
    const reason={"5":"os_access_denied","1223":"authorization_cancelled","1300":"privilege_not_held","1314":"privilege_not_held"}[String(system)]||(['EACCES','EPERM'].includes(code)?'os_access_denied':'policy_denied')
    console.error(JSON.stringify({schema:1,event:"permission_rejected",policy_hash:POLICY_HASH,profile:["installation","machine_authority","tool_owner","tool_writer","recovery_owner","recovery_writer","private_owner","private_writer","lease_state","lease_grant","native_directory","startup_mutex","tool_access","windows_api"].includes(profile)?profile:'unknown',stage:["owner","acl","inspect","binding","grant","lock","setup","recovery","private"].includes(stage)?stage:'unknown',reason,code,system_code:system,error_type:error.constructor?.name||'Error',correlation_id:error.permissionIncidentId,pid:process.pid,subject_kind:'unknown',target_id:crypto.createHash('sha256').update(resource).digest('hex').slice(0,16)}))
    error.permissionRecorded=true
  } catch {}
}
module.exports={SIDS,LEASE_STATE,LEASE_GRANT,recordDenial}
