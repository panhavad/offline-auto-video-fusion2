/**
 * Generates the raster app icons in public/ from the same shapes as public/icon.svg.
 *
 * SVG favicons are ignored by a few browsers (and by anything that blindly requests
 * /favicon.ico), so the tab icon needs PNG/ICO fallbacks. Everything here is hand-rolled to
 * keep the project dependency-free: a tiny rounded-rectangle rasterizer plus minimal PNG and
 * ICO writers.
 *
 * Run with: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

// Shapes are expressed on the 512x512 canvas used by icon.svg: [x, y, width, height, radius, color].
const CANVAS = 512;
const SHAPES = [
	[0, 0, 512, 512, 96, '#18211e'],
	[48, 140, 152, 232, 28, '#ffffff'],
	[312, 140, 152, 232, 28, '#ffffff'],
	[194, 234, 124, 44, 22, '#1f9d55'],
];

const parseColor = (hex) => [
	parseInt(hex.slice(1, 3), 16),
	parseInt(hex.slice(3, 5), 16),
	parseInt(hex.slice(5, 7), 16),
];

/** Signed coverage of a rounded rectangle at a point, 1 inside and 0 outside. */
const inside = (x, y, [rx, ry, w, h, r]) => {
	const cx = Math.min(Math.max(x, rx + r), rx + w - r);
	const cy = Math.min(Math.max(y, ry + r), ry + h - r);
	if (x >= rx && x <= rx + w && y >= ry && y <= ry + h && (x === cx || y === cy)) return true;
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** Renders the icon into an RGBA buffer of the requested size, 4x4 supersampled. */
const render = (size) => {
	const samples = 4;
	const scale = CANVAS / size;
	const pixels = Buffer.alloc(size * size * 4);

	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;

			for (let sy = 0; sy < samples; sy++) {
				for (let sx = 0; sx < samples; sx++) {
					const x = (px + (sx + 0.5) / samples) * scale;
					const y = (py + (sy + 0.5) / samples) * scale;
					let hit = null;
					for (const shape of SHAPES) if (inside(x, y, shape)) hit = shape;
					if (!hit) continue;
					const [sr, sg, sb] = parseColor(hit[5]);
					r += sr;
					g += sg;
					b += sb;
					a += 1;
				}
			}

			const total = samples * samples;
			const offset = (py * size + px) * 4;
			if (a > 0) {
				// Average only the covered samples so edges keep their colour and fade via alpha.
				pixels[offset] = Math.round(r / a);
				pixels[offset + 1] = Math.round(g / a);
				pixels[offset + 2] = Math.round(b / a);
				pixels[offset + 3] = Math.round((a / total) * 255);
			}
		}
	}

	return pixels;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

const crc32 = (buffer) => {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
};

const toPng = (pixels, size) => {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0; // filter: none
		pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
};

/** Classic 32-bit BMP entry: understood by every browser, unlike PNG-compressed ICO entries. */
const toIcoImage = (pixels, size) => {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8); // colour data + AND mask
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	const body = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const from = (y * size + x) * 4;
			const to = ((size - 1 - y) * size + x) * 4; // BMP rows run bottom-up
			body[to] = pixels[from + 2];
			body[to + 1] = pixels[from + 1];
			body[to + 2] = pixels[from];
			body[to + 3] = pixels[from + 3];
		}
	}
	const maskStride = Math.ceil(size / 32) * 4;
	return Buffer.concat([header, body, Buffer.alloc(maskStride * size)]);
};

const toIco = (images) => {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	const directory = Buffer.alloc(16 * images.length);
	let offset = header.length + directory.length;
	images.forEach(({ size, data }, index) => {
		const entry = index * 16;
		directory[entry] = size >= 256 ? 0 : size;
		directory[entry + 1] = size >= 256 ? 0 : size;
		directory.writeUInt16LE(1, entry + 4);
		directory.writeUInt16LE(32, entry + 6);
		directory.writeUInt32LE(data.length, entry + 8);
		directory.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
};

const main = async () => {
	const pngs = [
		['apple-touch-icon.png', 180],
		['icon-192.png', 192],
		['icon-512.png', 512],
	];

	for (const [name, size] of pngs) {
		await writeFile(join(publicDir, name), toPng(render(size), size));
		console.log(`${name} (${size}x${size})`);
	}

	const ico = toIco(
		[16, 32, 48].map((size) => ({ size, data: toIcoImage(render(size), size) })),
	);
	await writeFile(join(publicDir, 'favicon.ico'), ico);
	console.log('favicon.ico (16, 32, 48)');
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
