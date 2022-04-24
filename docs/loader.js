import * as THREE from "three";
import { readFileAsArrayBuffer } from './buffer.js';
import { Aar } from './aar.js';
class FilesLoader {
    constructor(files) {
        this.files = files;
        this.map = new Map();
        for (const f of this.files) {
            this.map.set(f.name, f);
        }
        this.map.keys;
    }
    filenames() {
        return this.map.keys();
    }
    load(fname) {
        return readFileAsArrayBuffer(this.getBlob(fname));
    }
    async loadImage(fname) {
        const url = URL.createObjectURL(this.getBlob(fname + '.png'));
        const texture = new THREE.TextureLoader().load(url);
        return { texture, hasAlpha: true };
    }
    getBlob(fname) {
        console.log('loading ' + fname);
        const f = this.map.get(fname);
        if (!f) {
            throw new Error(fname + ': not found');
        }
        return f;
    }
}
class AarLoader {
    constructor(aar, lib) {
        this.aar = aar;
        this.lib = lib;
    }
    filenames() {
        return this.aar.filenames();
    }
    load(fname) {
        console.log('loading ' + fname);
        return this.aar.load(fname);
    }
    async loadImage(fname) {
        const qnt = await this.load(fname);
        return decodeQnt(this.lib, new Uint8Array(qnt));
    }
}
function decodeQnt(lib, buf) {
    const ptr = lib._malloc(buf.byteLength);
    lib.HEAPU8.set(buf, ptr);
    const decoded = lib._qnt_extract(ptr);
    lib._free(ptr);
    if (decoded === 0)
        throw new Error('qnt_extract failed');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ofs = dv.getUint32(4, true) === 0 ? 0 : 4;
    const width = dv.getUint32(16 + ofs, true);
    const height = dv.getUint32(20 + ofs, true);
    const hasAlpha = dv.getUint32(36 + ofs, true) !== 0;
    const pixels = lib.HEAPU8.slice(decoded, decoded + width * height * 4);
    lib._free(decoded);
    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.flipY = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return { texture, hasAlpha };
}
export async function createLoader(files, pendingLibModule) {
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.red')) {
        const lib = await pendingLibModule;
        const aar = await Aar.create(files[0], lib);
        return new AarLoader(aar, lib);
    }
    return new FilesLoader(files);
}
