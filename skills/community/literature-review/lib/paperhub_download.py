"""Authenticated PaperHub binary downloads, independent of text/image model keys."""
from pathlib import Path
from email.message import Message
import json
import os
import time
from urllib.parse import urlsplit,urlunsplit
import httpx


class DownloadError(ValueError):
    def __init__(self,message,status=None):
        super().__init__(message);self.status=status


def download_url(base=None):
    from endpoint_defaults import paperhub_base
    value=paperhub_base(os.environ.get('PAPERHUB_URL') or os.environ.get('PAPER_HUB_URL') or base).strip()
    parsed=urlsplit(value)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:
        raise DownloadError('invalid PaperHub base URL')
    path=parsed.path.rstrip('/')
    for suffix in ['/papersearch','/paperdownload']:
        if path.endswith(suffix):path=path[:-len(suffix)];break
    suffix='' if parsed.hostname=='scholarseed.damo.alibaba.com' else '/'
    return urlunsplit((parsed.scheme,parsed.netloc,path+'/paperdownload'+suffix,'',''))


def download(paper_id,directory,base=None,timeout=120,max_bytes=100*1024*1024,use_cache=True,observer=None):
    key=os.environ.get('SCHOLARSEED_API_KEY','').strip()
    if not key:raise DownloadError('SCHOLARSEED_API_KEY is not set',401)
    if not str(paper_id).strip():raise DownloadError('PaperHub document ID is missing',422)
    url=download_url(base);directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    meta_path=directory/'download.json';target=directory/'source.bin'
    if use_cache and target.exists() and meta_path.exists():
        try:meta=json.loads(meta_path.read_text())
        except (OSError,ValueError):meta={}
        if meta.get('paper_id')==str(paper_id) and meta.get('url')==url and meta.get('pdf') is True and target.read_bytes().startswith(b'%PDF-'):
            if observer:observer('download_cache_hit', bytes=target.stat().st_size)
            return target,{**meta,'cached':True}
    attempts=[];mode=os.environ.get('PAPERHUB_PROXY_MODE','auto').lower()
    for attempt in range(3):
        started=time.monotonic();record={'attempt':attempt+1};temporary=directory/'source.part'
        if observer:observer('download_attempt_started', attempt=attempt+1, proxy_mode=mode)
        try:
            transports=[False] if mode=='direct' else ([True,False] if mode=='auto' else [True])
            for trust_env in transports:
                transport_started=time.monotonic()
                try:
                    with httpx.Client(timeout=httpx.Timeout(timeout,connect=min(timeout,10)),trust_env=trust_env,follow_redirects=False) as client:
                        with client.stream('GET',url,params={'id':str(paper_id),'pdf':'true'},headers={'Authorization':'Bearer '+key}) as response:
                            record['http_status']=response.status_code
                            if response.status_code!=200:
                                raise DownloadError('PaperHub download HTTP '+str(response.status_code),response.status_code)
                            size=0
                            with temporary.open('wb') as output:
                                for chunk in response.iter_bytes(65536):
                                    size+=len(chunk)
                                    if size>max_bytes:raise DownloadError('source file exceeds download-size limit')
                                    output.write(chunk)
                            temporary.replace(target)
                            if not target.read_bytes().startswith(b'%PDF-'):
                                target.unlink(missing_ok=True)
                                raise DownloadError('PaperHub pdf=true did not return a PDF')
                            header=Message();header['Content-Disposition']=response.headers.get('content-disposition','')
                            meta={'paper_id':str(paper_id),'url':url,'pdf':True,'filename':Path(header.get_filename() or 'source.pdf').name,'content_type':response.headers.get('content-type'),'http_status':200,'bytes':size,'cached':False}
                    break
                except httpx.TransportError as error:
                    if observer:observer('download_transport_failed', attempt=attempt+1,
                                         trust_env=trust_env, elapsed_seconds=time.monotonic()-transport_started,
                                         error_type=type(error).__name__)
                    if trust_env and mode=='auto':continue
                    raise
            record['seconds']=time.monotonic()-started;attempts.append(record);meta['attempts']=attempts
            if observer:observer('download_attempt_completed', attempt=attempt+1,
                                 elapsed_seconds=record['seconds'], http_status=200, bytes=size)
            meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
            return target,meta
        except (httpx.HTTPError,DownloadError) as exc:
            temporary.unlink(missing_ok=True)
            status=getattr(exc,'status',None);record.update(seconds=time.monotonic()-started,error=type(exc).__name__,http_status=status);attempts.append(record)
            if observer:observer('download_attempt_failed', **record)
            (directory/'download-errors.json').write_text(json.dumps(attempts,indent=2)+'\n')
            retryable=isinstance(exc,httpx.TransportError) or status in (429,500,502,503,504)
            if not retryable or attempt==2:raise DownloadError(str(exc).replace(key,'<redacted>'),status) from exc
            if observer:observer('download_retry_scheduled', attempt=attempt+1, delay_seconds=2**attempt)
            time.sleep(2**attempt)
    raise DownloadError('download failed')
