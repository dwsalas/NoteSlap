# NoteSlap

Turn study notes into typing drills. Upload a PDF, DOCX or TXT; the browser extracts the text,
splits it into short factual sentences, and you type them back. No backend, no build step.

Sentence splitting runs two ways:

- **Rules only** — algorithmic sentence segmentation. Instant, offline, no model.
- **Local model** — a local [Ollama](https://ollama.com) instance rewrites the notes into clean,
  self-contained sentences. Better output, because it can fix fragments and resolve "this" and "it".

---

## Run it locally

```bash
git clone https://github.com/dwsalas/NoteSlap.git
cd NoteSlap
python3 -m http.server 8080
```

Open <http://localhost:8080>. In VS Code the Live Server extension works too — right-click
`index.html` → *Open with Live Server*.

Do not open `index.html` with `file://`. `pdf.js` loads a worker over HTTP and will fail.

---

## Ollama setup (Linux / Kali)

```bash
# install
curl -fsSL https://ollama.com/install.sh | sh

# pull a small, fast model
ollama pull llama3.2:3b
```

### Allow the browser to call Ollama

Ollama rejects cross-origin requests by default. `OLLAMA_ORIGINS` is the allowlist.

**Quick test — foreground:**

```bash
sudo systemctl stop ollama          # free port 11434 first
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_ORIGINS="*" ollama serve
```

**Permanent — systemd:**

```bash
sudo systemctl edit ollama.service
```

Add:

```ini
[Service]
Environment="OLLAMA_ORIGINS=*"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
systemctl show ollama --property=Environment    # confirm it took
```

**Verify:**

```bash
curl http://localhost:11434/api/tags
curl -i -X OPTIONS http://localhost:11434/api/generate \
  -H "Origin: https://dwsalas.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

The second command must return `Access-Control-Allow-Origin`. If it doesn't, the environment
variable hasn't reached the running process.

`OLLAMA_ORIGINS="*"` lets **any** page you visit talk to your models. Once it works, narrow it:

```ini
Environment="OLLAMA_ORIGINS=https://dwsalas.github.io,http://localhost:8080"
```

---

## The HTTPS problem

GitHub Pages serves over `https://`. Ollama listens on `http://`. Browsers call that mixed
content and may block the request before Ollama ever sees it. Options, best first:

1. **Run the app locally** over `http://localhost:8080` and keep the Pages copy for the
   rules-only mode. Nothing to configure, works in every browser.
2. **Allow insecure content for the site.** Chrome/Edge: click the icon left of the address bar →
   *Site settings* → *Insecure content* → **Allow**, then reload. Chromium treats
   `http://localhost` as trustworthy, so this usually just works.
3. **Put Ollama behind HTTPS** with Caddy or a tunnel, and point the host field at that URL.

Firefox and Safari are stricter than Chromium here. Use option 1 if the connection dot stays red.

---

## Deploy to GitHub Pages

```bash
cd NoteSlap
git init -b main
git add .
git commit -m "Initial commit"

# create the repo on github.com first, then:
git remote add origin https://github.com/dwsalas/NoteSlap.git
git push -u origin main
```

On GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**

Live at `https://dwsalas.github.io/NoteSlap/` after a minute or two.

For a bare `dwsalas.github.io` URL, name the repo exactly `dwsalas.github.io`.

To push later changes:

```bash
git add .
git commit -m "Tune the sentence filter"
git push
```

---

## Keyboard

| Key | Action |
| --- | --- |
| `tab` | Restart the current line |
| `esc` | Back to the deck |
| `ctrl` + `/` | Skip the line, mark it missed |

---

## Files

```
NoteSlap/
├── index.html    Markup and CDN script tags
├── styles.css    Theme tokens, layout, typing canvas
├── app.js        Extraction, splitting, Ollama, typing engine
├── .nojekyll     Stops GitHub Pages running Jekyll over the files
└── README.md
```
