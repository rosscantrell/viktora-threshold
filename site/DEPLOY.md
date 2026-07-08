# Threshold beta site — deploy notes

Static single page + a tiny waitlist service, deployed on the existing demo /
pilot droplet stack (`deploy@`, `/opt` conventions, nginx + certbot + pm2 —
same idiom as `PILOT-OPERATIONS-RUNBOOK.md`). Nothing here publishes on its own;
these are the exact commands an operator runs once Ross approves the preview.

Assumptions (matching the pilot stack):
- Droplet already has: Node 20+, pm2, nginx, certbot, ufw (80/443 open).
- DNS for `viktora.ai` is on **GoDaddy** (not DigitalOcean).
- Deploy user is `deploy`; app/site roots live under `/opt`.
- Target host below is written as `<host>` (the droplet you're deploying to).

---

## 0. GoDaddy A-records (the manual DNS step)

`viktora.ai` is GoDaddy-managed. Log into <https://dcc.godaddy.com/control/portfolio>,
open **viktora.ai → DNS**, and add/confirm:

| Type | Name  | Value             | TTL     |
|------|-------|-------------------|---------|
| A    | `@`   | `<droplet IPv4>`  | 600 s   |
| A    | `www` | `<droplet IPv4>`  | 600 s   |

(GoDaddy appends `.viktora.ai`; `@` is the apex `viktora.ai`.) Wait for
propagation before running certbot: `dig +short viktora.ai` should return the
droplet IP.

---

## 1. Upload the static site

From this repo (the `site/` directory is self-contained):

```bash
# Create the web root and push the static assets (everything except the
# server-side files — index.html + assets/ only).
ssh deploy@<host> 'sudo mkdir -p /opt/threshold-site/public && sudo chown -R deploy:deploy /opt/threshold-site'
rsync -avz --delete \
  --exclude 'waitlist-server.mjs' --exclude 'DEPLOY.md' \
  --exclude 'waitlist.jsonl' --exclude 'preview-*.png' \
  site/ deploy@<host>:/opt/threshold-site/public/
```

The hero video (`assets/hero.mp4`, `assets/hero.webm`) is the largest asset
(~3 MB each). If you want to serve only one, drop the other and remove its
`<source>` line from `index.html` — browsers pick the first they can play.

---

## 2. Install + start the waitlist service (pm2)

The service is stdlib-only (Resend is called over plain HTTPS via `fetch` — no
`npm install`). Copy it up and start it on `127.0.0.1:4770` (nginx proxies to
it; it never binds a public port).

```bash
ssh deploy@<host> 'mkdir -p /opt/threshold-site/data'
scp site/waitlist-server.mjs deploy@<host>:/opt/threshold-site/waitlist-server.mjs

ssh deploy@<host> '
  # Resend key for signup notifications (optional — falls back to pm2-log
  # console notifications if unset). Store it out of the process table:
  #   echo "EMAIL_API_KEY=re_xxx" >> /opt/threshold-site/.env
  set -a; [ -f /opt/threshold-site/.env ] && . /opt/threshold-site/.env; set +a
  WAITLIST_PORT=4770 \
  WAITLIST_DATA_FILE=/opt/threshold-site/data/waitlist.jsonl \
  WAITLIST_NOTIFY_TO=beta@viktora.ai \
  pm2 start /opt/threshold-site/waitlist-server.mjs \
    --name threshold-waitlist --update-env
  pm2 save
'
```

Confirm it's up (internal only):

```bash
ssh deploy@<host> 'curl -s http://127.0.0.1:4770/health'   # → {"status":"ok"}
ssh deploy@<host> 'pm2 logs threshold-waitlist --lines 20 --nostream'
```

> `EMAIL_API_KEY` is read from `/opt/threshold-site/.env` above so it stays out
> of the pm2 process table. Note the runbook caveat: `pm2 restart --update-env`
> reads the **current shell environment**, so always re-source `.env` before a
> restart if you change the key.

---

## 3. nginx vhost — static root + /api/waitlist proxy

Write `/etc/nginx/sites-available/threshold-site`:

```nginx
# viktora.ai + www — Threshold beta static site
server {
    listen 80;
    listen [::]:80;
    server_name viktora.ai www.viktora.ai;

    root /opt/threshold-site/public;
    index index.html;

    # Long-cache the hashed/static media; the HTML stays fresh.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=604800, immutable";
        try_files $uri =404;
    }

    # Waitlist API → the pm2 service on 127.0.0.1:4770
    location /api/waitlist {
        proxy_pass http://127.0.0.1:4770;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 10s;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

Enable it and reload:

```bash
ssh deploy@<host> '
  sudo ln -sf /etc/nginx/sites-available/threshold-site /etc/nginx/sites-enabled/threshold-site
  sudo nginx -t && sudo systemctl reload nginx
'
```

---

## 4. HTTPS via certbot

Same stack as the pilots — Let's Encrypt, 90-day certs, auto-renewed by the
`certbot.timer` systemd unit. Run **after** the GoDaddy A-records resolve to
the droplet (step 0):

```bash
ssh deploy@<host> '
  sudo certbot --nginx \
    -d viktora.ai -d www.viktora.ai \
    --redirect --agree-tos -m ops@viktora.ai --no-eff-email
'
```

certbot rewrites the vhost to add the 443 server block + HTTP→HTTPS 301. It also
edits `server_name` handling for the `www` → apex redirect if you want it —
otherwise both hostnames serve the same site (the site's own CORS allow-list
already covers both `https://viktora.ai` and `https://www.viktora.ai`).

Verify:

```bash
curl -sI https://viktora.ai | head -1                 # → HTTP/2 200
curl -s https://viktora.ai/api/waitlist/health        # → {"status":"ok"}
```

---

## 5. Post-deploy checks

```bash
# End-to-end signup (writes a real row — delete it after):
curl -s -X POST https://viktora.ai/api/waitlist \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://viktora.ai' \
  -d '{"name":"Deploy Test","email":"deploy-test@viktora.ai","role":"smoke test"}'
# → {"ok":true}

ssh deploy@<host> 'tail -1 /opt/threshold-site/data/waitlist.jsonl'
```

Signups accumulate in `/opt/threshold-site/data/waitlist.jsonl` (one JSON object
per line). Pull them with:

```bash
scp deploy@<host>:/opt/threshold-site/data/waitlist.jsonl ./waitlist.jsonl
```

---

## Operational notes

- **Rate limit**: 5 signups / minute / IP (in-memory token bucket). Behind
  nginx, the real client IP arrives via `X-Forwarded-For` (set above) — the
  service reads the first hop.
- **CORS**: the service only returns `Access-Control-Allow-Origin` for
  `https://viktora.ai` / `https://www.viktora.ai`. Override with
  `WAITLIST_ALLOW_ORIGINS` (comma list) if the hostname changes.
- **Degrade**: with JS off, the form is a plain `POST /api/waitlist` (the
  service parses urlencoded too). If the service is down, the page's mailto
  fallback (`beta@viktora.ai`) is always visible.
- **Restart**: `ssh deploy@<host> 'pm2 restart threshold-waitlist --update-env'`
  (re-source `.env` first if you changed `EMAIL_API_KEY`).
- **Where things live**:
  `/opt/threshold-site/public/`    → static site (nginx root)
  `/opt/threshold-site/waitlist-server.mjs` → pm2 service
  `/opt/threshold-site/data/waitlist.jsonl` → signup sink
  `/opt/threshold-site/.env`       → `EMAIL_API_KEY` (chmod 600)
