import { BufferReader, readFileAsArrayBuffer } from './buffer.js';
const EntryType = {
    Compressed: 0,
    Raw: 1,
    Symlink: -1,
};
export class Aar {
    constructor(blob, lib, version, entries) {
        this.blob = blob;
        this.lib = lib;
        this.version = version;
        this.entries = entries;
        this.map = new Map();
        for (const e of entries) {
            this.map.set(e.name, e);
        }
    }
    static async create(file, lib) {
        const headerBuf = await readFileAsArrayBuffer(file.slice(0, 16));
        const hr = new BufferReader(headerBuf);
        if (hr.readFourCC() !== "AAR\0") {
            throw new Error('not an AAR file');
        }
        const version = hr.readU32();
        if (version !== 0 && version !== 2) {
            throw new Error('unknown AAR version ' + version);
        }
        const nr_entries = hr.readU32();
        const first_entry_offset = hr.readU32();
        const indexBuf = await readFileAsArrayBuffer(file.slice(12, first_entry_offset));
        const r = new BufferReader(indexBuf);
        const entries = [];
        const unmask = version === 2 ? ((b) => (b - 0x60) & 0xff) : undefined;
        for (let i = 0; i < nr_entries; i++) {
            const offset = r.readU32();
            const size = r.readU32();
            const type = r.readS32();
            const name = r.readStrZ(unmask);
            const symlink_target = version == 2 ? r.readStrZ(unmask) : null;
            entries.push({ offset, size, type, name, symlink_target });
        }
        return new Aar(file, lib, version, entries);
    }
    filenames() {
        return this.map.keys();
    }
    load(name) {
        const entry = this.map.get(name);
        if (!entry) {
            throw new Error(name + ' not found');
        }
        switch (entry.type) {
            case EntryType.Compressed:
                return this.inflateEntry(entry);
            case EntryType.Raw:
                return this.readEntry(entry);
            default:
                throw new Error('not implemented');
        }
    }
    async inflateEntry(entry) {
        const buf = await this.readEntry(entry);
        const r = new BufferReader(buf);
        if (r.readFourCC() !== "ZLB\0") {
            throw new Error('not a ZLB entry');
        }
        if (r.readU32() !== 0) {
            throw new Error('unknown ZLB version');
        }
        const outSize = r.readU32();
        const inSize = r.readU32();
        if (inSize + 16 !== entry.size) {
            throw new Error('bad ZLB size');
        }
        const inPtr = this.lib._malloc(inSize);
        if (!inPtr) {
            throw new Error('out of memroy');
        }
        this.lib.HEAPU8.set(new Uint8Array(buf, 16), inPtr);
        const outPtr = this.lib._decompress(inPtr, inSize, outSize);
        this.lib._free(inPtr);
        if (!outPtr) {
            throw new Error('decompress failed');
        }
        const rawBuf = this.lib.HEAPU8.slice(outPtr, outPtr + outSize).buffer;
        this.lib._free(outPtr);
        return rawBuf;
    }
    readEntry(entry) {
        return readFileAsArrayBuffer(this.blob.slice(entry.offset, entry.offset + entry.size));
    }
}
