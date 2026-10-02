import sys
import json
import base64

try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf
    except ImportError:
        print(json.dumps({"error": "PyMuPDF not installed"}))
        sys.exit(1)

def run():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({}))
            return
        
        req = json.loads(raw_input)
        docs_map = {}
        for d in req.get("docs", []):
            idx = d.get("index", 0)
            b64 = d.get("pdf_base64", "")
            if b64:
                pdf_bytes = base64.b64decode(b64)
                docs_map[idx] = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        
        results = {}
        crops = req.get("crops", [])
        for c in crops:
            cid = c.get("id")
            doc_idx = c.get("doc_index", 0)
            page_num = c.get("page", 1)
            box = c.get("box", [])
            
            doc = docs_map.get(doc_idx)
            if not doc:
                continue
            
            if page_num < 1 or page_num > len(doc):
                continue
            
            if not box or len(box) != 4:
                continue
            
            page = doc[page_num - 1]
            w = page.rect.width
            h = page.rect.height
            ymin, xmin, ymax, xmax = box
            
            # Normalize to page dimensions with small safety padding
            pad = 8
            r_xmin = max(0, (float(xmin) / 1000.0) * w - pad)
            r_ymin = max(0, (float(ymin) / 1000.0) * h - pad)
            r_xmax = min(w, (float(xmax) / 1000.0) * w + pad)
            r_ymax = min(h, (float(ymax) / 1000.0) * h + pad)
            
            if r_xmax <= r_xmin or r_ymax <= r_ymin:
                continue
            
            rect = pymupdf.Rect(r_xmin, r_ymin, r_xmax, r_ymax)
            pix = page.get_pixmap(clip=rect, dpi=200)
            png_b64 = base64.b64encode(pix.tobytes("png")).decode("utf-8")
            results[cid] = f"data:image/png;base64,{png_b64}"
            
        print(json.dumps({"success": True, "images": results}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    run()
