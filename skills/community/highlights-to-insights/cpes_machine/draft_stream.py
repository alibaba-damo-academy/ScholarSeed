"""Incremental, text-only Markdown projection of the existing draft JSON."""
import json


class DraftPreview:
    def __init__(self, emit):
        self.emit = emit
        self.stack = []
        self.opened, self.closed = set(), set()
        self.strings, self.finished = {}, set()
        self.string = None
        self.escape = ''
        self.high_surrogate = None
        self.primitive = False
        self.root_done = False
        self.rendered = ''

    @staticmethod
    def visible(path):
        return (path == ('title',) or
                len(path) == 3 and path[0] == 'sections' and path[2] == 'title' or
                len(path) == 5 and path[0] == 'sections' and path[2] == 'paragraphs' and path[4] == 'text')

    def path(self):
        if not self.stack:
            return ()
        frame = self.stack[-1]
        return frame['path'] + (frame['key'] if frame['type'] == 'object' else frame['index'],)

    def complete(self):
        if self.stack:
            frame = self.stack[-1]
            frame['state'] = 'comma'
            if frame['type'] == 'array':
                frame['index'] += 1
        else:
            self.root_done = True

    def append(self, char):
        number = ord(char)
        if self.high_surrogate is not None:
            if not 0xDC00 <= number <= 0xDFFF:
                raise ValueError('Invalid Unicode surrogate in draft stream.')
            char = chr(0x10000 + (self.high_surrogate - 0xD800) * 0x400 + number - 0xDC00)
            self.high_surrogate = None
        elif 0xD800 <= number <= 0xDBFF:
            self.high_surrogate = number
            return
        elif 0xDC00 <= number <= 0xDFFF:
            raise ValueError('Invalid Unicode surrogate in draft stream.')
        self.string['text'] += char
        if not self.string['key'] and self.visible(self.string['path']):
            self.strings[self.string['path']] = self.string['text']

    def feed(self, chunk):
        for char in chunk:
            if self.string is not None:
                if self.escape:
                    self.escape += char
                    if self.escape.startswith('\\u'):
                        if len(self.escape) < 6:
                            continue
                    elif len(self.escape) < 2:
                        continue
                    self.append(json.loads('"' + self.escape + '"'))
                    self.escape = ''
                elif char == '\\':
                    self.escape = char
                elif char == '"':
                    if self.high_surrogate is not None:
                        raise ValueError('Unfinished Unicode surrogate in draft stream.')
                    if self.string['key']:
                        frame = self.stack[-1]
                        key = self.string['text']
                        if key in frame['keys']:
                            raise ValueError('Duplicate key in draft stream.')
                        frame['keys'].add(key)
                        frame.update(key=key, state='colon')
                    else:
                        self.finished.add(self.string['path'])
                        self.complete()
                    self.string = None
                else:
                    if ord(char) < 32:
                        raise ValueError('Unescaped control character in draft stream.')
                    self.append(char)
                continue
            if self.primitive:
                if char not in ' \t\r\n,]}':
                    continue
                self.primitive = False
                self.complete()
            if char.isspace():
                continue
            if self.root_done:
                raise ValueError('Unexpected content after draft JSON.')
            frame = self.stack[-1] if self.stack else None
            state = frame['state'] if frame else 'value'
            if state == 'colon':
                if char != ':':
                    raise ValueError('Expected colon in draft stream.')
                frame['state'] = 'value'
            elif char in '}]':
                if not frame or frame['type'] != ('object' if char == '}' else 'array'):
                    raise ValueError('Mismatched JSON container in draft stream.')
                self.closed.add(frame['path'])
                self.stack.pop()
                self.complete()
            elif state == 'comma':
                if char != ',':
                    raise ValueError('Expected comma in draft stream.')
                frame['state'] = 'key' if frame['type'] == 'object' else 'value'
            elif char == '"':
                key = bool(frame and state == 'key')
                path = None if key else self.path()
                self.string = {'key': key, 'path': path, 'text': ''}
                if not key and self.visible(path):
                    self.strings[path] = ''
            elif state == 'value' and char in '[{':
                path = self.path()
                self.opened.add(path)
                self.stack.append({'type': 'object' if char == '{' else 'array', 'path': path,
                                   'state': 'key' if char == '{' else 'value', 'index': 0, 'key': None, 'keys': set()})
            elif state == 'value' and char in '-0123456789tfn':
                self.primitive = True
            else:
                raise ValueError('Unexpected token in draft stream.')
        text = self.projection()
        if not text.startswith(self.rendered):
            raise ValueError('Draft preview changed previously emitted text.')
        delta = text[len(self.rendered):]
        if delta:
            self.emit(delta)
            self.rendered = text

    def projection(self):
        result = []
        def field(path, prefix=''):
            if path not in self.strings:
                return False
            result.append(prefix + self.strings[path])
            if path not in self.finished:
                return False
            result.append('\n\n')
            return True
        if not field(('title',), '# '):
            return ''.join(result)
        section = 0
        while ('sections', section) in self.opened:
            base = ('sections', section)
            heading = base + ('title',)
            if section == 0 and self.strings.get(heading) == '':
                if heading not in self.finished:
                    break
            elif not field(heading, '## '):
                break
            paragraph = 0
            while base + ('paragraphs', paragraph) in self.opened:
                if not field(base + ('paragraphs', paragraph, 'text')):
                    return ''.join(result)
                paragraph += 1
            if base + ('paragraphs',) not in self.closed:
                break
            section += 1
        return ''.join(result)
