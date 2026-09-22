"""Public gateway defaults and explicit user configuration."""
MODEL_BASE='https://scholarseed.damo.alibaba.com/v1/'
PAPERHUB_BASE='https://scholarseed.damo.alibaba.com/paperhub'


def model_base(value):
    return value


def paperhub_base(value):
    return value or PAPERHUB_BASE
