"""Deterministic References boundary detection and geometry filtering; no LLM."""
from __future__ import annotations
import re
import statistics

HEADING = re.compile(r'^(?:(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+)?(?:references|bibliography|参考文献)\s*[:：]?$', re.I)
YEAR = re.compile(r'\b(?:18|19|20)\d{2}[a-z]?\b',re.I)
ENTRY = re.compile(r'^(?:\[\d{1,3}\]|\d{1,3}\.\s+|[^\W\d_][\w’\x27. -]{1,70}[,，]\s*[^\W\d_])',re.UNICODE)
VENUE = re.compile(r'\b(?:proceedings|journal|conference|transactions|arxiv|press|isbn|issn)\b|学报|出版社|期刊',re.I)


def citation_evidence(texts):
    """Look for several distinct entry starts, not just repeated years or DOIs."""
    lines=[line.strip() for text in texts for line in text.splitlines() if line.strip()][:160]
    starts=[i for i,line in enumerate(lines) if ENTRY.match(line)]
    qualified=year_entries=venue_entries=0;examples=[]
    for position,start in enumerate(starts):
        end=min(starts[position+1] if position+1<len(starts) else len(lines),start+12)
        text=' '.join(lines[start:end]);year=bool(YEAR.search(text));venue=bool(VENUE.search(text))
        if year or venue:
            qualified+=1;year_entries+=year;venue_entries+=venue
            if len(examples)<3:examples.append(text[:220])
    return {'qualified_entries':qualified,'year_entries':year_entries,'venue_entries':venue_entries,
            'strong':qualified>=3 and (year_entries>=2 or venue_entries>=2),'examples':examples}


def following_native_rows(rows,page_number,width,height,boundary):
    return [r for r in rows if not before_boundary(page_number,
        [r['bbox_pixels'][0]/width,r['bbox_pixels'][1]/height,r['bbox_pixels'][2]/width,r['bbox_pixels'][3]/height],boundary)]


def heading(text):
    text=' '.join(str(text).split())
    return bool(HEADING.fullmatch(text.replace('参 考 文 献','参考文献')))


def columns(rows,width,*,paragraph_regions=False):
    left=[r for r in rows if len(r['text'])>=20 and r['bbox_pixels'][2]<=width*.52]
    right=[r for r in rows if len(r['text'])>=20 and r['bbox_pixels'][0]>=width*.48]
    # Native extraction yields lines; OCR often yields whole paragraphs.
    def weight(group):
        return sum(max(len(r['text'].splitlines()),(len(r['text'])+79)//80) for r in group)
    if paragraph_regions:
        # Even a short bibliography tail is a complete OCR paragraph region.
        # Two substantial narrow text regions establish columns without needing
        # three lines on each side; captions alone do not establish a column.
        def has_paragraph(group):
            return any(r.get('raw_label') in {'text','reference','reference_content'}
                       and r['bbox_pixels'][2]-r['bbox_pixels'][0]>=width*.18 for r in group)
        if has_paragraph(left) and has_paragraph(right):return 2
    return 2 if weight(left)>=3 and weight(right)>=3 else 1


def make_boundary(text,box,page,width,height,method,ncolumns):
    return {'heading':text,'page_number':page,'bbox_normalized':[box[0]/width,box[1]/height,box[2]/width,box[3]/height],
            'columns':ncolumns,'method':method}


def headingless_bibliography(rows,page_number,page_count,width,height):
    """Conservative fallback for a dense numbered bibliography page with no title."""
    if page_number<=page_count/2:return None
    entries=[]
    for i,row in enumerate(rows):
        match=re.match(r'^\s*\[(\d{1,3})\]\s+',row['text'])
        if match:entries.append((i,int(match.group(1))))
    if len(entries)<6 or [n for _,n in entries]!=list(range(1,len(entries)+1)):return None
    first=rows[entries[0][0]]
    if first['bbox_pixels'][1]>height*.22:return None
    chunks=[' '.join(r['text'] for r in rows[start:entries[j+1][0] if j+1<len(entries) else len(rows)])
            for j,(start,_) in enumerate(entries)]
    years=sum(bool(YEAR.search(text)) and len(text)>=40 for text in chunks)
    venues=sum(bool(VENUE.search(text) or re.search(r'10\.\d{4,9}/',text)) for text in chunks)
    if years<max(5,len(entries)*.8) or venues<3:return None
    candidate=make_boundary(None,first['bbox_pixels'],page_number,width,height,'native_bibliography',columns(rows,width))
    candidate['citation_evidence']={'qualified_entries':len(entries),'year_entries':years,'venue_entries':venues,
                                    'strong':True,'examples':[text[:220] for text in chunks[:3]]}
    return candidate


def detect_native_boundary(document):
    from .native import native_lines
    needs_ocr=False;untitled=[]
    for page in document:
        width,height=page.rect.width*2,page.rect.height*2
        rows=native_lines(page,width,height)
        if any(re.fullmatch(r'(?:table of )?contents|目录',r['text'].strip(),re.I) for r in rows):continue
        if not rows:
            needs_ocr=needs_ocr or bool(page.images or page.drawings)
        blocks={}
        for row in rows:blocks.setdefault(row['source_line_id'].rsplit('-l',1)[0],[]).append(row)
        found=[]
        body_sizes=[r['font_size'] for r in rows if len(r['text'])>=30]
        typical=statistics.median(body_sizes or [r['font_size'] for r in rows] or [0])
        candidates=list(blocks.values())
        ncolumns=columns(rows,width)
        fallback=headingless_bibliography(rows,page.number+1,len(document),width,height)
        if fallback:untitled.append(fallback)
        # PDF text blocks may merge a typographic heading with its entries.
        # Also accept an exact heading line, but not a fragment of a prose line.
        for row in rows:
            if not heading(row['text']):continue
            box=row['bbox_pixels'];mid=(box[1]+box[3])/2
            if any(other is not row and other['bbox_pixels'][1]<mid<other['bbox_pixels'][3]
                   and (ncolumns==1 or ((other['bbox_pixels'][0]+other['bbox_pixels'][2]<width)
                        ==(box[0]+box[2]<width))) for other in rows):continue
            candidates.append([row])
        for block in candidates:
            text=' '.join(r['text'] for r in block)
            if not heading(text):continue
            boxes=[r['bbox_pixels'] for r in block]
            box=[min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]
            # Some journal styles use centered capitals at body size, without bold.
            # This remains a candidate only; bibliography evidence below is required.
            centers=[width/2]
            if ncolumns==2:
                # A heading contained within one column may center on that column.
                if box[2]<=width*.52:centers.append(width*.25)
                if box[0]>=width*.48:centers.append(width*.75)
            centered_caps=text.isupper() and any(abs((box[0]+box[2])/2-center)<=width*.08 for center in centers)
            if not (any(r['bold'] for r in block) or max(r['font_size'] for r in block)>typical*1.05
                    or re.match(r'^(?:\d+|[IVX]+)[.)]?\s+',text) or centered_caps):
                continue
            # Ignore running headers and footers. Exact heading blocks reject prose/TOC rows.
            if box[1]<height*.035 or box[3]>height*.965:continue
            candidate=make_boundary(text,box,page.number+1,width,height,'native',ncolumns)
            after=following_native_rows(rows,page.number+1,width,height,candidate)
            if page.number+1<len(document):
                following=document[page.number+1]
                after+=native_lines(following,following.rect.width*2,following.rect.height*2)
            evidence=citation_evidence(r['text'] for r in after)
            if evidence['strong']:
                candidate['citation_evidence']=evidence;found.append(candidate)
        if found:
            found.sort(key=lambda b:(b['bbox_normalized'][0]>=.5 if b['columns']==2 else False,b['bbox_normalized'][1]))
            return found[0],needs_ocr
    return (untitled[0] if untitled else None),needs_ocr


def detect_ocr_boundary(page,following=None):
    rows=[{'text':r['content'],'bbox_pixels':r['bbox_pixels'],'raw_label':r['raw_label']} for r in page['regions']]
    for region in page['regions']:
        if region['raw_label'] not in {'paragraph_title','doc_title'} or not heading(region['content']):continue
        box=region['bbox_pixels']
        if box[1]<page['height']*.035 or box[3]>page['height']*.965:continue
        candidate=make_boundary(region['content'],box,page['page_number'],page['width'],page['height'],page.get('extraction_method','ocr'),columns(rows,page['width'],paragraph_regions=True))
        after=following_native_rows(rows,page['page_number'],page['width'],page['height'],candidate)
        texts=[r['text'] for r in after]
        if following:texts.extend(r['content'] for r in following['regions'] if r['raw_label'] in {'text','reference','reference_content','paragraph_title'})
        evidence=citation_evidence(texts)
        if evidence['strong']:
            candidate['citation_evidence']=evidence
            return candidate
    return None


def before_boundary(page,box,boundary):
    """Require the entire normalized box to precede the heading in column order."""
    if page!=boundary['page_number']:return page<boundary['page_number']
    heading_box=boundary['bbox_normalized']
    if boundary.get('columns')==2:
        if heading_box[0]>=.5 and box[2]<=.5:return True
        if heading_box[0]<.5 and box[0]>=.5:return False
    return box[3]<=heading_box[1]


def filter_pages(pages,scope):
    if scope.get('mode')!='main':return pages
    boundary=scope.get('boundary')
    if not boundary:return []
    return [{**p,'regions':[r for r in p['regions'] if before_boundary(p['page_number'],r['bbox_normalized'],boundary)]}
            for p in pages if p['page_number']<=boundary['page_number']]
