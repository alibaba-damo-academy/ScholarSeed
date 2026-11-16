"""Small Table token breakdowns; provider billing and estimates stay separate."""
import json
from .usage import usage_summary

METHOD='o200k_base on compact JSON; local estimate, not Qwen billing'


def counter():
    try:
        import tiktoken
        encoding=tiktoken.get_encoding('o200k_base')
    except ImportError:return None
    return lambda text:len(encoding.encode(text,disallowed_special=()))


def compact(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))


def input_parts(skill,job):
    count=counter()
    if count is None:return {'method':'unavailable'}
    packet=skill.packet(job)
    # Count text evidence once; remaining JSON keys, IDs, source declarations,
    # structural facts and token-boundary effects belong to packet_structure.
    context=[c['text'] for c in packet['body_clauses']]+[r[2] for r in packet['surrounding_lines']]
    caption=count(packet['caption']['text']);references=sum(count(t) for t in context)
    cells=count(compact(packet.get('cells',[]))) if packet.get('cells',[]) else 0
    pairs=count(compact(packet.get('pairs',[]))) if packet.get('pairs',[]) else 0
    native=packet.get('table_text')
    native_text=count(native) if isinstance(native,str) else sum(count(r[-1]) for r in native['lines']) if native else 0
    native_locations=count(compact(native))-native_text if native and not isinstance(native,str) else 0
    request=count(packet['request']);packet_total=count(skill.packet_text(job))
    rules=count(job['rules']);schema=count(compact(skill.output_schema()));prompt=count(skill.prompt(job))
    components={'reading_rules':rules,'caption':caption,'reference_context':references,
        'candidate_cells':cells,'comparison_pairs':pairs,'table_native_text':native_text,'table_native_locations':native_locations,
        'packet_structure':packet_total-caption-references-cells-pairs-request-native_text-native_locations,
        'output_schema':schema,'request_and_separators':request+prompt-rules-packet_total}
    return {'method':METHOD,'components':components,**components,
        'packet_total':packet_total,'prompt_total':prompt,'text_and_schema_total':prompt+schema,
        'accounting':'packet_structure and request_and_separators include serialization/token-boundary residuals'}


def output_parts(raw):
    count=counter()
    if count is None:return {'method':'unavailable'}
    if not isinstance(raw,dict):return {'method':METHOD,'status':'unavailable_invalid_json'}
    fields={k:count(compact(v)) for k,v in raw.items()}
    total=count(compact(raw))
    return {'method':METHOD,'basis':'model-owned JSON, before fixed metadata/evidence expansion',
        'fields':fields,'json_structure':total-sum(fields.values()),'json_total':total,
        'accounting':'LOCAL ESTIMATE ONLY: compact JSON with o200k_base; not an additive breakdown of provider output_tokens. json_total is the local compact estimate, not billed output.'}


def billing_parts(usage,*,reused=False):
    normalized=usage_summary(usage,reused=reused) or {}
    value={k:normalized.get(k) for k in ('input_tokens','output_tokens','image_tokens','cached_tokens','uncached_input_tokens')}
    valid=lambda x:type(x) is int and x>=0
    inp,out,img=value['input_tokens'],value['output_tokens'],value['image_tokens']
    total=normalized.get('total_tokens')
    value['total_tokens']=total if valid(total) else inp+out if valid(inp) and valid(out) else None
    value['non_image_input_tokens']=inp-img if valid(inp) and valid(img) and inp>=img else None
    value['basis']='cache reuse: no model call' if reused else 'provider usage; total/non-image may be arithmetic from reported counts'
    return value
