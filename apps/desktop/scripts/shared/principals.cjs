// Named purpose-specific profiles share SID literals, never implicit privileges.
function compilePrincipals(policy, goName) {
  const catalog = policy.principals
  const profiles = policy.profiles
  if (new Set(Object.values(catalog).map((item) => item.sid)).size !== Object.keys(catalog).length)
    throw Error('duplicate principal SID')
  const known = (value) => typeof value === 'string' && /^[a-z_]+$/.test(value)
  for (const [name, item] of Object.entries(catalog)) {
    if (
      !known(name) ||
      typeof item.sid !== 'string' ||
      (item.alias && !/^[A-Z]{2}$/.test(item.alias))
    )
      throw Error('invalid principal catalog')
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (
      !known(name) ||
      typeof profile.current_user !== 'boolean' ||
      !Array.isArray(profile.allow) ||
      profile.allow.some((member) => !Object.hasOwn(catalog, member)) ||
      new Set(profile.allow).size !== profile.allow.length ||
      profile.allow.includes('owner_rights') ||
      (profile.owner_alias && profile.administrator_member) ||
      ['exclude_executor', 'administrator_member', 'owner_alias'].some(
        (key) => Object.hasOwn(profile, key) && typeof profile[key] !== 'boolean'
      ) ||
      Object.keys(profile).some(
        (key) =>
          ![
            'current_user',
            'allow',
            'exclude_executor',
            'administrator_member',
            'owner_alias',
          ].includes(key)
      )
    )
      throw Error('invalid permission profile')
  }
  const descriptor =
    'D:' +
    (policy.mutex.protected ? 'P' : '') +
    policy.mutex.aces
      .map((ace) => {
        if (!catalog[ace.principal]?.alias || !/^0x[0-9a-f]{8}$/.test(ace.mask))
          throw Error('invalid mutex grant')
        return `(A;;${ace.mask};;;${catalog[ace.principal].alias})`
      })
      .join('')
  const diagnostics = policy.diagnostics
  const profileNames = [...Object.keys(profiles), ...diagnostics.additional_profiles]
  function methods(lang) {
    const isGo = lang === 'go'
    return Object.entries(profiles)
      .filter(([name]) => name !== 'installation')
      .map(([name, profile]) => {
        const args = ['principal' + (isGo ? ' string' : ': str')]
        const terms = profile.allow.map(
          (member) =>
            `principal == ${isGo ? 'Sid' + goName(member) : 'SID_' + member.toUpperCase()}`
        )
        if (profile.current_user) {
          args.push('user' + (isGo ? ' string' : ': str'))
          terms.unshift('principal == user')
        }
        if (profile.owner_alias) {
          args.push('owner' + (isGo ? ' string' : ': str'))
          const ownerTerms = terms
            .map((term) => term.replace(/\bprincipal\b/g, 'owner'))
            .join(isGo ? ' || ' : ' or ')
          terms.push(
            `(principal == ${isGo ? 'SidOwnerRights' : 'SID_OWNER_RIGHTS'} ${isGo ? '&& owner != \"\" &&' : 'and bool(owner) and'} (${ownerTerms}))`
          )
        }
        if (profile.exclude_executor) args.push('executor' + (isGo ? ' string' : ': str'))
        if (profile.administrator_member) {
          args.push(isGo ? 'administratorMember bool' : 'administrator_member: bool')
          terms.push(
            isGo
              ? '(principal == SidAdministrators && administratorMember)'
              : '(principal == SID_ADMINISTRATORS and administrator_member)'
          )
        }
        const expr =
          `${isGo ? 'principal != ""' : 'bool(principal)'} ${isGo ? '&&' : 'and'} (${terms.join(isGo ? ' || ' : ' or ') || (isGo ? 'false' : 'False')})` +
          (profile.exclude_executor ? ` ${isGo ? '&&' : 'and'} principal != executor` : '')
        return isGo
          ? `func ${goName(name)}(${args.join(', ')}) bool { return ${expr} }`
          : `def ${name}(${args.join(', ')}) -> bool:\n    return ${expr}\n`
      })
      .join('\n\n')
  }
  const go =
    Object.entries(catalog)
      .map(([name, item]) => `const Sid${goName(name)} = ${JSON.stringify(item.sid)}`)
      .join('\n') +
    '\n' +
    `const DiagnosticSchema = ${diagnostics.schema}\nconst DiagnosticEvent = ${JSON.stringify(diagnostics.event)}\n` +
    [
      ['Profile', profileNames],
      ['Stage', diagnostics.stages],
      ['Reason', diagnostics.reasons],
    ]
      .map(
        ([kind, names]) =>
          `func Diagnostic${kind}(value string) string { switch value { case ${names.map(JSON.stringify).join(', ')}: return value }; return "unknown" }`
      )
      .join('\n') +
    '\n\n' +
    methods('go')
  const py =
    Object.entries(catalog)
      .map(([name, item]) => `SID_${name.toUpperCase()} = ${JSON.stringify(item.sid)}`)
      .join('\n') +
    '\n\n' +
    methods('py')
  const pythonDiagnostics = `
def record_denial(error: Exception, profile: str, stage: str, reason: str, *, logger=None, resource=None) -> None:
    """Observation never replaces the original exception or publishes its text."""
    try:
        if getattr(error, "permission_recorded", False):
            return
        incident = getattr(error, "permission_incident_id", None) or uuid.uuid4().hex
        setattr(error, "permission_incident_id", incident)
        system = getattr(error, "winerror", None) or getattr(error, "errno", None)
        code = getattr(error, "code", "permission_denied")
        event = {
            "schema": ${diagnostics.schema}, "event": ${JSON.stringify(diagnostics.event)}, "policy_hash": POLICY_HASH,
            "profile": profile if profile in ${JSON.stringify(profileNames)} else "unknown",
            "stage": stage if stage in ${JSON.stringify(diagnostics.stages)} else "unknown",
            "reason": ${JSON.stringify(diagnostics.system_reasons)}.get(str(getattr(error, "winerror", None) or (system if sys.platform == "win32" else 0))) or ("os_access_denied" if isinstance(error, PermissionError) else ("os_error" if isinstance(error, OSError) and system else (reason if reason in ${JSON.stringify(diagnostics.reasons)} else "unknown"))),
            "code": code if isinstance(code, str) and re.fullmatch(r"(?:ERR_[A-Z0-9_]{1,64}|EACCES|EPERM|permission_denied)", code) else "permission_denied",
            "system_code": system if isinstance(system, int) and not isinstance(system, bool) else 0,
            "error_type": type(error).__name__, "correlation_id": incident, "pid": os.getpid(),
            "subject_kind": ${JSON.stringify(diagnostics.subjects)}.get(reason, "unknown"),
        }
        trace = error.__traceback__
        for _ in range(8):
            if trace is None or trace.tb_next is None:
                break
            trace = trace.tb_next
        if trace is not None:
            event["site"] = {"file": os.path.basename(trace.tb_frame.f_code.co_filename), "function": trace.tb_frame.f_code.co_name, "line": trace.tb_lineno}
        if resource is not None:
            event["target_id"] = hashlib.sha256(str(resource).encode("utf-8", errors="surrogatepass")).hexdigest()[:16]
        (logger or logging.getLogger("scholarseed.permission")).warning("permission_rejected %s", json.dumps(event, separators=(",", ":")))
        setattr(error, "permission_recorded", True)
    except Exception:
        pass
`
  const imports =
    'import hashlib\nimport json\nimport logging\nimport os\nimport re\nimport sys\nimport uuid\n'
  const js = `// Generated from native/security.json; DO NOT EDIT.\nconst crypto = require('node:crypto')\nconst POLICY_HASH = "__POLICY_HASH__"\nconst SIDS = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(catalog).map(([name, item]) => [name, item.sid])))})\nconst LEASE_STATE = Object.freeze(${JSON.stringify([...(profiles.lease_state.current_user ? ['$user'] : []), ...profiles.lease_state.allow.map((name) => catalog[name].sid)])})\nconst LEASE_GRANT = Object.freeze(${JSON.stringify([...(profiles.lease_grant.current_user ? ['$user'] : []), ...profiles.lease_grant.allow.map((name) => catalog[name].sid)])})\nfunction recordDenial(error, profile, stage, resource) {\n  try {\n    if(error.permissionRecorded) return\n    error.permissionIncidentId=error.permissionIncidentId||crypto.randomUUID()\n    const code=typeof error.code==='string' && /^(?:ERR_[A-Z0-9_]{1,64}|EACCES|EPERM)$/.test(error.code) ? error.code : 'permission_denied'\n    const system=Number.isInteger(error.systemCode)?error.systemCode:Number.isInteger(error.errno)?error.errno:0\n    const reason=${JSON.stringify(diagnostics.system_reasons)}[String(system)]||(['EACCES','EPERM'].includes(code)?'os_access_denied':'policy_denied')\n    console.error(JSON.stringify({schema:${diagnostics.schema},event:${JSON.stringify(diagnostics.event)},policy_hash:POLICY_HASH,profile:${JSON.stringify(profileNames)}.includes(profile)?profile:'unknown',stage:${JSON.stringify(diagnostics.stages)}.includes(stage)?stage:'unknown',reason,code,system_code:system,error_type:error.constructor?.name||'Error',correlation_id:error.permissionIncidentId,pid:process.pid,subject_kind:'unknown',target_id:crypto.createHash('sha256').update(resource).digest('hex').slice(0,16)}))\n    error.permissionRecorded=true\n  } catch {}\n}\nmodule.exports={SIDS,LEASE_STATE,LEASE_GRANT,recordDenial}\n`
  const subjectGo = `func DiagnosticSubject(reason string) string { switch reason { ${Object.entries(
    diagnostics.subjects
  )
    .map(([reason, kind]) => `case ${JSON.stringify(reason)}: return ${JSON.stringify(kind)}`)
    .join('; ')} }; return "unknown" }`
  const subjectC = `static inline const char *sc_diagnostic_subject(const char *reason) { ${Object.entries(
    diagnostics.subjects
  )
    .map(
      ([reason, kind]) =>
        `if (!strcmp(reason, ${JSON.stringify(reason)})) return ${JSON.stringify(kind)};`
    )
    .join(' ')} return "unknown"; }`
  const nativeGo = `func DiagnosticSystemReason(code uint32) string { switch code { ${Object.entries(
    diagnostics.system_reasons
  )
    .map(([code, reason]) => `case ${Number(code)}: return ${JSON.stringify(reason)}`)
    .join('; ')} }; return "" }`
  const nativeC = `static inline const char *sc_diagnostic_system_reason(uint32_t code) { switch(code) { ${Object.entries(
    diagnostics.system_reasons
  )
    .map(([code, reason]) => `case ${Number(code)}: return ${JSON.stringify(reason)};`)
    .join(' ')} } return NULL; }`
  return {
    go: go + '\n' + subjectGo + '\n' + nativeGo,
    py,
    pythonDiagnostics,
    imports,
    descriptor,
    js,
    subjectC: subjectC + '\n' + nativeC,
  }
}
module.exports = { compilePrincipals }
