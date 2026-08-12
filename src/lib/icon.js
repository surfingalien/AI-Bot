// The desk's icon, drawn rather than shipped.
//
// An installed app needs real PNGs — a home screen cannot render an SVG on iOS,
// and a manifest without icons is not installable at all. Committing binaries
// to a repo whose whole front end is one authored HTML file seemed the worse
// trade, so the icon is computed: a few hundred lines of arithmetic and a
// deflate, cached after the first request.
//
// PNG is a short format when you only need one kind of image. Everything here
// is 8-bit RGBA, no interlacing, one IDAT.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA pixels -> a PNG file. */
function encode(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10..12 are compression, filter and interlace methods, all zero.

  // Each scanline is prefixed with its filter type. None of them are filtered:
  // the image is flat colour and deflate handles it fine.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The desk's own palette, so an icon on a home screen looks like the thing it
// opens rather than a generic square.
const BACKGROUND = [4, 14, 34];
const CYAN = [79, 208, 230];
const DIM = [30, 92, 130];

/** Coverage of a pixel by a ring, antialiased over one pixel of edge. */
function ring(distance, radius, width) {
  const edge = Math.abs(distance - radius);
  const half = width / 2;
  if (edge <= half - 0.5) return 1;
  if (edge >= half + 0.5) return 0;
  return half + 0.5 - edge;
}

function mix(base, colour, alpha) {
  return [
    Math.round(base[0] + (colour[0] - base[0]) * alpha),
    Math.round(base[1] + (colour[1] - base[1]) * alpha),
    Math.round(base[2] + (colour[2] - base[2]) * alpha),
  ];
}

/**
 * A maskable icon: two rings and a core, centred, with everything important
 * inside the middle 80% so a launcher can crop it to a circle without cutting
 * anything off.
 *
 * @param {number} size edge length in pixels
 * @returns {Buffer} PNG
 */
export function deskIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const unit = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const d = Math.sqrt(dx * dx + dy * dy);

      // A faint glow off the centre, so the flat background has some depth.
      let colour = mix(BACKGROUND, DIM, Math.max(0, 0.22 - d / (size * 1.6)));

      colour = mix(colour, DIM, ring(d, unit * 0.62, unit * 0.055) * 0.85);
      colour = mix(colour, CYAN, ring(d, unit * 0.42, unit * 0.075));
      if (d <= unit * 0.16) colour = mix(colour, CYAN, 1);

      const at = (y * size + x) * 4;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
      pixels[at + 3] = 255;
    }
  }

  return encode(size, size, pixels);
}

const cache = new Map();

/** The same icon, drawn once per size. */
export function iconFor(size) {
  if (!cache.has(size)) cache.set(size, deskIcon(size));
  return cache.get(size);
}
