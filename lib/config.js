// Configuration storage for registered devices
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from './logger.js';

const DEFAULT_ORIENTATION = 'landscape';

class Config {
  constructor() {
    // Use ~/.wacom-downloader as config directory
    this.configDir = path.join(os.homedir(), '.wacom-downloader');
    this.configFile = path.join(this.configDir, 'devices.json');
    this.devices = {};
    this.load();
  }

  load() {
    if (!fs.existsSync(this.configFile)) {
      this.devices = {};
      return;
    }

    try {
      const data = fs.readFileSync(this.configFile, 'utf8');
      const parsed = JSON.parse(data);
      this.devices = {};

      Object.keys(parsed).forEach((address) => {
        const normalizedAddress = this.normalizeAddress(address);
        const device = parsed[address] || {};
        this.devices[normalizedAddress] = {
          ...device,
          address: normalizedAddress
        };
        this.applyDeviceDefaults(normalizedAddress);
      });
    } catch (error) {
      logger.warn(`Failed to load config: ${error.message}`);
      this.devices = {};
    }
  }

  save() {
    // Ensure config directory exists
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.devices, null, 2));
    } catch (error) {
      logger.error(`Failed to save config: ${error.message}`);
      throw error;
    }
  }

  getDevice(address) {
    if (!address) {
      return null;
    }
    const normalizedAddress = this.normalizeAddress(address);
    const device = this.devices[normalizedAddress];
    if (!device) {
      return null;
    }
    this.applyDeviceDefaults(normalizedAddress);
    return this.devices[normalizedAddress];
  }

  registerDevice(address, uuid, protocol, profile = {}) {
    const normalizedAddress = this.normalizeAddress(address);
    if (!this.isValidAddress(normalizedAddress)) {
      throw new Error(`Invalid Bluetooth address: ${address}`);
    }
    if (!uuid || uuid.length !== 12) {
      throw new Error(`Invalid UUID: ${uuid} (must be 12 hex characters)`);
    }

    this.devices[normalizedAddress] = {
      address: normalizedAddress,
      uuid: uuid,
      protocol: protocol,
      registeredAt: new Date().toISOString(),
      downloadDir: profile.downloadDir || null,
      orientation: this.normalizeOrientation(profile.orientation)
    };
    this.save();
    return this.devices[normalizedAddress];
  }

  updateDevice(address, updates = {}) {
    const normalizedAddress = this.normalizeAddress(address);
    const existing = this.devices[normalizedAddress];
    if (!existing) {
      throw new Error(`Device with address ${address} is not registered`);
    }

    const next = {
      ...existing
    };

    if (Object.prototype.hasOwnProperty.call(updates, 'downloadDir')) {
      next.downloadDir = updates.downloadDir || null;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'orientation')) {
      next.orientation = this.normalizeOrientation(updates.orientation);
    } else {
      next.orientation = this.normalizeOrientation(next.orientation);
    }

    this.devices[normalizedAddress] = next;
    this.save();
    return this.devices[normalizedAddress];
  }

  deregisterDevice(address) {
    const normalizedAddress = this.normalizeAddress(address);
    
    if (!this.devices[normalizedAddress]) {
      throw new Error(`Device with address ${address} is not registered`);
    }

    const device = this.devices[normalizedAddress];
    delete this.devices[normalizedAddress];
    this.save();
    
    return device;
  }

  deregisterAllDevices() {
    const devices = { ...this.devices };
    const count = Object.keys(devices).length;
    
    if (count === 0) {
      throw new Error('No registered devices found');
    }

    this.devices = {};
    this.save();
    
    return devices;
  }

  isValidAddress(address) {
    if (!address) {
      return false;
    }

    const trimmed = address.trim();
    const macPattern = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i;
    if (macPattern.test(trimmed)) {
      return true;
    }

    const stripped = this.normalizeAddress(trimmed);
    return /^[0-9A-F]{12}$/i.test(stripped) || /^[0-9A-F]{32}$/i.test(stripped);
  }

  normalizeAddress(address) {
    if (!address) {
      return '';
    }
    // Remove non-hex characters for consistent storage
    return address.replace(/[^0-9A-F]/gi, '').toUpperCase();
  }

  normalizeOrientation(value) {
    return value && value.toLowerCase() === 'portrait' ? 'portrait' : DEFAULT_ORIENTATION;
  }

  applyDeviceDefaults(address) {
    const device = this.devices[address];
    if (!device) {
      return;
    }
    if (!device.address) {
      device.address = address;
    }
    device.orientation = this.normalizeOrientation(device.orientation);
    if (typeof device.downloadDir !== 'string' || device.downloadDir.trim() === '') {
      device.downloadDir = null;
    }
  }
}

export default new Config();

