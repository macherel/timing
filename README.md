# Real-Time USB HID Race Timing System

An event-driven, micro-service architecture built with **Node.js**, **TypeScript**, **WebSockets**, and **Vue.js** that monitors low-level USB HID hardware (mice) to record high-precision race line crossings (start and finish lines) across multiple race lanes.

---

## 📌 Features

- **Dynamic Hardware Monitoring**: Automatically enumerates USB HID devices by `usagePage` and `usage` parameters with hot-plugging detection.
- **YAML Configuration & Hot-Reloading**: Real-time configuration parsing (`config.yaml`) with bitmask trigger rules and live file watching.
- **State-Aware Edge Detection**: Eliminates false positives when multiple buttons are pressed simultaneously or released in complex sequences.
- **High-Precision Timing with `Temporal`**: Uses the modern ECMAScript `Temporal` API (`Temporal.Now.instant()`) for timezone-agnostic timing records.
- **Real-Time UI Synchronization**: Low-latency WebSocket event distribution to connected Vue.js clients.

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
│   └── package.json
├── frontend/                 # Vue + TypeScript frontend (Vite)
│   ├── src/
│   │   ├── components/       # Device cards, event log, config editor...
│   │   ├── composables/      # Hardware status polling & race WebSocket
│   │   ├── config/           # Configuration form state
│   │   ├── pages/            # Diagnostics and configuration pages
│   │   └── main.ts           # Entry point
│   └── package.json
├── scripts/
│   └── package.mjs           # Builds standalone release packages (npm run package)
├── workdir/                  # Working directory in dev mode, not in git: config.yaml lives here
├── release/                  # Release packages, not in git
├── package.json              # Root scripts: dev, build, start, package
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

Each package runs on a computer without Node.js or npm. It contains the built app, its production dependencies, the Node runtime (the same version as the one running the script, downloaded from nodejs.org and checked against the official checksums), `workdir/config.yaml` copied as `config.yaml` when it exists, and a `README.txt`. Unpack it and run `timing.sh` / `timing.cmd` (server) or `diagnose.sh` / `diagnose.cmd` (device diagnostics). `config.yaml` is read from the directory the app is started from. Without one, the app starts with no devices and the file is created from the configuration page.

The script runs on Linux and Windows, but build the Linux package on Linux: archives made on Windows lose the executable permissions. Building the Windows zip on Linux needs `zip`.

---

## 📄 License

MIT
