# Wacom BLE Note Downloader

A Node.js CLI tool to connect to Wacom BLE devices (Bamboo Spark, Bamboo Slate, Intuos Pro Paper, etc.) and download notes as SVG files.

## Installation

```bash
cd node-program-dir
npm install
```

## Usage

### Register a Device

Before downloading notes, you must register your Wacom device:

```bash
node index.js register
```

Follow the on-screen instructions:
1. Hold the button on your Wacom device for 6+ seconds until the LED blinks
2. Keep the LED blinking while registration proceeds
3. Press the button when prompted to confirm registration

### Download Notes

After registration, download notes from your device:

```bash
node index.js download [options]
```

Options:
- `-o, --output <dir>` - Output directory for SVG files (default: `./notes`)
- `-t, --timeout <ms>` - Scan timeout in milliseconds (default: `30000`)

### List Registered Devices

View all registered devices:

```bash
node index.js list
```

### Examples

```bash
# Register a new device
node index.js register

# Download notes to default ./notes directory
node index.js download

# Download notes to a specific directory
node index.js download --output ~/my-notes

# Use a longer scan timeout
node index.js download --timeout 60000
```

## Requirements

- Node.js >= 12.0.0
- macOS (uses noble-mac for BLE)
- Bluetooth enabled
- A Wacom BLE device (Bamboo Spark, Bamboo Slate, Intuos Pro Paper, etc.)

## How it works

1. Scans for Wacom BLE devices using manufacturer data
2. Connects to the first device found
3. Switches device to file transfer mode
4. Downloads all available notes
5. Parses stroke data
6. Converts to SVG format
7. Saves each note as an SVG file with timestamp-based filename

## Notes

- **Device Registration**: Wacom devices must be registered before downloading notes. Use `wacom-download register` to register a device. The device will only respond to the application that registered it.
- **Registration Process**: During registration, hold the device button for 6+ seconds until the LED starts blinking, then keep it blinking while registration proceeds.
- **Configuration**: Device UUIDs and protocol information are stored in `~/.wacom-downloader/devices.json`.
- Notes are deleted from the device after download
- SVG files are named using the note's timestamp
- Currently supports Bamboo Spark, Bamboo Slate, and Intuos Pro Paper devices

## License

MIT

