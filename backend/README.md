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
    ├── hardwareService.ts       # Polls devices, opens them, routes reports to triggers, tracks status
    └── hardware/
        ├── deviceConfig.ts      # config.yaml types, loading, validation and watching
        ├── deviceMatching.ts    # Matches system HID interfaces to config rules, explains mismatches
        ├── triggers.ts          # Edge detection on HID report bytes
        └── hidDiagnostics.ts    # Human-readable usages, hex dumps, bit diffs, failure hints
```

**Flow:** every second (and on a `config.yaml` change) `hardwareService` syncs devices → each HID report goes through `triggers` → fired actions go to `raceService` → `wsServer` broadcasts a `RACE_UPDATE`.

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

### REST Endpoints

- `GET /api/status`: Health check (status, uptime, server time).
- `GET /api/config`: `config.yaml` parsed as `config`, with its path and modification time. `config` is `null` when the file is missing, or invalid (then `problems` says why and `content` holds the text).
- `POST /api/config/validate` `{ config }`: the problems found in a config object, without saving it.
- `PUT /api/config` `{ config, modifiedAt }`: writes the config to `config.yaml`. `422` with the problems if it is invalid; `409` if the file changed since `modifiedAt` (the value returned by `GET`).
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
