// Configuration storage for registered devices
const fs = require('fs');
const path = require('path');
const os = require('os');

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
      this.devices = JSON.parse(data);
    } catch (error) {
      console.warn('Failed to load config:', error.message);
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
      console.error('Failed to save config:', error.message);
      throw error;
    }
  }

  getDevice(address) {
    return this.devices[address] || null;
  }

  registerDevice(address, uuid, protocol) {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid Bluetooth address: ${address}`);
    }
    if (!uuid || uuid.length !== 12) {
      throw new Error(`Invalid UUID: ${uuid} (must be 12 hex characters)`);
    }

    this.devices[address] = {
      address: address,
      uuid: uuid,
      protocol: protocol,
      registeredAt: new Date().toISOString()
    };
    this.save();
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
    // Bluetooth address format: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX
    // Or UUID format (for noble-mac on macOS)
    return /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i.test(address) ||
           /^[0-9A-F]{32}$/i.test(address.replace(/-/g, ''));
  }

  normalizeAddress(address) {
    // Remove dashes and convert to uppercase for consistent storage
    // This works for both MAC addresses and UUIDs
    return address.replace(/-/g, '').replace(/:/g, '').toUpperCase();
  }
}

module.exports = new Config();

