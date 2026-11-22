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
test/                            # Vitest tests (`npm test`), each file with its own temporary working directory
openapi.yaml                     # OpenAPI 3.1 reference of the REST API
└── services/
    ├── lines.ts                 # The timing lines of this computer (enabled lines of config.yaml, or simulated ones)
    ├── raceService.ts           # Routes the crossings of a line's gates to its run and broadcasts them
    ├── eventService.ts          # Events, disciplines and participant CSV files of the working directory
    ├── runService.ts            # Timed run of each line (ready → running → result in <event>-<discipline>-results.csv)
    ├── syncService.ts           # Finds the other instances on the network and syncs the event folders with them
    ├── hardwareService.ts       # Polls devices, opens those the lines use, routes reports to the line gates, tracks status
    └── hardware/
        ├── deviceConfig.ts      # config.yaml types, loading, validation and watching
        ├── deviceMatching.ts    # Matches system HID interfaces to config rules, explains mismatches
        ├── triggers.ts          # The gates of the lines on a device, edge detection on HID report bytes
        └── hidDiagnostics.ts    # Human-readable usages, hex dumps, bit diffs, failure hints
```

**Flow:** every second (and on a `config.yaml` change) `hardwareService` syncs devices → each HID report goes through the `triggers` of the device (the start and finish gates of the lines that use it) → a fired gate goes to `raceService` → `runService` times the run of the participant who is ready on that line, and `wsServer` broadcasts a `RACE_UPDATE`.

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

   Keep the device still and press each button/gate 3 times, one at a time. Each changed report is printed with the bits that changed. On exit you get a summary that ignores movement bytes, with the `reportId`, `byteIndex`, `mask` and `value` of each button, to use as the `start` or `finish` of a line in `config.yaml`. The configuration page can also find them: _Detect the button_ on the start or finish of a line waits for a press on its device and fills them in.

3. **Check it live in the server**: open the diagnostics page of the frontend (`/diagnostics`, on `http://localhost:5173` with `npm run dev`, or `http://localhost:3001` after a build). It lists every HID interface on the computer, then has one tab per device, configured or not, with its interfaces grouped by USB interface number. Unfold an interface to see its state, the gates of the lines on it (pressed/idle) when a line uses it, the last report bit by bit and the last 50 changed reports. The interfaces that no line uses are opened only while their tab is shown (or while the configuration page detects a button on them), and never fire race events. Set `logReports: true` on a rule to also log every changed raw report in the backend console.

### Windows: mice and keyboards cannot be read

Windows opens mice and keyboards exclusively, so no application can read their reports. If the device shows up **only** as a mouse (usage `1/2`) or keyboard (`1/6`), the diagnose tool reports it as not readable on Windows. Options, in order of preference:

- the device often has **another interface** (vendor-defined usage page `65280`/`0xFF00` or higher) that carries the same data. Use it with `usagePage`/`usage` on the rule;
- switch the device to a **joystick/gamepad** or **raw HID** mode if it has one;
- otherwise, give its USB interface the **WinUSB** driver with Zadig, see below.

On Linux, everything can be read once the udev permission is set (see below).

### Windows: reading a mouse with WinUSB (Zadig)

Replacing the Windows driver of the mouse's USB interface with WinUSB hands it over to the app, which then reads it over USB (libusb) instead of HID. Windows no longer uses it as a mouse: it stops moving the pointer and clicking on screen, which is what you want for a mouse wired to a gate.

**Before you start**

- Use a mouse dedicated to timing, never the one you point with.
- Don't do it on a wireless receiver (Logitech Unifying or Bolt, etc.) that also serves your keyboard or your own mouse: they would stop working.
- You need administrator rights.
- The driver is installed for the model (VID:PID and interface), so every unit of this model plugged into this computer, on any USB port, gets WinUSB too.

**1. Find the USB interface of the mouse**

1. Plug in the mouse, start the app and open the diagnostics page (`/diagnostics`).
2. Open the tab of the mouse. Its interfaces table is grouped by **USB interface**: on Windows, each HID collection has its own row, so one USB interface can show several rows (mouse, media keys, vendor-defined…).
3. Note the number of the **USB interface** that holds the row with usage `1/2 (Mouse)`, and the **VID:PID** of the device. In the path, `MI_00` means interface 0, `MI_01` interface 1, and so on. A path without `MI_` means the device has a single interface (0).

**2. Install WinUSB with Zadig**

1. Download Zadig from <https://zadig.akeo.ie> and run it (accept the administrator prompt).
2. Menu **Options > List All Devices**.
3. In the list, pick the mouse. For a device with several interfaces, pick the entry ending with **(Interface N)**, N being the number noted above.
4. Check that **USB ID** shows the VID and PID of the device (and the interface number as third field for a device with several interfaces).
5. Choose **WinUSB** as the target driver (arrows on the right of the driver box), then click **Replace Driver** (or **Install Driver**). It takes a minute.

The other collections of the same USB interface (e.g. media keys) go with it. The other USB interfaces of the device keep their driver.

**3. Check it in the app**

1. Back on the diagnostics page, within about 3 seconds the interface shows up again under its USB interface, with a path like `usb:1-4:0` (bus-ports:interface) and the badge **read over USB (WinUSB)**. The app restarts nothing: it finds the interface while the page is open.
2. Unfold it and press the buttons: the reports and the changed bits are shown as on Linux. When the interface declares report IDs (or holds several collections), byte 0 of every report is the report ID: use `reportId` in the gates of the lines.
3. Click **+ Add to configuration** and use the device in the start or finish of a line as usual. Rules work the same as with HID: `usagePage`/`usage` (read from the HID report descriptor), `serialNumber`, and `usbPort`, which also works on Windows for these interfaces.

`npm run diagnose` does not list these interfaces yet: use the diagnostics page.

**If it doesn't work**

| Shown on the diagnostics page                 | Meaning                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The mouse still shows as usage `1/2` (HID)    | WinUSB went on another interface: check the interface number, or the device in Zadig.                            |
| `LIBUSB_ERROR_NOT_SUPPORTED` or `…_NOT_FOUND` | This interface has no WinUSB driver: install it on this interface (the hint gives the number).                   |
| `LIBUSB_ERROR_BUSY` or `…_ACCESS`             | Another program uses the interface (e.g. another copy of the app, or a virtual machine it is passed through to). |
| Name or usage unknown                         | The app could not read the device descriptors. It retries every few seconds. Replug the device if it lasts.      |

**Undo**

Give the interface its original driver back:

1. Open the **Device Manager** (right-click the Start button, or `devmgmt.msc`): the mouse is under **Universal Serial Bus devices**. If it is not there, plug it in, or tick **View > Show hidden devices**.
2. Right-click it > **Update driver** > **Browse my computer for drivers** > **Let me pick from a list of available drivers on my computer**.
3. Pick **USB Input Device**, then **Next**. Windows uses the interface as a mouse again (unplug and replug it if the pointer does not move yet).

If Windows puts WinUSB back when the mouse is replugged, remove the driver instead:

1. In the Device Manager, right-click the mouse > **Uninstall device**, tick **Attempt to remove the driver for this device**, confirm, then unplug and replug the mouse.
2. If WinUSB still comes back, the driver package made by Zadig is still installed. In an administrator command prompt, `pnputil /enum-drivers` lists it with provider **libwdi**: note its published name (`oemNN.inf`), run `pnputil /delete-driver oemNN.inf /uninstall /force`, then replug the mouse.

Do it for every USB interface you gave to WinUSB. The interface then shows up again as HID on the diagnostics page, and the app can no longer read it.

**Timing**

Listing USB devices blocks the app for a moment on Windows. So the app only looks for these interfaces every 3 seconds, only while a device used by a line is missing, while one of them fails, or while the diagnostics page is open, and never while a participant is ready or running: nothing then delays the timestamps of the crossings. Marking a participant ready waits for the end of a search already running (usually a fraction of a second). The interfaces already found keep working during a run, but a WinUSB device plugged in (or replugged) during a run is only found once the run ends.

---

## 🔧 Configuration (`config.yaml`)

The timing lines and the devices they use are declared in `config.yaml`, in the working directory. It can be edited in any text editor or with the form of the frontend's configuration page (`/config`), which checks it as you type and refuses to save an invalid config. Saving from the page rewrites the file in a standard layout, so comments are not kept. Changes made while the server is running are applied immediately. An invalid file is reported in the logs and ignored, and the current connections are kept.

A **line** is a track where one participant at a time is timed, from a crossing of its start gate to a crossing of its finish gate. A computer can time several lines at once (e.g. two lanes side by side, each with its operator). Each gate is a button of a **device** (a pattern of bits in its HID reports). Several lines can share a device, one button each, and one button can be the gate of several lines (e.g. one start for two lanes).

### Working directory

The working directory is chosen in this order:

1. the `--work-dir <dir>` argument: `npm run dev -- --work-dir /srv/timing`, `node dist/server.js --work-dir /srv/timing`, `npm run diagnose -- --work-dir /srv/timing`;
2. the `TIMING_WORK_DIR` environment variable: `TIMING_WORK_DIR=/srv/timing npm run dev` (on Windows PowerShell: `$env:TIMING_WORK_DIR="C:\timing"; npm run dev`);
3. the directory the app is started from (`backend/` with `npm run dev`, run from the root or from `backend/`; the repository root with the root `npm start`).

A relative path is resolved against the directory the command is started from. The server logs the directory at startup, and the diagnostics page shows the config path. If the directory or `config.yaml` is missing, the server keeps running and picks up the file once it is created.

### Example `config.yaml`

```yaml
port: 3001           # Optional port of the app, read at startup (default 3001)
sync:                # Optional: sync with other computers, see "Syncing Several Computers"
  key: amber-otter-glide
discoveryFilter:     # Optional default interface for all devices (1/2 = mouse)
  usagePage: 1
  usage: 2

lines:
  - name: "Line 1"          # Shown on the race and live pages, must be unique
    enabled: true
    start:
      device: "Receiver"    # Name of a device below
      reportId: 2           # Only reports starting with this byte (when several collections share a path)
      byteIndex: 1          # Byte of the HID report to inspect
      mask: 0x01            # Bits of that byte to compare
      value: 0x01           # Pressed while (byte & mask) === value
    finish:
      device: "Receiver"
      reportId: 2
      byteIndex: 1
      mask: 0x02
      value: 0x02

  - name: "Line 2"
    enabled: true
    start:
      device: "Receiver"
      reportId: 2
      byteIndex: 1
      mask: 0x04
      value: 0x04
    finish:
      device: "Finish gate 2"
      byteIndex: 0
      mask: 0x01
      value: 0x01
      edge: release         # Optional: record the crossing when the button is released

devices:
  - name: "Receiver"        # Device name: the lines refer to it, must be unique
    vendorId: 0x046d
    productId: 0xc548
    usbPort: "3-5"          # Optional: physical USB port (Linux, or Windows over WinUSB), shown on the diagnostics page

  - name: "Finish gate 2"
    vendorId: 0x1234
    productId: 0x0001
```

**Line fields**

| Field              | Required | Meaning                                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `name`             | yes      | Line name, shown on the race and live pages. Must be unique.                                  |
| `enabled`          | yes      | Whether the line is used. A disabled line is kept in the file but not shown or timed.         |
| `start`, `finish`  | yes      | The gate that starts the run, and the one that ends it (see _Gate fields_).                    |

**Gate fields** (`start` and `finish` of a line)

| Field                        | Required | Meaning                                                                                                                                                                                                                     |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`                     | yes      | Name of a device of `devices`.                                                                                                                                                                                              |
| `reportId`                   | no       | Only check reports whose byte 0 has this value. Use it when several collections share one interface, otherwise reports of another collection can fire false presses/releases. The diagnose tool tells you when it's needed. |
| `byteIndex`, `mask`, `value` | yes      | The button is pressed while `(report[byteIndex] & mask) === value`.                                                                                                                                                         |
| `edge`                       | no       | `press` (default): the crossing is recorded when the button gets pressed; `release`: when it gets released.                                                                                                               |

**Device fields**

| Field                   | Required | Meaning                                                                                                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | yes      | Device name, used by the gates of the lines. Must be unique.                                                                                         |
| `vendorId`, `productId` | yes      | USB IDs of the device.                                                                                                                               |
| `usagePage`, `usage`    | no       | Which HID interface of the device to use. Overrides `discoveryFilter` for this rule. Without both, the rule matches any interface of the device.     |
| `serialNumber`          | no       | Binds the rule to one unit. Many devices report an empty serial number, so use `usbPort` for those.                                                  |
| `usbPort`               | no       | Binds the rule to a physical USB port (Linux, and Windows for the interfaces given to WinUSB). Needed when several identical devices are plugged in. |
| `logReports`            | no       | `true` logs every changed raw report with the changed bits. For debugging only.                                                                      |

Only the devices used by an enabled line are opened. A file without `lines` is valid but times nothing. Files of earlier versions (devices with `enabled` and `triggers`, no `lines`) still load, their devices included, but their triggers are ignored: add the lines on the configuration page.

### Linux permissions

The backend opens `/dev/hidrawN` directly. Give your user access with a udev rule, for example in `/etc/udev/rules.d/99-timing.rules` (the diagnose tool prints the exact line for a device it cannot open):

```
KERNEL=="hidraw*", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c548", MODE="0660", GROUP="plugdev"
```

Windows needs no permission setup for readable devices. For a mouse or keyboard, see [Windows: reading a mouse with WinUSB (Zadig)](#windows-reading-a-mouse-with-winusb-zadig).

### Linux: keeping a mouse from clicking on screen

On Linux, the kernel sends the reports of a mouse both to `/dev/hidrawN`, which the app reads, and to the desktop, which moves the pointer and clicks with them. A press on a gate then also clicks wherever the pointer is. To stop that, tell libinput (used by Wayland and by X11 by default) to ignore the mouse with another udev rule, for example in the same file:

```
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{id/vendor}=="046d", ATTRS{id/product}=="4055", ENV{LIBINPUT_IGNORE_DEVICE}="1"
```

Then run `sudo udevadm control --reload && sudo udevadm trigger` and replug the device (or log in again). The app keeps reading it through hidraw.

- `id/vendor` and `id/product` are those of the input device: `cat /proc/bus/input/devices` lists the input devices, each with its IDs (`I:` line, `Vendor=` and `Product=`), its name (`N:`) and its `eventN` (`H:`).
- A wireless mouse behind a Logitech Unifying receiver has its own product ID (e.g. `Logitech Wireless Device PID:4055`): the rule then only affects that mouse. Other receivers (e.g. Logitech Bolt) give the mouse the product ID of the receiver: the rule then affects every mouse paired to it.
- To check: `udevadm info /dev/input/eventN | grep LIBINPUT` shows `LIBINPUT_IGNORE_DEVICE=1`.
- To undo: remove the line, reload the rules and replug the device.
- Use a mouse dedicated to timing, never the one you point with.

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
│   │   ├── CFM26-100m-results.csv      # written by the app
│   │   └── CFM26-100m-uda-results.csv  # written by the app, for the UDA
│   └── Lenteur/
│       └── participants.csv
└── UNICON22/
    └── ...
```

A CSV file has a header row naming its columns, as the competitors export of the UDA (Unicycling Data Application):

```csv
ID,LastName,FirstName,Country,Gender,Age Group
1,Vasseur,Ninon,France,Female,Junior F
2,Guérin,Hugo,France,Male,Sénior M
```

- Columns are found by their name, ignoring case, accents, spaces, `-` and `_`: the bib is `ID`, `bib`, `dossard`, `number` or `numéro`; the name is `FirstName` (`prénom`) and `LastName` (`surname`), shown as "Ninon Vasseur" with the first letter of each word in uppercase and the others in lowercase (`VASSEUR` → `Vasseur`, `jean-luc` → `Jean-Luc`), or a single `name` (`nom`, `full name`) column; the category is `Age Group`, `category` or `catégorie`. Other columns are ignored.
- The category is shown next to the name on the race and live pages. Without a category column, or when the cell is empty, it is the file name without extension (e.g. `femmes`).
- Without a header row naming a bib and a name, the bib is in the first column and the name in the second:

  ```csv
  bib;name
  1;Ninon Vasseur
  2;Hugo Guérin
  ```

- The separator is detected from the first line: semicolon (French Excel), comma or tab. Quoted cells (`"Dupont, Jean"`) are supported.
- The first line is skipped when its bib is not a number (header row).
- `<event>-<discipline>-results.csv` and `<event>-<discipline>-uda-results.csv` are not participant lists, nor is any file in the UDA results format (`bib,status,minutes,seconds,hundredths` lines, see below), whatever its name.
- UTF-8 (with or without BOM) and Windows-1252 (Excel on Windows) are both read correctly.
- Rows with a bib that is not a number, without a name, or with a bib already used in the discipline are skipped and listed on the race page.
- Files are read on every request: click _↻ Reload lists_ in the event menu of the title ("CFM26 · 100m ▾") after adding or editing them.

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

# Which time is the best: shortest (a race) or longest (a slow race)
best: shortest

# Unit of the times: second, tenth, hundredth or thousandth
precision: hundredth
# How a time is brought to that unit: truncate, nearest or up
rounding: up
```

- `attempts`: how many runs each participant may do. `OK` and `DQ` runs use up an attempt; `INVALID` runs do not (the participant is not at fault, so they run again). Once all attempts are used, the participant cannot be made ready: the race page shows "All 3 attempt(s) used" and disables _Ready to start_. Setting a run back to `INVALID` frees an attempt.
- `start`, `end`: the period when the discipline is open, from `start` until `end` (excluded), as ISO 8601 date-times in UTC (`2026-11-05T07:00Z`), so they mean the same moment whatever the time zone of the server or the browser. Any offset is accepted (`2026-11-05T08:00+01:00`) and saved converted to UTC. Either can be left out. Seconds are ignored. A date-time without an offset (`2026-11-05T08:00` or `2026-11-05 08:00`) is read in the server's time zone; a date alone means the whole day (`start: 2026-11-05` opens at 00:00, `end: 2026-11-06` closes at the end of that day). The settings form and the messages show them in local time; the form saves them in UTC. Outside the period (with `access: auto`), getting a participant ready and changing a result's status are refused, so nothing is changed by accident; the race page says the discipline is closed and disables these actions. A run already in progress can still end. The settings themselves can always be edited, to correct the period. A `start` that is not before `end` is ignored.
- `access`: when runs can be timed and results changed, one of:
  - `auto` (default): during the `start` - `end` period;
  - `open`: always, ignoring the period, e.g. to correct a result after the event (the race page reminds that the discipline is forced open while the period would close it);
  - `locked`: never, the results are final (the race page says they are locked).

  It is the _Runs and result changes_ choice in _⚙ Discipline settings_. The older `locked: true` setting is read as `access: locked`.

- `best`: which time is a participant's best result, and ranks first: `shortest` (default, a race) or `longest` (a slow race, where the slowest participant wins). It decides the run highlighted as best on the race page, the ranking of the live page and the time written to `<event>-<discipline>-uda-results.csv`, which is rewritten when the setting changes. It is the _Best time_ choice in _⚙ Discipline settings_.
- `precision`, `rounding`: the unit of the times (`second`, `tenth`, `hundredth` or `thousandth`, default `hundredth`) and how the measured time is brought to it: `truncate` (the digits beyond are dropped), `nearest` (a half goes up) or `up` (any fraction counts as a whole unit, the default). In hundredths, 12.3401 s gives 12.34 truncated or to the nearest, and 12.35 up. The rounding is done on the exact time between the two hardware timestamps (to the nanosecond). This time is the one shown on the race and live pages, compared to find the best run and the ranking (two times equal at this precision are tied), and written to `<event>-<discipline>-uda-results.csv`. `<event>-<discipline>-results.csv` keeps the exact start and finish, so a change applies to the runs already timed too, and `<event>-<discipline>-uda-results.csv` is rewritten. They are the _Time precision_ and _Rounding_ choices in _⚙ Discipline settings_.

- The file is read on every request. A wrong or unknown setting is ignored and listed on the race page.
- _⚙ Discipline settings_, in the event menu of the title on the race pages ("CFM26 · 100m ▾"), edits these settings and saves the file (created if needed). Saving from the page rewrites the file in a standard layout: comments are not kept, other settings are. Every open page gets the new settings.

### Timed runs and `<event>-<discipline>-results.csv`

On the race page, choose the line (one tab per line when the computer has several; each browser remembers its own), select a participant and click _Ready to start_. The next crossing of the line's start gate starts the run, the next crossing of its finish gate ends it. The time is the difference between the two hardware timestamps. Then the participant can run again: every run is kept, and the page lists the participant's runs with the best one highlighted.

- A line is _ready_ when it is enabled and the app listens to the devices of its start and finish. The race page first asks which line to time on. Every line can be chosen, to see and change its results, but a run can only start on a ready line: a line that is not ready or is disabled has a red dot, and _Ready to start_ is disabled on it. Each browser remembers its line; when the line is removed from `config.yaml`, the page goes back to the choice of a line. `POST /api/lines/:line/ready` refuses a line that is not ready. The configuration page shows the state of each line.
- One run at a time on each line; the lines are independent, and can time different disciplines. A participant cannot be ready or running on two lines at once. The runs are kept by the backend, so every open page shows them, and reloading the page does not lose them. They are lost if the server restarts before the finish, and the run of a line removed from `config.yaml` is dropped.
- While a participant is ready or running on the line, the event, discipline and participant cannot change on the page (another line can be chosen). _Cancel_ abandons the run without saving anything.
- While running, _Invalidate_ or _Disqualify_ ends the run at once (no need to wait for the finish) and saves it as `INVALID` or `DQ`, without finish or time. Such a run is listed but never counts as the best.
- A saved run has a status, changed from the participant's results on the race page: `OK` (counts), `INVALID` (does not count, without the participant being at fault, e.g. a timing problem) or `DQ` (disqualified). A run keeps its time whatever its status (shown struck through when it does not count). A run ended before the finish has no time, so it cannot be set back to `OK`.
- Each finished run is appended to `<event>-<discipline>-results.csv` in the discipline folder, e.g. `CFM26/100m/CFM26-100m-results.csv` (this file is not read as a participant list):

  ```csv
  bib;name;start;finish;status;updated
  3;Gaspard Lacombe;2026-11-05T20:30:34.108928955Z;2026-11-05T20:30:35.337341064Z;OK;2026-11-05T20:30:35.340Z
  4;Margaux Perrin;2026-11-05T20:49:57.848684082Z;;DQ;2026-11-05T20:50:02.511Z
  ```

  `start` and `finish` are UTC instants with nanoseconds, `status` is `OK`, `INVALID` or `DQ`, `updated` is when the line was last changed (used by the sync). The time is not stored: it is computed as `finish` − `start` (rounded to the millisecond), so editing a date by hand changes the time. A run is identified by `bib` and `start` together. Lines can be deleted by hand to remove a run. Columns are found by their header name: files with an older layout (a `time` column, no `status` column, read as `OK`, no `updated` column) are read too, and rewritten in this layout on their next write.
- A `results.csv` written by an earlier version is renamed to `<event>-<discipline>-results.csv` the first time the discipline is used (unless that file exists already), and its `uda-results.csv` is removed: it is written again with the next results.
- Each write of `<event>-<discipline>-results.csv` also rewrites `<event>-<discipline>-uda-results.csv` beside it: the results in the import format of the UDA, to upload them there. One line per participant, sorted by bib, no header, comma separated:

  ```csv
  7,,0,29,92
  23,DQ,0,0,0
  40,DNF,0,0,0
  98,,1,13,23
  ```

  The columns are the bib, the status (empty, `DQ` or `DNF`), then minutes, seconds and hundredths. Every participant of the discipline is listed (and any other bib with runs). Each participant's best `OK` run is written (the shortest, or the longest with `best: longest`; `98,,1,13,23` is 1:13.23), the time measured with the `precision` and `rounding` of the discipline (the UDA has no thousandths: with `precision: thousandth`, the exact time is brought to the hundredth with the same rounding). Without an `OK` run, the participant is `DQ` when they have a `DQ` run, else `DNF` (only `INVALID` runs, or none), with a zero time. The file is not synced: each computer writes it from its own merged `<event>-<discipline>-results.csv`.


## 🔄 Syncing Several Computers

Instances of the app on the same local network (e.g. one computer at the start line, one at the finish) find each other and keep their event folders in sync. It is enabled by the `sync` section of the device `config.yaml`, also editable on the configuration page:

```yaml
sync:
  # Only instances with the same key sync together
  key: amber-otter-glide
  # Optional: the name shown to the other computers (the computer name by default)
  name: Finish line
```

- Without a `sync` section, or without a key, sync is off. The file is read again every few seconds, so sync can be turned on or off without restarting.
- **Discovery**: every instance announces itself every 3 s by UDP broadcast on port 41234 (its name, HTTP port and a hash of its key, never the key itself). The firewall must let UDP 41234 and the HTTP port (3001 by default) through; Windows asks the first time.
- **What is synced**: everything in the event folders.
  - Participant CSV files and discipline `config.yaml`: the most recently modified copy wins, and keeps its modification time on the other computers.
  - `<event>-<discipline>-results.csv`: merged line by line. A run is identified by its bib and start; when a line was changed on both computers, the most recently changed (`updated` column) wins. The page of every computer updates live.
  - Not synced: `<event>-<discipline>-uda-results.csv` (each computer writes it from its `<event>-<discipline>-results.csv`), the root `config.yaml` (devices, port and name differ per computer), and the run in progress (each computer times its own runs).
- Changes are sent at once to the other computers, which also check every 3 s, so a computer that was off catches up when it comes back.
- The latest change wins, so the computers' clocks must roughly agree: the navigation bar warns when they differ by more than 2 s.
- A deleted file or result line comes back from a computer that still has it: delete it on every computer while they are not connected, or mark the run `INVALID` instead.
- The key prevents mixing with another timing app on the same network; it is not a protection against someone on the network who wants to change the results.

The navigation bar shows the sync state ("Synced with 1 computer"); its tooltip lists the computers found and any problem.

### Live page

_Live_ (in the Race part of the title menu, `/live`) is a public display of the selected event and discipline, for a screen facing the audience:

- **On track**: one card per line (of this computer and the synced ones) that a race page shows with this discipline, or that times a run in it: _Waiting_, the participant _Ready_, a running clock, or the time (or DQ / Invalid) of the run that just ended. The card also shows the participant's best time and its rank (or _No time yet_), whether ready, running or just finished.
- **Ranking**: every participant with a run, by best valid time, with their category and number of runs; a run that just ended is highlighted. Invalid runs are left out (not counted, no time): a participant whose runs are all invalid is not listed. DQ runs are counted, without a time.

Each computer shares its activity (the event, discipline and line open on its race pages, and the run and last result of each of its lines) with the synced ones at once when it changes, and in every announcement. A running clock on another computer is corrected by the difference between the clocks; the saved time is always measured by the computer that times the run.

## 🩺 Troubleshooting in the Logs

- **Device list**: logged at startup and whenever a relevant device appears, disappears, or the config changes.
- **Rule matches no device**: the log explains why: the VID/PID is not plugged in, or the device is there but none of its interfaces fit the rule (the available interfaces are listed).
- **Open/read failure**: logged once with a hint (Windows mouse/keyboard, missing udev rule…). The device is retried every second and the error is repeated about once a minute. Recovery is logged.

---

## 🔌 API & WebSocket Documentation

HTTP and WebSocket share the same port, chosen at startup in this order: the `--port <n>` option, the `PORT` environment variable, `port` in `config.yaml` (also editable on the config page, applied after a restart), then `3001`. If the port is already used, the server logs it and stops.

### WebSocket Events

- **Endpoint**: `ws://localhost:3001`
- **Payload Structure** (see `src/types/messages.ts`):

  ```json
  {
    "type": "RACE_UPDATE",
    "line": "Line 1",
    "gate": "start",
    "deviceName": "Receiver",
    "timestamp": "2026-11-04T12:15:30.123456789Z"
  }
  ```

  Sent for every crossing of a gate of a line, whether or not a run uses it (`deviceName` is `Simulator` for the simulated gates).

- `RUN_UPDATE` `{ line, run }`: the run of a line changed. `run.status` is `idle`, `ready` (with `event`, `discipline`, `participant`) or `running` (also with `startedAt`).
- `LINES_UPDATE` `{ lines }`: the lines of this computer changed (`config.yaml`), see `GET /api/lines`.
- `RUN_RESULT` `{ line, event, discipline, result }`: a run finished or the participant was disqualified. `result` has `bib`, `name`, `start`, `finish`, `timeMs` and `status` (`ok`, `invalid` or `dq`) (`finish` and `timeMs` are `null` when the run was ended before the finish).
- `RESULT_UPDATE` `{ event, discipline, result }`: the status of a saved run changed.
- `SETTINGS_UPDATE` `{ event, discipline, settings }`: the settings of a discipline were saved from the race page.
- `SYNC_UPDATE` `{ event, discipline }`: files of a discipline were changed by the sync with another computer.
- `LIVE_UPDATE` `{ instances }`: the activity of this computer or of a synced one changed (see `GET /api/live`).
- From the page: `VIEWING` `{ event, discipline, line, participant }` tells which event and discipline a race page shows, the line it times on and the participant selected (`null` for none).

### REST Endpoints

The full reference, with every request and response schema, is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1): open it in any OpenAPI viewer (e.g. the Swagger Editor, or an editor extension). `npm test` checks that it lists exactly the routes of `src/routes/api.ts`, so a new or removed route must be documented there too. To lint it with the rules of `redocly.yaml` (at the repository root), run `npx @redocly/cli lint` from the repository root. In short:

- `GET /api/status`: Health check (status, uptime, server time).
- `GET /api/config`: `config.yaml` parsed as `config`, with its path and modification time. `config` is `null` when the file is missing, or invalid (then `problems` says why and `content` holds the text).
- `POST /api/config/validate` `{ config }`: the problems found in a config object, without saving it.
- `PUT /api/config` `{ config, modifiedAt }`: writes the config to `config.yaml`. `422` with the problems if it is invalid; `409` if the file changed since `modifiedAt` (the value returned by `GET`).
- `GET /api/events`: the working directory (`workDir`) and its `events`, each with its `disciplines`.
- `GET /api/events/:event/:discipline/participants`: the discipline's `participants` (`bib`, `name`, `file`: the category, from the `Age Group` column or else the CSV file name without extension), sorted by bib, its `settings` (`attempts`, `null` when unlimited, `start`, `end`, `access`, `best`) and the `problems` of ignored settings and skipped rows. `404` for an unknown event or discipline.
- `GET /api/events/:event/:discipline/settings`: the discipline's `settings` from its `config.yaml`, and the `problems` found in it.
- `PUT /api/events/:event/:discipline/settings` `{ settings: { attempts, start, end, access, best } }`: saves the discipline's `config.yaml` (`attempts`: a whole number from 1, or `null` for unlimited; `start`, `end`: ISO 8601 date-times, saved in UTC, or `null`; `access`: `auto`, `open` or `locked`; `best`: `shortest` or `longest`) and returns the `settings` read back with their `problems`. `422` for an invalid value.
- `GET /api/events/:event/:discipline/results`: every run of the discipline from `<event>-<discipline>-results.csv`, oldest first.
- `PATCH /api/events/:event/:discipline/results` `{ bib, start, status }`: sets the status (`ok`, `invalid` or `dq`) of the saved run of `bib` that started at `start` (bib and start together identify a run, as several participants can share a start). `404` when there is no such run, `409` to set `ok` on a run without a time, or when the discipline is closed (outside its period with `access: auto`, or `access: locked`).
- `GET /api/lines`: the `lines` of this computer (the enabled lines of `config.yaml`, in its order), each with its `run` (see `RUN_UPDATE`) and `lastResult`.
- `POST /api/lines/:line/ready` `{ event, discipline, bib }`: the participant is ready on the line, its next start crossing starts their run. `404` for an unknown line or participant, `409` while a run is in progress on the line, when the participant is ready or running on another line, has no attempt left, or when the discipline is closed.
- `POST /api/lines/:line/invalidate`, `POST /api/lines/:line/disqualify`: ends the running run of the line now and saves it as `INVALID` or `DQ`. `409` when no run is in progress on it.
- `POST /api/lines/:line/cancel`: abandons the run of the line, nothing is saved.
- `POST /api/simulate/crossing` `{ gate: "start" | "finish", line? }`, `POST /api/simulate/reset`: simulated gates, only when the server is started with `TIMING_SIMULATE_GATES=1` (the end-to-end tests do, and it can be used for training without hardware). A crossing acts as if the gate of the line (the first one by default) was crossed now; reset reads `config.yaml` again and forgets the runs in progress and the last results. Without lines in `config.yaml`, the server then has two simulated lines, `Line 1` and `Line 2`. The server logs a warning when they are on.
- `GET /api/live`: the `instances` shown on the live page: this computer and the synced ones, each with its `name`, `viewing` (event, discipline and line open on its race pages), `lines` (each with its `run` and `lastResult`) and `clockOffsetMs`.
- `GET /api/sync`: whether sync is on, this computer's `name`, and the `peers` found (name, address, port, last sync, error, clock offset).
- `GET /api/sync/manifest`, `GET /api/sync/file?path=`, `GET /api/sync/results?event=&discipline=`, `POST /api/sync/notify`, `POST /api/sync/activity`: used between instances, only with the hash of the same key in the `x-timing-sync` header (`403` otherwise).
- `GET /api/hardware/status`: Device diagnostics, used by the frontend diagnostics page. Lists each device used by a line (`deviceName`) as `listening` (report count, last report, last 50 changed reports, the state of the line gates on it) or `failing` (error, hint, attempts), every HID interface found by the last scan with the rule using it (and `transport: usb` for the ones read with libusb), and explanations for the used devices that match nothing connected. `?monitor=0x046d:0xc548,…` also opens the interfaces of these models that no line uses, and returns their reports in `monitor`: they stay open while requests keep asking, and close 5 seconds after the last one.

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
