"""Find command and verified literal references without expanding source windows."""
import re
from .reference_context import reference_numbers


def masked_source(text):
    chars = list(text)
    for match in re.finditer(r'(?<!\\)%[^\n]*', text):
        chars[match.start():match.end()] = ' ' * (match.end() - match.start())
    clean = ''.join(chars)
    # Mask floats, including nested subfigures/tables, while retaining offsets/newlines.
    stack = []
    for match in re.finditer(r'\\(begin|end)\s*\{(figure\*?|table\*?|longtable|subfigure|subtable|tabular\*?|tabularx)\}', clean):
        if match[1] == 'begin':
            stack.append((match[2], match.start()))
        elif stack and stack[-1][0] == match[2]:
            _, start = stack.pop()
            if not stack:
                for i in range(start, match.end()):
                    if chars[i] != '\n':chars[i] = ' '
    return ''.join(chars)


def reference_mentions(text, kind, number, *, label=None):
    """`number=None` disables literal matching when numbering is unverified."""
    clean = masked_source(text);lines = text.splitlines();hits = set()
    if label:
        for match in re.finditer(r'\\(?:ref|autoref|cref|Cref|vref|Vref|prettyref)\s*\{([^{}]+)\}', clean):
            if label in [s.strip() for s in match[1].split(',')]:
                hits.add(clean.count('\n', 0, match.start()) + 1)
    if number is not None:
        for i, line in enumerate(clean.splitlines(), 1):
            if str(number).lower() in reference_numbers(line, kind):hits.add(i)
    return [{'reference_line': n, 'lines': [{'line': n, 'text': lines[n-1]}]} for n in sorted(hits)]
