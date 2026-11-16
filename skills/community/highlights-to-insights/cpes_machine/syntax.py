"""Escape interior prose quotes only; never infer JSON structure or source values."""
import json
import re

FREE_TEXT_FIELDS = frozenset(('text', 'title', 'reason', 'explanation'))
MAX_TEXT_CHARS = 1_000_000
MAX_DEPTH = 64


def escape_prose_quotes(text):
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError('Draft exceeds syntax normalization limit.')
    decoder = json.JSONDecoder()
    position = 0
    output = []
    edits = []

    def whitespace():
        nonlocal position
        start = position
        while position < len(text) and text[position] in ' \r\n\t':
            position += 1
        output.append(text[start:position])

    def token(expected):
        nonlocal position
        whitespace()
        if position >= len(text) or text[position] != expected:
            raise ValueError('Ambiguous or missing JSON punctuation; normalization refused.')
        output.append(expected)
        position += 1

    def string(field=None):
        nonlocal position
        start = position
        if field not in FREE_TEXT_FIELDS:
            value, end = decoder.raw_decode(text, position)
            if not isinstance(value, str):
                raise ValueError('JSON string required.')
            output.append(text[position:end])
            position = end
            return value
        output.append('"')
        position += 1
        while position < len(text):
            char = text[position]
            if ord(char) < 32:
                raise ValueError('Unescaped control character; normalization refused.')
            if char == '\\':
                output.append(text[position:position + 2])
                position += 2
                continue
            if char == '"':
                following = position + 1
                while following < len(text) and text[following] in ' \r\n\t':
                    following += 1
                if following == len(text) or text[following] in ',}]':
                    output.append(char)
                    position += 1
                    return None
                # A key-like boundary can mean a missing comma. Do not merge
                # properties into prose or guess whether a colon was intended.
                if (following > position + 1 and text[following] == '"') or text[following] == ':' or re.match(r'"\s+"(?:[^"\\]|\\.)*"\s*:', text[position:]):
                    raise ValueError('Ambiguous JSON property boundary; normalization refused.')
                output.append('\\')
                edits.append({'offset': position, 'field': field})
            output.append(char)
            position += 1
        raise ValueError('Unclosed JSON string; normalization refused.')

    def value(field=None, depth=0):
        nonlocal position
        if depth > MAX_DEPTH:
            raise ValueError('Draft nesting exceeds syntax normalization limit.')
        whitespace()
        if position >= len(text):
            raise ValueError('Incomplete JSON; normalization refused.')
        char = text[position]
        if char == '{':
            token('{')
            whitespace()
            if position < len(text) and text[position] == '}':
                token('}')
                return
            while True:
                whitespace()
                key = string()
                token(':')
                value(key, depth + 1)
                whitespace()
                if position < len(text) and text[position] == '}':
                    token('}')
                    return
                token(',')
        elif char == '[':
            token('[')
            whitespace()
            if position < len(text) and text[position] == ']':
                token(']')
                return
            while True:
                value(None, depth + 1)
                whitespace()
                if position < len(text) and text[position] == ']':
                    token(']')
                    return
                token(',')
        elif char == '"':
            string(field)
        else:
            scalar, end = decoder.raw_decode(text, position)
            if isinstance(scalar, (str, dict, list)):
                raise ValueError('Unexpected JSON value; normalization refused.')
            output.append(text[position:end])
            position = end

    value()
    whitespace()
    if position != len(text):
        raise ValueError('Trailing content; normalization refused.')
    normalized = ''.join(output)
    json.loads(normalized)
    return normalized, edits
