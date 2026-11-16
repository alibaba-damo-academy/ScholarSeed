"""Current gateway defaults and exact retired-default migrations."""
MODEL_BASE='https://scholarseed.damo.alibaba.com/v1/'
PAPERHUB_BASE='https://scholarseed.damo.alibaba.com/paperhub'


def model_base(value):
    if str(value or '').rstrip('/')=='https://pre-pub-gateway-scholarseed.alibaba-inc.com/v1':return MODEL_BASE
    return value


def paperhub_base(value):
    old=str(value or '').rstrip('/')
    roots=('http://120.26.184.97','https://pre-pub-gateway-scholarseed.alibaba-inc.com')
    if any(old==root+suffix for root in roots for suffix in ('','/papersearch','/paperdownload')):return PAPERHUB_BASE
    return value or PAPERHUB_BASE
