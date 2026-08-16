# Web debugging scripts

These scripts exercise a running Angular development client with Puppeteer. Install the Web client
dependencies first, then start the required development services.

```bash
npm install --prefix web
npm run start --prefix web
```

Run scripts from the repository root. Set `CHROME_PATH` if Chrome or Chromium is not installed in a
standard Linux location. `SOMS_BASE` overrides the target URL.

```bash
node dev/web-debug/probe.mjs
node dev/web-debug/capture-flicker.mjs
SOMS_USER=user SOMS_PASS=password node dev/web-debug/verify-chat-slide.mjs
```

The chat-slide verifier requires the API, database, and at least one conversation for its account.
It writes screenshots to `SOMS_OUT_DIR` or `/tmp` by default.
