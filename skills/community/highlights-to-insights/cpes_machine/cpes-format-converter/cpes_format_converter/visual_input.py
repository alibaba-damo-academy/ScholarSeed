"""Deterministic figure inputs: original complete bitmap, else full region + native text.

Geometry is evaluated in displayed PDF points; detector and exported image pixels
are separate coordinate systems. Never concatenate SVG programs or invoke OCR/LLMs.
"""
from __future__ import annotations

import math
import hashlib
import json
from pathlib import Path

import pypdfium2
import pypdfium2.raw as pdfium

from .pdf import PDFDocument, Rect, render_page

POLICY = 'figure-visual-v36'
PAD_POINTS = 6.0
RENDER_SCALE = 4.0
MAX_EDGE = 4096
MAX_PIXELS = 12_000_000


def _area(rect):
    return max(0, rect.width) * max(0, rect.height)


def _overlap(a, b):
    return _area(a & b)


def _touches(a, b):
    # Lines / paths may have zero-area bounds.
    return bool((a + (-.25, -.25, .25, .25)).intersects(b))


def _export_bitmap(doc, info, output):
    candidates=[image for image in doc.reader.pages[info['page_number']-1].images
                if getattr(image.indirect_reference,'idnum',None)==info['xref']]
    if len(candidates)!=1:raise ValueError('Original bitmap identity is ambiguous.')
    image=candidates[0].image
    image.save(output,format='PNG')
    return image.size


def _safe_region(page, info, detected):
    """Small label margin, stopped by detected text/captions/other figures."""
    sx, sy = info['width']/page.rect.width, info['height']/page.rect.height
    region = (detected + (-PAD_POINTS,-PAD_POINTS,PAD_POINTS,PAD_POINTS)) & page.rect
    for other in info.get('regions', []):
        native_lines = [row['bbox_pixels'] for row in other.get('source_lines', [])
                        if row.get('extraction_method') == 'native'
                        and row.get('coordinate_precision') == 'line' and row.get('bbox_pixels')]
        # Native text geometry is more precise than a layout detector's caption
        # rectangle, which may overlap a neighboring axis label.
        values = ([min(row[0] for row in native_lines),min(row[1] for row in native_lines),
                   max(row[2] for row in native_lines),max(row[3] for row in native_lines)]
                  if native_lines and other.get('raw_label') not in {'figure','image','chart'}
                  else other['bbox_pixels'])
        guard = Rect(values[0]/sx,values[1]/sy,values[2]/sx,values[3]/sy)
        # An owned visual region is inside detected; it is not a boundary.
        if other.get('raw_label') in {'figure','image','chart'} and _overlap(guard,detected) >= .9*_area(guard):
            continue
        if not region.intersects(guard): continue
        x_overlap = min(detected.x1,guard.x1) > max(detected.x0,guard.x0)
        y_overlap = min(detected.y1,guard.y1) > max(detected.y0,guard.y0)
        if x_overlap:
            if guard.y0 >= detected.y1: region.y1 = min(region.y1,max(detected.y1,guard.y0-.1))
            if guard.y1 <= detected.y0: region.y0 = max(region.y0,min(detected.y0,guard.y1+.1))
        if y_overlap:
            if guard.x0 >= detected.x1: region.x1 = min(region.x1,max(detected.x1,guard.x0-.1))
            if guard.x1 <= detected.x0: region.x0 = max(region.x0,min(detected.x0,guard.x1+.1))
    return region


def profile_config(profile):
    if profile not in {'deep','fast'}:
        raise ValueError('Figure profile must be deep or fast')
    return {'policy':POLICY, 'profile':profile, 'pad_points':PAD_POINTS,
            'render_scale':RENDER_SCALE if profile=='deep' else 2.0,
            'max_edge':MAX_EDGE if profile=='deep' else 1024,
            'max_pixels':MAX_PIXELS if profile=='deep' else 1024*1024,
            'original_bitmap':profile=='deep', 'native_visual_text':profile=='deep'}


def extract_figure_image(pdf: Path, page_info: dict, detected_box: list, output: Path, *, profile='deep') -> dict:
    """Write exactly one image and return bounded provenance + auxiliary text."""
    config = profile_config(profile)
    config_hash = hashlib.sha256(json.dumps(config,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    with PDFDocument(pdf) as doc:
        page = doc[page_info['page_number']-1]
        sx, sy = page_info['width']/page.rect.width, page_info['height']/page.rect.height
        detected = Rect(detected_box[0]/sx,detected_box[1]/sy,detected_box[2]/sx,detected_box[3]/sy) & page.rect
        region = _safe_region(page,page_info,detected)
        transforms=[]
        with pypdfium2.PdfDocument(pdf,password='') as rendered:
            handle=rendered[page.number]
            try:
                for image in handle.get_objects(filter=[pdfium.FPDF_PAGEOBJ_IMAGE],max_depth=1):
                    transforms.append((page.raw_rect(image.get_bounds()),image.get_matrix().get()))
            finally:handle.close()
        images=[]
        for original in page.images:
            item=dict(original)
            item['display_rect']=page.display_rect(item['bbox'])
            item['xref']=getattr(item.get('stream'),'objid',0)
            item['page_number']=page.number+1
            item['width'],item['height']=item.get('srcsize',(0,0))
            matched=[matrix for box,matrix in transforms if _overlap(box,Rect(item['bbox']))>=.99*max(_area(box),_area(Rect(item['bbox'])))]
            item['transform']=matched[0] if len(matched)==1 else (0,0,0,0,0,0)
            if _overlap(item['display_rect'],region)>0:images.append(item)
        words=[(page.display_rect(line['rect']),line['text'],(bi,li))
               for bi,block in enumerate(page.blocks) for li,line in enumerate(block['lines'])]
        words=[(rect,text,key) for rect,text,key in words if _overlap(rect,region)>.5*_area(rect)]
        drawings=[page.display_rect(row['rect']) for row in page.drawings]
        overlays=[rect for rect in drawings if _touches(rect,region)]
        annotations=[page.display_rect(page.raw_rect(ref.get_object().get('/Rect',[0,0,0,0])))
                     for ref in page.raw.get('/Annots',[])]
        annotations=[box for box in annotations if box.intersects(region)]
        # Preserve native PDF line grouping; no semantic reconstruction.
        native = []
        grouped = {}
        for rect,text,key in words:
            group = grouped.setdefault(tuple(key[:2]), [])
            group.append((rect,text))
        for group in grouped.values():
            line_rect = Rect(group[0][0])
            for rect,_ in group[1:]: line_rect |= rect
            native.append({'text':' '.join(text for _,text in group),
                           'bbox_pdf_points':[round(x,3) for x in line_rect]})
        route = 'mixed-render-native-text' if images else 'vector-render-native-text'
        if not native: route = route.replace('-native-text','')
        reason = None
        chosen = images[0] if len(images)==1 else None
        complete = False
        if chosen:
            image_rect = chosen['display_rect']
            a,b,c,d,_,_ = chosen['transform']
            complete = (chosen.get('xref',0)>0 and not page.rotation and a>0 and d>0 and abs(b)<1e-6 and abs(c)<1e-6
                        and _overlap(image_rect,detected) >= .9*_area(detected)
                        and _overlap(image_rect,detected) >= .9*_area(image_rect)
                        and region.contains(image_rect) and not words and not overlays and not annotations)
        if complete and profile == 'fast':
            # Use exactly the recovered complete image domain, but render the
            # displayed PDF region. Do not decode/export a source PNG first.
            region = chosen['display_rect']
            complete = False
        if complete:
            try:
                width,height = _export_bitmap(doc,chosen,output)
                region = chosen['display_rect']; route = 'bitmap-original'; native = []
            except (ValueError, RuntimeError, OSError):
                reason = 'bitmap_export_failed'; complete = False
        if not complete:
            # Render from the PDF, never upscale a previously cropped bitmap.
            density = config['render_scale']
            if profile == 'deep':
                density = max([density] + [max(item['width']/max(item['display_rect'].width,1),
                            item['height']/max(item['display_rect'].height,1)) for item in images
                            if _overlap(item['display_rect'],detected) >= .9*_area(item['display_rect'])])
            # Pixmap rounds both ends of a fractional clip outward. Reserve the
            # possible extra rows/columns rather than silently exceeding limits.
            max_edge, max_pixels = config['max_edge'], config['max_pixels']
            scale = min(density,(max_edge-1)/max(region.width,region.height),
                        math.sqrt((max_pixels-4*max_edge)/_area(region)))
            pix = render_page(pdf,page.number,scale=scale,region=region)
            pix.save(str(output)); width,height = pix.width,pix.height
        if profile == 'fast':
            route = 'bitmap-crop'; native = []
        actual = [region.x0*sx,region.y0*sy,region.x1*sx,region.y1*sy]
        return {'policy':POLICY,'profile':profile,'config_sha256':config_hash,'route':route,'bbox_pixels':actual,
                'detected_bbox_pixels':list(detected_box),'bbox_pdf_points':list(region),
                'width':width,'height':height,'native_text':native,
                'native_text_coordinate_space':'displayed_pdf_points_top_left',
                'fallback_reason':reason,
                'render_scale':None if complete else scale,
                'resolution_limited':False if complete else scale < density}
