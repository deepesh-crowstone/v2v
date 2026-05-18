"""Mounts the compiled Gemini Live UI (`dist/`) inside Streamlit."""

from __future__ import annotations

import re
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"


def _inline_built_assets(html: str, dist_dir: Path) -> str:
    css_pattern = re.compile(r'<link[^>]+href="([^"]+\.css)"[^>]*>', re.I)
    js_pattern = re.compile(r'<script[^>]*src="([^"]+\.js)"[^>]*></script>', re.I)

    def repl_css(match: re.Match[str]) -> str:
        href = match.group(1).lstrip("/").lstrip("./")
        path = dist_dir / href
        css = path.read_text(encoding="utf-8")
        return f"<style>{css}</style>"

    def repl_js(match: re.Match[str]) -> str:
        src = match.group(1).lstrip("/").lstrip("./")
        path = dist_dir / src
        js = path.read_text(encoding="utf-8")
        return f'<script type="module">\n{js}\n</script>'

    out = css_pattern.sub(repl_css, html)
    out = js_pattern.sub(repl_js, out)
    return out


def _load_embed_document() -> str:
    index = DIST / "index.html"
    if not index.exists():
        return ""
    return _inline_built_assets(index.read_text(encoding="utf-8"), DIST)


def main() -> None:
    st.set_page_config(
        page_title="Gemini Live · Voice",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    embed = _load_embed_document()
    if not embed:
        st.error("`dist/` is missing. Run `npm ci && npm run build`, then redeploy.")
        st.stop()

    components.html(embed, height=1100, scrolling=True)


main()
