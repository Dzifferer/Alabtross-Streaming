/**
 * Minimal QR Code Generator
 * Generates QR codes as SVG — no external dependencies.
 * Based on the QR code specification (ISO/IEC 18004).
 */

(function (global) {
  'use strict';

  // ─── GF(256) arithmetic for Reed-Solomon ────────

  const EXP = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    }
    EXP[255] = EXP[0];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
  }

  function rsGenPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenPoly(ecLen);
    const msg = new Array(data.length + ecLen).fill(0);
    for (let i = 0; i < data.length; i++) msg[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  // ─── QR Code data structures ────────────────────

  // Version info: [version, totalCodewords, ecCodewordsPerBlock, numBlocks]
  // Using error correction level M for good balance
  const VERSION_TABLE = [
    null, // 0 unused
    [1, 26, 10, 1],
    [2, 44, 16, 1],
    [3, 70, 26, 1],
    [4, 100, 18, 2],
    [5, 134, 24, 2],
    [6, 172, 16, 4],
    [7, 196, 18, 4],
    [8, 242, 22, 4],
    [9, 292, 22, 4], // extra from spec
    [10, 346, 26, 4],
  ];

  // Data capacity in bytes for each version at EC level M (byte mode)
  const CAPACITY = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

  function getVersion(dataLen) {
    for (let v = 1; v <= 10; v++) {
      if (dataLen <= CAPACITY[v]) return v;
    }
    return -1; // too long
  }

  function getSize(version) {
    return 17 + version * 4;
  }

  // ─── Encode data ────────────────────────────────

  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    const version = getVersion(bytes.length);
    if (version < 0) throw new Error('Data too long for QR code');

    const vInfo = VERSION_TABLE[version];
    const totalCodewords = vInfo[1];
    const ecPerBlock = vInfo[2];
    const numBlocks = vInfo[3];
    const dataCodewords = totalCodewords - ecPerBlock * numBlocks;

    // Byte mode indicator (0100) + character count
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }

    pushBits(0b0100, 4); // byte mode
    const ccLen = version <= 9 ? 8 : 16;
    pushBits(bytes.length, ccLen);
    for (const b of bytes) pushBits(b, 8);

    // Terminator
    const totalDataBits = dataCodewords * 8;
    const termLen = Math.min(4, totalDataBits - bits.length);
    for (let i = 0; i < termLen; i++) bits.push(0);

    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Convert to bytes
    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] || 0);
      dataBytes.push(byte);
    }

    // Pad with 0xEC, 0x11
    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (dataBytes.length < dataCodewords) {
      dataBytes.push(padBytes[padIdx % 2]);
      padIdx++;
    }

    // Split into blocks and compute EC
    const blockSize = Math.floor(dataCodewords / numBlocks);
    const longBlocks = dataCodewords % numBlocks;
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;

    for (let b = 0; b < numBlocks; b++) {
      const size = blockSize + (b >= numBlocks - longBlocks ? 1 : 0);
      const block = dataBytes.slice(offset, offset + size);
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
      offset += size;
    }

    // Interleave data blocks
    const result = [];
    const maxDataLen = blockSize + (longBlocks > 0 ? 1 : 0);
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        if (i < dataBlocks[b].length) result.push(dataBlocks[b][i]);
      }
    }
    // Interleave EC blocks
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) {
        result.push(ecBlocks[b][i]);
      }
    }

    return { version, codewords: result };
  }

  // ─── Matrix placement ──────────────────────────

  function createMatrix(version) {
    const size = getSize(version);
    // 0 = white, 1 = black, null = unset
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    return { matrix, reserved, size };
  }

  function setModule(m, row, col, val) {
    if (row >= 0 && row < m.size && col >= 0 && col < m.size) {
      m.matrix[row][col] = val ? 1 : 0;
      m.reserved[row][col] = true;
    }
  }

  function addFinderPattern(m, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r, x = col + c;
        if (y < 0 || y >= m.size || x < 0 || x >= m.size) continue;
        const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(m, y, x, inOuter || inInner ? 1 : 0);
      }
    }
  }

  function addAlignmentPattern(m, row, col) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const val = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        setModule(m, row + r, col + c, val ? 1 : 0);
      }
    }
  }

  const ALIGNMENT_POSITIONS = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  function addPatterns(m, version) {
    const size = m.size;

    // Finder patterns
    addFinderPattern(m, 0, 0);
    addFinderPattern(m, 0, size - 7);
    addFinderPattern(m, size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setModule(m, 6, i, i % 2 === 0);
      setModule(m, i, 6, i % 2 === 0);
    }

    // Alignment patterns
    if (version >= 2) {
      const pos = ALIGNMENT_POSITIONS[version];
      for (const r of pos) {
        for (const c of pos) {
          // Skip if overlapping finder
          if (r <= 8 && c <= 8) continue;
          if (r <= 8 && c >= size - 8) continue;
          if (r >= size - 8 && c <= 8) continue;
          addAlignmentPattern(m, r, c);
        }
      }
    }

    // Dark module
    setModule(m, size - 8, 8, 1);

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (!m.reserved[8][i]) { m.reserved[8][i] = true; m.matrix[8][i] = 0; }
      if (!m.reserved[i][8]) { m.reserved[i][8] = true; m.matrix[i][8] = 0; }
      if (!m.reserved[8][size - 1 - i]) { m.reserved[8][size - 1 - i] = true; m.matrix[8][size - 1 - i] = 0; }
      if (!m.reserved[size - 1 - i][8]) { m.reserved[size - 1 - i][8] = true; m.matrix[size - 1 - i][8] = 0; }
    }
    m.reserved[8][8] = true;
    m.matrix[8][8] = 0;
  }

  function placeData(m, codewords) {
    const size = m.size;
    let bitIdx = 0;
    const totalBits = codewords.length * 8;

    // Data is placed in 2-column strips from right to left, going up then down
    let col = size - 1;
    let goingUp = true;

    while (col >= 0) {
      if (col === 6) col--; // skip timing column

      const rows = goingUp
        ? Array.from({ length: size }, (_, i) => size - 1 - i)
        : Array.from({ length: size }, (_, i) => i);

      for (const row of rows) {
        for (let c = 0; c <= 1; c++) {
          const x = col - c;
          if (x < 0 || m.reserved[row][x]) continue;
          if (bitIdx < totalBits) {
            const byteIdx = Math.floor(bitIdx / 8);
            const bitOff = 7 - (bitIdx % 8);
            m.matrix[row][x] = (codewords[byteIdx] >> bitOff) & 1;
            bitIdx++;
          } else {
            m.matrix[row][x] = 0;
          }
        }
      }

      col -= 2;
      goingUp = !goingUp;
    }
  }

  // ─── Masking ───────────────────────────────────

  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(m, maskIdx) {
    const fn = MASK_FNS[maskIdx];
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) {
        if (!m.reserved[r][c]) {
          if (fn(r, c)) m.matrix[r][c] ^= 1;
        }
      }
    }
  }

  // Format info (EC level M = 00, mask patterns 0-7)
  const FORMAT_BITS = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  ];

  function addFormatInfo(m, maskIdx) {
    const bits = FORMAT_BITS[maskIdx];
    const size = m.size;

    for (let i = 0; i < 15; i++) {
      const bit = (bits >> (14 - i)) & 1;

      // Around top-left finder
      if (i < 6) {
        m.matrix[8][i] = bit;
      } else if (i === 6) {
        m.matrix[8][7] = bit;
      } else if (i === 7) {
        m.matrix[8][8] = bit;
      } else if (i === 8) {
        m.matrix[7][8] = bit;
      } else {
        m.matrix[14 - i][8] = bit;
      }

      // Around other finders
      if (i < 8) {
        m.matrix[size - 1 - i][8] = bit;
      } else {
        m.matrix[8][size - 15 + i] = bit;
      }
    }
  }

  // ─── Penalty scoring for mask selection ─────────

  function penaltyScore(matrix, size) {
    let score = 0;

    // Rule 1: runs of same color
    for (let r = 0; r < size; r++) {
      let count = 1;
      for (let c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c - 1]) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score++;
        } else {
          count = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let count = 1;
      for (let r = 1; r < size; r++) {
        if (matrix[r][c] === matrix[r - 1][c]) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score++;
        } else {
          count = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = matrix[r][c];
        if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    return score;
  }

  // ─── Generate QR ───────────────────────────────

  function generateQR(text) {
    const { version, codewords } = encodeData(text);

    let bestMask = 0;
    let bestScore = Infinity;
    let bestMatrix = null;

    for (let mask = 0; mask < 8; mask++) {
      const m = createMatrix(version);
      addPatterns(m, version);
      placeData(m, codewords);
      applyMask(m, mask);
      addFormatInfo(m, mask);

      const score = penaltyScore(m.matrix, m.size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
        bestMatrix = m;
      }
    }

    return { matrix: bestMatrix.matrix, size: bestMatrix.size };
  }

  // ─── SVG output ────────────────────────────────

  function toSVG(qr, opts = {}) {
    const {
      moduleSize = 8,
      margin = 4,
      dark = '#000000',
      light = '#ffffff',
    } = opts;

    const totalSize = (qr.size + margin * 2) * moduleSize;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}">`;
    svg += `<rect width="${totalSize}" height="${totalSize}" fill="${light}"/>`;

    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.matrix[r][c]) {
          const x = (c + margin) * moduleSize;
          const y = (r + margin) * moduleSize;
          svg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="${dark}"/>`;
        }
      }
    }

    svg += '</svg>';
    return svg;
  }

  // ─── Public API ────────────────────────────────

  global.QRCode = {
    generate: generateQR,
    toSVG: function (text, opts) {
      const qr = generateQR(text);
      return toSVG(qr, opts);
    },
  };

})(window);
