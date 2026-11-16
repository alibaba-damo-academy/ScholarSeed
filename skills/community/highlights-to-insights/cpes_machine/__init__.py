"""HINT's self-contained CPES fork; no model calls at import time."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
VERSION = 'hint-cpes-machine-v1'

for name, directory in [('cpes', ROOT / 'src'),
                        ('cpes_format_converter', ROOT / 'cpes-format-converter')]:
    loaded = sys.modules.get(name)
    if loaded and not Path(loaded.__file__).resolve().is_relative_to(directory):
        raise ImportError(f'{name} is already loaded from outside the bundled machine.')
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from cpes_format_converter.pdf import PDFDocument, Rect, engine_versions, render_page
from cpes_format_converter.native import native_lines

__all__ = ['ROOT', 'VERSION', 'native_lines', 'PDFDocument', 'Rect', 'engine_versions', 'render_page']
