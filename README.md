# Wacom BLE Note Downloader

A Node.js CLI tool to connect to Wacom BLE devices (Bamboo Spark, Bamboo Slate, Intuos Pro Paper, etc.) and download notes as SVG files.

## Installation

You can run the CLI directly with `npx`, or install it globally:

```bash
# from the node-program-dir folder
npm install

# optional: make the wacom-download binary available everywhere
npm install --global .
```

## Usage

### Command Summary

```bash
wacom-download register           # pair a new device
wacom-download download [opts]    # fetch & delete all notes
wacom-download list               # show registered devices
wacom-download deregister <addr>  # remove one device
wacom-download deregister-all     # remove every device
```

Add `-v` to any command for verbose BLE logging.

### Register a Device

Before downloading notes, you must register your Wacom device:

```bash
wacom-download register
```

Follow the on-screen instructions:
1. Hold the button on your Wacom device for 6+ seconds until the LED blinks
2. Keep the LED blinking while registration proceeds
3. Press the button when prompted to confirm registration
4. Answer the questions about where to download notes and whether your tablet is used in landscape or portrait orientation (portrait rotates every exported SVG 90° clockwise)

### Download Notes

After registration, download notes from your device:

```bash
wacom-download download [options]
```

Options:
- `-o, --output <dir>` - Override the saved download directory for this run
- `-t, --timeout <ms>` - Scan timeout in milliseconds (default: `30000`)
- `-v, --verbose` - Log every BLE event and file chunk

### List Registered Devices

View all registered devices:

```bash
wacom-download list
```

### Examples

```bash
# Register a new device
wacom-download register

# Download notes to default ./notes directory
wacom-download download

# Download notes to a specific directory
wacom-download download --output ~/my-notes

# Use a longer scan timeout
wacom-download download --timeout 60000

# Show verbose BLE logging
wacom-download download --verbose
```

## Requirements

- Node.js >= 12.0.0
- macOS (uses noble-mac for BLE)
- Bluetooth enabled
- A Wacom BLE device (Bamboo Spark, Bamboo Slate, Intuos Pro Paper, etc.)

## How it works

1. Scans for Wacom BLE devices using manufacturer data
2. Connects to the first device found
3. Authenticates using the saved UUID (registration)
4. Switches the device to file transfer mode
5. Downloads and **decompresses** every Smartpad file (same codec as Wacom Inkspace)
6. Parses the stroke stream into absolute coordinates and pressures
7. Converts the drawing to SVG and saves it with a timestamp-based filename

## Notes

- **Device Registration**: Wacom devices must be registered before downloading notes. Use `wacom-download register` to register a device. The device will only respond to the application that registered it.
- **Registration Process**: During registration, hold the device button for 6+ seconds until the LED starts blinking, then keep it blinking while registration proceeds.
- **Configuration**: Device UUIDs, preferred download directories, and tablet orientation are stored in `~/.wacom-downloader/devices.json`.
- Notes are deleted from the device after download
- SVG files are named using the note's timestamp
- Currently supports Bamboo Spark, Bamboo Slate, Intuos Pro Paper, and compatible Smartpad models.
- The downloader mirrors Wacom Inkspace’s decompression/parsing logic to ensure the SVG matches what the device recorded.

## License

MIT

