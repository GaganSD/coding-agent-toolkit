const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Parse the PNG container without decoding pixels. Chunk bounds, CRCs, the
// IHDR dimensions, at least one IDAT chunk, and the terminal IEND chunk make
// truncation and corruption fail without imposing optional screen-size rules.
export function validatePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("missing the PNG signature");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let chunkCount = 0;
  let sawIdat = false;
  let sawIend = false;

  while (offset < buffer.length) {
    if (sawIend) throw new Error("has data after the IEND chunk");
    if (buffer.length - offset < 12) throw new Error("has a truncated chunk header");

    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (length > 0x7fffffff || crcOffset + 4 > buffer.length) {
      throw new Error("has a truncated chunk");
    }

    const type = buffer.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("has an invalid chunk type");
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = crc32(buffer, typeStart, crcOffset);
    if (expectedCrc !== actualCrc) throw new Error(`has an invalid ${type} chunk CRC`);

    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("does not start with a valid IHDR chunk");
      }
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0) throw new Error("has zero image dimensions");
    } else if (type === "IHDR") {
      throw new Error("has more than one IHDR chunk");
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0) throw new Error("has a non-empty IEND chunk");
      sawIend = true;
    }

    chunkCount += 1;
    offset = crcOffset + 4;
  }

  if (chunkCount === 0) throw new Error("has no PNG chunks");
  if (!sawIdat) throw new Error("has no IDAT image data");
  if (!sawIend) throw new Error("is missing the terminal IEND chunk");
  return { width, height, chunks: chunkCount };
}
