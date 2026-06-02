//! Minimal, dependency-free `.xlsx` writer (roadmap item #8).
//!
//! This project ships with **zero external crates** (see `Cargo.toml`), so rather
//! than pull in `rust_xlsxwriter` (and risk an offline build), we emit a real
//! Office-Open-XML workbook by hand: an `.xlsx` is just a ZIP archive of a few
//! small XML parts. We write the ZIP with the **store** method (no compression),
//! which needs only a CRC-32 — no deflate — and Excel/LibreOffice open the result
//! natively. Strings are written as inline strings (`t="inlineStr"`) so there's
//! no shared-string table to manage.
//!
//! Public surface: build a single worksheet from a header row + data rows of
//! [`Cell`]s via [`workbook`].

use std::fmt::Write as _;

/// One spreadsheet cell. `Text` becomes an inline string; `Int`/`Float` become
/// native numeric cells (so Excel can sum/sort them).
pub(crate) enum Cell {
    Text(String),
    Int(u64),
    Float(f64),
}

/// Assemble a one-sheet workbook from an already-built worksheet XML string.
/// Used by [`workbook`] and by streaming callers that build the sheet via
/// [`SheetWriter`], so the only large buffers are the sheet XML and the final
/// store-ZIP (the CRC-32 forces one pass over the bytes — no extra copy beyond
/// that is made).
pub(crate) fn workbook_from_sheet(sheet_name: &str, sheet_xml: &str) -> Vec<u8> {
    let workbook = build_workbook_xml(sheet_name);
    let parts: [(&str, &[u8]); 5] = [
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet_xml.as_bytes()),
    ];
    zip_store(&parts)
}

/// Builds the worksheet XML one row at a time. A large export streams rows in
/// (each transient `&[Cell]` is consumed immediately) rather than materialising
/// a `Vec<Vec<Cell>>` of the whole sheet. Every text cell is still formula-
/// guarded via [`write_inline_str_cell`].
pub(crate) struct SheetWriter {
    out: String,
    row: usize,
}

impl SheetWriter {
    pub(crate) fn new(headers: &[&str]) -> Self {
        let mut out = String::with_capacity(64 * 1024);
        out.push_str(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>",
        );
        let _ = write!(out, "<row r=\"1\">");
        for (c, h) in headers.iter().enumerate() {
            write_inline_str_cell(&mut out, c, 1, h);
        }
        out.push_str("</row>");
        Self { out, row: 1 }
    }

    pub(crate) fn push_row(&mut self, cells: &[Cell]) {
        self.row += 1;
        let row_num = self.row;
        let _ = write!(self.out, "<row r=\"{row_num}\">");
        for (c, cell) in cells.iter().enumerate() {
            match cell {
                Cell::Text(s) => write_inline_str_cell(&mut self.out, c, row_num, s),
                Cell::Int(n) => {
                    let _ = write!(self.out, "<c r=\"{}{}\"><v>{}</v></c>", col_letters(c), row_num, n);
                }
                Cell::Float(f) => {
                    let _ = write!(self.out, "<c r=\"{}{}\"><v>{}</v></c>", col_letters(c), row_num, f);
                }
            }
        }
        self.out.push_str("</row>");
    }

    pub(crate) fn finish(mut self) -> String {
        self.out.push_str("</sheetData></worksheet>");
        self.out
    }
}

const CONTENT_TYPES: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
    "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
    "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
    "</Types>"
);

const ROOT_RELS: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
    "</Relationships>"
);

const WORKBOOK_RELS: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
    "</Relationships>"
);

fn build_workbook_xml(sheet_name: &str) -> String {
    let mut name = String::new();
    xml_escape(&mut name, sheet_name);
    // Excel limits sheet names to 31 chars and forbids a few characters; the
    // caller passes a safe short name, but truncate defensively.
    let name: String = name.chars().take(31).collect();
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" ",
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
            "<sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets>",
            "</workbook>"
        ),
        name
    )
}

fn write_inline_str_cell(out: &mut String, col: usize, row: usize, value: &str) {
    let _ = write!(out, "<c r=\"{}{}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">", col_letters(col), row);
    // Formula-injection hardening (mirrors the CSV export): neutralize a leading
    // = + - @ TAB CR with a single quote so a spreadsheet treats the cell as
    // literal text rather than a formula. Headers never trigger this.
    if crate::export::needs_formula_guard(value) {
        out.push('\'');
    }
    xml_escape(out, value);
    out.push_str("</t></is></c>");
}

/// 0-based column index → Excel column letters (0→A, 25→Z, 26→AA …).
fn col_letters(mut index: usize) -> String {
    let mut buf = Vec::new();
    loop {
        buf.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap()
}

fn xml_escape(out: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids most control chars; drop them rather than emit
            // an invalid document Excel would refuse to open.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
}

// ── ZIP (store / no compression) ─────────────────────────────────────────────

/// Build a ZIP archive from `(name, bytes)` parts using the *store* method.
/// Store needs no deflate — only a CRC-32 — which keeps this dependency-free,
/// and the tiny XML parts of an `.xlsx` compress poorly anyway.
fn zip_store(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|(_, d)| d.len()).sum::<usize>() + 1024);
    // (name, crc, size, local-header offset) for the central directory.
    let mut central: Vec<(&str, u32, usize, usize)> = Vec::with_capacity(parts.len());

    for (name, data) in parts {
        let offset = out.len();
        let crc = crc32(data);
        // Local file header (signature 0x04034b50).
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method 0 = store
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0x21u16.to_le_bytes()); // mod date (1980-01-01)
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.push((name, crc, data.len(), offset));
    }

    let cd_offset = out.len();
    for (name, crc, size, offset) in &central {
        // Central directory header (signature 0x02014b50).
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version made by
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0x21u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(*size as u32).to_le_bytes());
        out.extend_from_slice(&(*size as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(&0u16.to_le_bytes()); // comment len
        out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        out.extend_from_slice(&(*offset as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    let cd_size = out.len() - cd_offset;

    // End of central directory record (signature 0x06054b50).
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with cd
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd_size as u32).to_le_bytes());
    out.extend_from_slice(&(cd_offset as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

/// Standard IEEE CRC-32 (polynomial 0xEDB88320), computed without a static
/// table — fine for the handful of small parts in an `.xlsx`.
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_known_vector() {
        // CRC-32 of "123456789" is 0xCBF43926 (standard test vector).
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn col_letters_sequence() {
        assert_eq!(col_letters(0), "A");
        assert_eq!(col_letters(25), "Z");
        assert_eq!(col_letters(26), "AA");
        assert_eq!(col_letters(27), "AB");
        assert_eq!(col_letters(701), "ZZ");
        assert_eq!(col_letters(702), "AAA");
    }

    #[test]
    fn workbook_is_a_valid_zip() {
        let mut sheet = SheetWriter::new(&["Name", "Size"]);
        sheet.push_row(&[Cell::Text("a.txt".into()), Cell::Int(123)]);
        sheet.push_row(&[Cell::Text("b & <c>".into()), Cell::Float(4.5)]);
        let bytes = workbook_from_sheet("Scan", &sheet.finish());
        // ZIP local-file signature at the front, EOCD signature near the end.
        assert_eq!(&bytes[0..4], &0x0403_4b50u32.to_le_bytes());
        assert!(bytes.windows(4).any(|w| w == 0x0605_4b50u32.to_le_bytes()));
        // Inline string must be XML-escaped.
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("b &amp; &lt;c&gt;"));
    }
}
