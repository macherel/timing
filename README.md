# Real-Time USB HID Race Timing System

An event-driven, micro-service architecture built with **Node.js**, **TypeScript**, **WebSockets**, and **Vue.js** that monitors low-level USB HID hardware (mice) to record high-precision race line crossings (start and finish lines) across multiple race lanes.

---

## 📌 Features

- **Dynamic Hardware Monitoring**: Automatically enumerates USB HID devices by `usagePage` and `usage` parameters with hot-plugging detection.
- **YAML Configuration & Hot-Reloading**: Real-time configuration parsing (`config.yaml`) with bitmask trigger rules and live file watching.
- **State-Aware Edge Detection**: Eliminates false positives when multiple buttons are pressed simultaneously or released in complex sequences.
- **High-Precision Timing with `Temporal`**: Uses the modern ECMAScript `Temporal` API (`Temporal.Now.instant()`) for timezone-agnostic timing records.
- **Events & Participants**: The race page picks an event and a discipline from the working directory, then finds a participant by partial bib or name (case and accents ignored), times their runs between the start and finish crossings, and keeps every result in the discipline's `results.csv`.
- **Several Computers**: Instances on the same network with the same sync key in `config.yaml` find each other and keep their events, participants and results in sync (see `backend/README.md`).
- **Live Display**: The *Live* page shows the public what every synced computer is timing in a discipline (participant up next, running clocks, last times) and the ranking by best time.
- **Real-Time UI Synchronization**: Low-latency WebSocket event distribution to connected Vue.js clients.
- **English and French**: The interface language is chosen in the title menu and remembered by the browser (the browser's language the first time). See *Translations* below to add one.

---

## 📂 Repository Structure

```
.
├── backend/                  # Node.js + TypeScript backend (see backend/README.md)
│   ├── src/
│   │   ├── middlewares/      # Serves the built frontend
│   │   ├── routes/           # REST API endpoints (status, diagnostics, configuration)
│   │   ├── services/         # Hardware listener (hardware/: config, device matching, triggers) & race timing
│   │   ├── tools/            # diagnose CLI to find devices and trigger bytes
│   │   ├── types/            # WebSocket message types
│   │   ├── utils/            # Logger, working directory, browser opening
│   │   ├── websocket/        # Real-time WebSocket broadcasting server
│   │   └── server.ts         # Entry point
│   ├── test/                 # Unit and API tests (Vitest)
│   ├── openapi.yaml          # OpenAPI 3.1 reference of the REST API
│   └── package.json
├── frontend/                 # Vue + TypeScript frontend (Vite)
│   ├── src/
│   │   ├── components/       # Navigation menu & event switcher, device cards, race panels, config editor...
│   │   ├── composables/      # Hardware status polling, race WebSocket, dropdowns
│   │   ├── config/           # Configuration form state
│   │   ├── locales/          # Interface texts: en.ts (the reference) and fr.ts
│   │   ├── i18n.ts           # Languages, the language choice and its memory
│   │   ├── selection.ts      # Selected event & discipline, shared by the navigation bar and the race pages
│   │   ├── pages/            # Race, live, diagnostics and configuration pages
│   │   └── main.ts           # Entry point
│   ├── scripts/
│   │   └── check-i18n.mjs    # Checks that the text keys used in the code exist (run by npm run build)
│   ├── test/                 # Unit and component tests (Vitest)
│   └── package.json
├── e2e/                      # End-to-end tests in a browser (Playwright), with simulated gates
├── scripts/
│   └── package.mjs           # Builds standalone release packages (npm run package)
├── workdir/                  # Working directory in dev mode, not in git: config.yaml and the events
│   ├── config.yaml
│   └── CFM26/                # One folder per event...
│       └── 100m/             # ...one subfolder per discipline...
│           ├── config.yaml   # ...optional settings (number of attempts)...
│           ├── femmes.csv    # ...with participant CSV files (bib;name)
│           └── results.csv   # Timed runs, written by the app
├── release/                  # Release packages, not in git
├── playwright.config.ts      # End-to-end test settings: server, browser
├── redocly.yaml              # Linter settings for backend/openapi.yaml (npx @redocly/cli lint)
├── package.json              # Root scripts: dev, build, start, package, test, test:e2e
└── README.md                 # Root documentation
```

---

## ⚙️ Quick Start

### Prerequisites

- **Node.js**: v26 or higher (`nvm use` reads `.nvmrc`)
- **Linux Users**: USB HID access permissions (`udev` rules for non-root `/dev/hidraw*` access).

### Installation & Startup

1. **Configure Hardware Targets**:
   No configuration file is needed to start. Open the configuration page (`/config`) and add your devices (Vendor ID and Product ID): saving creates `config.yaml`, and its directory if needed.
   The file is kept in the directory the app runs from (`workdir/` with `npm run dev` from the root). To keep it elsewhere, set `TIMING_WORK_DIR=<dir>` or pass `--work-dir <dir>` (see `backend/README.md`).

2. **Run the Backend**:
   ```bash
   cd backend
   npm install
   npm run dev
   ```

---

## 📦 Packaging for Linux and Windows

```bash
nvm use
npm run package                      # both platforms
npm run package -- --platform win    # or only one: linux, win
```

This builds the app and creates, in `release/`:

- `timing-<version>-linux-x64.tar.gz`
- `timing-<version>-win-x64.zip`

Each package runs on a computer without Node.js or npm. It contains the built app, its production dependencies, the Node runtime (the same version as the one running the script, downloaded from nodejs.org and checked against the official checksums), a `data` folder, and a `README.txt`. Unpack it and run `timing.sh` / `timing.cmd` (server) or `diagnose.sh` / `diagnose.cmd` (device diagnostics).

The launchers use the `data` folder beside them as the working directory, whatever folder they are started from: `config.yaml` (devices) and the event folders go there, and `results.csv` files are written there. `workdir/config.yaml` is copied into it when it exists; without it, the app starts with no devices and the file is created from the configuration page. `TIMING_WORK_DIR` or `--work-dir <dir>` still selects another folder.

The script runs on Linux and Windows, but build the Linux package on Linux: archives made on Windows lose the executable permissions. Building the Windows zip on Linux needs `zip`.

---

## 🧪 Tests

```bash
npm test            # Unit tests of the backend and the frontend, then a type check of the tests
npm run test:e2e    # Builds the app, then runs the end-to-end tests in Chrome
```

- **Backend** (`backend/test`, Vitest): CSV and participant files, discipline settings and periods, the run from ready to result, attempts, `results.csv` and its merge between computers, HID trigger edges, device matching, `config.yaml`, and the HTTP API. Each test file works in its own temporary working directory.
- **Frontend** (`frontend/test`, Vitest in a simulated browser): participant search, time formats, the configuration form, the texts of every language (same keys and placeholders, plurals, language choice), and the participant picker and run panel components.
- **End-to-end** (`e2e`, Playwright): the built app in a browser against a server with its own temporary working directory: timing a run, cancel, disqualify and invalid runs, attempts, locked disciplines, the live page and ranking, the configuration page, the language, and two computers syncing. There are no USB gates: the server is started with `TIMING_SIMULATE_GATES=1`, and the tests fire the start and finish crossings over HTTP.

`npm run test:watch` in `backend` or `frontend` reruns the tests on each change. The end-to-end tests use the installed Google Chrome; with `E2E_CHANNEL=chromium` they use Playwright's Chromium instead (`npx playwright install chromium` once). On a failure, `npx playwright show-trace test-results/<test>/trace.zip` replays it step by step.

---

## 📄 License

MIT

---

## 🌐 Translations

The interface texts are in `frontend/src/locales`, with [vue-i18n](https://vue-i18n.intlify.dev/): `en.ts` is the reference and `fr.ts` the French translation. Components use `$t('race.participant')` in templates, `useI18n().t` in scripts, and `t` from `i18n.ts` in plain modules.

- **Change a text**: edit it in each language file. `{name}` is replaced by a value, `one | many` picks a form by count, and `{ } @ $ |` cannot be used as plain text.
- **Add a text**: add its key to `en.ts` and to every other language. `npm run build` fails when a key used in the code is missing from `en.ts` (`npm run check:i18n`), or when a language misses a key of `en.ts` (type check).
- **Add a language**: copy `en.ts` to `<code>.ts` (e.g. `de.ts`), translate it, then add it to `LOCALES` and `messages` in `frontend/src/i18n.ts` (and a plural rule if it differs from English), and its flag to `frontend/src/components/nav/LanguageFlag.vue`. It then appears in the title menu.

Texts sent by the backend (validation problems, device errors and hints) are not translated.

