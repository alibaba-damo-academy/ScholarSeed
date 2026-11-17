"""Bounded provider rejection details; never persist headers or request payloads."""
import re


def provider_error(exc, *, secrets=()):
    def clean(value):
        if value is None:return None
        text=str(value)
        for secret in secrets:
            if secret:text=text.replace(secret,'[REDACTED]')
        text=re.sub(r'data:image/[^\s"\']+', '[IMAGE REDACTED]',text)
        text=re.sub(r'Bearer\s+\S+','Bearer [REDACTED]',text,flags=re.I)
        return text[:2000]
    body=getattr(exc,'body',None)
    error=body.get('error',body) if isinstance(body,dict) else {}
    if not isinstance(error,dict):error={}
    return {'error':type(exc).__name__,'http_status':getattr(exc,'status_code',None),
            'request_id':clean(getattr(exc,'request_id',None)),
            'code':clean(error.get('code',getattr(exc,'code',None))),
            'param':clean(error.get('param',getattr(exc,'param',None))),
            'message':clean(error.get('message',getattr(exc,'message',None)))}
