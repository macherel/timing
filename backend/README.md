# Hardware & Timing Backend Service

The backend reads USB HID devices (e.g. buttons or timing gates seen by the computer as a mouse, gamepad or custom HID device) with `node-hid`, turns byte patterns in their reports into race crossings, and pushes them live to the frontend over WebSockets. It runs on Windows and Linux.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 26+ (ES Modules). The project's `.nvmrc` selects it with `nvm use`
- **Language**: TypeScript
- **USB HID Interface**: `node-hid` (devices are rescanned every second to detect plug/unplug)
- **Config & Hot-Reload**: `yaml`, `fs.watchFile`
- **Timestamps**: ECMAScript `Temporal` API (built into Node 26, nanosecond precision)
- **Real-Time Transport**: `ws` (WebSockets)

---

## 📁 Project Structure

```
src/
├── server.ts                    # Entry point: HTTP + WebSocket server, startup and shutdown
├── routes/api.ts                # REST endpoints
├── middlewares/frontend.ts      # Serves the built frontend in production
├── websocket/wsServer.ts        # WebSocket server and broadcast to the UI
├── types/messages.ts            # Messages sent to the frontend
├── utils/logger.ts              # Scoped console logger
├── utils/workDir.ts             # Working directory (--work-dir / TIMING_WORK_DIR) holding config.yaml
├── utils/openBrowser.ts         # Opens the default browser (--open)
├── tools/diagnose.ts            # `npm run diagnose`: find and test devices without the server
└── services/
    ├── raceService.ts           # Records crossings per lane and broadcasts them
    ├── eventService.ts          # Events, disciplines and participant CSV files of the working directory
    ├── runService.ts            # Timed run of one participant (ready → running → result in results.csv)
    ├── syncService.ts           # Finds the other instances on the network and syncs the event folders with them
    ├── hardwareService.ts       # Polls devices, opens them, routes reports to triggers, tracks status
    └── hardware/
        ├── deviceConfig.ts      # config.yaml types, loading, validation and watching
        ├── deviceMatching.ts    # Matches system HID interfaces to config rules, explains mismatches
        ├── triggers.ts          # Edge detection on HID report bytes
        └── hidDiagnostics.ts    # Human-readable usages, hex dumps, bit diffs, failure hints
```

**Flow:** every second (and on a `config.yaml` change) `hardwareService` syncs devices → each HID report goes through `triggers` → fired actions go to `raceService` → `wsServer` broadcasts a `RACE_UPDATE`, and `runService` times the run of the participant who is ready.

---

## 🔍 Setting Up a New Device

When you don't know yet how a device shows up, use the diagnose tool. It doesn't need the server running.

1. **List what the computer sees**

   ```bash
   npm run diagnose
   ```

   For each device: its VID/PID, every interface (path, HID usage, serial number, USB port), whether it can be opened (with the reason and a hint if not), and which `config.yaml` rule matches it.

2. **Find the button bits**

   ```bash
   npm run diagnose -- --listen 046d:c548          # every interface of a VID:PID
   npm run diagnose -- --listen <path>             # or one interface, path as shown by the list
   npm run diagnose -- --listen 046d:c548 --duration 30
   ```

   Keep the device still and press each button/gate 3 times, one at a time. Each changed report is printed with the bits that changed. On exit you get a summary that ignores movement bytes, and ready-to-paste `triggers` for `config.yaml`.

3. **Check it live in the server**: open the diagnostics page of the frontend (`/diagnostics`, on `http://localhost:5173` with `npm run dev`, or `http://localhost:3001` after a build). It shows each configured device's state, its triggers (pressed/idle), the last report bit by bit, the last 50 changed reports, the race events and every HID interface on the computer. Set `logReports: true` on a rule to also log every changed raw report in the backend console.

### Windows: mice and keyboards cannot be read

Windows opens mice and keyboards exclusively, so no application can read their reports. If the device shows up **only** as a mouse (usage `1/2`) or keyboard (`1/6`), the diagnose tool reports it as not readable on Windows. Options, in order of preference:

- the device often has **another interface** (vendor-defined usage page `65280`/`0xFF00` or higher) that carries the same data. Use it with `usagePage`/`usage` on the rule;
- switch the device to a **joystick/gamepad** or **raw HID** mode if it has one;
- otherwise, it needs a different input method (e.g. Windows Raw Input), which this backend does not implement.

On Linux, everything can be read once the udev permission is set (see below).

---

## 🔧 Configuration (`config.yaml`)

Hardware targets, bitmask rules, and trigger actions are declared in `config.yaml`, in the working directory. It can be edited in any text editor or with the form of the frontend's configuration page (`/config`), which checks it as you type and refuses to save an invalid config. Saving from the page rewrites the file in a standard layout, so comments are not kept. Changes made while the server is running are applied immediately. An invalid file is reported in the logs and ignored, and the current connections are kept.

### Working directory

The working directory is chosen in this order:

1. the `--work-dir <dir>` argument: `npm run dev -- --work-dir /srv/timing`, `node dist/server.js --work-dir /srv/timing`, `npm run diagnose -- --work-dir /srv/timing`;
2. the `TIMING_WORK_DIR` environment variable: `TIMING_WORK_DIR=/srv/timing npm run dev` (on Windows PowerShell: `$env:TIMING_WORK_DIR="C:\timing"; npm run dev`);
3. the directory the app is started from (`backend/` with `npm run dev`, run from the root or from `backend/`; the repository root with the root `npm start`).

A relative path is resolved against the directory the command is started from. The server logs the directory at startup, and the diagnostics page shows the config path. If the directory or `config.yaml` is missing, the server keeps running and picks up the file once it is created.

### Example `config.yaml`

```yaml
discoveryFilter:     # Optional default interface for all rules (1/2 = mouse)
  usagePage: 1
  usage: 2

devices:
  - name: "Lane 1"   # Device name: identifies it in race events, must be unique
    vendorId: 0x046d
    productId: 0xc548
    usbPort: "3-5"   # Optional: physical USB port (Linux), shown by npm run diagnose
    enabled: true
    triggers:
      - reportId: 2         # Only reports starting with this byte (when several collections share a path)
        byteIndex: 1        # Byte of the HID report to inspect
        mask: 0x01          # Bits of that byte to compare
        value: 0x01         # Fires when (byte & mask) === value
        action: "start_crossed"

      - reportId: 2
        byteIndex: 1
        mask: 0x02
        value: 0x02
        action: "finish_crossed"
```

**Device fields**

| Field                   | Required | Meaning                                                                                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                  | yes      | Device name, shown in race events. Must be unique.                                                                                               |
| `vendorId`, `productId` | yes      | USB IDs of the device.                                                                                                                           |
| `enabled`               | yes      | Whether to listen to the device.                                                                                                                 |
| `usagePage`, `usage`    | no       | Which HID interface of the device to use. Overrides `discoveryFilter` for this rule. Without both, the rule matches any interface of the device. |
| `serialNumber`          | no       | Binds the rule to one unit. Many devices report an empty serial number, so use `usbPort` for those.                                              |
| `usbPort`               | no       | Binds the rule to a physical USB port (Linux only). Needed when several identical devices are plugged in.                                        |
| `logReports`            | no       | `true` logs every changed raw report with the changed bits. For debugging only.                                                                  |

**Trigger fields**

| Field                        | Required       | Meaning                                                                                                                                                                                                                     |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reportId`                   | no             | Only check reports whose byte 0 has this value. Use it when several collections share one interface, otherwise reports of another collection can fire false presses/releases. The diagnose tool tells you when it's needed. |
| `byteIndex`, `mask`, `value` | yes            | The trigger matches when `(report[byteIndex] & mask) === value`.                                                                                                                                                            |
| `action`                     | one of the two | Fired when the pattern starts matching (press).                                                                                                                                                                             |
| `releaseAction`              | one of the two | Fired when the pattern stops matching (release).                                                                                                                                                                            |

Only actions containing `start`, `finish` or `click` are recorded as crossings.

### Linux permissions

The backend opens `/dev/hidrawN` directly. Give your user access with a udev rule, for example in `/etc/udev/rules.d/99-timing.rules` (the diagnose tool prints the exact line for a device it cannot open):

```
KERNEL=="hidraw*", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c548", MODE="0660", GROUP="plugdev"
```

Windows needs no permission setup for readable devices.

---

## 🏁 Events and Participants

The race page lists the events found in the working directory. Each event is a folder, each discipline a subfolder, and a discipline holds one or more participant CSV files (e.g. one per category), merged in the app:

```
<working directory>/
├── config.yaml
├── CFM26/
│   ├── 100m/
│   │   ├── config.yaml       # optional discipline settings
│   │   ├── femmes.csv
│   │   ├── hommes.csv
│   │   └── results.csv       # written by the app
│   └── Lenteur/
│       └── participants.csv
└── UNICON22/
    └── ...
```

A CSV file has the bib number in the first column and the name in the second; other columns are ignored:

```csv
bib;name
1;Zoé Nguyen
2;Hugo Guérin
```

- The separator is detected from the first line: semicolon (French Excel), comma or tab. Quoted cells (`"Dupont, Jean"`) are supported.
- The first line is skipped when its bib is not a number (header row).
- UTF-8 (with or without BOM) and Windows-1252 (Excel on Windows) are both read correctly.
- Rows with a bib that is not a number, without a name, or with a bib already used in the discipline are skipped and listed on the race page.
- Files are read on every request: click *Reload lists* on the race page after adding or editing them.

### Discipline settings (`config.yaml`)

A discipline folder can hold a `config.yaml` with its settings (not to be confused with the device `config.yaml` at the root of the working directory). Every setting is optional:

```yaml
# Runs allowed per participant. Remove for unlimited attempts.
attempts: 3

# Period when runs can be timed and results changed, from start (included) to end (excluded).
start: 2026-11-05T07:00Z
end: 2026-11-06T17:00Z

# When runs can be timed and results changed: auto (during the period), open (always) or locked (never)
access: auto
```

- `attempts`: how many runs each participant may do. `OK` and `DQ` runs use up an attempt; `INVALID` runs do not (the participant is not at fault, so they run again). Once all attempts are used, the participant cannot be made ready: the race page shows "All 3 attempt(s) used" and disables *Ready to start*. Setting a run back to `INVALID` frees an attempt.
- `start`, `end`: the period when the discipline is open, from `start` until `end` (excluded), as ISO 8601 date-times in UTC (`2026-11-05T07:00Z`), so they mean the same moment whatever the time zone of the server or the browser. Any offset is accepted (`2026-11-05T08:00+01:00`) and saved converted to UTC. Either can be left out. Seconds are ignored. A date-time without an offset (`2026-11-05T08:00` or `2026-11-05 08:00`) is read in the server's time zone; a date alone means the whole day (`start: 2026-11-05` opens at 00:00, `end: 2026-11-06` closes at the end of that day). The settings form and the messages show them in local time; the form saves them in UTC. Outside the period (with `access: auto`), getting a participant ready and changing a result's status are refused, so nothing is changed by accident; the race page says the discipline is closed and disables these actions. A run already in progress can still end. The settings themselves can always be edited, to correct the period. A `start` that is not before `end` is ignored.
- `access`: when runs can be timed and results changed, one of:
  - `auto` (default): during the `start` - `end` period;
  - `open`: always, ignoring the period, e.g. to correct a result after the event (the race page reminds that the discipline is forced open while the period would close it);
  - `locked`: never, the results are final (the race page says they are locked).

  It is the *Runs and result changes* choice in *⚙ Settings*. The older `locked: true` setting is read as `access: locked`.
- The file is read on every request. A wrong or unknown setting is ignored and listed on the race page.
- *⚙ Settings* next to the discipline on the race page edits these settings and saves the file (created if needed). Saving from the page rewrites the file in a standard layout: comments are not kept, other settings are. Every open page gets the new settings.

### Timed runs and `results.csv`

On the race page, select a participant and click *Ready to start*. The next crossing whose action contains `start` (from any device) starts the run, the next one containing `finish` ends it. The time is the difference between the two hardware timestamps. Then the participant can run again: every run is kept, and the page lists the participant's runs with the best one highlighted.

- One run at a time. The run is kept by the backend, so every open page shows it, and reloading the page does not lose it. It is lost if the server restarts before the finish.
- While a participant is ready or running, the event, discipline and participant cannot change. *Cancel* abandons the run without saving anything.
- While running, *Invalidate* or *Disqualify* ends the run at once (no need to wait for the finish) and saves it as `INVALID` or `DQ`, without finish or time. Such a run is listed but never counts as the best.
- A saved run has a status, changed from the participant's results on the race page: `OK` (counts), `INVALID` (does not count, without the participant being at fault, e.g. a timing problem) or `DQ` (disqualified). A run keeps its time whatever its status (shown struck through when it does not count). A run ended before the finish has no time, so it cannot be set back to `OK`.
- Each finished run is appended to `results.csv` in the discipline folder (this file is not read as a participant list):

  ```csv
  bib;name;start;finish;status;updated
  3;Nathan Henry;2026-11-05T20:30:34.108928955Z;2026-11-05T20:30:35.337341064Z;OK;2026-11-05T20:30:35.340Z
  4;Margaux Perrin;2026-11-05T20:49:57.848684082Z;;DQ;2026-11-05T20:50:02.511Z
  ```

  `start` and `finish` are UTC instants with nanoseconds, `status` is `OK`, `INVALID` or `DQ`, `updated` is when the line was last changed (used by the sync). The time is not stored: it is computed as `finish` − `start` (rounded to the millisecond), so editing a date by hand changes the time. A run is identified by `bib` and `start` together. Lines can be deleted by hand to remove a run. Columns are found by their header name: files with an older layout (a `time` column, no `status` column, read as `OK`, no `updated` column) are read too, and rewritten in this layout on their next write.

## 🔄 Syncing Several Computers

Instances of the app on the same local network (e.g. one computer at the start line, one at the finish) find each other and keep their event folders in sync. It is enabled by a `sync.yaml` in the working directory, next to the device `config.yaml`:

```yaml
# Only instances with the same key sync together
key: cfm26
# Optional: the name shown to the other computers (the computer name by default)
name: Finish line
```

- Without `sync.yaml`, or without a key, sync is off. The file is read again every few seconds, so sync can be turned on or off without restarting.
- **Discovery**: every instance announces itself every 3 s by UDP broadcast on port 41234 (its name, HTTP port and a hash of its key, never the key itself). The firewall must let UDP 41234 and the HTTP port (`PORT`, 3001 by default) through; Windows asks the first time.
- **What is synced**: everything in the event folders.
  - Participant CSV files and discipline `config.yaml`: the most recently modified copy wins, and keeps its modification time on the other computers.
  - `results.csv`: merged line by line. A run is identified by its bib and start; when a line was changed on both computers, the most recently changed (`updated` column) wins. The page of every computer updates live.
  - Not synced: the device `config.yaml` (devices differ per computer), `sync.yaml`, and the run in progress (each computer times its own runs).
- Changes are sent at once to the other computers, which also check every 3 s, so a computer that was off catches up when it comes back.
- The latest change wins, so the computers' clocks must roughly agree: the navigation bar warns when they differ by more than 2 s.
- A deleted file or result line comes back from a computer that still has it: delete it on every computer while they are not connected, or mark the run `INVALID` instead.
- The key prevents mixing with another timing app on the same network; it is not a protection against someone on the network who wants to change the results.

The navigation bar shows the sync state ("Synced with 1 computer"); its tooltip lists the computers found and any problem.

## 🩺 Troubleshooting in the Logs

- **Device list**: logged at startup and whenever a relevant device appears, disappears, or the config changes.
- **Rule matches no device**: the log explains why: the VID/PID is not plugged in, or the device is there but none of its interfaces fit the rule (the available interfaces are listed).
- **Open/read failure**: logged once with a hint (Windows mouse/keyboard, missing udev rule…). The device is retried every second and the error is repeated about once a minute. Recovery is logged.

---

## 🔌 API & WebSocket Documentation

HTTP and WebSocket share the same port: `PORT`, default `3001`.

### WebSocket Events

- **Endpoint**: `ws://localhost:3001`
- **Payload Structure** (see `src/types/messages.ts`):
  ```json
  {
    "type": "RACE_UPDATE",
    "deviceId": "Lane 1",
    "deviceName": "Lane 1",
    "action": "start_crossed",
    "timestamp": "2026-11-04T12:15:30.123456789Z",
    "allCrossings": [
      {
        "action": "start_crossed",
        "timestamp": "2026-11-04T12:15:30.123456789Z"
      }
    ]
  }
  ```

- `RUN_UPDATE` `{ run }`: the run changed. `run.status` is `idle`, `ready` (with `event`, `discipline`, `participant`) or `running` (also with `startedAt`).
- `RUN_RESULT` `{ event, discipline, result }`: a run finished or the participant was disqualified. `result` has `bib`, `name`, `start`, `finish`, `timeMs` and `status` (`ok`, `invalid` or `dq`) (`finish` and `timeMs` are `null` when the run was ended before the finish).
- `RESULT_UPDATE` `{ event, discipline, result }`: the status of a saved run changed.
- `SETTINGS_UPDATE` `{ event, discipline, settings }`: the settings of a discipline were saved from the race page.
- `SYNC_UPDATE` `{ event, discipline }`: files of a discipline were changed by the sync with another computer.

### REST Endpoints

- `GET /api/status`: Health check (status, uptime, server time).
- `GET /api/config`: `config.yaml` parsed as `config`, with its path and modification time. `config` is `null` when the file is missing, or invalid (then `problems` says why and `content` holds the text).
- `POST /api/config/validate` `{ config }`: the problems found in a config object, without saving it.
- `PUT /api/config` `{ config, modifiedAt }`: writes the config to `config.yaml`. `422` with the problems if it is invalid; `409` if the file changed since `modifiedAt` (the value returned by `GET`).
- `GET /api/events`: the working directory (`workDir`) and its `events`, each with its `disciplines`.
- `GET /api/events/:event/:discipline/participants`: the discipline's `participants` (`bib`, `name`, `file`: the CSV file name without extension), sorted by bib, its `settings` (`attempts`, `null` when unlimited) and the `problems` of ignored settings and skipped rows. `404` for an unknown event or discipline.
- `PUT /api/events/:event/:discipline/settings` `{ settings: { attempts, start, end, access } }`: saves the discipline's `config.yaml` (`attempts`: a whole number from 1, or `null` for unlimited; `start`, `end`: ISO 8601 date-times, saved in UTC, or `null`; `access`: `auto`, `open` or `locked`) and returns the `settings` read back with their `problems`. `422` for an invalid value.
- `GET /api/events/:event/:discipline/results`: every run of the discipline from `results.csv`, oldest first.
- `PATCH /api/events/:event/:discipline/results` `{ bib, start, status }`: sets the status (`ok`, `invalid` or `dq`) of the saved run of `bib` that started at `start` (bib and start together identify a run, as several participants can share a start). `404` when there is no such run, `409` to set `ok` on a run without a time, or when the discipline is closed (outside its period with `access: auto`, or `access: locked`).
- `GET /api/run`: the current run (see `RUN_UPDATE`).
- `POST /api/run/ready` `{ event, discipline, bib }`: the participant is ready, the next start crossing starts their run. `404` for an unknown participant, `409` while a run is in progress, when the participant has no attempt left, or when the discipline is closed.
- `POST /api/run/invalidate`, `POST /api/run/disqualify`: ends the running run now and saves it as `INVALID` or `DQ`. `409` when no run is in progress.
- `POST /api/run/cancel`: abandons the current run, nothing is saved.
- `GET /api/sync`: whether sync is on, this computer's `name`, and the `peers` found (name, address, port, last sync, error, clock offset).
- `GET /api/sync/manifest`, `GET /api/sync/file?path=`, `GET /api/sync/results?event=&discipline=`, `POST /api/sync/notify`: used between instances, only with the hash of the same key in the `x-timing-sync` header (`403` otherwise).
- `GET /api/hardware/status`: Device diagnostics, used by the frontend diagnostics page. Lists each configured device (`deviceName`) as `listening` (report count, last report, last 50 changed reports, trigger states) or `failing` (error, hint, attempts), every HID interface found by the last scan with the rule using it, and explanations for rules that match no device.

---

## 🚀 Running the Backend

```bash
# Use the Node version from .nvmrc
nvm use

# Install dependencies
npm install

# Start development mode with hot-reloading
npm run dev

# Open the app in the default browser once the server listens
npm run dev -- --open

# Find and test devices
npm run diagnose

# Type-check without building
npm run typecheck

# Build for production
npm run build
```
