// Readable source notation lowers to the same bounded IR used by all emitters.
// References name literal policy values, never runtime lookups or executable text.
function lowerPolicy(source) {
  if (source.schema !== 2) throw Error('unsupported ACL policy schema')
  const groups = ['roles', 'rights', 'flags', 'scopes', 'reasons']
  const operators = ['&', '|', '==', '!=', '>=', '&&', '||']
  const identifier = (value) => typeof value === 'string' && /^[a-z_]+$/.test(value)
  const reference = (value) => {
    const match = /^@([a-z_]+)\.([a-z_]+)$/.exec(value)
    if (!match || !groups.includes(match[1]) || !Object.hasOwn(source[match[1]] || {}, match[2]))
      throw Error('unknown ACL policy reference: ' + value)
    const item = source[match[1]][match[2]]
    const literal = match[1] === 'rights' ? item.value : item
    const number =
      typeof literal === 'string' && /^0x[0-9a-f]+$/.test(literal)
        ? Number.parseInt(literal.slice(2), 16)
        : literal
    if (!Number.isInteger(number) || number < 0 || number > 0xffffffff)
      throw Error('invalid ACL policy literal: ' + value)
    return number
  }
  const expression = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('@')) return reference(value)
      if (!identifier(value)) throw Error('invalid ACL identifier')
      return value
    }
    if (typeof value === 'boolean' || Number.isInteger(value)) return value
    if (!Array.isArray(value) || !value.length) throw Error('invalid ACL expression')
    const [operator, ...args] = value
    if (operators.includes(operator)) {
      if (args.length !== 2) throw Error('binary ACL operator requires two operands')
      return ['bin', operator, ...args.map(expression)]
    }
    const unary = { '~': 'invert', '!': 'not' }
    if (Object.hasOwn(unary, operator)) {
      if (args.length !== 1) throw Error('unary ACL operator requires one operand')
      return [unary[operator], expression(args[0])]
    }
    const arities = { length: 0, entry: 2, result: 4 }
    if (
      operator !== 'call' &&
      (!Object.hasOwn(arities, operator) || args.length !== arities[operator])
    )
      throw Error('unknown ACL expression: ' + operator)
    if (operator === 'call' && !args.length) throw Error('ACL call requires a function')
    return [operator, ...args.map(expression)]
  }
  const statements = (values) => {
    if (!Array.isArray(values)) throw Error('ACL body must be an array')
    return values.map((statement) => {
      if (!statement || Array.isArray(statement) || typeof statement !== 'object')
        throw Error('ACL statement must be an object')
      const forms = {
        return: ['return'],
        let: ['let', 'type', 'value'],
        set: ['set', 'value'],
        if: ['if', 'then'],
        for: ['for', 'from', 'to', 'do'],
      }
      const keys = Object.keys(statement)
      const form = Object.keys(forms).find((name) => Object.hasOwn(statement, name))
      if (
        !form ||
        keys.length !== forms[form].length ||
        !forms[form].every((key) => Object.hasOwn(statement, key))
      )
        throw Error('invalid ACL statement fields')
      if (form === 'return') return ['return', expression(statement.return)]
      if (form === 'if') return ['if', expression(statement.if), statements(statement.then)]
      if (!identifier(statement[form])) throw Error('invalid ACL statement identifier')
      if (form === 'for')
        return [
          'for',
          statement.for,
          expression(statement.from),
          expression(statement.to),
          statements(statement.do),
        ]
      if (form === 'set') return ['set', statement.set, expression(statement.value)]
      if (!['int', 'u32', 'bool'].includes(statement.type)) throw Error('invalid ACL variable type')
      return ['let', statement.let, statement.type, expression(statement.value)]
    })
  }
  return {
    schema: source.schema,
    roles: source.roles,
    principals: source.principals,
    profiles: source.profiles,
    mutex: source.mutex,
    diagnostics: source.diagnostics,
    authorities: {
      current_user: source.profiles.installation.current_user,
      sids: source.profiles.installation.allow.map(name => source.principals[name].sid),
    },
    functions: source.functions.map((fn) => ({
      name: fn.name,
      args: fn.args.map((arg) => {
        if (!identifier(arg.name) || !['int', 'u32', 'bool', 'entries'].includes(arg.type))
          throw Error('invalid ACL parameter')
        return [arg.name, arg.type]
      }),
      returns: fn.returns,
      body: statements(fn.body),
    })),
  }
}

module.exports = { lowerPolicy }
