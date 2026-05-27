#!/usr/bin/env python3
"""docling_extract.py — called by llm_wiki Rust backend.

Usage: python3 docling_extract.py <pdf_path> [page_start page_end]
  page_start, page_end: 1-indexed, inclusive.
Writes markdown to stdout.
"""
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: docling_extract.py <pdf_path> [page_start page_end]", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    page_range: tuple[int, int] | None = None
    if len(sys.argv) >= 4:
        page_range = (int(sys.argv[2]), int(sys.argv[3]))

    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()

    convert_kwargs: dict = {}
    if page_range is not None:
        convert_kwargs["page_range"] = page_range

    result = converter.convert(path, **convert_kwargs)
    md = result.document.export_to_markdown()
    sys.stdout.write(md)


main()
