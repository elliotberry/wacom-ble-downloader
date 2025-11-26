#!/usr/bin/env node

const { program } = require('commander');
const WacomBLE = require('./lib/wacom-ble');
const config = require('./lib/config');
const fs = require('fs');
const path = require('path');

program
  .name('wacom-download')
  .description('Download notes from Wacom BLE devices as SVG files')
  .version('1.0.0');

program
  .command('download')
  .description('Download notes from a registered Wacom device')
  .option('-o, --output <dir>', 'Output directory for SVG files', './notes')
  .option('-t, --timeout <ms>', 'Scan timeout in milliseconds', '30000')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    try {
      const outputDir = path.resolve(options.output);
      
      // Create output directory if it doesn't exist
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
      }

      console.log('Scanning for Wacom devices...');
      console.log('(Make sure your device is powered on. You may need to press the button briefly to wake it up.)');
      if (options.verbose) {
        console.log('(Verbose mode: showing all discovered BLE devices)');
      }
      const wacom = new WacomBLE(options.verbose);
      
      const device = await wacom.scanAndConnect(parseInt(options.timeout), false);
      if (!device) {
        console.error('No Wacom device found or connection failed');
        process.exit(1);
      }

      if (!device.registered) {
        console.error('\nError: Device is not registered!');
        console.error('Please register the device first using: wacom-download register');
        await wacom.disconnect();
        process.exit(1);
      }

      console.log(`\nFound registered device: ${device.name || device.id}`);
      console.log('Connecting and authenticating...');
      
      // Download all notes
      const notes = await wacom.downloadAllNotes();
      console.log(`Downloaded ${notes.length} note(s)`);

      // Save each note as SVG
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const timestamp = note.timestamp 
          ? new Date(note.timestamp * 1000).toISOString().replace(/[:.]/g, '-').slice(0, -5)
          : `note-${i + 1}`;
        const filename = path.join(outputDir, `${timestamp}.svg`);
        
        fs.writeFileSync(filename, note.svg);
        console.log(`Saved: ${filename}`);
      }

      await wacom.disconnect();
      console.log('Done!');
      process.exit(0);
    } catch (error) {
      console.error('Error:', error.message);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('register')
  .description('Register a new Wacom device')
  .option('-t, --timeout <ms>', 'Scan timeout in milliseconds', '30000')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    try {
      console.log('=== Wacom Device Registration ===');
      console.log('');
      console.log('Instructions:');
      console.log('1. Hold the button on your Wacom device for 6+ seconds');
      console.log('2. Wait until the LED starts blinking (blue light)');
      console.log('3. Keep the LED blinking while registration proceeds');
      console.log('4. Make sure Bluetooth is enabled on your computer');
      console.log('');
      
      console.log('Scanning for Wacom devices...');
      if (options.verbose) {
        console.log('(Verbose mode: showing all discovered BLE devices)');
      }
      const wacom = new WacomBLE(options.verbose);
      
      const device = await wacom.scanAndConnect(parseInt(options.timeout), true);
      if (!device) {
        console.error('No Wacom device found or connection failed');
        process.exit(1);
      }

      if (device.registered) {
        console.log('\nDevice is already registered!');
        const savedConfig = config.getDevice(device.address);
        console.log(`UUID: ${savedConfig.uuid}`);
        console.log(`Protocol: ${savedConfig.protocol}`);
        console.log('\nTo re-register, you may need to reset the device first.');
        await wacom.disconnect();
        process.exit(0);
      }

      console.log(`\nFound unregistered device: ${device.name || device.id}`);
      console.log(`Address: ${device.address}`);
      
      // Register the device
      await wacom.registerDevice();

      await wacom.disconnect();
      console.log('\nRegistration complete! You can now use "wacom-download download" to download notes.');
      process.exit(0);
    } catch (error) {
      console.error('\nRegistration failed:', error.message);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List registered devices')
  .action(() => {
    const devices = config.devices;
    const addresses = Object.keys(devices);
    
    if (addresses.length === 0) {
      console.log('No registered devices found.');
      return;
    }

    console.log('Registered devices:');
    console.log('');
    addresses.forEach(address => {
      const device = devices[address];
      console.log(`  Address: ${device.address}`);
      console.log(`  UUID: ${device.uuid}`);
      console.log(`  Protocol: ${device.protocol}`);
      console.log(`  Registered: ${device.registeredAt}`);
      console.log('');
    });
  });

// Default to download command if no command specified
if (process.argv.length === 2) {
  process.argv.push('download');
}

program.parse();

