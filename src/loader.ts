import * as THREE from "three";
import {readFileAsArrayBuffer} from './buffer.js';
import {Aar} from './aar.js';
import {LibModule} from './lib.js';

type Image = {texture: THREE.Texture, hasAlpha: boolean};

export interface Loader {
    filenames(): string[];
    load(fname: string): Promise<ArrayBuffer>;
    loadImage(fname: string): Promise<Image>;
}

class FilesLoader implements Loader {
    private map: Map<string, File> = new Map();
    constructor(private files: FileList) {
        for (const f of this.files) {
            this.map.set(f.name.toLowerCase(), f);
        }
    }

    filenames() {
        return Array.from(this.map.values(), (f, _) => f.name);
    }

    load(fname: string): Promise<ArrayBuffer> {
        return readFileAsArrayBuffer(this.getBlob(fname));
    }

    async loadImage(fname: string): Promise<Image> {
        const url = URL.createObjectURL(this.getBlob(fname + '.png'));
        const texture = new THREE.TextureLoader().load(url);
        return {texture, hasAlpha: true};
    }

    private getBlob(fname: string): Blob {
        console.log('loading ' + fname);
        const f = this.map.get(fname.toLowerCase());
        if (!f) {
            throw new Error(fname + ': not found');
        }
        return f;
    }
}

class AarLoader implements Loader {
    constructor(private aar: Aar, private lib: LibModule) {}

    filenames() {
        return this.aar.filenames();
    }

    load(fname: string): Promise<ArrayBuffer> {
        console.log('loading ' + fname);
        return this.aar.load(fname);
    }

    async loadImage(fname: string): Promise<Image> {
        const qnt = await this.load(fname);
        return decodeQnt(this.lib, new Uint8Array(qnt));
    }
}

function decodeQnt(lib: LibModule, buf: Uint8Array): Image {
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
    const pixels: Uint8Array = lib.HEAPU8.slice(decoded, decoded + width * height * 4);
    lib._free(decoded);
    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.flipY = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return { texture, hasAlpha };
}

export async function createLoader(files: FileList, pendingLibModule: Promise<LibModule>): Promise<Loader> {
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.red')) {
        const lib = await pendingLibModule;
        const aar = await Aar.create(files[0], lib);
        return new AarLoader(aar, lib);
    }
    return new FilesLoader(files);
}