// UUID generator for Wacom device registration
// Generates a 6-byte (12 hex character) UUID

import crypto from 'crypto';

class UUIDGenerator {
  static generate() {
    // Generate 6 random bytes
    const bytes = crypto.randomBytes(6);
    // Convert to hex string (12 characters)
    return bytes.toString('hex').toUpperCase();
  }

  static validate(uuid) {
    // UUID must be 12 hex characters
    return /^[0-9A-F]{12}$/i.test(uuid);
  }

  static toBytes(uuid) {
    if (!this.validate(uuid)) {
      throw new Error(`Invalid UUID format: ${uuid}`);
    }
    // Convert hex string to array of bytes
    const bytes = [];
    for (let i = 0; i < uuid.length; i += 2) {
      bytes.push(parseInt(uuid.substring(i, i + 2), 16));
    }
    return bytes;
  }
}

export default UUIDGenerator;

