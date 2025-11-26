// Stroke File Parser
// Based on tuhi's protocol.py StrokeFile implementation

const MAGIC_ID_SPARK = 0x74623862; // 'b8bt'
const MAGIC_ID_INTUOS = 0x65698267; // 'gieb'

class StrokeParser {
  constructor() {
    // Device dimensions (Spark/Slate defaults)
    this.width = 21000;
    this.height = 14800;
    this.pressure = 1023;
    this.pointSize = 10;
  }

  parse(data, timestamp) {
    const bytes = this.ensureByteArray(data);
    
    if (!bytes || bytes.length < 4) {
      throw new Error('Invalid stroke data');
    }

    const smartPadDrawing = this.tryParseSmartPad(bytes, timestamp);
    if (smartPadDrawing) {
      return smartPadDrawing;
    }

    const header = this.parseFileHeader(bytes);
    const payload = bytes.slice(header.size);
    
    const strokes = this.parseStrokes(payload);
    
    return {
      timestamp: timestamp || header.timestamp || Math.floor(Date.now() / 1000),
      dimensions: [this.width * this.pointSize, this.height * this.pointSize],
      strokes
    };
  }
  
  ensureByteArray(data) {
    if (!data) return null;
    if (Array.isArray(data)) {
      return data.slice();
    }
    if (Buffer.isBuffer(data)) {
      return Array.from(data);
    }
    return Array.from(Buffer.from(data));
  }
  
  tryParseSmartPad(bytes, timestamp) {
    const magic = this.readUInt32LE(bytes, 0);
    if (magic !== MAGIC_ID_SPARK && magic !== MAGIC_ID_INTUOS) {
      return null;
    }

    const payloadOffset = magic === MAGIC_ID_SPARK ? 4 : 16;
    let decompressed;
    try {
      decompressed = SmartPadDecompressor.decompress(bytes, payloadOffset);
    } catch (error) {
      console.warn(`Smartpad decompression failed: ${error.message}`);
      return null;
    }

    if (!decompressed || decompressed.length === 0) {
      return null;
    }

    let paths;
    const fileTimestamp = timestamp ? new Date(timestamp * 1000) : null;
    try {
      if (magic === MAGIC_ID_SPARK) {
        paths = SmartPadFileParserColumbia.parse(decompressed, fileTimestamp);
      } else {
        paths = SmartPadFileParser020102.parse(decompressed);
      }
    } catch (error) {
      console.warn(`Smartpad parsing failed: ${error.message}`);
      return null;
    }

    if (!paths || paths.length === 0) {
      return null;
    }

    return this.buildDrawingFromPaths(paths, timestamp);
  }
  
  buildDrawingFromPaths(paths, fallbackTimestamp) {
    const drawingTimestamp = fallbackTimestamp ||
      Math.floor((paths.find(p => p.timestamp)?.timestamp || Date.now()) / 1000);

    const scaledStrokes = [];
    let maxX = 0;
    let maxY = 0;

    for (const path of paths) {
      const stroke = [];
      for (const point of path.points) {
        if (!point.valid || point.x === 0xffff || point.y === 0xffff) continue;
        const xRaw = point.x;
        const yRaw = point.y;
        maxX = Math.max(maxX, xRaw);
        maxY = Math.max(maxY, yRaw);
        stroke.push({
          x: xRaw * this.pointSize,
          y: yRaw * this.pointSize,
          p: Math.max(0, Math.min(0xffff, Math.floor((point.p * 0x10000) / this.pressure)))
        });
      }
      if (stroke.length > 0) {
        scaledStrokes.push(stroke);
      }
    }

    if (scaledStrokes.length === 0) {
      return null;
    }

    const width = Math.max(maxX || this.width, this.width) * this.pointSize;
    const height = Math.max(maxY || this.height, this.height) * this.pointSize;

    return {
      timestamp: drawingTimestamp,
      dimensions: [width, height],
      strokes: scaledStrokes
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
        // Note: tuhi does NOT reset last_point or lastDelta after stroke end
      } else if (packetType === 'LOST_POINT') {
        offset += this.getLostPointSize(data.slice(offset));
        // We currently ignore lost points but keep parsing aligned
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
        // Unknown packet, skip entire payload to stay aligned
        offset += this.getUnknownPacketSize(data.slice(offset));
      }
    }

    return strokes;
  }

  identifyPacketType(data) {
    if (data.length < 1) return 'UNKNOWN';
    
    const header = data[0];
    const payloadLength = this.countBits(header);
    const payload = data.slice(1, 1 + payloadLength);
    
    // Known file headers (b8bt/slate or gieb/intuos)
    if (data.length >= 4) {
      const sig = [data[0], data[1], data[2], data[3]];
      const sparkSig = [0x62, 0x38, 0x62, 0x74];
      const intuosSig = [0x67, 0x82, 0x69, 0x65];
      if (sig.every((b, idx) => b === sparkSig[idx]) || sig.every((b, idx) => b === intuosSig[idx])) {
        return 'FILE_HEADER';
      }
    }
    
    // EOF: payload filled with 0xff (at least 8 bytes)
    if (payload.length >= 8 && payload.slice(0, 8).every(b => b === 0xff)) {
      return 'EOF';
    }
    
    // Stroke end marker: 0xfc followed by six 0xff bytes
    if (data.length >= 7 && data[0] === 0xfc && data.slice(1, 7).every(b => b === 0xff)) {
      return 'STROKE_END';
    }
    
    // Lost point marker: payload starts with 0xdd 0xdd
    if (payload.length >= 2 && payload[0] === 0xdd && payload[1] === 0xdd) {
      return 'LOST_POINT';
    }
    
    // Delta packets have the lower two bits cleared
    if ((header & 0x03) === 0) {
      return 'DELTA';
    }
    
    // Stroke header patterns (intuos vs slate)
    if (payload.length > 0 && payload[0] === 0xfa) {
      return 'STROKE_HEADER';
    }
    if (payload.length >= 3 && payload[0] === 0xff && payload[1] === 0xee && payload[2] === 0xee) {
      return 'STROKE_HEADER';
    }
    
    // Full point packets include 0xff 0xff marker
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
    const header = data[0] || 0;
    const nbytes = this.countBits(header);
    const payload = data.slice(1, 1 + nbytes);
    
    // Intuos Pro format: payload starts with 0xfa and optional pen id flag
    if (payload.length > 0 && payload[0] === 0xfa) {
      let size = 1 + nbytes;
      const flags = payload.length > 1 ? payload[1] : 0;
      const needsPenId = (flags & 0x80) !== 0;
      if (needsPenId) {
        size += 9; // Pen ID header + 8-byte payload
      }
      return size;
    }
    
    // Slate/Spark header (payload begins with 0xff 0xee 0xee)
    if (payload.length >= 3 && payload[0] === 0xff && payload[1] === 0xee && payload[2] === 0xee) {
      return 1 + nbytes;
    }
    
    // Fallback - treat like generic packet
    return 1 + nbytes;
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

  getLostPointSize(data) {
    const header = data[0] || 0;
    const nbytes = this.countBits(header);
    return 1 + nbytes;
  }

  getUnknownPacketSize(data) {
    if (!data.length) {
      return 1;
    }
    const header = data[0];
    const nbytes = this.countBits(header);
    return 1 + nbytes;
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
  
  readUInt32LE(data, offset) {
    return (
      (data[offset] | 0) |
      ((data[offset + 1] | 0) << 8) |
      ((data[offset + 2] | 0) << 16) |
      ((data[offset + 3] | 0) << 24)
    ) >>> 0;
  }
}

class SmartPadDecompressor {
  constructor(data) {
    this.data = data;
    this.workBuffer = new Int32Array(12);
    this.predict = new Int32Array(4);
    this.bits = new Int32Array(4);
    this.output = [];
  }
  
  static decompress(data, offset) {
    const instance = new SmartPadDecompressor(data);
    return instance.decompressFrom(offset);
  }
  
  decompressFrom(readIndex) {
    this.output = [];
    let t0 = 0;
    let t1 = 4;
    let t2 = 8;
    
    while (readIndex < this.data.length) {
      const dataTag = this.data[readIndex++];
      this.bits[0] = dataTag & 0x03;
      this.bits[1] = (dataTag >> 2) & 0x03;
      this.bits[2] = (dataTag >> 4) & 0x03;
      this.bits[3] = (dataTag >> 6) & 0x03;
      
      for (let i = 0; i < 4; i++) {
        const prev = this.workBuffer[t1 + i] & 0xffff;
        const prev2 = this.workBuffer[t2 + i] & 0xffff;
        const predicted = ((prev * 2) - prev2) & 0xffff;
        this.predict[i] = predicted;
      }
      
      for (let i = 0; i < 4; i++) {
        let value;
        switch (this.bits[i]) {
          case 0:
          case 1:
            value = this.predict[i];
            break;
          case 2: {
            const diff = this.signExtend8(this.data[readIndex++] | 0);
            value = (this.predict[i] + diff) & 0xffff;
            break;
          }
          case 3: {
            const shData = this.readShort(readIndex);
            readIndex += 2;
            const signed = this.signExtend16(shData);
            this.workBuffer[t2 + i] = signed;
            this.workBuffer[t1 + i] = signed;
            value = shData & 0xffff;
            break;
          }
          default:
            value = this.predict[i];
        }
        this.workBuffer[t0 + i] = this.signExtend16(value & 0xffff);
      }
      
      for (let i = 0; i < 4; i++) {
        const val = this.workBuffer[t0 + i] & 0xffff;
        this.output.push(val & 0xff);
        this.output.push((val >> 8) & 0xff);
      }
      
      const temp = t2;
      t2 = t1;
      t1 = t0;
      t0 = temp;
    }
    
    return this.output;
  }
  
  readShort(index) {
    const lsb = this.data[index] | 0;
    const msb = this.data[index + 1] | 0;
    return ((msb << 8) | lsb) & 0xffff;
  }
  
  signExtend8(value) {
    return (value << 24) >> 24;
  }
  
  signExtend16(value) {
    return (value << 16) >> 16;
  }
}

class ByteReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.index = offset;
  }

  remaining() {
    return this.bytes.length - this.index;
  }

  readByte() {
    this.assertAvailable(1);
    return this.bytes[this.index++];
  }

  readUShort() {
    this.assertAvailable(2);
    const value = this.bytes[this.index] | (this.bytes[this.index + 1] << 8);
    this.index += 2;
    return value >>> 0;
  }

  readUInt() {
    this.assertAvailable(4);
    const b0 = this.bytes[this.index];
    const b1 = this.bytes[this.index + 1];
    const b2 = this.bytes[this.index + 2];
    const b3 = this.bytes[this.index + 3];
    this.index += 4;
    return ((b3 << 24) >>> 0) | ((b2 << 16) >>> 0) | ((b1 << 8) >>> 0) | (b0 >>> 0);
  }

  readUnixTimestamp() {
    const seconds = this.readUInt();
    const subSecondUnits = this.readUShort();
    return seconds * 1000 + Math.floor(subSecondUnits / 10);
  }

  skip(count) {
    this.assertAvailable(count);
    this.index += count;
  }

  assertAvailable(count) {
    if (this.remaining() < count) {
      throw new Error('Unexpected end of data while parsing Smartpad file');
    }
  }
}

const SmartPadFileParser020102 = {
  PEN_ID_MASK: 0x80,
  NEW_LAYER_MASK: 0x40,
  PEN_TYPE_MASK: 0x3f,
  parse(data) {
    if (!data || data.length === 0 || data.length % 8 !== 0) {
      throw new Error('Unexpected data length for Smartpad file (new format)');
    }

    const reader = new ByteReader(data);
    const paths = [];
    let currentStroke = null;

    while (reader.remaining() > 0) {
      const tag = reader.readByte();

      if (tag === 0xff) {
        reader.assertAvailable(7);
        const tag2 = reader.readByte();
        if (tag2 !== 0xff) {
          throw new Error('Invalid stroke point marker');
        }
        const x = reader.readUShort();
        const y = reader.readUShort();
        const p = reader.readUShort();

        if (x === 0xffff && y === 0xffff && p === 0xffff) {
          currentStroke = null;
          continue;
        }

        if (!currentStroke) {
          throw new Error('Missing stroke header before point data');
        }

        currentStroke.points.push({ x, y, p, valid: true });
      } else if (tag === 0xfa) {
        reader.assertAvailable(7);
        const flags = reader.readByte();
        const timestamp = reader.readUnixTimestamp();

        if ((flags & this.PEN_ID_MASK) !== 0) {
          reader.skip(8); // skip pen ID
        }

        currentStroke = {
          points: [],
          timestamp,
          penType: flags & this.PEN_TYPE_MASK,
          newLayer: (flags & this.NEW_LAYER_MASK) !== 0
        };
        paths.push(currentStroke);
      } else if (tag === 0xdd) {
        reader.assertAvailable(7);
        const marker = reader.readByte();
        if (marker !== 0xdd) {
          throw new Error('Invalid lost point marker');
        }
        const lostPoints = reader.readUShort();
        reader.skip(4);

        if (currentStroke) {
          for (let i = 0; i < lostPoints; i++) {
            currentStroke.points.push({ x: 0xffff, y: 0xffff, p: 0xffff, valid: false });
          }
        }
      } else {
        // Unknown marker - stop parsing to avoid corrupt output
        break;
      }
    }

    return paths;
  }
};

const SmartPadFileParserColumbia = {
  STROKE_HEAD: 0xeeff, // 61183
  STROKE_POINT: 0xffff,
  LOST_POINTS_MARKER: 0xdddf, // 56831
  POINT_REPORT_RATE: 5,
  parse(data, fileTimestamp) {
    if (!data || data.length === 0 || data.length % 8 !== 0) {
      throw new Error('Unexpected data length for Smartpad file (legacy format)');
    }

    const reader = new ByteReader(data);
    const paths = [];
    const baseTime = fileTimestamp ? fileTimestamp.getTime() : Date.now();
    let currentStroke = null;

    while (reader.remaining() >= 2) {
      const value = reader.readUShort();

      if (value === this.STROKE_POINT) {
        reader.assertAvailable(6);
        const x = reader.readUShort();
        const y = reader.readUShort();
        const p = reader.readUShort();

        if (x === 0xffff && y === 0xffff && p === 0xffff) {
          currentStroke = null;
          continue;
        }

        if (!currentStroke) {
          currentStroke = this.createStrokeForMissing(paths);
        }

        currentStroke.points.push({ x, y, p, valid: true });
      } else if (value === this.STROKE_HEAD) {
        reader.assertAvailable(6);
        reader.skip(2);
        const offset = reader.readUInt();
        const strokeTimestamp = baseTime + Math.round(offset * this.POINT_REPORT_RATE);

        currentStroke = {
          points: [],
          timestamp: strokeTimestamp,
          penType: 0,
          newLayer: false
        };
        paths.push(currentStroke);
      } else if (value === this.LOST_POINTS_MARKER) {
        reader.assertAvailable(6);
        if (!currentStroke) {
          currentStroke = this.createStrokeForMissing(paths);
        }
        reader.skip(4);
        const lost = reader.readUShort();
        for (let i = 0; i < lost; i++) {
          currentStroke.points.push({ x: 0xffff, y: 0xffff, p: 0xffff, valid: false });
        }
      } else {
        break;
      }
    }

    return paths;
  },
  createStrokeForMissing(paths) {
    const stroke = {
      points: [],
      timestamp: Date.now(),
      penType: 0,
      newLayer: false
    };
    paths.push(stroke);
    return stroke;
  }
};

export default StrokeParser;

