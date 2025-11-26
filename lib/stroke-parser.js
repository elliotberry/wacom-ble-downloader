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
    // Check file format signature
    const sig1 = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    const sparkSig = 0x62746238; // 'bt8b' in little-endian
    const intuosSig = 0x65698267; // 'gieb' in little-endian
    
    if (sig1 === sparkSig) {
      return { size: 4, timestamp: null };
    } else if (sig1 === intuosSig) {
      // Intuos Pro format has timestamp and stroke count
      const timestamp = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
      const strokeCount = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
      return { size: 16, timestamp, strokeCount };
    } else {
      throw new Error(`Unknown file format: 0x${sig1.toString(16)}`);
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
      } else if (packetType === 'STROKE_HEADER') {
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
          currentStroke = [];
        }
        lastDelta = { x: 0, y: 0, p: 0 };
        offset += this.getStrokeHeaderSize(data.slice(offset));
      } else if (packetType === 'POINT' || packetType === 'DELTA') {
        const point = this.parsePoint(data.slice(offset), lastPoint, lastDelta);
        lastPoint = point;
        currentStroke.push(point);
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
    
    // EOF: all 0xff
    if (data.length >= 8 && data.slice(0, 8).every(b => b === 0xff)) {
      return 'EOF';
    }
    
    // Stroke end: 0xfc followed by 0xff
    if (header === 0xfc && data.length > 1 && data[1] === 0xff) {
      return 'STROKE_END';
    }
    
    // Stroke header: 0xfa or 0xff 0xee 0xee
    if (data.length > 1 && data[1] === 0xfa) {
      return 'STROKE_HEADER';
    }
    if (data.length > 3 && data[1] === 0xff && data[2] === 0xee && data[3] === 0xee) {
      return 'STROKE_HEADER';
    }
    
    // Point: 0xff 0xff
    if (data.length > 2 && data[1] === 0xff && data[2] === 0xff) {
      return 'POINT';
    }
    
    // Delta: lowest two bits are 0
    if ((header & 0x03) === 0) {
      return 'DELTA';
    }
    
    return 'UNKNOWN';
  }

  parsePoint(data, lastPoint, lastDelta) {
    const header = data[0];
    let x = lastPoint.x;
    let y = lastPoint.y;
    let p = lastPoint.p;
    let dx = lastDelta.x;
    let dy = lastDelta.y;
    let dp = lastDelta.p;
    
    if (data[1] === 0xff && data[2] === 0xff) {
      // Full point
      const offset = 3;
      const xmask = (header & 0x0c) >> 2;
      const ymask = (header & 0x30) >> 4;
      const pmask = (header & 0xc0) >> 6;
      
      let pos = offset;
      if (xmask === 3) {
        x = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dx = 0;
      } else if (xmask === 2) {
        dx += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
      
      if (ymask === 3) {
        y = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dy = 0;
      } else if (ymask === 2) {
        dy += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
      
      if (pmask === 3) {
        p = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dp = 0;
      } else if (pmask === 2) {
        dp += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
    } else {
      // Delta
      const xmask = (header & 0x0c) >> 2;
      const ymask = (header & 0x30) >> 4;
      const pmask = (header & 0xc0) >> 6;
      
      let pos = 1;
      if (xmask === 3) {
        x = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dx = 0;
      } else if (xmask === 2) {
        dx += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
      
      if (ymask === 3) {
        y = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dy = 0;
      } else if (ymask === 2) {
        dy += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
      
      if (pmask === 3) {
        p = data[pos] | (data[pos + 1] << 8);
        pos += 2;
        dp = 0;
      } else if (pmask === 2) {
        dp += data[pos] | ((data[pos] & 0x80) ? 0xFFFFFF00 : 0);
        pos += 1;
      }
    }
    
    // Apply delta
    x += dx;
    y += dy;
    p += dp;
    
    // Scale coordinates by point size
    x *= this.pointSize;
    y *= this.pointSize;
    
    // Normalize pressure to 0x10000 range
    const normalizedPressure = Math.floor((p * 0x10000) / this.pressure);
    
    return { x, y, p: normalizedPressure };
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

