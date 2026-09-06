// qr.js — pure-JS QR Code generator (ESM, no dependencies).
//
// Vendored from the canonical `qrcode-generator` library by Kazuhiko Arase
// (http://www.d-project.com/, MIT license). Trimmed to byte-mode scanning
// payloads, wrapped in a small ESM API: makeQr(text) -> matrix + renderers.
//
// Only what a scan-login flow needs is kept: encode a URL/ticket -> module
// matrix, render to ASCII (works in any terminal/UI <pre>) and to PNG bytes
// (see png.js). No canvas/GIF/base64-output helpers are needed.

// ---- GF(256) / Reed–Solomon helpers ----------------------------------------
const QRMath = (function () {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
  for (let i = 8; i < 256; i++)
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
  return {
    glog(n) {
      if (n < 1) throw "glog(" + n + ")";
      return LOG_TABLE[n];
    },
    gexp(n) {
      while (n < 0) n += 255;
      while (n >= 256) n -= 255;
      return EXP_TABLE[n];
    },
  };
})();

function qrPolynomial(num, shift) {
  let offset = 0;
  while (offset < num.length && num[offset] == 0) offset += 1;
  const _num = new Array(num.length - offset + shift);
  for (let i = 0; i < num.length - offset; i++) _num[i] = num[i + offset];
  const that = {};
  that.getAt = (index) => _num[index];
  that.getLength = () => _num.length;
  that.multiply = (e) => {
    const num2 = new Array(that.getLength() + e.getLength() - 1);
    for (let i = 0; i < that.getLength(); i++) {
      for (let j = 0; j < e.getLength(); j++) {
        num2[i + j] ^= QRMath.gexp(QRMath.glog(that.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return qrPolynomial(num2, 0);
  };
  that.mod = (e) => {
    if (that.getLength() - e.getLength() < 0) return that;
    const ratio = QRMath.glog(that.getAt(0)) - QRMath.glog(e.getAt(0));
    const num2 = new Array(that.getLength());
    for (let i = 0; i < that.getLength(); i++) num2[i] = that.getAt(i);
    for (let i = 0; i < e.getLength(); i++) num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    return qrPolynomial(num2, 0).mod(e);
  };
  return that;
}

// ---- Bit buffer -------------------------------------------------------------
function qrBitBuffer() {
  let _buffer = [];
  let _length = 0;
  const that = {};
  that.getBuffer = () => _buffer;
  that.getAt = (index) => ((_buffer[Math.floor(index / 8)] >>> (7 - (index % 8))) & 1) == 1;
  that.put = (num, length) => {
    for (let i = 0; i < length; i++) that.putBit(((num >>> (length - i - 1)) & 1) == 1);
  };
  that.getLengthInBits = () => _length;
  that.putBit = (bit) => {
    const bufIndex = Math.floor(_length / 8);
    if (_buffer.length <= bufIndex) _buffer.push(0);
    if (bit) _buffer[bufIndex] |= 0x80 >>> _length % 8;
    _length += 1;
  };
  return that;
}

// ---- Modes / constants ------------------------------------------------------
const QRMode = { MODE_8BIT_BYTE: 1 << 2 };
const QRErrorCorrectionLevel = { L: 1, M: 0, Q: 3, H: 2 };

// ---- Core utility -----------------------------------------------------------
const QRUtil = (function () {
  const PATTERN_POSITION_TABLE = [
    [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
  ];
  const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
  const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
  const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | 1;
  const getBCHDigit = (data) => {
    let digit = 0;
    while (data != 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  };
  const that = {};
  that.getBCHTypeInfo = (data) => {
    let d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << (getBCHDigit(d) - getBCHDigit(G15));
    }
    return ((data << 10) | d) ^ G15_MASK;
  };
  that.getBCHTypeNumber = (data) => {
    let d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << (getBCHDigit(d) - getBCHDigit(G18));
    }
    return (data << 12) | d;
  };
  that.getPatternPosition = (typeNumber) => PATTERN_POSITION_TABLE[typeNumber - 1];
  that.getMaskFunction = (maskPattern) => {
    switch (maskPattern) {
      case 0: return (i, j) => (i + j) % 2 == 0;
      case 1: return (i) => i % 2 == 0;
      case 2: return (i, j) => j % 3 == 0;
      case 3: return (i, j) => (i + j) % 3 == 0;
      case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
      case 5: return (i, j) => ((i * j) % 2) + ((i * j) % 3) == 0;
      case 6: return (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 == 0;
      case 7: return (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 == 0;
      default: throw "bad maskPattern:" + maskPattern;
    }
  };
  that.getErrorCorrectPolynomial = (errorCorrectLength) => {
    let a = qrPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i++) a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
    return a;
  };
  that.getLengthInBits = (mode, type) => {
    if (1 <= type && type < 10) return 8;
    if (type < 27) return 16;
    if (type < 41) return 16;
    throw "type:" + type;
  };
  that.getLostPoint = (qrcode) => {
    const moduleCount = qrcode.getModuleCount();
    let lostPoint = 0;
    // LEVEL1
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        let sameCount = 0;
        const dark = qrcode.isDark(row, col);
        for (let r = -1; r <= 1; r++) {
          if (row + r < 0 || moduleCount <= row + r) continue;
          for (let c = -1; c <= 1; c++) {
            if (col + c < 0 || moduleCount <= col + c) continue;
            if (r == 0 && c == 0) continue;
            if (dark == qrcode.isDark(row + r, col + c)) sameCount += 1;
          }
        }
        if (sameCount > 5) lostPoint += 3 + sameCount - 5;
      }
    }
    // LEVEL2
    for (let row = 0; row < moduleCount - 1; row++) {
      for (let col = 0; col < moduleCount - 1; col++) {
        let count = 0;
        if (qrcode.isDark(row, col)) count += 1;
        if (qrcode.isDark(row + 1, col)) count += 1;
        if (qrcode.isDark(row, col + 1)) count += 1;
        if (qrcode.isDark(row + 1, col + 1)) count += 1;
        if (count == 0 || count == 4) lostPoint += 3;
      }
    }
    // LEVEL3
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount - 6; col++) {
        if (
          qrcode.isDark(row, col) && !qrcode.isDark(row, col + 1) &&
          qrcode.isDark(row, col + 2) && qrcode.isDark(row, col + 3) &&
          qrcode.isDark(row, col + 4) && !qrcode.isDark(row, col + 5) &&
          qrcode.isDark(row, col + 6)
        ) lostPoint += 40;
      }
    }
    for (let col = 0; col < moduleCount; col++) {
      for (let row = 0; row < moduleCount - 6; row++) {
        if (
          qrcode.isDark(row, col) && !qrcode.isDark(row + 1, col) &&
          qrcode.isDark(row + 2, col) && qrcode.isDark(row + 3, col) &&
          qrcode.isDark(row + 4, col) && !qrcode.isDark(row + 5, col) &&
          qrcode.isDark(row + 6, col)
        ) lostPoint += 40;
      }
    }
    // LEVEL4
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col++) {
      for (let row = 0; row < moduleCount; row++) {
        if (qrcode.isDark(row, col)) darkCount += 1;
      }
    }
    const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  };
  return that;
})();

// ---- RS block table ---------------------------------------------------------
const QRRSBlock = (function () {
  // [L][M][Q][H] per version 1..40; each entry = [count, total, data] triplets.
  const RS_BLOCK_TABLE = [
    [1,26,19],[1,26,16],[1,26,13],[1,26,9],
    [1,44,34],[1,44,28],[1,44,22],[1,44,16],
    [1,70,55],[1,70,44],[2,35,17],[2,35,13],
    [1,100,80],[2,50,32],[2,50,24],[4,25,9],
    [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
    [2,86,68],[4,43,27],[4,43,19],[4,43,15],
    [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
    [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
    [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
    [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
    [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
    [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
    [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
    [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
    [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
    [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
    [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
    [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
    [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
    [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
    [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
    [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
    [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
    [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
    [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
    [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
    [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
    [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
    [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
    [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
    [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
    [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
    [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
    [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
    [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
    [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
    [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
    [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
    [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
    [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16],
  ];
  const getRsBlockTable = (typeNumber, errorCorrectionLevel) => {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H: return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default: return undefined;
    }
  };
  return {
    getRSBlocks(typeNumber, errorCorrectionLevel) {
      const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
      const length = rsBlock.length / 3;
      const list = [];
      for (let i = 0; i < length; i++) {
        const count = rsBlock[i * 3 + 0];
        const totalCount = rsBlock[i * 3 + 1];
        const dataCount = rsBlock[i * 3 + 2];
        for (let j = 0; j < count; j++) list.push({ totalCount, dataCount });
      }
      return list;
    },
  };
})();

// ---- Data producers ---------------------------------------------------------
function qr8BitByte(data) {
  const _bytes = utf8Bytes(data);
  return {
    getMode: () => QRMode.MODE_8BIT_BYTE,
    getLength: () => _bytes.length,
    write: (buffer) => {
      for (let i = 0; i < _bytes.length; i++) buffer.put(_bytes[i], 8);
    },
  };
}

function utf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return bytes;
}

// ---- Byte sequence (mode 4-bit header + length + payload) -------------------
function createData(typeNumber, errorCorrectionLevel, dataList) {
  const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
  const buffer = qrBitBuffer();
  for (const data of dataList) {
    buffer.put(data.getMode(), 4);
    buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
    data.write(buffer);
  }
  let totalDataCount = 0;
  for (const rs of rsBlocks) totalDataCount += rs.dataCount;
  if (buffer.getLengthInBits() > totalDataCount * 8) {
    throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
  }
  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false);
  while (true) {
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0xec, 8);
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(0x11, 8);
  }
  return createBytes(buffer, rsBlocks);
}

function createBytes(buffer, rsBlocks) {
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata = [];
  const ecdata = [];
  for (let r = 0; r < rsBlocks.length; r++) {
    const dcCount = rsBlocks[r].dataCount;
    const ecCount = rsBlocks[r].totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);
    dcdata[r] = new Array(dcCount);
    for (let i = 0; i < dcdata[r].length; i++) dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
    offset += dcCount;
    const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
    const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
    const modPoly = rawPoly.mod(rsPoly);
    ecdata[r] = new Array(rsPoly.getLength() - 1);
    for (let i = 0; i < ecdata[r].length; i++) {
      const modIndex = i + modPoly.getLength() - ecdata[r].length;
      ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
    }
  }
  let totalCodeCount = 0;
  for (let i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
  const data = new Array(totalCodeCount);
  let index = 0;
  for (let i = 0; i < maxDcCount; i++) {
    for (let r = 0; r < rsBlocks.length; r++) {
      if (i < dcdata[r].length) {
        data[index] = dcdata[r][i];
        index += 1;
      }
    }
  }
  for (let i = 0; i < maxEcCount; i++) {
    for (let r = 0; r < rsBlocks.length; r++) {
      if (i < ecdata[r].length) {
        data[index] = ecdata[r][i];
        index += 1;
      }
    }
  }
  return data;
}

// ---- QR object --------------------------------------------------------------
function makeQr(text, errorCorrectionLevel) {
  const ecl = QRErrorCorrectionLevel[errorCorrectionLevel || "M"];
  if (ecl == null) throw "bad ec level";
  let typeNumber = 1;
  for (; typeNumber < 40; typeNumber++) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, ecl);
    const buffer = qrBitBuffer();
    const data = qr8BitByte(text);
    buffer.put(data.getMode(), 4);
    buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
    data.write(buffer);
    let totalDataCount = 0;
    for (const rs of rsBlocks) totalDataCount += rs.dataCount;
    if (buffer.getLengthInBits() <= totalDataCount * 8) break;
  }
  if (typeNumber >= 40) throw "QR payload too large";

  let _modules = null;
  let _moduleCount = 0;
  let _dataCache = null;

  const setupPositionProbePattern = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        _modules[row + r][col + c] =
          (0 <= r && r <= 6 && (c == 0 || c == 6)) ||
          (0 <= c && c <= 6 && (r == 0 || r == 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4);
      }
    }
  };

  const setupPositionAdjustPattern = () => {
    const pos = QRUtil.getPatternPosition(typeNumber);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            _modules[row + r][col + c] = r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0);
          }
        }
      }
    }
  };

  const setupTimingPattern = () => {
    for (let r = 8; r < _moduleCount - 8; r++) {
      if (_modules[r][6] != null) continue;
      _modules[r][6] = r % 2 == 0;
    }
    for (let c = 8; c < _moduleCount - 8; c++) {
      if (_modules[6][c] != null) continue;
      _modules[6][c] = c % 2 == 0;
    }
  };

  const setupTypeNumber = (test) => {
    if (typeNumber < 7) return;
    const bits = QRUtil.getBCHTypeNumber(typeNumber);
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((bits >> i) & 1) == 1;
      _modules[Math.floor(i / 3)][(i % 3) + _moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((bits >> i) & 1) == 1;
      _modules[(i % 3) + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  };

  const setupTypeInfo = (test, maskPattern) => {
    const data = (ecl << 3) | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) == 1;
      if (i < 6) _modules[i][8] = mod;
      else if (i < 8) _modules[i + 1][8] = mod;
      else _modules[_moduleCount - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) == 1;
      if (i < 8) _modules[8][_moduleCount - i - 1] = mod;
      else if (i < 9) _modules[8][15 - i - 1 + 1] = mod;
      else _modules[8][15 - i - 1] = mod;
    }
    _modules[_moduleCount - 8][8] = !test;
  };

  const mapData = (data, maskPattern) => {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) == 1;
            const mask = maskFunc(row, col - c);
            if (mask) dark = !dark;
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex == -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };

  const makeImpl = (test, maskPattern) => {
    _moduleCount = typeNumber * 4 + 17;
    _modules = [];
    for (let row = 0; row < _moduleCount; row++) {
      _modules[row] = new Array(_moduleCount);
      for (let col = 0; col < _moduleCount; col++) _modules[row][col] = null;
    }
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    setupTypeNumber(test);
    if (_dataCache == null) {
      _dataCache = createData(typeNumber, ecl, [qr8BitByte(text)]);
    }
    mapData(_dataCache, maskPattern);
  };

  const getBestMaskPattern = () => {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i++) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(that);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };

  const that = {
    getModuleCount: () => _moduleCount,
    isDark: (row, col) => _modules[row][col],
    make: () => makeImpl(false, getBestMaskPattern()),
  };
  that.make();

  return {
    moduleCount: _moduleCount,
    isDark: (row, col) => {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) return false;
      return !!_modules[row][col];
    },
    toMatrix() {
      const m = [];
      for (let r = 0; r < _moduleCount; r++) {
        const row = [];
        for (let c = 0; c < _moduleCount; c++) row.push(!!_modules[r][c]);
        m.push(row);
      }
      return m;
    },
    toASCII(margin) {
      margin = typeof margin == "undefined" ? 2 : margin;
      const size = _moduleCount + margin * 2;
      const min = margin;
      const max = size - margin;
      const blocks = { "██": "█", "█ ": "▀", " █": "▄", "  ": " " };
      const blocksLastLineNoMargin = { "██": "▀", "█ ": "▀", " █": " ", "  ": " " };
      let ascii = "";
      for (let y = 0; y < size; y += 2) {
        const r1 = Math.floor((y - min));
        const r2 = Math.floor((y + 1 - min));
        for (let x = 0; x < size; x++) {
          let p = "█";
          if (min <= x && x < max && min <= y && y < max && _modules[r1] && _modules[r1][Math.floor(x - min)]) p = " ";
          if (min <= x && x < max && min <= y + 1 && y + 1 < max && _modules[r2] && _modules[r2][Math.floor(x - min)]) p += " ";
          else p += "█";
          ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
        }
        ascii += "\n";
      }
      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + new Array(size + 1).join("▀");
      }
      return ascii.substring(0, ascii.length - 1);
    },
  };
}

export { makeQr };
