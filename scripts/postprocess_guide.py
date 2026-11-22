"""Post-process the users guide docx per toc.md:
1. Remove empty <w:pgNumType/> (confuses WPS).
2. Patch footer PAGE fields with explicit format switches (WPS ignores pgNumType fmt):
   section 2 (front matter, upperRoman) -> PAGE \\* ROMAN \\* MERGEFORMAT
   section 3 (body, decimal) -> PAGE \\* arabic \\* MERGEFORMAT
Footer files are mapped to sections via footerReference rIds in document order.
"""
import re
import shutil
import zipfile

DOC = "/home/z/my-project/download/LocalForge-Users-Guide.docx"
TMP = "/tmp/guide-docx"

shutil.rmtree(TMP, ignore_errors=True)
with zipfile.ZipFile(DOC) as z:
    z.extractall(TMP)

doc_path = TMP + "/word/document.xml"
xml = open(doc_path, encoding="utf-8").read()

# 1) strip empty pgNumType
xml = re.sub(r"<w:pgNumType/>", "", xml)
open(doc_path, "w", encoding="utf-8").write(xml)

# 2) collect footerReference ids in document order
rids = re.findall(r'<w:footerReference w:type="default" r:id="(rId\d+)"/>', xml)
print("footer refs in order:", rids)

rels = open(TMP + "/word/_rels/document.xml.rels", encoding="utf-8").read()
rid_to_target = dict(re.findall(r'<Relationship Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))

# Section order: [front-matter(Roman), body(arabic)] — cover has no footer ref
formats = ["ROMAN", "arabic"]
seen = []
for rid in rids:
    target = rid_to_target.get(rid)
    if not target or target in seen:
        continue
    seen.append(target)
    idx = len(seen) - 1
    fmt = formats[idx] if idx < len(formats) else "arabic"
    fpath = TMP + "/word/" + target
    fx = open(fpath, encoding="utf-8").read()
    fx2, n = re.subn(
        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
        r"\1 PAGE \\* " + fmt + r" \\* MERGEFORMAT \2",
        fx,
    )
    open(fpath, "w", encoding="utf-8").write(fx2)
    print(f"{target}: patched {n} PAGE field(s) -> {fmt}")

# rezip
out = DOC
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    import os
    for root, _, files in os.walk(TMP):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, TMP)
            z.write(full, rel)
print("rezipped", out)
