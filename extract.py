#!/usr/bin/env python3
"""استخراج متن از فایل‌ها برای ایجنت: PDF, DOCX, XLSX, PPTX, ZIP و متن/CSV/کد.
استفاده: extract.py <مسیر فایل> <مسیر خروجی متن> <نام اصلی فایل>
خروجی: یک JSON در stdout."""
import sys, os, json, zipfile

MAX_CHARS = 6_000_000
TEXT_EXT = {"txt","md","markdown","csv","tsv","json","jsonl","log","js","mjs","cjs","ts","tsx","jsx","py","html","htm",
            "css","scss","xml","yaml","yml","toml","ini","cfg","conf","env","sh","bash","sql","java","c","cpp","h","hpp",
            "cs","go","rs","rb","php","swift","kt","lua","r","srt","vtt","tex","svg","rtf"}

def decode(raw: bytes) -> str:
    # فایل‌های فارسی اکسل اغلب windows-1256 هستند
    for enc in ("utf-8-sig", "utf-8", "cp1256"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")

def read_pdf(path):
    from pypdf import PdfReader
    r = PdfReader(path)
    if r.is_encrypted:
        try:
            r.decrypt("")
        except Exception:
            raise RuntimeError("PDF رمزگذاری شده است")
    parts, total, size = [], 0, 0
    pages = len(r.pages)
    for i, p in enumerate(r.pages):
        try:
            t = (p.extract_text() or "").strip()
        except Exception:
            t = ""
        total += len(t)
        chunk = f"--- صفحه {i + 1} ---\n{t}\n"
        parts.append(chunk)
        size += len(chunk)
        if size > MAX_CHARS:
            break
    note = "scanned" if pages > 0 and total < 20 * pages else ""
    return "\n".join(parts), pages, note

def read_docx(path):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    d = Document(path)
    out = []
    for child in d.element.body.iterchildren():
        if child.tag.endswith("}p"):
            out.append(Paragraph(child, d).text)
        elif child.tag.endswith("}tbl"):
            for row in Table(child, d).rows:
                out.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(out), 0, ""

def read_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out, size = [], 0
    for ws in wb.worksheets:
        out.append(f"--- شیت {ws.title} ---")
        for row in ws.iter_rows(values_only=True):
            line = "\t".join("" if v is None else str(v) for v in row)
            out.append(line)
            size += len(line) + 1
            if size > MAX_CHARS:
                break
        if size > MAX_CHARS:
            break
    return "\n".join(out), len(wb.worksheets), ""

def read_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    out = []
    for i, s in enumerate(prs.slides, 1):
        out.append(f"--- اسلاید {i} ---")
        for sh in s.shapes:
            if getattr(sh, "has_text_frame", False) and sh.has_text_frame:
                out.append(sh.text_frame.text)
            if getattr(sh, "has_table", False) and sh.has_table:
                for row in sh.table.rows:
                    out.append(" | ".join(c.text.strip() for c in row.cells))
        if s.has_notes_slide and s.notes_slide.notes_text_frame is not None:
            n = s.notes_slide.notes_text_frame.text.strip()
            if n:
                out.append(f"[یادداشت: {n}]")
    return "\n".join(out), len(prs.slides), ""

def read_zip(path):
    with zipfile.ZipFile(path) as z:
        lines = [f"{i.filename}\t{i.file_size} بایت" for i in z.infolist()[:2000]]
    return "فهرست فایل‌های داخل zip:\n" + "\n".join(lines), 0, ""

def main():
    src, out, name = sys.argv[1], sys.argv[2], sys.argv[3]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    try:
        if ext == "pdf":
            text, pages, note = read_pdf(src); kind = "pdf"
        elif ext == "docx":
            text, pages, note = read_docx(src); kind = "docx"
        elif ext in ("xlsx", "xlsm"):
            text, pages, note = read_xlsx(src); kind = "xlsx"
        elif ext == "pptx":
            text, pages, note = read_pptx(src); kind = "pptx"
        elif ext == "zip":
            text, pages, note = read_zip(src); kind = "zip"
        else:
            raw = open(src, "rb").read()
            if ext not in TEXT_EXT and b"\x00" in raw[:4096]:
                raise RuntimeError(f"نوع فایل «{ext or 'نامشخص'}» پشتیبانی نمی‌شود")
            text, pages, note, kind = decode(raw), 0, "", "text"
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS] + "\n…[ادامه‌ی فایل بیش از سقف ۶ میلیون کاراکتر بود و بریده شد]"
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print(json.dumps({"ok": True, "kind": kind, "chars": len(text), "pages": pages, "note": note}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))

main()
