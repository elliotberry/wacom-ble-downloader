// Wacom BLE Protocol Implementation
// Based on tuhi's protocol.py
import logger from './logger.js';

class WacomProtocol {
  constructor(transport) {
    this.transport = transport;
  }

  // Create NordicData format: [opcode, length, ...data]
  createMessage(opcode, data = []) {
    return [opcode, data.length, ...data];
  }

  // Parse NordicData format
  parseMessage(data) {
    if (data.length < 2) {
      throw new Error('Invalid message format');
    }
    const opcode = data[0];
    const length = data[1];
    const payload = data.slice(2, 2 + length);
    return {opcode, length, payload};
  }

  async setPaperMode() {
    // Set mode to PAPER (0x01) - separate from transfer GATT setup
    const msg = this.createMessage(0xb1, [0x01]);
    await this.transport.sendCommand(msg);
    const reply = await this.transport.waitForReply(0xb3, 5000);

    if (reply.length > 2 && reply[2] !== 0x00) {
      const errorCode = reply[2];
      if (errorCode === 0x02) {
        throw new Error('Device in invalid state - make sure the LED is blue (data ready) and press the button to switch to green (ready)');
      }
      throw new Error(`Failed to set paper mode: error code 0x${errorCode.toString(16)}`);
    }
  }

  async switchToFileTransferMode() {
    // This method is kept for compatibility but the flow is now:
    // 1. selectTransferGatt() - called first
    // 2. setPaperMode() - called second
    // This matches tuhi's retrieve_data flow
    await this.setPaperMode();
  }

  async getFilesCount() {
    // Request format: [0xc1, 0x01, 0x00] - opcode, length=1, data=[0x00]
    const msg = this.createMessage(0xc1, [0x00]);
    await this.transport.sendCommand(msg);
    const reply = await this.transport.waitForReply(0xc2, 5000);

    // Reply format: [0xc2, 0x02, count_low, count_high]
    // For Slate devices, count is little-endian 16-bit
    if (reply.length < 4) {
      throw new Error(`Invalid reply length for file count: ${reply.length}`);
    }
    const count = reply[2] | (reply[3] << 8);
    return count;
  }

  async getOldestFileInfo() {
    // Get stroke data info (count and timestamp)
    // Request format: [0xc5, 0x01, 0x00] - opcode, length=1, data=[0x00]
    const msg = this.createMessage(0xc5, [0x00]);
    await this.transport.sendCommand(msg);

    let count = 0;
    let timestamp = null;

    // May receive multiple replies: 0xc7 (count) and 0xcd (timestamp)
    // For Spark/Slate: count is big-endian 32-bit, timestamp is 6 bytes as hex
    try {
      const reply1 = await this.transport.waitForReply(0xc7, 2000);
      // Reply format: [0xc7, 0x04, byte0, byte1, byte2, byte3]
      // Count is big-endian 32-bit
      if (reply1.length >= 6) {
        count = (reply1[2] << 24) | (reply1[3] << 16) | (reply1[4] << 8) | reply1[5];
      }
    } catch (e) {
      // Count reply may be missing for some devices
    }

    try {
      const reply2 = await this.transport.waitForReply(0xcd, 2000);
      // Reply format: [0xcd, 0x06, byte0...byte5]
      // Timestamp: YYMMDDHHmmss format (6 bytes as hex)
      if (reply2.length >= 8) {
        const timestampBytes = reply2.slice(2, 8);
        const timestampStr = timestampBytes.map(b => b.toString(16).padStart(2, '0')).join('');
        const year = 2000 + parseInt(timestampStr.substring(0, 2), 16);
        const month = parseInt(timestampStr.substring(2, 4), 16) - 1; // JS months are 0-indexed
        const day = parseInt(timestampStr.substring(4, 6), 16);
        const hour = parseInt(timestampStr.substring(6, 8), 16);
        const minute = parseInt(timestampStr.substring(8, 10), 16);
        const second = parseInt(timestampStr.substring(10, 12), 16);
        timestamp = Math.floor(new Date(Date.UTC(year, month, day, hour, minute, second)).getTime() / 1000);
      }
    } catch (e) {
      // Timestamp may be missing, use current time
      timestamp = Math.floor(Date.now() / 1000);
    }

    return {count, timestamp};
  }

  async getOldestFile() {
    // Clear buffer and reset completion flag
    this.transport.clearFileTransferBuffer();
    this.transport.setFileTransferComplete(false);

    // Start downloading oldest file
    // Request format: [0xc3, 0x01, 0x00] - opcode, length=1, data=[0x00]
    const startMsg = this.createMessage(0xc3, [0x00]);
    await this.transport.sendCommand(startMsg);

    // Wait for file transfer start (0xc8 0x01 0xbe)
    // Format: [opcode, length, data]
    const startReply = await this.transport.waitForReply(0xc8, 5000);
    if (startReply.length < 3 || startReply[2] !== 0xbe) {
      throw new Error(
        `Unexpected file transfer start response: ${Array.from(startReply)
          .map(b => `0x${b.toString(16)}`)
          .join(' ')}`,
      );
    }

    // Wait for file transfer end (0xc8 0x01 0xed)
    // File data comes through FILE_TRANSFER_NOTIFY characteristic
    // The end notification comes through COMMAND_NOTIFY as 0xc8 0xed
    const endReply = await this.transport.waitForReply(0xc8, 30000);
    if (endReply.length < 3 || endReply[2] !== 0xed) {
      throw new Error(
        `Unexpected file transfer end response: ${Array.from(endReply)
          .map(b => `0x${b.toString(16)}`)
          .join(' ')}`,
      );
    }

    // Small delay to ensure all file transfer data has been received
    // File transfer data comes asynchronously through notifications
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get the accumulated file data - make a copy immediately
    // Use getter function to ensure we get the current buffer
    const buffer = this.transport.getFileTransferBuffer ? this.transport.getFileTransferBuffer() : this.transport.fileTransferBuffer;
    const fileData = Array.from(buffer); // Create a copy before clearing
   // logger.detail(`Received ${fileData.length} bytes of file data (buffer had ${buffer.length} bytes)`);

    if (fileData.length === 0) {
      logger.warn('No file data received!');
      logger.warn(`Buffer state: length=${buffer.length}, complete=${this.transport.fileTransferComplete}`);
    } else if (fileData.length < 20) {
      logger.warn(
        `File data seems too small (${fileData.length} bytes). First bytes: ${fileData
          .slice(0, Math.min(20, fileData.length))
          .map(b => `0x${b.toString(16).padStart(2, '0')}`)
          .join(' ')}`,
      );
    }

    // Clear buffer after we've copied the data
    this.transport.clearFileTransferBuffer();
    this.transport.setFileTransferComplete(false);
    logger.success(`Downloaded file (${fileData.length} bytes)`);
    return fileData;
  }

  async deleteOldestFile() {
    // Delete command format: [0xca, 0x01, 0x00] - opcode, length=1, data=[0x00]
    const msg = this.createMessage(0xca, [0x00]);
    await this.transport.sendCommand(msg);
    // For Slate/Intuos devices, deletion uses the default 0xb3 handler
    // Wait for 0xb3 reply with data byte 0x00 (success) or non-zero (error)
    try {
      const reply = await this.transport.waitForReply(0xb3, 2000);
      if (reply.length < 3 || reply[2] !== 0x00) {
        const errorCode = reply.length > 2 ? reply[2] : reply[1];
        // Error code 0x1 = GENERAL_ERROR, might be okay to continue
        // Error code 0x2 = INVALID_STATE, might mean file already deleted
        if (errorCode === 0x1) {
          logger.warn('Delete returned GENERAL_ERROR (0x1) - file may already be deleted');
          return; // Continue anyway
        } else if (errorCode === 0x2) {
          logger.warn('Delete returned INVALID_STATE (0x2) - file may already be deleted');
          return; // Continue anyway
        }
        throw new Error(`Delete failed with error code: 0x${errorCode.toString(16)}`);
      }
      // Success
    } catch (e) {
      // If no reply, that's okay for Spark devices (requires_reply = False)
      // But for Slate, we should get a reply
      if (e.message.includes('timeout') || e.message.includes('No response')) {
        // Spark devices don't require a reply, so timeout is okay
        logger.note('No reply to delete command (normal for Spark devices)');
      } else {
        throw e;
      }
    }
  }

  // Registration methods
  async connect(uuid, isRegistration = false, allowNoResponse = false) {
    // Convert UUID string to bytes
    const uuidBytes = [];
    for (let i = 0; i < uuid.length; i += 2) {
      uuidBytes.push(parseInt(uuid.substring(i, i + 2), 16));
    }

    const msg = this.createMessage(0xe6, uuidBytes);
    await this.transport.sendCommand(msg);

    // Wait for reply - may be 0x50 (success), 0x51 (error), or 0xb3 (error)
    try {
      const reply = await this.transport.waitForReply(0x50, 2000);
      return {success: true};
    } catch (e) {
      // Try other opcodes
      try {
        const reply = await this.transport.waitForReply(0x51, 2000);
        const reason = reply.length > 2 ? reply[2] : reply[1];
        if (reason === 0x00 || reason === 0x03) {
          throw new Error('Device in invalid state');
        } else if (reason === 0x01 || reason === 0x02) {
          if (isRegistration) {
            // During registration, this might be expected
            return {success: false, needsRegistration: true};
          }
          throw new Error('Authorization failed - wrong UUID. Device may need re-registration.');
        }
        throw new Error(`Connection failed: 0x${reason.toString(16)}`);
      } catch (e2) {
        // Check for 0xb3 error response
        try {
          const reply = await this.transport.waitForReply(0xb3, 2000);
          if (reply.length > 2 && reply[2] !== 0x00) {
            if (reply[2] === 0x01) {
              // General error on Spark means authorization failed
              if (isRegistration) {
                return {success: false, needsRegistration: true};
              }
              throw new Error('Authorization failed - wrong UUID. Device may need re-registration.');
            }
            throw new Error(`Device error: 0x${reply[2].toString(16)}`);
          }
          // Success (0xb3 0x00)
          return {success: true};
        } catch (e3) {
          // For Slate devices in download mode, no response might be okay
          // The device is already connected via BLE, so authentication might not be needed
          if (allowNoResponse) {
            // logger.note('No response to CONNECT command (this may be normal for Slate devices)');
            return {success: true};
          }
          if (isRegistration) {
            // During registration, no reply might be expected for Spark
            return {success: false, needsRegistration: true};
          }
          throw new Error('No response from device');
        }
      }
    }
  }

  async registerPressButton(uuid = null) {
    // For Spark: opcode 0xe3, no UUID
    // For Slate/Intuos: opcode 0xe7, with UUID
    if (uuid === null) {
      // Spark protocol
      const msg = this.createMessage(0xe3, [0x01]);
      await this.transport.sendCommand(msg);
      // Doesn't require reply
    } else {
      // Slate/Intuos protocol
      const uuidBytes = [];
      for (let i = 0; i < uuid.length; i += 2) {
        uuidBytes.push(parseInt(uuid.substring(i, i + 2), 16));
      }
      const msg = this.createMessage(0xe7, uuidBytes);
      await this.transport.sendCommand(msg);
      // Doesn't require reply
    }
  }

  async registerWaitForButton(timeout = 10000) {
    // Wait for button press confirmation
    // Spark: 0xe4
    // Slate: 0xe4
    // Intuos Pro: 0x53
    try {
      const reply = await this.transport.waitForReply(0xe4, timeout);
      return {protocolVersion: 'SPARK'}; // or 'SLATE'
    } catch (e) {
      try {
        const reply = await this.transport.waitForReply(0x53, timeout);
        return {protocolVersion: 'INTUOS_PRO'};
      } catch (e2) {
        throw new Error('Timeout waiting for button press');
      }
    }
  }

  async registerComplete() {
    const msg = this.createMessage(0xe5, []);
    await this.transport.sendCommand(msg);
    const reply = await this.transport.waitForReply(0xb3, 5000);
    if (reply.length > 2 && reply[2] !== 0x00) {
      throw new Error(`Registration complete failed: 0x${reply[2].toString(16)}`);
    }
  }

  async setTime() {
    const now = Math.floor(Date.now() / 1000);
    // Format as YYMMDDHHmmss (6 bytes as hex)
    const date = new Date(now * 1000);
    const year = date.getUTCFullYear() % 100;
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();

    const timeStr = [year.toString().padStart(2, '0'), month.toString().padStart(2, '0'), day.toString().padStart(2, '0'), hour.toString().padStart(2, '0'), minute.toString().padStart(2, '0'), second.toString().padStart(2, '0')].join('');

    // Convert hex string to bytes
    const timeBytes = [];
    for (let i = 0; i < timeStr.length; i += 2) {
      timeBytes.push(parseInt(timeStr.substring(i, i + 2), 16));
    }

    const msg = this.createMessage(0xb6, timeBytes);
    await this.transport.sendCommand(msg);
    try {
      const reply = await this.transport.waitForReply(0xb3, 5000);
      if (reply.length > 2 && reply[2] !== 0x00) {
        const errorCode = reply[2];
        if (errorCode === 0x02) {
          throw new Error('Device in invalid state - cannot set time');
        }
        throw new Error(`Set time failed: 0x${errorCode.toString(16)}`);
      }
    } catch (error) {
      if (error.message.includes('Timeout')) {
        throw new Error('Timeout setting device time - device may not be ready');
      }
      throw error;
    }
  }

  async readTime() {
    // GET_TIME uses same opcode 0xb6 but expects reply 0xbd
    // For Slate, we just need to read it, don't need to parse
    const msg = this.createMessage(0xb6, []);
    await this.transport.sendCommand(msg);
    try {
      const reply = await this.transport.waitForReply(0xbd, 5000);
      // Time is in reply payload, but we don't need to parse it for registration
      return reply;
    } catch (error) {
      // If readTime fails, it's not critical for registration
      logger.warn('Could not read device time (this is usually okay)');
      return null;
    }
  }

  async selectTransferGatt() {
    // Same as switchToFileTransferMode but just the reporting type part
    const setReportMsg = this.createMessage(0xec, [0x06, 0x00, 0x00, 0x00, 0x00, 0x00]);
    await this.transport.sendCommand(setReportMsg);
    try {
      const setReportReply = await this.transport.waitForReply(0xb3, 5000);
      if (setReportReply.length > 2 && setReportReply[2] !== 0x00) {
        const errorCode = setReportReply[2];
        if (errorCode === 0x02) {
          throw new Error('Device in invalid state - cannot configure transfer GATT');
        }
        throw new Error(`Set file transfer reporting type failed: 0x${errorCode.toString(16)}`);
      }
    } catch (error) {
      if (error.message.includes('Timeout')) {
        throw new Error('Timeout configuring transfer GATT - device may not be ready');
      }
      throw error;
    }
  }
}

export default WacomProtocol;
