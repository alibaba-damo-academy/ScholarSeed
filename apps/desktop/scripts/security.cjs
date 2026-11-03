// Compile the bounded ACL decision IR into all consumers. No runtime policy loading.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { lowerPolicy } = require('./shared/policy.cjs')
const { compilePrincipals } = require('./shared/principals.cjs')
const root = path.resolve(__dirname, '../../..')
const input = fs.readFileSync(path.join(root, 'apps/desktop/native/security.json'))
const source = JSON.parse(input)
if (source.schema !== 2) throw new Error('unsupported ACL policy schema')

const policy = lowerPolicy(source)
const principalCode = compilePrincipals(policy, s => s.split('_').map(p=>p[0].toUpperCase()+p.slice(1)).join(''))
const hash = crypto.createHash('sha256').update(input).digest('hex')
const fields = {principal:'u32',mask:'u32',flags:'u32',deny:'bool',trusted:'bool',universal:'bool',allow_subject:'bool',deny_subject:'bool'}
const goName = s => s.split('_').map(p=>p[0].toUpperCase()+p.slice(1)).join('')

// SID literals are validated and serialized once at build time. Adapters only
// supply the actual OS principal/current user; they do not choose authorities.
function sidBytes(sid) {
  if (typeof sid !== 'string' || !/^S-1-(0|[1-9][0-9]*)(-(0|[1-9][0-9]*))*$/.test(sid))
    throw Error('invalid authority SID')
  const [, revision, authority, ...parts] = sid.split('-')
  if (revision !== '1' || BigInt(authority) >= 2n ** 48n || parts.length > 15 ||
      parts.some(part => BigInt(part) > 0xffffffffn)) throw Error('invalid authority SID bounds')
  const bytes = Buffer.alloc(8 + parts.length * 4)
  bytes[0] = 1
  bytes[1] = parts.length
  let identifier = BigInt(authority)
  for (let index = 7; index >= 2; index--) {
    bytes[index] = Number(identifier & 255n)
    identifier >>= 8n
  }
  parts.forEach((part, index) => bytes.writeUInt32LE(Number(part), 8 + index * 4))
  return bytes
}
const authorities = policy.authorities
if (!authorities || authorities.current_user !== true || !Array.isArray(authorities.sids) ||
    new Set(authorities.sids).size !== authorities.sids.length) throw Error('invalid installation authorities')
const authorityBytes = authorities.sids.map(sidBytes)
for(const item of Object.values(policy.principals)) sidBytes(item.sid)
function authorityCode(lang) {
  if (lang === 'go') return `func Authority(principal, user string) bool {
    return principal != "" && (principal == user${authorities.sids.map(sid => ` || principal == ${JSON.stringify(sid)}`).join('')})
}
`
  if (lang === 'py') return `INSTALLATION_AUTHORITIES = frozenset((
${authorityBytes.map(bytes => `    bytes.fromhex("${bytes.toString('hex')}"),`).join('\n')}
))

def authority(principal: bytes, user: bytes) -> bool:
    return bool(principal) and (principal == user or principal in INSTALLATION_AUTHORITIES)
`
  return `${authorityBytes.map((bytes, index) => `static const unsigned char sc_authority_${index}[] = {${[...bytes].join(', ')}};`).join('\n')}
static inline bool sc_authority(const void *principal, size_t principal_len, const void *user, size_t user_len) {
    if (!principal || !principal_len) return false;
    if (user && principal_len == user_len && !memcmp(principal, user, user_len)) return true;
${authorityBytes.map((bytes, index) => `    if (principal_len == sizeof(sc_authority_${index}) && !memcmp(principal, sc_authority_${index}, principal_len)) return true;`).join('\n')}
    return false;
}
`
}
function generate(lang) {
  const name = n => lang==='go' ? goName(n) : lang==='c' ? 'sc_'+n : n
  const type = t => ({c:{u32:'uint32_t',int:'int',bool:'bool',result:'struct sc_result'},go:{u32:'uint32',int:'int',bool:'bool',result:'Result'},py:{u32:'int',int:'int',bool:'bool',result:'Result'}}[lang][t])
  const expr = v => {
    if (typeof v==='number') return String(v)
    if (typeof v==='boolean') return lang==='py' ? (v?'True':'False') : String(v)
    if (typeof v==='string') { if (!/^[a-z_]+$/.test(v)) throw Error('invalid IR identifier'); return v }
    const [op,...a]=v
    if(op==='length')return lang==='c'?'entries_len':'len(entries)'
    if(op==='entry')return `entries[${expr(a[0])}].${lang==='go'?goName(a[1]):a[1]}`
    if(op==='invert')return lang==='py'?`((~${expr(a[0])}) & 4294967295)`:(lang==='go'?`(^uint32(${expr(a[0])}))`:`(~(uint32_t)(${expr(a[0])}))`)
    if(op==='not')return `(${lang==='py'?'not ':'!'}${expr(a[0])})`
    if(op==='bin') {
      const [operator,x,y]=a
      if(!['&','|','==','!=','>=','&&','||'].includes(operator))throw Error('unsupported IR operator')
      return `(${expr(x)} ${lang==='py'?({'&&':'and','||':'or'}[operator]||operator):operator} ${expr(y)})`
    }
    if(op==='call') {
      const [fn,...args]=a
      if(!policy.functions.some(f=>f.name===fn))throw Error('unknown IR function')
      return `${name(fn)}(${args.flatMap(x=>x==='entries'&&lang==='c'?['entries','entries_len']:[expr(x)]).join(', ')})`
    }
    if(op==='result') return lang==='c'?`(struct sc_result){${a.map(expr).join(', ')}}`:lang==='go'?`Result{${a.map(expr).join(', ')}}`:`Result(${a.map(expr).join(', ')})`
    throw Error('unsupported IR expression '+op)
  }
  function body(stmts,indent=1) {
    const pad='    '.repeat(indent),out=[]
    for(const [op,...a] of stmts) {
      const end=lang==='py'?'':';'
      if(op==='let')out.push(pad+(lang==='go'?`var ${a[0]} ${type(a[1])} = ${expr(a[2])}`:lang==='c'?`${type(a[1])} ${a[0]} = ${expr(a[2])}`:`${a[0]} = ${expr(a[2])}`)+end)
      else if(op==='set')out.push(pad+`${expr(a[0])} = ${expr(a[1])}`+end)
      else if(op==='return')out.push(pad+'return '+expr(a[0])+end)
      else if(op==='if') { const condition=expr(a[0]);out.push(pad+(lang==='py'?`if ${condition}:`:lang==='go'?`if ${condition} {`:`if ${condition.startsWith('(')?condition:'('+condition+')'} {`),body(a[1],indent+1),...(lang==='py'?[]:[pad+'}'])) }
      else if(op==='for') {
        const [n,start,end,inner]=a
        out.push(pad+(lang==='py'?`for ${n} in range(${expr(start)}, ${expr(end)}):`:lang==='go'?`for ${n} := ${expr(start)}; ${n} < ${expr(end)}; ${n}++ {`:`for (int ${n} = ${expr(start)}; ${n} < ${expr(end)}; ${n}++) {`),body(inner,indent+1),...(lang==='py'?[]:[pad+'}']))
      } else throw Error('unsupported IR statement '+op)
    }
    return out.join('\n')
  }
  let header
  if(lang==='c')header=`// Generated from security.json; schema=${policy.schema} sha256=${hash}\n#ifndef SCHOLARSEED_SECURITY_H\n#define SCHOLARSEED_SECURITY_H\n#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n#include <string.h>\n#define SC_POLICY_HASH "${hash}"\n#define SC_DIAGNOSTIC_SCHEMA ${policy.diagnostics.schema}\n#define SC_DIAGNOSTIC_EVENT ${JSON.stringify(policy.diagnostics.event)}\nstruct sc_entry { ${Object.entries(fields).map(([n,t])=>`${type(t)} ${n};`).join(' ')} };\nstruct sc_result { int reason; int index; uint32_t mask; int scope; };\n`
  if(lang==='go')header=`// Code generated from security.json; DO NOT EDIT. Schema=${policy.schema} sha256=${hash}\npackage security\nconst PolicyHash = "${hash}"\ntype Entry struct { ${Object.entries(fields).map(([n,t])=>`${goName(n)} ${type(t)} \`json:"${n}"\``).join('; ')} }\ntype Result struct { Reason int; Index int; Mask uint32; Scope int }\n`
  if(lang==='py')header=`# Generated from security.json; DO NOT EDIT. schema=${policy.schema} sha256=${hash}\n${principalCode.imports}from dataclasses import dataclass\nfrom collections.abc import Sequence\n\nPOLICY_HASH = "${hash}"\n\n@dataclass(frozen=True)\nclass Entry:\n${Object.entries(fields).map(([n,t])=>`    ${n}: ${type(t)}`).join('\n')}\n\n    def __post_init__(self) -> None:\n        for value in (self.principal, self.mask, self.flags):\n            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 4294967295:\n                raise ValueError("ACL input must be uint32")\n\n@dataclass(frozen=True)\nclass Result:\n    reason: int\n    index: int\n    mask: int\n    scope: int\n`
  header += Object.entries(policy.roles).map(([n,v])=>lang==='c'?`#define SC_ROLE_${n.toUpperCase()} ${v}`:lang==='go'?`const Role${goName(n)} = ${v}`:`ROLE_${n.toUpperCase()} = ${v}`).join('\n')+'\n'
  const functions=policy.functions.map(f=>{
    const args=f.args.flatMap(([n,t])=>t==='entries'?(lang==='c'?[`const struct sc_entry *${n}`,'int entries_len']:lang==='go'?[`${n} []Entry`]:[`${n}: Sequence[Entry]`]):[lang==='c'?`${type(t)} ${n}`:lang==='go'?`${n} ${type(t)}`:`${n}: ${type(t)}`]).join(', ')
    const declaration=lang==='c'?`static inline ${type(f.returns)} ${name(f.name)}(${args}) {`:lang==='go'?`func ${name(f.name)}(${args}) ${type(f.returns)} {`:`def ${name(f.name)}(${args}) -> ${type(f.returns)}:`
    return declaration+'\n'+(lang==='c'&&f.args.some(([,t])=>t==='entries')?'    (void)entries_len;\n':'')+body(f.body)+(lang==='py'?'':'\n}')
  }).join('\n\n')
  let result=header+'\n'+authorityCode(lang)+'\n'+(lang==='go'?principalCode.go:lang==='py'?principalCode.py+principalCode.pythonDiagnostics:principalCode.subjectC)+'\n'+functions+'\n'+(lang==='c'?'#endif\n':'')
  if(lang==='go') {
    const p=spawnSync('gofmt',[],{input:result,encoding:'utf8'})
    if(p.status!==0)throw Error(p.stderr)
    result=p.stdout
  }
  return result
}
const outputs=[['c','apps/desktop/native/security.h'],['go','apps/desktop/updater/internal/security/evaluate.go'],['py','apps/serve/service/platform/security.py'],['adapter','packages/adapters/codex/scholarseed_codex/permissions.py'],['js','scripts/shared/security.cjs']]
const receiptPath=path.join(root,'apps/desktop/native/security.outputs.json')
const digest=value=>crypto.createHash('sha256').update(value).digest('hex')
if(process.argv.includes('--check')) {
 const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'))
 if(receipt.schema!==policy.schema||receipt.policyHash!==hash)throw Error('stale ACL policy outputs')
 for(const [,file] of outputs)if(receipt.outputs[file]!==digest(fs.readFileSync(path.join(root,file))))throw Error('stale or edited ACL output: '+file)
} else {
 const receipts={schema:policy.schema,policyHash:hash,outputs:{}}
 for(const [lang,file] of outputs) {
  let value=lang==='adapter'?`# Generated from native/security.json; DO NOT EDIT.\n${principalCode.imports}POLICY_HASH = "${hash}"\nSTARTUP_MUTEX_DESCRIPTOR = ${JSON.stringify(principalCode.descriptor)}\n${principalCode.pythonDiagnostics}`:lang==='js'?principalCode.js.replace('__POLICY_HASH__',hash):generate(lang)
  if(lang==='py'||lang==='adapter') {
   const {developmentPython}=require('../../../scripts/shared/python.cjs')
   const python=developmentPython(root)
   for(const args of [['-m','isort','-'],['-m','black','--quiet','-']]) {
    const result=spawnSync(python,args,{input:value,encoding:'utf8',cwd:root})
    if(result.status!==0)throw Error(result.stderr)
    value=result.stdout
   }
  }
  const output=path.join(root,file)
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,value)
  receipts.outputs[file]=digest(value)
 }
 fs.writeFileSync(receiptPath,JSON.stringify(receipts,null,2)+'\n')
}
