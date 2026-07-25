"""Auto-orient a rendered page so OCR and the vision model read it upright.

Scanned PDFs (e.g. an HP MFP scan) often carry a ``/Rotate`` flag that poppler
applies to a page whose image content is *still* sideways, so ``pdf2image``
hands us a 90°/180°/270° rotated page. AWS Textract's table detection and the
vision model both degrade badly on rotated dense tables — the document that
triggered this fix came back with a fully hallucinated transaction list because
neither signal could read the sideways scan.

Tesseract's Orientation-and-Script-Detection (``--psm 0``) reports the rotation
needed to make the page upright, with a confidence score. We shell out to the
``tesseract`` binary directly (already in the image — see Dockerfile; more robust
than pytesseract's OSD parser across builds) and rotate only when it's confident,
so an already-upright page is never touched. Any failure (no binary, low
confidence, parse error) returns the image unchanged — orientation correction is
best-effort and must never break extraction.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
from typing import Tuple

# OSD confidence below this is treated as "not sure" and the page is left as-is,
# so we never rotate a correctly-oriented page on a weak guess. The real rotated
# scans we've seen score ~9; genuinely upright pages report rotate=0 regardless.
_MIN_CONF = float(os.getenv("FINOVA_ORIENT_MIN_CONF", "2.0"))


def _enabled() -> bool:
    return os.getenv("FINOVA_AUTO_ORIENT", "true").lower() == "true"


def _osd(img) -> Tuple[int, float]:
    """Return (clockwise degrees to upright, confidence) from tesseract OSD.

    Pipes the page to ``tesseract stdin stdout --psm 0`` (no temp file).
    (0, 0.0) on any failure so callers fall back to the original image.
    """
    if shutil.which("tesseract") is None:
        return 0, 0.0
    try:
        rgb = img if img.mode in ("RGB", "L") else img.convert("RGB")
        buf = io.BytesIO()
        rgb.save(buf, format="PNG")
        out = subprocess.run(
            ["tesseract", "stdin", "stdout", "--psm", "0"],
            input=buf.getvalue(), capture_output=True, timeout=30,
        ).stdout.decode("utf-8", "replace")
        rot = re.search(r"Rotate:\s*(\d+)", out)
        conf = re.search(r"Orientation confidence:\s*([\d.]+)", out)
        return (int(rot.group(1)) if rot else 0,
                float(conf.group(1)) if conf else 0.0)
    except Exception as e:
        print(f"⚠️  orientation OSD failed ({type(e).__name__}: {e})", file=sys.stderr)
        return 0, 0.0


def auto_orient(img):
    """Rotate a PIL image upright when tesseract OSD is confident; else unchanged."""
    if not _enabled():
        return img
    rotate, conf = _osd(img)
    if rotate % 360 != 0 and conf >= _MIN_CONF:
        try:
            # OSD 'Rotate' is clockwise-degrees-to-upright; PIL rotates CCW, so
            # negate. expand=True keeps the whole page (no corner clipping).
            oriented = img.rotate(-rotate, expand=True)
            print(f"🔄 auto-oriented page {rotate}° (OSD conf {conf:.1f})", file=sys.stderr)
            return oriented
        except Exception as e:
            print(f"⚠️  orientation rotate failed ({type(e).__name__}: {e})", file=sys.stderr)
    return img
