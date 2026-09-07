"""Drive files become text the index can chunk — or are refused for a reason (#6).

Each office format is written with its own library and read back through
``extraction.extract``; the PDF is hand-built so page attribution is tested
against pages whose contents are known. Secrets and binaries are refused before
being read.
"""

import pytest

from kurisuassistant.utils.extraction import (
    ExtractionError,
    Page,
    Unextractable,
    extract,
    is_secret_name,
    kind_of,
    looks_like_text,
)

CAP = 20 * 1024 * 1024


def _pdf_bytes(pages):
    """A minimal but valid PDF: one Helvetica line of text per page."""
    objects = []
    n = len(pages)
    font_num = 3 + 2 * n
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    for i, text in enumerate(pages):
        page_num = 3 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {page_num + 1} 0 R "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> >>".encode()
        )
        stream = f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class TestSniffing:
    def test_utf8_is_text_even_when_cut_mid_character(self):
        sample = "tiếng Việt có dấu".encode("utf-8")
        assert looks_like_text(sample)
        assert looks_like_text(sample[:-1]), "a truncated final character is still text"

    def test_a_nul_byte_is_binary(self):
        assert not looks_like_text(b"PK\x03\x04\x00\x00")

    def test_kind_comes_from_the_extension_first(self):
        assert kind_of("report.pdf", "application/pdf") == "pdf"
        assert kind_of("deck.pptx", None) == "pptx"
        assert kind_of("main.ts", "video/mp2t") == "text", "mimetypes calls .ts a video; it is source"
        assert kind_of("notes.md", "text/markdown") == "text"
        assert kind_of("page.htm", None) == "html"

    def test_unknown_names_are_undecided_not_refused(self):
        assert kind_of("README", None) is None
        assert kind_of("mystery.qqq", "application/octet-stream") is None


class TestSecrets:
    @pytest.mark.parametrize(
        "name", [".env", ".env.production", "id_rsa", "server.pem", "site.key", "vault.kdbx"],
    )
    def test_are_named_as_such(self, name):
        assert is_secret_name(name)

    def test_and_are_refused_before_being_read(self, tmp_path):
        path = tmp_path / "blob"
        path.write_text("SECRET_TOKEN=abc")
        with pytest.raises(Unextractable, match="secret"):
            extract(path, ".env", None, CAP)


class TestText:
    def test_plain_text_is_one_page_with_no_page_number(self, tmp_path):
        path = tmp_path / "blob"
        path.write_text("first line\r\nsecond line")
        assert extract(path, "notes.txt", "text/plain", CAP) == [Page("first line\nsecond line", None)]

    def test_a_file_with_no_extension_is_sniffed(self, tmp_path):
        path = tmp_path / "blob"
        path.write_text("# A readme\n\nwith words")
        [page] = extract(path, "README", None, CAP)
        assert "with words" in page.text

    def test_binary_is_refused(self, tmp_path):
        path = tmp_path / "blob"
        path.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
        with pytest.raises(Unextractable, match="binary"):
            extract(path, "photo.png", "image/png", CAP)

    def test_over_the_cap_is_refused_without_being_read(self, tmp_path):
        path = tmp_path / "blob"
        path.write_text("x" * 100)
        with pytest.raises(Unextractable, match="larger"):
            extract(path, "big.txt", "text/plain", 50)

    def test_html_keeps_the_words_and_drops_the_markup(self, tmp_path):
        path = tmp_path / "blob"
        path.write_text(
            "<html><head><title>Trip</title><style>p{color:red}</style></head>"
            "<body><h1>Plan</h1><p>Fly to <b>Hanoi</b> on Monday.</p>"
            "<script>alert(1)</script><ul><li>passport</li><li>charger</li></ul></body></html>"
        )
        [page] = extract(path, "plan.html", "text/html", CAP)
        assert page.text.splitlines() == ["Trip", "Plan", "Fly to Hanoi on Monday.", "passport", "charger"]


class TestPdf:
    def test_pages_are_numbered_from_one(self, tmp_path):
        path = tmp_path / "blob"
        path.write_bytes(_pdf_bytes(["First page about cats", "Second page about passports"]))
        pages = extract(path, "report.pdf", "application/pdf", CAP)
        assert [p.page for p in pages] == [1, 2]
        assert "cats" in pages[0].text and "passports" in pages[1].text

    def test_garbage_with_a_pdf_name_is_an_extraction_error(self, tmp_path):
        path = tmp_path / "blob"
        path.write_bytes(b"%PDF-1.4\nthis is not a pdf")
        with pytest.raises(ExtractionError):
            extract(path, "broken.pdf", "application/pdf", CAP)


class TestOffice:
    def test_docx_paragraphs_and_tables(self, tmp_path):
        import docx

        path = tmp_path / "blob"
        document = docx.Document()
        document.add_paragraph("Quarterly summary")
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "revenue"
        table.rows[0].cells[1].text = "up"
        document.save(str(path))

        [page] = extract(path, "summary.docx", None, CAP)
        assert page.page is None
        assert "Quarterly summary" in page.text
        assert "revenue\tup" in page.text

    def test_pptx_slides_are_pages(self, tmp_path):
        from pptx import Presentation

        path = tmp_path / "blob"
        presentation = Presentation()
        for title in ("Why we travel", "Where we go"):
            slide = presentation.slides.add_slide(presentation.slide_layouts[5])
            slide.shapes.title.text = title
        presentation.save(str(path))

        pages = extract(path, "deck.pptx", None, CAP)
        assert [(p.page, p.text.strip()) for p in pages] == [(1, "Why we travel"), (2, "Where we go")]

    def test_xlsx_sheets_are_pages_and_name_themselves(self, tmp_path):
        import openpyxl

        path = tmp_path / "blob"
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = "Budget"
        sheet.append(["item", "cost"])
        sheet.append(["flight", 420])
        workbook.create_sheet("Empty")
        workbook.save(str(path))

        [page] = extract(path, "budget.xlsx", None, CAP)
        assert page.page == 1
        assert page.text.splitlines() == ["Sheet: Budget", "item\tcost", "flight\t420"]
