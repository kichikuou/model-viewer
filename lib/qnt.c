/*
 * Copyright (C) 2020 <KichikuouChrome@gmail.com>
 * Copyright (C) 1997-1998 Masaki Chikama (Wren) <chikama@kasumi.ipl.mech.nagoya-u.ac.jp>
 *               1998-                           <masaki-c@is.aist-nara.ac.jp>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 *
 */
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <emscripten.h>

struct qnt_header {
	uint32_t version;     // QNT version
	uint32_t header_size; // size of the header
	uint32_t x;           // display location x
	uint32_t y;           // display location y
	uint32_t width;       // image width
	uint32_t height;      // image height
	uint32_t bpp;         // bits per pixel, must be 24
	uint32_t unknown;     // must be 1
	uint32_t pixel_size;  // compressed size of pixel data
	uint32_t alpha_size;  // compressed size of alpha data
};

static uint32_t getdw(const uint8_t *b, int index) {
	return b[index] | b[index + 1] << 8 | b[index + 2] << 16 | b[index + 3] << 24;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *decompress(const uint8_t *compressed, uint32_t compressed_size, unsigned long raw_size) {
	uint8_t *raw = malloc(raw_size);
	if (!raw)
		return NULL;
	unsigned long uncompressed_size = raw_size;
	if (uncompress(raw, &uncompressed_size, compressed, compressed_size) != Z_OK)
		return NULL;
	if (uncompressed_size != raw_size)
		return NULL;
	return raw;
}

static bool qnt_extract_header(const uint8_t *b, struct qnt_header *qnt) {
	if (b[0] != 'Q' || b[1] != 'N' || b[2] != 'T' || b[3] != 0)
		return false;
	int ofs = 4;
	qnt->version     = getdw(b, ofs); ofs += 4;
	if (qnt->version) {
		qnt->header_size = getdw(b, ofs); ofs += 4;
	} else {
		qnt->header_size = 48;
	}
	qnt->x           = getdw(b, ofs); ofs += 4;
	qnt->y           = getdw(b, ofs); ofs += 4;
	qnt->width       = getdw(b, ofs); ofs += 4;
	qnt->height      = getdw(b, ofs); ofs += 4;
	qnt->bpp         = getdw(b, ofs); ofs += 4;
	qnt->unknown     = getdw(b, ofs); ofs += 4;
	qnt->pixel_size  = getdw(b, ofs); ofs += 4;
	qnt->alpha_size  = getdw(b, ofs); ofs += 4;
	if (qnt->bpp != 24) {
		fprintf(stderr, "Unsupported bits-per-pixel: %d\n", qnt->bpp);
		return false;
	}
	return true;
}

static uint8_t *extract_pixels(struct qnt_header *qnt, const uint8_t *buf) {
	int width = (qnt->width + 1) & ~1;
	int height = (qnt->height + 1) & ~1;

	const int bufsize = width * height * 3;
	uint8_t *raw = decompress(buf, qnt->pixel_size, bufsize);
	if (!raw)
		return NULL;

	uint8_t *pixels = malloc(width * height * 4);
	memset(pixels, 0, width * height * 4);

	uint8_t *p = raw;
	for (int c = 2; c >= 0; c--) {
		for (int y = 0; y < height; y += 2) {
			uint8_t *row1 = pixels + y * width * 4;
			uint8_t *row2 = row1 + width * 4;
			for (int x = 0; x < width; x += 2) {
				row1[ x    * 4 + c] = *p++;
				row2[ x    * 4 + c] = *p++;
				row1[(x+1) * 4 + c] = *p++;
				row2[(x+1) * 4 + c] = *p++;
			}
		}
	}
	assert(p == raw + bufsize);
	free(raw);

	return pixels;
}

static uint8_t *extract_alpha(struct qnt_header *qnt, const uint8_t *buf) {
	int width = (qnt->width + 1) & ~1;
	int height = (qnt->height + 1) & ~1;

	uint8_t *alpha = decompress(buf, qnt->alpha_size, width * height);
	if (!alpha)
		return NULL;

	return alpha;
}

static void unfilter(uint8_t *pixels, int width, int height) {
	for (int x = 1; x < width; x++) {
		for (int c = 0; c < 4; c++)
			pixels[x*4+c] = pixels[(x-1)*4+c] - pixels[x*4+c];
	}
	for (int y = 1; y < height; y++) {
		uint8_t *row = pixels + y * width * 4;
		uint8_t *prevrow = row - width * 4;
		for (int c = 0; c < 4; c++)
			row[c] = prevrow[c] - row[c];

		for (int x = 1; x < width; x++) {
			for (int c = 0; c < 4; c++) {
				int up = prevrow[x*4+c];
				int left = row[(x-1)*4+c];
				row[x*4+c] = ((up + left) >> 1) - row[x*4+c];
			}
		}
	}
}

static void merge_alpha_channel(uint8_t *pixels, uint8_t *alpha, int width, int height) {
	for (int y = 0; y < height; y++) {
		uint8_t *dst = pixels + y * width * 4 + 3;
		uint8_t *src = alpha + y * width;
		for (int x = 0; x < width; x++) {
			*dst = *src;
			dst += 4;
			src += 1;
		}
	}
}

EMSCRIPTEN_KEEPALIVE
uint8_t *qnt_extract(const uint8_t *buf) {
	struct qnt_header qnt;
	if (!qnt_extract_header(buf, &qnt)) {
		fprintf(stderr, "not a QNT file\n");
		return NULL;
	}

	uint8_t *pixels = extract_pixels(&qnt, buf + qnt.header_size);
	if (!pixels) {
		fprintf(stderr, "broken image\n");
		return NULL;
	}
	if (qnt.alpha_size) {
		uint8_t *alpha = extract_alpha(&qnt, buf + qnt.header_size + qnt.pixel_size);
		if (!alpha) {
			fprintf(stderr, "broken alpha image\n");
			free(pixels);
			return NULL;
		}
		merge_alpha_channel(pixels, alpha, qnt.width, qnt.height);
		free(alpha);
	} else {
		// unfilter() will copy this to alpha channels of all pixels.
		pixels[3] = 0xff;
	}

	unfilter(pixels, qnt.width, qnt.height);

	return pixels;
}
