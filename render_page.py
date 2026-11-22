#!/usr/bin/env python3
"""رندر یک صفحه‌ی PDF به JPEG. استفاده: render_page.py <pdf> <شماره صفحه از ۱> <خروجی.jpg>"""
import sys, json
import pypdfium2 as pdfium

src, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    pdf = pdfium.PdfDocument(src)
    if n < 1 or n > len(pdf):
        print(json.dumps({"ok": False, "error": f"صفحه باید بین 1 و {len(pdf)} باشد"}, ensure_ascii=False)); sys.exit(0)
    img = pdf[n - 1].render(scale=1.5).to_pil().convert("RGB")
    img.save(out, "JPEG", quality=75)
    print(json.dumps({"ok": True, "pages": len(pdf), "width": img.width, "height": img.height}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
