# Real-Time USB HID Race Timing System

An event-driven, micro-service architecture built with **Node.js**, **TypeScript**, **WebSockets**, and **Vue.js** that monitors low-level USB HID hardware (mice) to record high-precision race line crossings (start and finish lines) across multiple race lanes.

---

## 📌 Features

- **Dynamic Hardware Monitoring**: Automatically enumerates USB HID devices by `usagePage` and `usage` parameters with hot-plugging detection.
- **YAML Configuration & Hot-Reloading**: Real-time configuration parsing (`config.yaml`) and live file watching: timing lines whose start and finish are device buttons (bitmask rules on the HID reports).
- **Several Lines per Computer**: One computer times several lines at once (e.g. two lanes side by side, each with its operator), one participant at a time on each. The configuration page is organised around the lines: pick the device of the start and of the finish of each line, and press its button to detect it. The race page has a tab per line.
- **State-Aware Edge Detection**: Eliminates false positives when multiple buttons are pressed simultaneously or released in complex sequences.
- **High-Precision Timing with `Temporal`**: Uses the modern ECMAScript `Temporal` API (`Temporal.Now.instant()`) for timezone-agnostic timing records.
- **Events & Participants**: The home page lists the events of the working directory, each one folding out its disciplines: one click opens the race page on it, or the live page (small race / live toggle in the navigation bar, which also switches between these pages on the same discipline). Unless the administration is locked, it also creates new events and disciplines (_+ New event_, _+ New discipline_). The pages of a discipline have its name in their address: `/<event>/<discipline>/race`, `/<event>/<discipline>/live`, and `/<event>/<discipline>/config` for its settings (the gear beside the title of these pages, "CFM26 · 100m ▾", whose menu also changes the event and discipline). The settings page has the settings tabs, then a data tab: the participant files (download and replace them; a discipline without one gets its file there, saved as `<event>-<discipline>-competitors.csv`), the results files (download), and the backups (download). New participants reset the results, on every synced computer, after a backup of them, with their UDA export and the participant files they were timed for, in the discipline's `backup` folder; the results files are then removed, until the next run. The race page then finds a participant by partial bib or name (case and accents ignored), times their runs between the start and finish crossings, and keeps every result in the discipline's `<event>-<discipline>-results.csv`.
- **Distance Disciplines**: A discipline can measure a distance instead of a time (_Performance_ in its basic settings, `measure: distance` in its `config.yaml`). The operator types the distance in centimetres on the race page, on a manual line of the computer, which gets the participant ready, then validates it, or saves it as invalid or disqualified. A distance started must be validated before the participant changes distance (unless the advanced settings allow it, `allowDistanceChange`), and besides the total of attempts, the attempts at one distance can be limited (`attemptsPerDistance`): a participant who fails them all at a distance, since they last validated it, is eliminated. A minimum distance can be set (`minDistance`, in centimetres): no shorter distance can be tried, and the race page suggests it before the first run of the line. The race page suggests the distance of the last run of the line (5 cm more after a valid run of the same participant), or for a participant who validated a distance already, 5 cm more than their best. The longest valid distance is the best, and the UDA export holds it in centimetres (`bib,,345` for 3.45 m).
- **UDA Export**: Each write of the results also writes `<event>-<discipline>-uda-results.csv`, the best result of each participant. By default it is the import format of the UDA (`bib,,minutes,seconds,fraction`, or `bib,,centimetres` for a distance; `bib,DQ,0…` or `bib,DNF,0…`). The _UDA export_ tab of the settings (`udaHeader`, `udaColumns`, `udaSeparator`, `udaSort` in `config.yaml`) changes it, with a preview of the export of the moment: its columns, one by one (added, removed and moved, each with the template of its value and of its title), an optional header line of their titles, the separator of the columns and the order of the lines (e.g. `category, rank`; a `-` for descending). A template is text with `{expressions}`: variables (`{bib}`, `{name}`, `{firstName}`, `{lastName}`, `{category}`, `{status}` — OK, DQ, DNF or DNS —, `{rank}`, `{categoryRank}`, `{runs}`, `{okRuns}`, `{attempts}`, `{bestRun}`, `{bestAttempt}`, `{minutes}`, `{seconds}`, `{fraction}`, `{units}`, `{timeMs}`, `{distance}`, `{col("Country")}` for any column of the participant file…), formulas on whole numbers (`{minutes * 60 + seconds}`; `/` is the whole division, `%` its remainder), functions (`pad`, `upper`, `lower`, `left`, `right`, `min`, `max`…) and conditions (`{if status == "OK"}…{elif status == "DQ"}…{else}…{end}`); `{{` and `}}` write a brace. A value holding the separator is quoted, as in CSV. For example, a column `{if status == "OK"}{minutes * 60 + seconds}.{pad(fraction, 2)}{else}{status}{end}` gives `73.24` for 1:13.24. A new discipline gets the format of the last discipline saved that measures a time (any event), and a change of _Performance_ the format of the last one that measures the new one; the tab also copies the format of any other discipline.
- **Several Runs at Once on One Computer**: Each tab of the race page that times by hand or measures a distance takes its own manual line, `Manuel`, then `Manuel 2`… up to `Manuel 9`, kept on reload and freed when the tab closes, so several participants can run at once from one computer. The line is written in the line column of the results, and each tab lists the last runs of its own line.
- **Several Computers**: Instances on the same network with the same sync key in `config.yaml` find each other and keep their events, participants and results in sync (see `backend/README.md`).
- **Live Display**: The *Live* page shows the public what every synced computer is timing in a discipline (participant up next, running clocks, last times) and the ranking by best time.
- **Real-Time UI Synchronization**: Low-latency WebSocket event distribution to connected Vue.js clients.
- **English, French and German**: The interface language is chosen in the title menu and remembered by the browser (the browser's language the first time). See *Translations* below to add one.

---

## 📂 Repository Structure

```
.
├── backend/                  # Node.js + TypeScript backend (see backend/README.md)
│   ├── src/
│   │   ├── middlewares/      # Serves the built frontend
│   │   ├── routes/           # REST API endpoints (status, diagnostics, configuration)
│   │   ├── services/         # Hardware listener (hardware/: config, device matching, line gates) & race timing per line
│   │   ├── tools/            # diagnose CLI to find devices and button bytes
│   │   ├── types/            # WebSocket message types
│   │   ├── utils/            # Logger, working directory, browser opening
│   │   ├── websocket/        # Real-time WebSocket broadcasting server
│   │   └── server.ts         # Entry point
│   ├── test/                 # Unit and API tests (Vitest)
│   ├── openapi.yaml          # OpenAPI 3.1 reference of the REST API
│   └── package.json
├── frontend/                 # Vue + TypeScript frontend (Vite)
│   ├── src/
│   │   ├── components/       # Navigation menu & event switcher, device cards, race panels, line and device editors...
│   │   ├── composables/      # Hardware status polling, race WebSocket, dropdowns
│   │   ├── config/           # Configuration form state
│   │   ├── locales/          # Interface texts: en.ts (the reference), fr.ts and de.ts
│   │   ├── i18n.ts           # Languages, the language choice and its memory
│   │   ├── selection.ts      # Selected event & discipline, shared by the navigation bar and the race pages
│   │   ├── adminLock.ts      # Administration lock: hides the administration while the password is not typed
│   │   ├── pages/            # Race, live, diagnostics and configuration pages
│   │   └── main.ts           # Entry point
│   ├── scripts/
│   │   └── check-i18n.mjs    # Checks that the text keys used in the code exist (run by npm run build)
│   ├── test/                 # Unit and component tests (Vitest)
│   └── package.json
├── e2e/                      # End-to-end tests in a browser (Playwright), with simulated gates
├── sample-data/              # Example config.yaml and event, copied into the data folder of the release packages
├── scripts/
│   └── package.mjs           # Builds standalone release packages (npm run package)
├── workdir/                  # Working directory in dev mode, not in git: config.yaml and the events
│   ├── config.yaml
│   └── CFM26/                # One folder per event...
│       └── 100m/             # ...one subfolder per discipline...
│           ├── config.yaml   # ...optional settings (time or distance, attempts, period, best time, time precision)...
│           ├── competitors.csv # ...with participant CSV files (UDA competitors export, or bib;name)
│           ├── CFM26-100m-results.csv     # Timed runs, written by the app
│           └── CFM26-100m-uda-results.csv # Best result of each participant, to import into the UDA
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

`<version>` is the date-time in UTC of the commit it was built from and that commit, e.g. `timing-20261116-1432-2beba2a-win-x64.zip`, so each package tells from which code it was made and when that code was committed; building the same commit again gives the same version. `-dirty` is added (e.g. `20261116-1432-2beba2a-dirty`) when the working tree had uncommitted changes: commit before building a release. Without git, or outside a git clone, the version is the build date-time alone (e.g. `20261116-1432`).

Each package runs on a computer without Node.js or npm. It contains the built app, its production dependencies, the Node runtime (the same version as the one running the script, downloaded from nodejs.org and checked against the official checksums), a `data` folder, and a `README.txt` (English), `LISEZMOI.txt` (French) and `LIESMICH.txt` (German) that explain how to start the app and configure a device, with the Zadig procedure for mice on Windows. Their text is in `scripts/packageReadme.mjs`. Unpack it and run `timing.sh` / `timing.exe` (server) or `diagnose.sh` / `diagnose.cmd` (device diagnostics).

On Windows, the Node runtime is `timing.exe`, so the app starts from a file with its own icon (a `.cmd` file can only have the icon of all `.cmd` files). It is the Windows `node.exe` with the icon of the app (`frontend/public/favicon.svg`, turned into PNG images at each build with [resvg](https://github.com/thx/resvg-js)) and its name, changed with [resedit](https://github.com/jet2jet/resedit-js), and with `scripts/windowsLauncher.cjs` as its main script (a Node [single executable application](https://nodejs.org/api/single-executable-applications.html)): it starts the server, or the diagnostics with `diagnose` as its first argument (`diagnose.cmd`). Changing the file removes the Microsoft signature of `node.exe`: Windows SmartScreen may block the first start, which the README files explain.

The launchers use the `data` folder beside them as the working directory, whatever folder they are started from: `config.yaml` (devices) and the event folders go there, and the results files are written there. It starts with the content of `sample-data/`, so the app has something to show on its first start: an example `config.yaml` (no sync key, three lines: two sharing the buttons of a mouse on a Logitech receiver, and a disabled one with a wired mouse for each gate, told apart by their USB port) and an example event (`Exemple`: two disciplines with fictitious participants). Your own `workdir/` is never copied. `TIMING_WORK_DIR` or `--work-dir <dir>` still selects another folder.

The script runs on Linux and Windows, but build the Linux package on Linux: archives made on Windows lose the executable permissions. Building the Windows zip on Linux needs `zip`.

---

## 🧪 Tests

```bash
npm test            # Unit tests of the backend and the frontend, then a type check of the tests
npm run test:e2e    # Builds the app, then runs the end-to-end tests in Chrome
```

- **Backend** (`backend/test`, Vitest): CSV and participant files, discipline settings and periods, the run from ready to result, attempts, the results file and its merge between computers, the runs of several lines at once, HID gate edges, device matching, `config.yaml` (lines and devices), and the HTTP API. Each test file works in its own temporary working directory.
- **Frontend** (`frontend/test`, Vitest in a simulated browser): participant search, time formats, the configuration form, the texts of every language (same keys and placeholders, plurals, language choice), and the participant picker and run panel components.
- **End-to-end** (`e2e`, Playwright): the built app in a browser against a server with its own temporary working directory: timing a run, two lines at once, disqualify and invalid runs, attempts, locked disciplines, the live page and ranking, the configuration page, the language, and two computers syncing. There are no USB gates: the server is started with `TIMING_SIMULATE_GATES=1`, and the tests fire the start and finish crossings of the simulated lines over HTTP.

`npm run test:watch` in `backend` or `frontend` reruns the tests on each change. The end-to-end tests use the installed Google Chrome; with `E2E_CHANNEL=chromium` they use Playwright's Chromium instead (`npx playwright install chromium` once). On a failure, `npx playwright show-trace test-results/<test>/trace.zip` replays it step by step.

---

## 📄 License

MIT

---

## 🌐 Translations

The interface texts are in `frontend/src/locales`, with [vue-i18n](https://vue-i18n.intlify.dev/): `en.ts` is the reference, `fr.ts` the French translation and `de.ts` the German one. Components use `$t('race.participant')` in templates, `useI18n().t` in scripts, and `t` from `i18n.ts` in plain modules.

- **Change a text**: edit it in each language file. `{name}` is replaced by a value, `one | many` picks a form by count, and `{ } @ $ |` cannot be used as plain text.
- **Add a text**: add its key to `en.ts` and to every other language. `npm run build` fails when a key used in the code is missing from `en.ts` (`npm run check:i18n`), or when a language misses a key of `en.ts` (type check).
- **Add a language**: copy `en.ts` to `<code>.ts` (e.g. `es.ts`), translate it, then add it to `LOCALES` and `messages` in `frontend/src/i18n.ts` (and a plural rule if it differs from English), and its flag to `frontend/src/components/nav/LanguageFlag.vue`. It then appears in the title menu.

Texts sent by the backend (validation problems, device errors and hints) are not translated.

