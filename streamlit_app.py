"""
Streamlit shell around the Gemini Live (Vite) voice UI.

Why not pure Python Live? Continuous bidirectional PCM + browsers work best from
that small front-end; Streamlit mounts it via an iframe (see below).

Deploy:
  npm ci && npm run build   # populate ./dist/
  streamlit run streamlit_app.py
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"


def _inline_built_assets(html: str, dist_dir: Path) -> str:
    """Turn Vite's index.html + hashed assets into a single document for srcdoc."""
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


def _try_npm_build() -> bool:
    if not (ROOT / "package.json").exists():
        return False
    try:
        subprocess.run(
            ["npm", "run", "build"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        return (DIST / "index.html").exists()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def main() -> None:
    st.set_page_config(
        page_title="Gemini 3.1 Flash Live (Streamlit)",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    st.title("Gemini 3.1 Flash Live (preview)")
    st.caption(
        "Runs the bundled browser demo inside Streamlit via `components.html` iframe. "
        "Your Gemini API key never touches Python — it stays in the embedded page."
    )

    embed = _load_embed_document()
    if not embed:
        st.error("`dist/` is missing. Build the front-end first.")
        if st.button("Try `npm run build` automatically (needs Node/npm on PATH)"):
            with st.spinner("Building …"):
                if _try_npm_build():
                    st.success("Build finished — rerun the page or reload.")
                    st.rerun()
                else:
                    st.warning(
                        "Automatic build failed. From the project root run: "
                        "`npm ci && npm run build`, then rerun Streamlit."
                    )
        st.stop()

    st.info(
        "**Microphone + speaker** need to work inside Streamlit's iframe — most browsers prompt "
        "through the iframe. **If Chrome blocks mic**, deploy the **`dist/`** folder as a static "
        "site instead, or keep using `npm run dev` standalone — Streamlit stays best as an "
        "optional wrapper.",
        icon="📌",
    )

    components.html(embed, height=1100, scrolling=True)


main()
