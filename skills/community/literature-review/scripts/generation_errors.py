"""Compatibility import for shared model-independent generation diagnostics."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from generation_diagnostics import GenerationError, diagnostic
