const noble = require('noble-mac');
const path = require('path');
const fs = require('fs');
const WacomProtocol = require('./protocol');
const StrokeParser = require('./stroke-parser');
const SVGConverter = require('./svg-converter');
const config = require('./config');
const UUIDGenerator = require('./uuid-generator');

// BLE Characteristic UUIDs
const CHARACTERISTIC_COMMAND_NOTIFY = '6e400003b5a3f393e0a9e50e24dcca9e';
const CHARACTERISTIC_COMMAND_WRITE = '6e400002b5a3f393e0a9e50e24dcca9e';
const CHARACTERISTIC_FILE_TRANSFER_NOTIFY = 'ffee0003bbaa99887766554433221100';
const CHARACTERISTIC_EVENTS_NOTIFY = '3a340721c57211e586c50002a5d5c51b';

// Wacom company IDs (first 2 bytes of manufacturer data, little-endian)
const WACOM_COMPANY_ID_COLUMBIA = 0x4755; // "UG" = 0x55 0x47
const WACOM_COMPANY_ID_WACOM = 0x4157;    // "WA" = 0x57 0x41
const WACOM_COMPANY_ID_BM = 0x424d;       // "MB" = 0x4d 0x42

// Wacom device manufacturer data identifiers (full patterns)
const COLUMBIA_CONSUMER_ADV = Buffer.from([0x55, 0x47, 0x2D, 0x43, 0x4C, 0x52]); // UG-CLR
const COLUMBIA_CONSUMER_DATA_READY = Buffer.from([0x55, 0x47, 0x2D, 0x43, 0x4C, 0x52, 0x2E, 0x73, 0x61]); // UG-CLR.sa
const COLUMBIA_CREATIVE_ADV = Buffer.from([0x55, 0x47, 0x2D, 0x43, 0x41, 0x54]); // UG-CAT
const COLUMBIA_CREATIVE_DATA_READY = Buffer.from([0x55, 0x47, 0x2D, 0x43, 0x41, 0x54, 0x2E, 0x73, 0x61]); // UG-CAT.sa
const VIPER_ADV = Buffer.from([0x57, 0x41, 0x2D, 0x56, 0x49, 0x50]); // WA-VIP
const VIPER_DATA_READY = Buffer.from([0x57, 0x41, 0x2D, 0x56, 0x49, 0x50, 0x2E, 0x53, 0x49]); // WA-VIP.SI

// Wacom device name patterns
const WACOM_NAME_PATTERNS = [
  /bamboo/i,
  /spark/i,
  /slate/i,
  /intuos/i,
  /folio/i,
  /wacom/i
];

class WacomBLE {
  constructor(verbose = false) {
    this.peripheral = null;
    this.commandChar = null;
    this.commandNotifyChar = null;
    this.fileTransferChar = null;
    this.eventsChar = null;
    this.protocol = null;
    this.pendingReplies = new Map();
    this.fileTransferBuffer = [];
    this.fileTransferComplete = false;
    this.deviceInfo = null;
    this.verbose = verbose;
  }

  async scanAndConnect(timeout = 30000, registerMode = false) {
    return new Promise((resolve, reject) => {
      const foundDevices = [];
      let scanningStopped = false;

      const stopScanningAndConnect = async () => {
        if (scanningStopped) return;
        scanningStopped = true;
        
        try {
          await noble.stopScanning();
        } catch (e) {
          // Ignore errors stopping scan
        }
        
        if (foundDevices.length === 0) {
          if (this.verbose) {
            console.log('\nNo Wacom devices found.');
            console.log('\nTroubleshooting tips:');
            console.log('1. Make sure your Wacom device is powered on');
            console.log('2. For registration: Hold the button for 6+ seconds until LED blinks');
            console.log('3. Make sure Bluetooth is enabled on your computer');
            console.log('4. Try moving closer to the device');
          }
          reject(new Error('No Wacom devices found'));
          return;
        }

        // Use the first device found
        const device = foundDevices[0];
        console.log(`\nFound ${foundDevices.length} device(s). Using: ${device.name}`);
        console.log(`Connecting to ${device.name}...`);
        
        if (device.registered && !registerMode) {
          const savedConfig = config.getDevice(device.address);
          if (savedConfig) {
            console.log(`Device is registered with UUID: ${savedConfig.uuid}`);
            console.log(`Protocol: ${savedConfig.protocol}`);
          }
        }
        
        try {
          await this.connect(device.peripheral);
          this.deviceInfo = device;
          
          // Load saved UUID if registered (after protocol is initialized)
          // We'll do this after services are discovered
          
          console.log('✓ Connection established');
          resolve(device);
        } catch (error) {
          console.error(`\n✗ Connection failed: ${error.message}`);
          if (device.registered && !registerMode) {
            console.log('\nTroubleshooting tips:');
            console.log('1. Press the button on your device briefly to wake it up');
            console.log('2. Make sure the device is not in use by another application');
            console.log('3. Try running the command again');
            console.log('4. If problems persist, you may need to re-register the device');
          }
          reject(error);
        }
      };

      noble.on('stateChange', async (state) => {
        if (state === 'poweredOn') {
          console.log('Bluetooth powered on, starting scan...');
          noble.startScanning([], false);
        } else if (state === 'poweredOff') {
          reject(new Error('Bluetooth is powered off'));
        }
      });

      noble.on('discover', (peripheral) => {
        const advData = peripheral.advertisement.manufacturerData;
        const deviceName = peripheral.advertisement.localName || '';
        // On macOS, noble-mac uses UUID as identifier (MAC address not available)
        const address = peripheral.uuid || peripheral.address;
        
        if (this.verbose) {
          console.log(`  Discovered: ${deviceName || '(no name)'} (${address})`);
          if (advData) {
            const data = Buffer.from(advData);
            console.log(`    Manufacturer data: ${data.toString('hex')} (${data.length} bytes)`);
          } else {
            console.log(`    No manufacturer data`);
          }
        }
        
        let isWacom = false;
        let isRegistrationMode = false;
        
        // Check manufacturer data if available
        if (advData) {
          const data = Buffer.from(advData);
          
          // Check for full manufacturer data patterns
          if (data.equals(COLUMBIA_CONSUMER_ADV) ||
              data.equals(COLUMBIA_CONSUMER_DATA_READY) ||
              data.equals(COLUMBIA_CREATIVE_ADV) ||
              data.equals(COLUMBIA_CREATIVE_DATA_READY) ||
              data.equals(VIPER_ADV) ||
              data.equals(VIPER_DATA_READY)) {
            isWacom = true;
          }
          // Check for company ID match (first 2 bytes)
          else if (data.length >= 2) {
            const companyId = data.readUInt16LE(0);
            if (companyId === WACOM_COMPANY_ID_COLUMBIA ||
                companyId === WACOM_COMPANY_ID_WACOM ||
                companyId === WACOM_COMPANY_ID_BM) {
              isWacom = true;
              // During registration, manufacturer data is typically 4 bytes
              if (data.length === 4) {
                isRegistrationMode = true;
              }
            }
          }
        }
        
        // Also check device name patterns (useful when manufacturer data is missing)
        if (!isWacom && deviceName) {
          for (const pattern of WACOM_NAME_PATTERNS) {
            if (pattern.test(deviceName)) {
              isWacom = true;
              // If no manufacturer data but name matches, might be in registration mode
              if (!advData) {
                isRegistrationMode = true;
              }
              break;
            }
          }
        }
        
        // Also check if device is already registered (by UUID/address)
        if (!isWacom) {
          const normalizedAddress = config.normalizeAddress(address);
          const savedDevice = config.getDevice(normalizedAddress);
          if (savedDevice) {
            isWacom = true;
          }
        }

        if (isWacom) {
          const normalizedAddress = config.normalizeAddress(address);
          const deviceInfo = {
            id: peripheral.uuid,
            address: normalizedAddress,
            name: deviceName || 'Wacom Device',
            peripheral: peripheral,
            registered: config.getDevice(normalizedAddress) !== null,
            registrationMode: isRegistrationMode
          };
          foundDevices.push(deviceInfo);
          const status = deviceInfo.registered ? '[registered]' : '[unregistered]';
          const mode = isRegistrationMode ? ' [registration mode]' : '';
          // Display address in a more readable format
          const displayAddress = normalizedAddress.length === 32 
            ? normalizedAddress.match(/.{1,8}/g).join('-') 
            : normalizedAddress.match(/.{1,2}/g).join(':');
          console.log(`✓ Found Wacom device: ${deviceInfo.name} ${status}${mode} (${displayAddress})`);
          
          // Stop scanning and connect immediately when we find a device
          if (!scanningStopped) {
            setTimeout(() => stopScanningAndConnect(), 500); // Small delay to allow other devices to be discovered
          }
        }
      });

      // Timeout fallback - if no device found within timeout, stop scanning
      setTimeout(async () => {
        if (!scanningStopped) {
          await stopScanningAndConnect();
        }
      }, timeout);
    });
  }

  async useSavedUUID(uuid) {
    // Connect using saved UUID (not registration mode)
    // For Slate devices, authentication might not be required after BLE connection
    // or "no response" might be acceptable
    console.log('Authenticating with saved UUID...');
    try {
      // Allow no response for Slate devices - they might not reply to CONNECT when already connected
      const result = await this.protocol.connect(uuid, false, true);
      if (result.success) {
        console.log('✓ Authenticated with saved UUID');
        return true;
      } else {
        throw new Error('Authentication failed');
      }
    } catch (error) {
      if (error.message.includes('No response')) {
        // For Slate devices, no response might be okay - device is already connected via BLE
        console.log('Note: Device did not respond to authentication (this may be normal)');
        console.log('Proceeding with download...');
        return true;
      }
      if (error.message.includes('invalid state') || error.message.includes('Authorization failed')) {
        console.warn('\nAuthentication failed. Possible reasons:');
        console.warn('1. Device may need a brief button press to wake up');
        console.warn('2. Device registration may have changed');
        console.warn('3. Device may be in use by another application');
        throw new Error('Could not authenticate. Try pressing the device button briefly, then run again.');
      }
      throw error;
    }
  }

  async connect(peripheral) {
    this.peripheral = peripheral;
    
    return new Promise((resolve, reject) => {
      let connectionTimeout;
      let resolved = false;
      
      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        resolved = true;
      };
      
      peripheral.once('connect', async () => {
        if (resolved) return;
        cleanup();
        console.log('Connected, discovering services...');
        try {
          await this.discoverServices(peripheral);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      peripheral.once('disconnect', () => {
        if (!resolved) {
          console.log('Device disconnected');
        }
      });

      // Add timeout for connection
      connectionTimeout = setTimeout(() => {
        if (!resolved && peripheral.state !== 'connected') {
          cleanup();
          peripheral.removeAllListeners('connect');
          peripheral.removeAllListeners('disconnect');
          reject(new Error('Connection timeout - device may need a button press to wake up. Try pressing the button briefly, then run again.'));
        }
      }, 15000);

      peripheral.connect((error) => {
        if (error) {
          cleanup();
          console.error(`BLE connection error: ${error.message}`);
          reject(error);
        }
      });
    });
  }

  async discoverServices(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
        if (error) {
          reject(error);
          return;
        }

        // Find the characteristics we need
        for (const char of characteristics) {
          const uuid = char.uuid.toLowerCase();
          
          if (uuid === CHARACTERISTIC_COMMAND_WRITE) {
            this.commandChar = char;
          } else if (uuid === CHARACTERISTIC_COMMAND_NOTIFY) {
            this.commandNotifyChar = char;
          } else if (uuid === CHARACTERISTIC_FILE_TRANSFER_NOTIFY) {
            this.fileTransferChar = char;
          } else if (uuid === CHARACTERISTIC_EVENTS_NOTIFY) {
            this.eventsChar = char;
          }
        }

        if (!this.commandChar || !this.commandNotifyChar || !this.fileTransferChar) {
          reject(new Error('Required characteristics not found'));
          return;
        }

        // Initialize protocol (protocol version will be determined during registration)
        this.protocol = new WacomProtocol({
          sendCommand: (data) => this.sendCommand(data),
          waitForReply: (opcode) => this.waitForReply(opcode),
          getFileTransferBuffer: () => this.fileTransferBuffer, // Use getter to always get current buffer
          fileTransferComplete: () => this.fileTransferComplete,
          setFileTransferComplete: (val) => { this.fileTransferComplete = val; },
          clearFileTransferBuffer: () => { this.fileTransferBuffer = []; }
        });

        // Setup notifications
        this.setupCommandNotify(this.commandNotifyChar);
        this.setupFileTransferNotify(this.fileTransferChar);
        if (this.eventsChar) {
          this.setupEventsNotify(this.eventsChar);
        }

        // Enable notifications
        const enableNotifications = async () => {
          try {
            await this.enableNotification(this.commandNotifyChar);
            await this.enableNotification(this.fileTransferChar);
            if (this.eventsChar) {
              await this.enableNotification(this.eventsChar);
            }
            console.log('Services discovered and notifications enabled');
            
            // Don't authenticate here - we'll do it in downloadAllNotes after protocol is ready
            // Authentication needs to happen right before we start downloading
            
            resolve();
          } catch (err) {
            reject(err);
          }
        };

        enableNotifications();
      });
    });
  }

  async enableNotification(characteristic) {
    return new Promise((resolve, reject) => {
      characteristic.subscribe((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  setupCommandNotify(characteristic) {
    characteristic.on('data', (data, isNotification) => {
      this.handleCommandResponse(data);
    });
  }

  setupFileTransferNotify(characteristic) {
    characteristic.on('data', (data, isNotification) => {
      this.handleFileTransferData(data);
    });
  }

  setupEventsNotify(characteristic) {
    characteristic.on('data', (data, isNotification) => {
      // Handle events if needed
    });
  }

  async sendCommand(data) {
    return new Promise((resolve, reject) => {
      this.commandChar.write(Buffer.from(data), false, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async waitForReply(expectedOpcode, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Check if there's already a pending reply for this opcode
      if (this.pendingReplies.has(expectedOpcode)) {
        reject(new Error(`Already waiting for reply with opcode 0x${expectedOpcode.toString(16)}`));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingReplies.delete(expectedOpcode);
        reject(new Error(`Timeout waiting for reply with opcode 0x${expectedOpcode.toString(16)}`));
      }, timeout);

      this.pendingReplies.set(expectedOpcode, (data) => {
        clearTimeout(timer);
        this.pendingReplies.delete(expectedOpcode);
        resolve(data);
      });
    });
  }

  handleCommandResponse(data) {
    if (data.length < 1) return;
    
    const buffer = Buffer.from(data);
    const opcode = buffer[0];
    
    // Handle file transfer notifications specially
    // Format: [0xc8, length, data...]
    // For 0xc8 0xbe: [0xc8, 0x01, 0xbe] - file transfer started
    // For 0xc8 0xed: [0xc8, 0x01, 0xed] - file transfer ended
    if (opcode === 0xc8 && buffer.length > 2) {
      const dataByte = buffer[2]; // Data is at index 2 (after opcode and length)
      if (dataByte === 0xbe) {
        // File transfer started - clear buffer
        this.fileTransferBuffer = [];
        this.fileTransferComplete = false;
        // Still notify any waiting handlers
        const handler = this.pendingReplies.get(opcode);
        if (handler) handler(buffer);
        return;
      } else if (dataByte === 0xed) {
        // File transfer ended - notify waiting handlers
        this.fileTransferComplete = true;
        const handler = this.pendingReplies.get(opcode);
        if (handler) handler(buffer);
        return;
      }
    }
    
    // Handle other responses
    const handler = this.pendingReplies.get(opcode);
    if (handler) {
      handler(buffer);
    }
  }

  handleFileTransferData(data) {
    // Accumulate file transfer data
    const buffer = Buffer.from(data);
    for (let i = 0; i < buffer.length; i++) {
      this.fileTransferBuffer.push(buffer[i]);
    }
    if (this.verbose) {
      console.log(`Received ${buffer.length} bytes of file transfer data (total: ${this.fileTransferBuffer.length} bytes)`);
    }
  }

  async downloadAllNotes(outputDir) {
    const notes = [];
    this.outputDir = outputDir;
    
    try {
      // Following tuhi's retrieve_data flow exactly:
      // 1. check_connection (authenticate with UUID) - MUST be first
      // 2. set_time
      // 3. select_transfer_gatt (before set_paper_mode)
      // 4. set_paper_mode (inside read_offline_data)
      
      // Step 1: Check connection / authenticate with UUID
      // This must be done AFTER services are discovered and protocol is initialized
      if (this.deviceInfo && this.deviceInfo.registered) {
        const savedConfig = config.getDevice(this.deviceInfo.address);
        if (savedConfig && savedConfig.uuid) {
          console.log('Authenticating with device...');
          try {
            await this.useSavedUUID(savedConfig.uuid);
            console.log('✓ Authentication successful');
          } catch (error) {
            console.error('✗ Authentication failed:', error.message);
            throw error;
          }
        } else {
          throw new Error('Device registration not found in config');
        }
      } else {
        throw new Error('Device is not registered');
      }
      
      console.log('Preparing device for file transfer...');
      
      // Following tuhi's retrieve_data flow:
      // 1. check_connection (done above)
      // 2. set_time (optional, can fail)
      // 3. select_transfer_gatt (optional, can fail)  
      // 4. read_offline_data which does:
      //    - set_paper_mode
      //    - count_available_files
      //    - download files
      
      // Step 2: Set device time (optional - can fail without breaking download)
      try {
        await this.protocol.setTime();
        console.log('✓ Device time synchronized');
      } catch (error) {
        console.log(`Note: Could not set device time: ${error.message} (this is usually okay)`);
      }
      
      // Step 3: Select transfer GATT (optional - can fail without breaking download)
      // Note: In tuhi, this is called in retrieve_data before read_offline_data
      try {
        await this.protocol.selectTransferGatt();
        console.log('✓ File transfer GATT configured');
      } catch (error) {
        console.log(`Note: Could not configure transfer GATT: ${error.message} (this is usually okay)`);
      }
      
      // Step 4: Set paper mode and get file count
      // In tuhi's read_offline_data, set_paper_mode is called first, then count_available_files
      console.log('Setting device to paper mode...');
      try {
        await this.protocol.setPaperMode();
        console.log('✓ Device set to paper mode');
      } catch (error) {
        if (error.message.includes('invalid state')) {
          console.error('\nDevice is in invalid state (error 0x2).');
          console.error('This usually means the device has no data to download.');
          console.error('Make sure you have notes on the device, then try again.');
          throw new Error('Device has no data or is not ready for download');
        }
        throw error;
      }
      
      // Get file count
      const fileCount = await this.protocol.getFilesCount();
      console.log(`Found ${fileCount} note(s) on device`);
      
      if (fileCount === 0) {
        console.log('No notes found on device.');
        return [];
      }

      // Download each file
      for (let i = 0; i < fileCount; i++) {
        console.log(`Downloading note ${i + 1}/${fileCount}...`);
        
        // Get file info (timestamp and stroke count)
        const fileInfo = await this.protocol.getOldestFileInfo();
        console.log(`  File info: ${fileInfo.count} strokes, timestamp: ${fileInfo.timestamp ? new Date(fileInfo.timestamp * 1000).toISOString() : 'N/A'}`);
        
        // Download the file
        const strokeData = await this.protocol.getOldestFile();
        console.log(`  Downloaded ${strokeData.length} bytes of raw data`);
        
        // Log a hash of first 50 bytes to verify files are different
        const hashBytes = strokeData.slice(0, Math.min(50, strokeData.length));
        const hash = hashBytes.reduce((sum, b) => sum + b, 0).toString(16);
        console.log(`  Data hash (first 50 bytes sum): 0x${hash}`);
        
        // Delete the file from device IMMEDIATELY after download (before parsing)
        // This ensures we get the next file on the next iteration
        await this.protocol.deleteOldestFile();
        
        // Verify deletion worked by checking file count decreased
        const newFileCount = await this.protocol.getFilesCount();
        console.log(`  File count after deletion: ${newFileCount} (was ${fileCount - i})`);
        
        // Add a small delay to ensure deletion completes
        await new Promise(resolve => setTimeout(resolve, 200));
        
        if (strokeData && strokeData.length > 0) {
          try {
            // Log first few bytes to verify we're getting different data
            const firstBytes = strokeData.slice(0, Math.min(20, strokeData.length))
              .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
            console.log(`  First bytes: ${firstBytes}...`);
            
            // Parse strokes
            const parser = new StrokeParser();
            const drawing = parser.parse(strokeData, fileInfo.timestamp);
            
            if (!drawing || !drawing.strokes || drawing.strokes.length === 0) {
              console.warn(`Note ${i + 1}: Parsed but no strokes found`);
              continue;
            }
            
            // Log parsed stroke info and sample coordinates
            const totalPoints = drawing.strokes.reduce((sum, s) => sum + s.length, 0);
            const firstPoint = drawing.strokes[0] && drawing.strokes[0][0];
            const lastPoint = drawing.strokes[drawing.strokes.length - 1] && 
              drawing.strokes[drawing.strokes.length - 1][drawing.strokes[drawing.strokes.length - 1].length - 1];
            console.log(`  Parsed: ${drawing.strokes.length} stroke(s), ${totalPoints} point(s)`);
            if (firstPoint) {
              console.log(`  First point: x=${firstPoint.x.toFixed(2)}, y=${firstPoint.y.toFixed(2)}, p=${firstPoint.p}`);
            }
            if (lastPoint) {
              console.log(`  Last point: x=${lastPoint.x.toFixed(2)}, y=${lastPoint.y.toFixed(2)}, p=${lastPoint.p}`);
            }
            
            // Convert to SVG
            const converter = new SVGConverter();
            const svg = converter.convert(drawing);
            
            // Save immediately
            const timestamp = fileInfo.timestamp 
              ? new Date(fileInfo.timestamp * 1000).toISOString().replace(/[:.]/g, '-').slice(0, -5)
              : `note-${i + 1}`;
            const filename = path.join(this.outputDir, `${timestamp}.svg`);
            
            fs.writeFileSync(filename, svg);
            console.log(`✓ Note ${i + 1} saved: ${filename} (${drawing.strokes.length} stroke(s), ${strokeData.length} bytes)`);
            
            notes.push({
              timestamp: fileInfo.timestamp,
              svg: svg,
              filename: filename
            });
          } catch (parseError) {
            console.error(`Error parsing note ${i + 1}:`, parseError.message);
            continue;
          }
        } else {
          console.warn(`Note ${i + 1}: No data received`);
        }
      }
    } catch (error) {
      console.error('Error downloading notes:', error);
      throw error;
    }

    return notes;
  }

  async registerDevice() {
    if (!this.deviceInfo) {
      throw new Error('No device connected');
    }

    const address = config.normalizeAddress(this.deviceInfo.address);
    
    // Check if device is already registered
    const existingConfig = config.getDevice(address);
    if (existingConfig) {
      console.log(`Device ${address} is already registered with UUID: ${existingConfig.uuid}`);
      return existingConfig;
    }

    console.log('\nStarting device registration...');
    console.log('Make sure the device LED is blinking (hold button for 6+ seconds)');

    // Generate UUID
    const uuid = UUIDGenerator.generate();
    console.log(`Generated UUID: ${uuid}`);

    // Try to detect device type by checking characteristics
    const isSpark = !this.eventsChar; // Spark doesn't have events characteristic
    
    let protocolVersion = 'SPARK';
    
    try {
      if (isSpark) {
        // Spark registration flow
        console.log('\nDetected Spark device');
        const connectResult = await this.protocol.connect(uuid, true);
        // Spark may return needsRegistration, which is expected during registration
        
        console.log('\nPress the button on the device now to confirm registration...');
        await this.protocol.registerPressButton(null); // No UUID for Spark
        
        const waitResult = await this.protocol.registerWaitForButton(15000);
        // For Spark, protocolVersion from waitResult should be 'SPARK'
        protocolVersion = waitResult.protocolVersion || 'SPARK';
      } else {
        // Slate/Intuos registration flow
        console.log('\nDetected Slate/Intuos device');
        const connectResult = await this.protocol.connect(uuid, true);
        // Should succeed for Slate/Intuos
        
        console.log('\nPress the button on the device now to confirm registration...');
        await this.protocol.registerPressButton(uuid);
        
        const waitResult = await this.protocol.registerWaitForButton(15000);
        // Check if it's Intuos Pro (0x53 reply) or Slate (0xe4 reply)
        // But we already know it's not Spark (has eventsChar), so use waitResult or default to SLATE
        if (waitResult.protocolVersion === 'INTUOS_PRO') {
          protocolVersion = 'INTUOS_PRO';
        } else {
          protocolVersion = 'SLATE'; // Default to SLATE if not Intuos Pro
        }
      }

      console.log('\nButton pressed! Completing registration...');
      
      // For Slate/Intuos devices, registerComplete is a NOOP, so we skip it
      // For Spark devices, we need to call registerComplete
      if (isSpark) {
        // Spark devices need registerComplete
        await this.protocol.registerComplete();
      } else {
        // For Slate/Intuos, do the finish steps instead (registerComplete is NOOP)
        console.log('Finalizing registration...');
        try {
          await this.protocol.setTime();
        } catch (error) {
          console.log('Warning: Could not set device time (this is usually okay)');
        }
        try {
          await this.protocol.readTime();
        } catch (error) {
          // readTime failure is already handled in the method
        }
        try {
          await this.protocol.selectTransferGatt();
        } catch (error) {
          console.log('Warning: Could not set transfer GATT (this is usually okay)');
        }
      }
      
      // Save configuration
      config.registerDevice(address, uuid, protocolVersion);
      console.log(`\nDevice registered successfully!`);
      console.log(`  Address: ${address}`);
      console.log(`  UUID: ${uuid}`);
      console.log(`  Protocol: ${protocolVersion}`);
      
      return {
        address: address,
        uuid: uuid,
        protocol: protocolVersion
      };
    } catch (error) {
      console.error('\nRegistration failed:', error.message);
      throw error;
    }
  }

  async disconnect() {
    if (this.peripheral) {
      this.peripheral.disconnect();
    }
  }
}

module.exports = WacomBLE;

