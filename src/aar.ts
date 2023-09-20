import {BufferReader, readFileAsArrayBuffer} from './buffer.js';
import {LibModule} from './lib.js';

/*
struct aar_header {
  char magic[4];  // "AAR\0"
  uint32 version; // 0 or 2
  uint32 nr_entries;
  struct {
    uint32 offset;
    uint32 size;
    int32 type;  // 0=compressed, 1=raw, -1=symlink (AAR v2)
    strz filename;
    if (version == 2) {
      strz symlink_target;
    }
  } entries[nr_entries];
};
*/

type Entry = {offset: number, size: number, type: number, name: string, symlink_target: string | null};

const EntryType = {
    Compressed: 0,
    Raw: 1,
    Symlink: -1,
} as const;

export class Aar {
    static async create(file: File, lib: LibModule): Promise<Aar> {
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
        const entries: Entry[] = [];
        const unmask = version === 2 ? ((b: number) => (b - 0x60) & 0xff) : undefined;
        for (let i = 0; i < nr_entries; i++) {
            const offset = r.readU32();
            const size = r.readU32();
            const type = r.readS32();
            const name = r.readStrZ(unmask);
            const symlink_target = version == 2 ? r.readStrZ(unmask) : null;
            entries.push({offset, size, type, name, symlink_target});
        }
        return new Aar(file, lib, version, entries);
    }

    private map: Map<string, Entry> = new Map();

    constructor(private blob: Blob, private lib: LibModule, private version: number, private entries: Entry[]) {
        for (const e of entries) {
            this.map.set(e.name.toLowerCase(), e);
        }
    }

    filenames() {
        return Array.from(this.map.values(), (entry, _) => entry.name);
    }

    load(name: string): Promise<ArrayBuffer> {
        const entry = this.map.get(name.toLowerCase());
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

    private async inflateEntry(entry: Entry): Promise<ArrayBuffer> {
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
        const inPtr = this.lib.malloc(inSize);
        if (!inPtr) {
            throw new Error('out of memroy');
        }
        this.lib.memset(inPtr, new Uint8Array(buf, 16));
        const outPtr = this.lib.decompress(inPtr, inSize, outSize);
        this.lib.free(inPtr);
        if (!outPtr) {
            throw new Error('decompress failed');
        }
        const rawBuf = this.lib.memget(outPtr, outSize).buffer;
        this.lib.free(outPtr);
        return rawBuf;
    }

    private readEntry(entry: Entry): Promise<ArrayBuffer> {
        return readFileAsArrayBuffer(this.blob.slice(entry.offset, entry.offset + entry.size));
    }
}
