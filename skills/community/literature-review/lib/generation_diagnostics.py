"""Small, model-independent diagnostics for scripted generation."""
class GenerationError(ValueError):
    def __init__(self, code, message, location=None, **context):
        super().__init__(message)
        self.code, self.location, self.context = code, location, context

    def report(self):
        return {'status': 'FAILED', 'code': self.code, 'message': str(self),
                'location': self.location, **self.context,
                'next_action': self.context.get('next_action', 'Resolve the reported input or artifact; no automatic semantic repair.')}


def diagnostic(exc):
    if isinstance(exc, GenerationError):
        return exc.report()
    import json
    code = 'INPUT_MISSING' if isinstance(exc, OSError) else 'SCHEMA_INVALID'
    if isinstance(exc, json.JSONDecodeError):
        code = 'JSON_INVALID'
    return GenerationError(code, str(exc)).report()
