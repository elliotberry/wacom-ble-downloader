#!/usr/bin/env node

import {program} from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import inquirer from 'inquirer';
import WacomBLE from './lib/wacom-ble.js';
import config from './lib/config.js';
import logger from './lib/logger.js';

async function collectProfilePreferences(defaults = {}) {
  const defaultDir = defaults.downloadDir
    ? path.resolve(defaults.downloadDir)
    : path.resolve(path.join(os.homedir(), 'wacom-notes'));
  const defaultOrientation = defaults.orientation === 'portrait' ? 'portrait' : 'landscape';

  logger.blank();
  logger.headline('Device preferences');
  logger.info('Answer a few quick questions so we know where to save notes and how your tablet is oriented.');
  logger.blank();

  const orientationChoices = [
    {
      name: `Landscape${defaultOrientation === 'landscape' ? ' (default)' : ''}`,
      value: 'landscape'
    },
    {
      name: `Portrait (rotates exported SVG 90 degrees clockwise)${defaultOrientation === 'portrait' ? ' (default)' : ''}`,
      value: 'portrait'
    }
  ];

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'downloadDir',
      message: 'Where should notes be saved?',
      default: defaultDir,
      filter: (input) => path.resolve((input || '').trim() || defaultDir)
    },
    {
      type: 'list',
      name: 'orientation',
      message: 'Tablet orientation',
      choices: orientationChoices,
      default: defaultOrientation
    }
  ]);

  logger.blank();
  logger.info(`Notes will be downloaded to: ${answers.downloadDir}`);
  logger.info(`Tablet orientation set to: ${answers.orientation}`);
  logger.blank();

  return {
    downloadDir: answers.downloadDir,
    orientation: answers.orientation
  };
}

program
  .name('wacom-download')
  .description('Download notes from Wacom BLE devices as SVG files')
  .version('1.0.0');

program
  .command('download')
  .description('Download notes from a registered Wacom device')
  .option('-o, --output <dir>', 'Output directory for SVG files')
  .option('-t, --timeout <ms>', 'Scan timeout in milliseconds', '30000')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async ({output, verbose, timeout}) => {
    try {
      logger.info('Scanning for Wacom devices...');
      logger.detail('Make sure your device is powered on. You may need to press the button briefly to wake it up.');
      if (verbose) {
        logger.detail('Verbose mode enabled: showing all discovered BLE devices');
      }
      const wacom = new WacomBLE(verbose);
      
      const device = await wacom.scanAndConnect(parseInt(timeout), false);
      if (!device) {
        logger.error('No Wacom device found or connection failed');
        process.exit(1);
      }

      if (!device.registered) {
        logger.blank();
        logger.error('Error: Device is not registered!');
        logger.note('Please register the device first using: wacom-download register');
        await wacom.disconnect();
        process.exit(1);
      }

      logger.blank();
      logger.success(`Found registered device: ${device.name || device.id}`);
      
      const savedConfig = config.getDevice(device.address);
      let outputDir = output ? path.resolve(output) : null;

      if (!outputDir) {
        if (savedConfig?.downloadDir) {
          outputDir = path.resolve(savedConfig.downloadDir);
          logger.info(`Using saved download directory: ${outputDir}`);
        } else {
          outputDir = path.resolve(path.join(os.homedir(), 'wacom-notes'));
          logger.note(`No saved download directory found. Using default: ${outputDir}`);
        }
      } else {
        logger.info(`Using overridden download directory: ${outputDir}`);
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        logger.success(`Created output directory: ${outputDir}`);
      }

      const orientation = savedConfig?.orientation || 'landscape';
      if (orientation === 'portrait') {
        logger.info('Portrait orientation selected: rotating SVG output 90° clockwise.');
      }

      logger.info('Connecting and authenticating...');
      
      // Download all notes (they are saved immediately during download)
      const notes = await wacom.downloadAllNotes(outputDir, { orientation });
      logger.blank();
      logger.success(`Downloaded ${notes.length} note(s)`);

      await wacom.disconnect();
      logger.success('Done!');
      process.exit(0);
    } catch (error) {
      logger.error(`Error: ${error.message}`);
      if (error.stack) {
        logger.detail(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('register')
  .description('Register a new Wacom device')
  .option('-t, --timeout <ms>', 'Scan timeout in milliseconds', '30000')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async ({verbose, timeout}) => {
    try {
      logger.headline('=== Wacom Device Registration ===');
      logger.blank();
      logger.info('Instructions:');
      logger.detail('1. Hold the button on your Wacom device for 6+ seconds');
      logger.detail('2. Wait until the LED starts blinking (blue light)');
      logger.detail('3. Keep the LED blinking while registration proceeds');
      logger.detail('4. Make sure Bluetooth is enabled on your computer');
      logger.blank();
      
      logger.info('Scanning for Wacom devices...');
      if (verbose) {
        logger.detail('Verbose mode enabled: showing all discovered BLE devices');
      }
      const wacom = new WacomBLE(verbose);
      
      const device = await wacom.scanAndConnect(parseInt(timeout), true);
      if (!device) {
        logger.error('No Wacom device found or connection failed');
        process.exit(1);
      }

      if (device.registered) {
        logger.blank();
        logger.note('Device is already registered!');
        const savedConfig = config.getDevice(device.address);
        logger.detail(`UUID: ${savedConfig.uuid}`);
        logger.detail(`Protocol: ${savedConfig.protocol}`);
        logger.blank();
        logger.note('To re-register, you may need to reset the device first.');
        await wacom.disconnect();
        process.exit(0);
      }

      logger.blank();
      logger.success(`Found unregistered device: ${device.name || device.id}`);
      logger.detail(`Address: ${device.address}`);
      
      // Register the device
      const registrationResult = await wacom.registerDevice();

      await wacom.disconnect();

      const savedDevice = config.getDevice(registrationResult.address) || {};
      const preferences = await collectProfilePreferences({
        downloadDir: savedDevice.downloadDir || path.resolve(path.join(os.homedir(), 'wacom-notes')),
        orientation: savedDevice.orientation || 'landscape'
      });
      const updatedProfile = config.updateDevice(registrationResult.address, preferences);

      logger.blank();
      logger.success('Registration complete and preferences saved!');
      logger.detail(`Notes directory: ${updatedProfile.downloadDir}`);
      logger.detail(`Tablet orientation: ${updatedProfile.orientation}`);
      logger.note('You can now use "wacom-download download" to sync your notes.');
      process.exit(0);
    } catch (error) {
      logger.blank();
      logger.error(`Registration failed: ${error.message}`);
      if (error.stack) {
        logger.detail(error.stack);
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
      logger.warn('No registered devices found.');
      return;
    }

    logger.headline('Registered devices:');
    logger.blank();
    addresses.forEach(address => {
      const device = devices[address];
      logger.detail(`Address: ${device.address}`);
      logger.detail(`UUID: ${device.uuid}`);
      logger.detail(`Protocol: ${device.protocol}`);
      logger.detail(`Registered: ${device.registeredAt}`);
      logger.detail(`Notes directory: ${device.downloadDir || '(not set)'}`);
      logger.detail(`Orientation: ${device.orientation}`);
      logger.blank();
    });
  });

program
  .command('deregister <address>')
  .description('Deregister a Wacom device by its Bluetooth address')
  .action((address) => {
    try {
      if (!config.isValidAddress(address)) {
        logger.error(`Invalid Bluetooth address format: ${address}`);
        logger.detail('Expected format: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX');
        process.exit(1);
      }

      const device = config.deregisterDevice(address);
      logger.success('Device deregistered successfully!');
      logger.detail(`Address: ${device.address}`);
      logger.detail(`UUID: ${device.uuid}`);
      logger.detail(`Protocol: ${device.protocol}`);
      logger.detail(`Was registered: ${device.registeredAt}`);
      process.exit(0);
    } catch (error) {
      logger.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('deregister-all')
  .description('Deregister all registered Wacom devices')
  .action(() => {
    try {
      const devices = config.deregisterAllDevices();
      const addresses = Object.keys(devices);
      const count = addresses.length;

      logger.success(`Successfully deregistered ${count} device(s):`);
      logger.blank();
      addresses.forEach(address => {
        const device = devices[address];
        logger.detail(`Address: ${device.address}`);
        logger.detail(`UUID: ${device.uuid}`);
        logger.detail(`Protocol: ${device.protocol}`);
        logger.detail(`Was registered: ${device.registeredAt}`);
        logger.blank();
      });
      process.exit(0);
    } catch (error) {
      logger.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

// Default to download command if no command specified
if (process.argv.length === 2) {
  process.argv.push('download');
}

program.parse();

