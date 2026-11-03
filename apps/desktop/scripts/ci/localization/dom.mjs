const TRANSLATION_MODULE = 'react-i18next'
const TRANSLATION_HOOK = 'useTranslation'
const TRANS_COMPONENT = 'Trans'
const TEXT_SLOT = 'text'
const SLOT_NAMES = new Set([
  'aria-label',
  'content',
  'description',
  'error',
  'helperText',
  'label',
  'placeholder',
  'title',
  'value'
])

function attributeName(types, attribute) {
  return types.isJSXIdentifier(attribute.name) ? attribute.name.name : undefined
}

function staticAttribute(types, opening, name) {
  const attribute = opening.attributes.find(
    (candidate) => types.isJSXAttribute(candidate) && attributeName(types, candidate) === name
  )
  return attribute && types.isStringLiteral(attribute.value) ? attribute.value.value : undefined
}

function markerName(slot) {
  return `data-i18n-${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

function hookNamespace(types, argument) {
  if (types.isStringLiteral(argument)) return argument.value
  if (types.isArrayExpression(argument) && types.isStringLiteral(argument.elements[0])) return argument.elements[0].value
  return undefined
}

function callNamespace(types, expression, fallback) {
  const options = expression.arguments[1]
  if (!types.isObjectExpression(options)) return fallback
  const property = options.properties.find(
    (candidate) => types.isObjectProperty(candidate) && types.isIdentifier(candidate.key, { name: 'ns' })
  )
  if (!property) return fallback
  return types.isObjectProperty(property) && types.isStringLiteral(property.value) ? property.value.value : undefined
}

function sourceForCall(types, expressionPath, translators) {
  const expression = expressionPath.node
  if (!types.isCallExpression(expression) || !types.isIdentifier(expression.callee)) return undefined
  const fallbackNamespace = translators.get(expressionPath.scope.getBinding(expression.callee.name))
  if (!fallbackNamespace) return undefined
  const [key] = expression.arguments
  if (!types.isStringLiteral(key)) return null
  if (key.value.includes(':')) return key.value
  const namespace = callNamespace(types, expression, fallbackNamespace)
  return namespace ? `${namespace}:${key.value}` : null
}

function sourceForTrans(types, elementPath, transBindings) {
  const opening = elementPath.node.openingElement
  if (!types.isJSXIdentifier(opening.name) || !transBindings.has(elementPath.scope.getBinding(opening.name.name))) return undefined
  const namespace = staticAttribute(types, opening, 'ns')
  const key = staticAttribute(types, opening, 'i18nKey')
  return namespace && key ? `${namespace}:${key}` : null
}

function addMarker(types, path, slot, source) {
  const opening = path.node.openingElement
  const name = markerName(slot)
  const existing = opening.attributes.find(
    (candidate) => types.isJSXAttribute(candidate) && attributeName(types, candidate) === name
  )
  if (existing) {
    if (types.isStringLiteral(existing.value) && existing.value.value === source) return
    throw path.buildCodeFrameError(`${name} conflicts with inferred localization source ${source}`)
  }
  opening.attributes.push(types.jsxAttribute(types.jsxIdentifier(name), types.stringLiteral(source)))
}

function gap(path, reason, slot) {
  return {
    column: path.node.loc?.start.column ?? 0,
    line: path.node.loc?.start.line ?? 0,
    reason,
    slot
  }
}

function isComposed(path) {
  for (let current = path.parentPath; current; current = current.parentPath) {
    if (current.isBinaryExpression() || current.isTemplateLiteral()) return true
    if (current.isJSXAttribute() || current.isJSXExpressionContainer()) return false
  }
  return false
}

function uniqueSource(sources) {
  const values = [...new Set(sources.filter((source) => typeof source === 'string'))]
  return values.length === 1 ? values[0] : undefined
}

export default function localizationDom({ types }) {
  return {
    name: 'scholarseed-localization-dom',
    visitor: {
      Program(programPath, state) {
        const hookBindings = new Set()
        const transBindings = new Set()
        const translators = new Map()
        const translationCalls = []
        const transElements = []
        const consumed = new Set()
        const gaps = []

        for (const statement of programPath.node.body) {
          if (!types.isImportDeclaration(statement) || statement.source.value !== TRANSLATION_MODULE) continue
          for (const specifier of statement.specifiers) {
            if (!types.isImportSpecifier(specifier) || !types.isIdentifier(specifier.imported)) continue
            const binding = programPath.scope.getBinding(specifier.local.name)
            if (specifier.imported.name === TRANSLATION_HOOK) hookBindings.add(binding)
            if (specifier.imported.name === TRANS_COMPONENT) transBindings.add(binding)
          }
        }

        programPath.traverse({
          VariableDeclarator(path) {
            const { id, init } = path.node
            if (!types.isObjectPattern(id) || !types.isCallExpression(init) || !types.isIdentifier(init.callee)) return
            if (!hookBindings.has(path.scope.getBinding(init.callee.name))) return
            const namespace = hookNamespace(types, init.arguments[0])
            if (!namespace) return
            for (const property of id.properties) {
              if (!types.isObjectProperty(property) || !types.isIdentifier(property.key, { name: 't' }) || !types.isIdentifier(property.value)) continue
              translators.set(path.scope.getBinding(property.value.name), namespace)
            }
          }
        })

        programPath.traverse({
          CallExpression(path) {
            const source = sourceForCall(types, path, translators)
            if (source !== undefined) translationCalls.push({ path, source })
          },
          JSXElement(path) {
            const source = sourceForTrans(types, path, transBindings)
            if (source !== undefined) transElements.push({ path, source })
          }
        })

        programPath.traverse({
          JSXElement(path) {
            const opening = path.node.openingElement
            for (const attributePath of path.get('openingElement').get('attributes')) {
              const attribute = attributePath.node
              if (!types.isJSXAttribute(attribute)) continue
              const slot = attributeName(types, attribute)
              if (!slot || !SLOT_NAMES.has(slot) || !types.isJSXExpressionContainer(attribute.value)) continue
              const expressionPath = attributePath.get('value').get('expression')
              const source = sourceForCall(types, expressionPath, translators)
              if (source !== undefined) consumed.add(expressionPath.node)
              if (source === null) gaps.push(gap(path, 'dynamic-key', slot))
              else if (source) addMarker(types, path, slot, source)
            }

            const childSources = []
            let unresolved = false
            for (const childPath of path.get('children')) {
              const child = childPath.node
              if (types.isJSXExpressionContainer(child)) {
                const expressionPath = childPath.get('expression')
                const source = sourceForCall(types, expressionPath, translators)
                if (source !== undefined) consumed.add(expressionPath.node)
                if (source === null) unresolved = true
                else if (source) childSources.push(source)
              } else if (types.isJSXElement(child)) {
                const source = sourceForTrans(types, childPath, transBindings)
                if (source !== undefined) consumed.add(childPath.node)
                if (source === null) unresolved = true
                else if (source) childSources.push(source)
              }
            }
            if (unresolved) gaps.push(gap(path, 'dynamic-key', TEXT_SLOT))
            const source = uniqueSource(childSources)
            if (source) addMarker(types, path, TEXT_SLOT, source)
            else if (new Set(childSources).size > 1) gaps.push(gap(path, 'multiple-sources', TEXT_SLOT))
          }
        })

        for (const candidate of translationCalls) {
          if (consumed.has(candidate.path.node)) continue
          const reason = candidate.source === null
            ? 'dynamic-key'
            : isComposed(candidate.path) ? 'composed-value' : 'indirect-usage'
          gaps.push(gap(candidate.path, reason, 'unknown'))
        }
        for (const candidate of transElements) {
          if (consumed.has(candidate.path.node)) continue
          gaps.push(gap(candidate.path, candidate.source === null ? 'dynamic-key' : 'indirect-usage', 'unknown'))
        }

        state.file.metadata.localizationDomGaps = gaps
      }
    }
  }
}

export function developmentLocalization(command) {
  return command === 'serve' ? { plugins: [localizationDom] } : undefined
}
