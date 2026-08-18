# NoteSlap

Turn your study notes into typing drills. Upload a PDF, DOCX or TXT; NoteSlap pulls out the
facts, and you type them back. Retyping a definition from memory beats rereading it.

**[Try it →](https://dwsalas.github.io/NoteSlap/)**

Everything runs in your browser. Your files are never uploaded anywhere.

---

## How it works

1. **Load** a document, or paste text.
2. **Split** it into short factual sentences — three ways to do this, see below.
3. **Review** the lines. Edit what reads badly, delete what isn't worth knowing.
4. **Type** them, with live WPM, accuracy, and a highlighter that fills in behind your correct keystrokes.

The results screen leads with lines typed clean on the first try, not words per minute. Speed is
a side effect; recall is the point.

---

## Three ways to split

| Mode | Needs | First run | Quality |
| --- | --- | --- | --- |
| **Rules only** | nothing | instant | decent |
| **In this browser** | WebGPU | one model download | good |
| **Local model** | [Ollama](https://ollama.com) | instant | best |

NoteSlap picks a mode that works when the page loads, so you can ignore this section entirely if
you want to. Change it under *Pick a splitter*.

### Rules only

Algorithmic sentence segmentation. No model, no network, no wait. It handles hard-wrapped PDF
paragraphs, strips headers, page numbers, citations and table rows, and flattens curly quotes and
em dashes into characters you can actually type.

### In this browser

Runs a small language model on your own GPU through [WebLLM](https://github.com/mlc-ai/web-llm).
No install, no account, no API key — and your notes still never leave the machine.

The first load downloads model weights, roughly 0.6–2 GB depending on which model you pick. Your
browser caches them, so it only happens once. The smallest models are listed first on purpose:
this task is sentence rewriting, not reasoning, and a 1B model does it nearly as well as a 7B in a
quarter of the download.

Needs WebGPU — Chrome or Edge 113+, or Safari 18+. Where it's unavailable the option is disabled
and rules-only takes over.

### Local model

If you already run Ollama, NoteSlap will use it. Best output, since a larger model can repair
fragments and resolve dangling references like "this" and "it".

Ollama blocks cross-origin requests by default, so allow the page's origin:

```bash
OLLAMA_ORIGINS="http://localhost:8080" ollama serve
```

On Windows, set `OLLAMA_ORIGINS` as an environment variable, then quit Ollama from the system
tray and relaunch it — closing the window isn't enough.

The hosted version is served over HTTPS while Ollama listens on HTTP, which browsers may block as
mixed content. If the connection dot stays red, run NoteSlap locally instead.

---

## Run it yourself

No build step, nothing to install.

```bash
git clone https://github.com/dwsalas/NoteSlap.git
cd NoteSlap
python3 -m http.server 8080
```

Open <http://localhost:8080>.

Serve it over HTTP rather than opening `index.html` directly — `pdf.js` loads a worker script and
will fail on `file://`.

### Deploy your own copy

Fork the repo, then **Settings → Pages → Deploy from a branch → `main` / `(root)`**. Live at
`https://YOUR-USERNAME.github.io/NoteSlap/` within a couple of minutes. The files must stay at the
repository root.

---

## Keyboard

| Key | Action |
| --- | --- |
| `tab` | Restart the current line |
| `esc` | Back to the deck |
| `ctrl` + `/` | Skip the line and mark it missed |

---

## Privacy

Documents are parsed in the browser and never sent to a server. The rules and in-browser modes
make no network calls at all once the page has loaded. The Ollama mode talks only to the address
you enter, which is your own machine by default.

Drill lines are kept in `localStorage` so a session survives a refresh. Clearing site data removes
them.

---

## Built with

Vanilla HTML, CSS and JavaScript — no framework, no bundler, no npm.
[pdf.js](https://mozilla.github.io/pdf.js/) for PDFs,
[mammoth.js](https://github.com/mwilliamson/mammoth.js) for DOCX, and
[WebLLM](https://github.com/mlc-ai/web-llm) for in-browser inference.

## Contributing

Issues and pull requests welcome. The whole app is three files at the repo root: `index.html`,
`styles.css`, `app.js`.

## License

MIT