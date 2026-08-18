# NoteSlap

Study-by-typing app. Upload PDF/DOCX/TXT, split into sentences, type them back.

## Constraints
- Vanilla HTML/CSS/JS. No build step, no framework, no npm.
- Files must stay at repo root — served by GitHub Pages.
- pdf.js and mammoth.js load from CDN. WebLLM is pinned to 0.2.84.
- Three splitter modes: rules (offline), webllm (in-browser GPU), ollama (localhost).
- Design: ruled-paper theme, correct characters get a highlighter background.