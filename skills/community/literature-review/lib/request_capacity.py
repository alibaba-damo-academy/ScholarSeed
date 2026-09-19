"""Conservative, non-truncating capacity checks shared by all text backends."""
import json
from generation_diagnostics import GenerationError


def capacity(messages,cfg):
    cap=cfg.get('context_window');output=cfg.get('max_tokens');verified=cfg.get('capacity_verified')
    if not verified or type(cap) is not int or type(output) is not int or not 0<output<cap:
        raise GenerationError('INPUT_MISSING','configure verified context_window, max_tokens and capacity_verified for this model stage')
    advertised=verified.get('model_max_output') if isinstance(verified,dict) else None
    if advertised and output>advertised:raise GenerationError('OUTPUT_CAPACITY','requested output exceeds verified model output limit')
    size=len(json.dumps(messages,ensure_ascii=False).encode('utf-8'));upper=size+256
    if upper+output>cap:raise GenerationError('INPUT_TOO_LARGE','conservative input bound plus output exceeds verified context; no evidence was removed',input_token_upper_bound=upper,output_capacity=output,context_window=cap)
    return {'input_bytes':size,'input_token_upper_bound':upper,'count_method':'utf8_bytes_plus_256',
            'context_window':cap,'output_capacity':output,'capacity_verified':verified}


def configured_check(model,messages,output):
    from load_model_config import _load_raw
    stages=(_load_raw() or {}).get('stages',{})
    matches=[c for c in stages.values() if c.get('model')==model and c.get('context_window')]
    if not matches:return None  # custom low-level clients must provide capacity at their caller
    cfg=min(matches,key=lambda c:c['context_window'])
    return capacity(messages,{**cfg,'max_tokens':output})
