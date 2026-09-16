//! Album search against balbums.st, an index of public Bunkr albums.
//!
//! The site renders its results server-side, so one GET per search is enough —
//! there is no API and no crawling: the plugin asks for exactly the page the
//! user is looking at, and the album links it finds are what cyberdrop-dl takes
//! as its input list.

use serde::Serialize;
use serde_json::{Value, json};
use std::io::Read;
use std::time::Duration;

const BASE: &str = "https://balbums.st/";
const AGENT: &str = concat!(
    "FileTree/",
    env!("CARGO_PKG_VERSION"),
    " (album search plugin)"
);
/// A result page is ~50 KB; anything far beyond that is not the page we expect.
const MAX_BODY: usize = 4 * 1024 * 1024;
const MODES: [&str; 5] = ["broad", "strict", "fuzzy", "substring", "whole"];
const SORTS: [&str; 3] = ["latest", "oldest", "files"];
const SIZES: [u32; 4] = [20, 40, 60, 100];

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Album {
    pub title: String,
    pub url: String,
    /// Files in the album as the index reports it; `None` when it says nothing.
    pub files: Option<u32>,
    pub thumbnail: Option<String>,
}

/// Value of `name="…"` in one start tag.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    Some(&rest[..rest.find('"')?])
}

/// Text of the first `<tag>` in `html`, with any nested markup dropped.
fn text_of(html: &str, tag: &str) -> Option<String> {
    let open = html.find(&format!("<{tag}"))?;
    let body_start = open + html[open..].find('>')? + 1;
    let body_end = body_start + html[body_start..].find(&format!("</{tag}>"))?;
    Some(strip_markup(&html[body_start..body_end]))
}

fn strip_markup(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut depth = 0usize;
    for ch in html.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    decode_entities(out.split_whitespace().collect::<Vec<_>>().join(" ").trim())
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" | "#x27" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix('#')
                .and_then(|code| match code.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => code.parse().ok(),
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The "10 files" line each card carries under its title.
fn file_count(card: &str) -> Option<u32> {
    let at = card.find(" files").or_else(|| card.find(" file"))?;
    let digits: String = card[..at]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.chars().rev().collect::<String>().parse().ok()
}

/// Albums in one rendered result page, in the order the page lists them.
pub(crate) fn parse_albums(html: &str) -> Vec<Album> {
    let mut albums = Vec::new();
    let mut rest = html;
    while let Some(open) = rest.find("<a ") {
        let after = &rest[open..];
        let Some(tag_end) = after.find('>') else {
            break;
        };
        let tag = &after[..tag_end];
        let body_start = open + tag_end + 1;
        let body_len = rest[body_start..]
            .find("</a>")
            .unwrap_or(rest.len() - body_start);
        let card = &rest[body_start..body_start + body_len];
        let is_card = attr(tag, "class")
            .map(|class| class.split_whitespace().any(|word| word == "card"))
            .unwrap_or(false);
        if let Some(href) = attr(tag, "href")
            && is_card
            && href.starts_with("http")
        {
            albums.push(Album {
                title: text_of(card, "h3").unwrap_or_default(),
                url: decode_entities(href),
                files: file_count(card),
                thumbnail: card
                    .split("<img")
                    .find(|img| img.contains("thumb-img"))
                    .and_then(|img| attr(img, "src"))
                    .map(str::to_string),
            });
        }
        rest = &rest[body_start + body_len..];
    }
    albums
}

/// "page 1 of 4" in the summary line above the grid.
pub(crate) fn parse_pages(html: &str) -> (u32, u32) {
    let Some(at) = html.find("page <span") else {
        return (1, 1);
    };
    let numbers: Vec<u32> = strip_markup(&html[at..(at + 400).min(html.len())])
        .split_whitespace()
        .filter_map(|word| word.parse().ok())
        .take(2)
        .collect();
    match numbers[..] {
        [page, pages] => (page.max(1), pages.max(1)),
        _ => (1, 1),
    }
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The search URL for these options, with anything unrecognized falling back to
/// the site's own defaults rather than being passed through.
pub(crate) fn search_url(query: &str, mode: &str, per: u32, sort: &str, page: u32) -> String {
    let mode = if MODES.contains(&mode) { mode } else { "broad" };
    let sort = if SORTS.contains(&sort) {
        sort
    } else {
        "latest"
    };
    let per = if SIZES.contains(&per) { per } else { 20 };
    let mut url = format!(
        "{BASE}?search={}&mode={mode}&per={per}&sort={sort}",
        encode(query)
    );
    if page > 1 {
        url.push_str(&format!("&page={page}"));
    }
    url
}

#[tauri::command]
pub(crate) async fn bunkr_search(
    query: String,
    mode: String,
    per: u32,
    sort: String,
    page: u32,
) -> Result<Value, String> {
    if query.trim().is_empty() {
        return Err("Enter something to search for".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let url = search_url(query.trim(), &mode, per, &sort, page.max(1));
        let response = ureq::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(AGENT)
            .build()
            .get(&url)
            .call()
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => format!("The album index answered {code}"),
                other => other.to_string(),
            })?;
        let mut body = String::new();
        response
            .into_reader()
            .take(MAX_BODY as u64)
            .read_to_string(&mut body)
            .map_err(|error| error.to_string())?;
        let (page, pages) = parse_pages(&body);
        Ok(json!({
            "albums": parse_albums(&body),
            "page": page,
            "pages": pages,
            "url": url,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"
      <div>page <span class="text-[var(--text)]">2</span> of <span class="text-[var(--text)]">7</span></div>
      <section class="grid gap-4">
        <a href="https://bunkr.cr/a/EeVZecTX" target="_blank" class="card rounded-xl block">
          <div class="relative">
            <img src="/img/bunkr.svg" alt="">
            <img src="https://static.scdn.st/one/thumbs/two.png" alt="x" class="thumb-img absolute">
          </div>
          <div class="p-3.5">
            <h3 class="text-[13.5px] font-medium">Sample &amp; Album <span class="x">06/2026</span></h3>
            <div class="flex"><span class="text-[var(--text-soft)]">10 files</span><span>&rarr; Open</span></div>
          </div>
        </a>
        <a href="/topalbums" class="btn-ghost">Top albums</a>
        <a href="https://bunkr.cr/a/0fU51hUK" class="card block">
          <div class="p-3.5"><h3>Second</h3><div><span>1 file</span></div></div>
        </a>
      </section>"#;

    #[test]
    fn reads_every_album_card_and_skips_other_links() {
        let albums = parse_albums(PAGE);
        assert_eq!(albums.len(), 2);
        assert_eq!(
            albums[0],
            Album {
                title: "Sample & Album 06/2026".into(),
                url: "https://bunkr.cr/a/EeVZecTX".into(),
                files: Some(10),
                thumbnail: Some("https://static.scdn.st/one/thumbs/two.png".into()),
            }
        );
        assert_eq!(albums[1].files, Some(1));
        assert_eq!(albums[1].thumbnail, None);
    }

    #[test]
    fn reads_the_page_counter() {
        assert_eq!(parse_pages(PAGE), (2, 7));
        assert_eq!(parse_pages("<div>no counter here</div>"), (1, 1));
    }

    #[test]
    fn builds_urls_and_refuses_unknown_options() {
        assert_eq!(
            search_url("Jessitron", "broad", 20, "latest", 1),
            "https://balbums.st/?search=Jessitron&mode=broad&per=20&sort=latest"
        );
        assert_eq!(
            search_url("two words", "sneaky&mode=x", 33, "sideways", 3),
            "https://balbums.st/?search=two+words&mode=broad&per=20&sort=latest&page=3"
        );
    }

    /// Checks the parser against a page saved from the live site, which the
    /// repo does not carry: `BUNKR_FIXTURE=<file> cargo test -- --ignored`.
    #[test]
    #[ignore = "needs a saved result page in BUNKR_FIXTURE"]
    fn parses_a_saved_live_page() {
        let path = std::env::var("BUNKR_FIXTURE").expect("set BUNKR_FIXTURE to a saved page");
        let html = std::fs::read_to_string(path).expect("fixture is readable");
        let albums = parse_albums(&html);
        assert!(!albums.is_empty(), "no album cards found");
        for album in &albums {
            assert!(album.url.starts_with("http"), "bad url: {}", album.url);
            assert!(!album.title.is_empty(), "no title for {}", album.url);
        }
        println!("{} albums, pages {:?}", albums.len(), parse_pages(&html));
    }

    #[test]
    fn decodes_the_entities_titles_arrive_with() {
        assert_eq!(
            decode_entities("a &amp; b &#39;c&#39; &quot;d&quot;"),
            "a & b 'c' \"d\""
        );
        assert_eq!(decode_entities("bare & ampersand"), "bare & ampersand");
    }
}
