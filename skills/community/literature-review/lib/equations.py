"""A strict, editable OMML projection for supported scientific notation."""

import re
import unicodedata

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

SYMBOLS = {
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ε',
    'theta': 'θ', 'lambda': 'λ', 'mu': 'μ', 'pi': 'π', 'sigma': 'σ',
    'tau': 'τ', 'phi': 'φ', 'psi': 'ψ', 'omega': 'ω', 'Gamma': 'Γ',
    'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ', 'Sigma': 'Σ', 'Omega': 'Ω',
    'infty': '∞', 'in': '∈', 'notin': '∉', 'subset': '⊂', 'subseteq': '⊆',
    'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥', 'ne': '≠', 'neq': '≠',
    'times': '×', 'cdot': '·', 'pm': '±', 'to': '→', 'rightarrow': '→',
    'leftarrow': '←', 'Rightarrow': '⇒', 'forall': '∀', 'exists': '∃',
    'sum': '∑', 'prod': '∏', 'int': '∫', 'partial': '∂', 'nabla': '∇',
    'approx': '≈', 'equiv': '≡', 'ldots': '…', 'cdots': '⋯',
    'log': 'log', 'ln': 'ln', 'exp': 'exp', 'sin': 'sin', 'cos': 'cos', 'tanh': 'tanh',
    'min': 'min', 'max': 'max', 'argmin': 'argmin', 'argmax': 'argmax',
    'mid': '|', 'Vert': '‖', 'lVert': '‖', 'rVert': '‖', 'ell': 'ℓ',
    'top': '⊤', 'bot': '⊥', 'perp': '⊥', 'otimes': '⊗', 'oplus': '⊕',
    'cup': '∪', 'cap': '∩', 'emptyset': '∅', 'varnothing': '∅',
    'rho': 'ρ', 'xi': 'ξ', 'eta': 'η', 'zeta': 'ζ', 'nu': 'ν',
    '|': '‖',
    'kappa': 'κ', 'upsilon': 'υ', 'varepsilon': 'ε', 'varphi': 'φ', 'varrho': 'ϱ',
}
FONTS = {'mathrm': 'p', 'mathbf': 'b', 'bm': 'b', 'boldsymbol': 'b', 'mathit': 'i', 'mathbb': 'double-struck',
         'mathcal': 'script', 'text': 'p', 'operatorname': 'p'}
TOKEN = re.compile(r'\\[A-Za-z]+|\\.|[^\\]', re.DOTALL)
TEXT_ARGUMENTS = frozenset(('e', 'sub', 'sup', 'num', 'den'))
ACCENTS = {'hat': '\u0302', 'widehat': '\u0302', 'tilde': '\u0303', 'widetilde': '\u0303',
           'bar': '\u0305', 'overline': '\u0305', 'vec': '\u20d7', 'dot': '\u0307',
           'ddot': '\u0308', 'check': '\u030c', 'breve': '\u0306',
           'acute': '\u0301', 'grave': '\u0300'}
COMBINING_ACCENTS = {value: value for value in ACCENTS.values()}
COMBINING_ACCENTS['\u0304'] = ACCENTS['bar']


def run_style(node):
    properties = node.find(qn('m:rPr'))
    return tuple((child.tag, tuple(sorted(child.attrib.items()))) for child in properties) if properties is not None else ()


def element(name, children=()):
    node = OxmlElement('m:' + name)
    for child in children:
        if (name in TEXT_ARGUMENTS and len(node) and child.tag == node[-1].tag == qn('m:r')
                and run_style(child) == run_style(node[-1])):
            previous = node[-1].find(qn('m:t'))
            current = child.find(qn('m:t'))
            if previous is not None and current is not None:
                previous.text = (previous.text or '') + (current.text or '')
                continue
        node.append(child)
    return node


def text_run(text):
    value = element('t')
    value.text = text
    value.set(qn('xml:space'), 'preserve')
    return element('r', [value])


def accent(base, mark):
    character = element('chr')
    character.set(qn('m:val'), mark)
    return element('acc', [element('accPr', [character]), element('e', base)])


def combining(token):
    return len(token) == 1 and unicodedata.category(token).startswith('M')


def equation(source):
    tokens = TOKEN.findall(source)
    position = 0

    def argument():
        nonlocal position
        while position < len(tokens) and tokens[position].isspace():
            position += 1
        return marked_atom()

    def atom():
        nonlocal position
        if position >= len(tokens):
            raise ValueError('incomplete DOCX equation')
        token = tokens[position]
        position += 1
        if token == '{':
            return sequence(True)
        if token in ('}', '^', '_'):
            raise ValueError('unexpected equation delimiter: ' + token)
        if not token.startswith('\\'):
            if combining(token):
                raise ValueError('DOCX combining accent requires a base')
            return [text_run(token)]
        command = token[1:]
        if command in ACCENTS:
            return [accent(argument(), ACCENTS[command])]
        if command in SYMBOLS:
            return [text_run(SYMBOLS[command])]
        if command in (',', ';', ' ', '!'):
            return [text_run(' ')]
        if command in ('{', '}', '%', '#', '&', '_', '$'):
            return [text_run(command)]
        if command in ('left', 'right'):
            return atom()
        if command in ('frac', 'dfrac', 'tfrac'):
            return [element('f', [element('num', argument()), element('den', argument())])]
        if command == 'sqrt':
            while position < len(tokens) and tokens[position].isspace():
                position += 1
            if position < len(tokens) and tokens[position] == '[':
                raise ValueError('indexed roots are not supported by this DOCX equation renderer')
            properties = element('radPr')
            hidden = element('degHide')
            hidden.set(qn('m:val'), '1')
            properties.append(hidden)
            return [element('rad', [properties, element('deg'), element('e', argument())])]
        if command in FONTS:
            children = argument()
            runs = [run for child in children for run in child.iter(qn('m:r'))]
            for child in runs:
                properties = child.find(qn('m:rPr'))
                if properties is None:
                    properties = element('rPr')
                    child.insert(0, properties)
                kind = 'scr' if command in ('mathbb', 'mathcal') else 'sty'
                if properties.find(qn('m:' + kind)) is None:
                    style = element(kind)
                    style.set(qn('m:val'), FONTS[command])
                    properties.append(style)
            return children
        raise ValueError('unsupported DOCX equation command: ' + token)

    def marked_atom():
        nonlocal position
        base = atom()
        while position < len(tokens) and combining(tokens[position]):
            token = tokens[position]
            if token not in COMBINING_ACCENTS:
                raise ValueError('unsupported DOCX combining accent: ' + token)
            position += 1
            base = [accent(base, COMBINING_ACCENTS[token])]
        return base

    def sequence(group=False):
        nonlocal position
        children = []
        while position < len(tokens):
            if tokens[position] == '}':
                if not group:
                    raise ValueError('unbalanced DOCX equation')
                position += 1
                return children
            base = marked_atom()
            scripts = {}
            while position < len(tokens) and tokens[position] in ('^', '_'):
                kind = tokens[position]
                position += 1
                if kind in scripts:
                    raise ValueError('duplicate equation script')
                scripts[kind] = argument()
            if scripts:
                kind = 'sSubSup' if len(scripts) == 2 else 'sSub' if '_' in scripts else 'sSup'
                parts = [element('e', base)]
                parts += [element('sub', scripts['_'])] if '_' in scripts else []
                parts += [element('sup', scripts['^'])] if '^' in scripts else []
                children.append(element(kind, parts))
            else:
                children.extend(base)
        if group:
            raise ValueError('unclosed DOCX equation group')
        return children

    return element('oMath', sequence())
