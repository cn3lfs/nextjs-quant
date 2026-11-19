"""Freeze official field metadata; not used by the application at runtime."""
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen
import json
import re

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://help.tdx.com.cn/quant/docs/markdown/TdxQuant.md/"
PAGES = {
    "FN": "mindoc-1h10m001ic888.html",
    "GP": "mindoc-1h10muc82r55k.html",
    "BK": "mindoc-1h10p0ncmp5mc.html",
    "SC": "mindoc-1h10p8op6ia9g.html",
    "GO": "mindoc-1h10pk3rsg044.html",
}


class Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def main():
    target = ROOT / "docs/data-sources/tdx-financial"
    catalog = ROOT / "packages/tstdx/src/financial-data"
    sources = []
    outputs = {}
    for namespace, page in PAGES.items():
        url = BASE + page
        body = urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25).read()
        parser = Tables()
        parser.feed(body.decode("utf-8"))
        section = namespace
        rows = []
        for row in parser.rows:
            if row and re.fullmatch(namespace + r"\d+", row[0], re.I):
                code = namespace + str(int(re.search(r"\d+", row[0]).group()))
                label = row[-1]
                rows.append({"code": code, "section": section, "label": label})
            elif namespace == "FN" and len(row) >= 4 and row[0] and not any(row[1:]):
                section = row[0]
        if not rows or len({r["code"] for r in rows}) != len(rows):
            raise ValueError(f"Missing or duplicate official fields: {namespace}")
        snapshot = json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
        outputs[target / f"{namespace.lower()}-fields.json"] = snapshot
        sources.append({"namespace": namespace, "url": url, "retrievedOn": "2026-11-07", "responseSha256": sha256(body).hexdigest(), "metadataSha256": sha256(snapshot.encode()).hexdigest(), "fields": len(rows)})
        entries = [[row["code"], row["section"], row["label"]] for row in rows]
        name = namespace.lower()
        outputs[catalog / f"catalog-{name}.ts"] = (
            f"// {namespace} field metadata from the frozen TongDaXin source snapshot.\n"
            'import type { FinancialSourceEntry } from "./catalog-types.js";\n\n'
            f"export const {name}SourceEntries: readonly FinancialSourceEntry[] = [\n"
            + "".join(f"  {json.dumps(entry, ensure_ascii=False)},\n" for entry in entries)
            + "];\n"
        )
        print(f"{namespace}: {len(rows)} fields")
    outputs[target / "manifest.json"] = json.dumps(sources, ensure_ascii=False, indent=2) + "\n"
    target.mkdir(parents=True, exist_ok=True)
    catalog.mkdir(parents=True, exist_ok=True)
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
