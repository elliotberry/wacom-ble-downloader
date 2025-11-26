// Stroke File Parser
// Based on tuhi's protocol.py StrokeFile implementation

class StrokeParser {
  constructor() {
    // Device dimensions (Spark/Slate defaults)
    this.width = 21000;
    this.height = 14800;
    this.pressure = 1023;
    this.pointSize = 10;
  }

  parse(data, timestamp) {
    if (!data || data.length < 4) {
      throw new Error('Invalid stroke data');
    }

    // Parse file header
    const header = this.parseFileHeader(data);
    let offset = header.size;
    
    // Parse strokes
    const strokes = this.parseStrokes(data.slice(offset));
    
    // Create drawing object
    return {
      timestamp: timestamp || header.timestamp || Math.floor(Date.now() / 1000),
      dimensions: [this.width * this.pointSize, this.height * this.pointSize],
      strokes: strokes
    };
  }

  parseFileHeader(data) {
    // Check file format signature - compare bytes directly
    // Spark/Slate format: [0x62, 0x38, 0x62, 0x74] = 'b8bt'
    // Intuos Pro format: [0x67, 0x82, 0x69, 0x65] = 'gieb'
    if (data.length < 4) {
      throw new Error('File data too short for header');
    }
    
    const sigBytes = [data[0], data[1], data[2], data[3]];
    const sparkSig = [0x62, 0x38, 0x62, 0x74];
    const intuosSig = [0x67, 0x82, 0x69, 0x65];
    
    const isSpark = sigBytes.every((b, i) => b === sparkSig[i]);
    const isIntuos = sigBytes.every((b, i) => b === intuosSig[i]);
    
    if (isSpark) {
      // Spark/Slate format - 4 byte header, no timestamp in header
      return { size: 4, timestamp: null };
    } else if (isIntuos) {
      // Intuos Pro format has timestamp and stroke count (16 bytes total)
      if (data.length < 16) {
        throw new Error('Intuos Pro format requires at least 16 bytes for header');
      }
      // Timestamp is little-endian 32-bit at offset 4
      const timestamp = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
      // Stroke count is little-endian 32-bit at offset 10
      const strokeCount = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
      return { size: 16, timestamp, strokeCount };
    } else {
      // Show hex representation for debugging
      const sigHex = sigBytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
      throw new Error(`Unknown file format: [${sigHex}] (expected [0x62 0x38 0x62 0x74] or [0x67 0x82 0x69 0x65])`);
    }
  }

  parseStrokes(data) {
    const strokes = [];
    let currentStroke = [];
    let lastPoint = { x: 0, y: 0, p: 0 };
    let lastDelta = { x: 0, y: 0, p: 0 };
    let offset = 0;

    while (offset < data.length) {
      const packetType = this.identifyPacketType(data.slice(offset));
      
      if (packetType === 'EOF') {
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
        }
        break;
      } else if (packetType === 'STROKE_END') {
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
          currentStroke = [];
        }
        offset += this.getStrokeEndSize(data.slice(offset));
        // Reset deltas after stroke end (as tuhi does)
        lastDelta = { x: 0, y: 0, p: 0 };
        // Note: tuhi does NOT reset last_point after stroke end
      } else if (packetType === 'STROKE_HEADER') {
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
          currentStroke = [];
        }
        // Only reset delta, NOT lastPoint (as tuhi does)
        // The first point after STROKE_HEADER should be a POINT packet with absolute coordinates
        lastDelta = { x: 0, y: 0, p: 0 };
        offset += this.getStrokeHeaderSize(data.slice(offset));
      } else if (packetType === 'POINT' || packetType === 'DELTA') {
        const result = this.parsePoint(data.slice(offset), lastPoint, lastDelta);
        // result contains { x, y, p, dx, dy, dp }
        // Following tuhi's logic exactly from _parse_data:
        // Start with previous cumulative deltas and absolute coordinates
        let dx = lastDelta.x;
        let dy = lastDelta.y;
        let dp = lastDelta.p;
        let x = lastPoint.x;
        let y = lastPoint.y;
        let p = lastPoint.p;
        
        // Update cumulative deltas OR set absolute coordinates
        if (result.dx !== undefined) {
          // Delta: add to cumulative delta
          dx += result.dx;
        } else if (result.x !== undefined) {
          // Absolute coordinate: set it and reset delta
          x = result.x;
          dx = 0;
        }
        
        if (result.dy !== undefined) {
          // Delta: add to cumulative delta
          dy += result.dy;
        } else if (result.y !== undefined) {
          // Absolute coordinate: set it and reset delta
          y = result.y;
          dy = 0;
        }
        
        if (result.dp !== undefined) {
          // Delta: add to cumulative delta
          dp += result.dp;
        } else if (result.p !== undefined) {
          // Absolute coordinate: set it and reset delta
          p = result.p;
          dp = 0;
        }
        
        // dx,dy,dp are cumulative deltas for this packet
        // x,y,p are most recent known absolute coordinates
        // Add those together to get the real coordinates (in raw device units)
        const finalPointRaw = {
          x: x + dx,
          y: y + dy,
          p: p + dp
        };
        
        // Update lastPoint and lastDelta for next iteration (keep in raw device coordinates)
        // lastPoint becomes the final calculated point (this becomes the baseline for next iteration)
        lastPoint = finalPointRaw;
        lastDelta = { x: dx, y: dy, p: dp };
        
        // Scale coordinates by point size (convert to micrometers) for storage
        const finalPoint = {
          x: finalPointRaw.x * this.pointSize,
          y: finalPointRaw.y * this.pointSize,
          p: Math.floor((finalPointRaw.p * 0x10000) / this.pressure)
        };
        
        currentStroke.push(finalPoint);
        offset += this.getPointSize(data.slice(offset));
      } else {
        // Unknown packet, skip one byte
        offset++;
      }
    }

    return strokes;
  }

  identifyPacketType(data) {
    if (data.length < 1) return 'UNKNOWN';
    
    const header = data[0];
    
    // Count bits in header to determine payload size (as tuhi does)
    const nbytes = this.countBits(header);
    const payload = data.slice(1, 1 + nbytes);
    
    // EOF: all 0xff (check payload, not raw data)
    if (payload.length >= 8 && payload.slice(0, 8).every(b => b === 0xff)) {
      return 'EOF';
    }
    
    // Stroke end: 0xfc followed by 0xff (check raw data[0:7])
    if (data.length >= 7 && data[0] === 0xfc && data.slice(1, 7).every(b => 0xff)) {
      return 'STROKE_END';
    }
    
    // Delta: lowest two bits are 0 (check BEFORE payload checks)
    if ((header & 0x03) === 0) {
      return 'DELTA';
    }
    
    // Stroke header: 0xfa or 0xff 0xee 0xee (check payload)
    if (payload.length > 0 && payload[0] === 0xfa) {
      return 'STROKE_HEADER';
    }
    if (payload.length >= 3 && payload[0] === 0xff && payload[1] === 0xee && payload[2] === 0xee) {
      return 'STROKE_HEADER';
    }
    
    // Point: 0xff 0xff (check payload)
    if (payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xff) {
      return 'POINT';
    }
    
    return 'UNKNOWN';
  }

  parsePoint(data, lastPoint, lastDelta) {
    let header = data[0];
    const result = { x: undefined, y: undefined, p: undefined, dx: undefined, dy: undefined, dp: undefined };
    
    // Check if this is a POINT (has 0xff 0xff) or DELTA
    const isPoint = data.length > 2 && data[1] === 0xff && data[2] === 0xff;
    
    // For POINT packets, clear bottom 2 bits of header (as tuhi does)
    if (isPoint) {
      header = header & ~0x03;
    }
    
    // For POINT packets, skip the 0xff 0xff bytes
    const offset = isPoint ? 3 : 1;
    
    const xmask = (header & 0x0c) >> 2;
    const ymask = (header & 0x30) >> 4;
    const pmask = (header & 0xc0) >> 6;
    
    let pos = offset;
    
    // Parse x coordinate
    if (xmask === 3) {
      // Absolute coordinate (little-endian 16-bit, unsigned)
      if (data.length >= pos + 2) {
        result.x = data[pos] | (data[pos + 1] << 8);
        pos += 2;
      }
    } else if (xmask === 2) {
      // 8-bit signed delta
      // Equivalent to: int.from_bytes(bytes([data[pos]]), byteorder='little', signed=True)
      if (data.length >= pos + 1) {
        // Sign-extend 8-bit to 32-bit signed: (byte << 24) >> 24
        const delta = (data[pos] << 24) >> 24;
        result.dx = delta;
        pos += 1;
      }
    }
    // xmask === 0 means no data for this coordinate - don't update result
    
    // Parse y coordinate
    if (ymask === 3) {
      // Absolute coordinate (little-endian 16-bit, unsigned)
      if (data.length >= pos + 2) {
        result.y = data[pos] | (data[pos + 1] << 8);
        pos += 2;
      }
    } else if (ymask === 2) {
      // 8-bit signed delta
      if (data.length >= pos + 1) {
        const delta = (data[pos] << 24) >> 24;
        result.dy = delta;
        pos += 1;
      }
    }
    
    // Parse pressure coordinate
    if (pmask === 3) {
      // Absolute coordinate (little-endian 16-bit, unsigned)
      if (data.length >= pos + 2) {
        result.p = data[pos] | (data[pos + 1] << 8);
        pos += 2;
      }
    } else if (pmask === 2) {
      // 8-bit signed delta
      if (data.length >= pos + 1) {
        const delta = (data[pos] << 24) >> 24;
        result.dp = delta;
        pos += 1;
      }
    }
    
    return result;
  }

  getStrokeEndSize(data) {
    const header = data[0];
    const nbytes = this.countBits(header);
    return 1 + nbytes;
  }

  getStrokeHeaderSize(data) {
    if (data[1] === 0xfa) {
      // Intuos Pro format
      const header = data[0];
      const nbytes = this.countBits(header);
      let size = 1 + nbytes;
      // Check if pen ID is included
      if (data.length > size && data[size] === 0xff) {
        size += 9; // header + 8 bytes pen ID
      }
      return size;
    } else {
      // Slate format
      return 6;
    }
  }

  getPointSize(data) {
    if (data[1] === 0xff && data[2] === 0xff) {
      // Full point
      const header = data[0] & ~0x03;
      const xmask = (header & 0x0c) >> 2;
      const ymask = (header & 0x30) >> 4;
      const pmask = (header & 0xc0) >> 6;
      let size = 3; // header + 0xff 0xff
      size += this.getMaskSize(xmask);
      size += this.getMaskSize(ymask);
      size += this.getMaskSize(pmask);
      return size;
    } else {
      // Delta
      const header = data[0];
      const xmask = (header & 0x0c) >> 2;
      const ymask = (header & 0x30) >> 4;
      const pmask = (header & 0xc0) >> 6;
      let size = 1;
      size += this.getMaskSize(xmask);
      size += this.getMaskSize(ymask);
      size += this.getMaskSize(pmask);
      return size;
    }
  }

  getMaskSize(mask) {
    if (mask === 0) return 0;
    if (mask === 2) return 1; // 8-bit delta
    if (mask === 3) return 2; // 16-bit absolute
    return 0;
  }

  countBits(byte) {
    let count = 0;
    for (let i = 0; i < 8; i++) {
      if (byte & (1 << i)) count++;
    }
    return count;
  }
}

module.exports = StrokeParser;

