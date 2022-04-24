import {Vec3, Vec4} from './types.js';

export function readFileAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => { resolve(reader.result as ArrayBuffer); };
        reader.onerror = () => { reject(reader.error); };
        reader.readAsArrayBuffer(blob);
    });
}

export class BufferReader {
    private view: DataView;
    public offset = 0;

    constructor(buf: ArrayBuffer) {
        this.view = new DataView(buf);
    }

    get buffer(): ArrayBuffer {
        return this.view.buffer;
    }

    readU8(): number {
        const val = this.view.getUint8(this.offset);
        this.offset += 1;
        return val;
    }

    readU16(): number {
        const val = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return val;
    }

    readU32(): number {
        const val = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return val;
    }

    readS32(): number {
        const val = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return val;
    }

    readF32(): number {
        const val = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return val;
    }

    readF64(): number {
        const val = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return val;
    }

    readFourCC(): string {
        const fourcc = new Uint8Array(this.view.buffer, this.offset, 4);
        this.offset += 4;
        return String.fromCharCode.apply(null, Array.from(fourcc));
    }

    readBytes(len: number): Uint8Array {
        const bytes = new Uint8Array(this.view.buffer, this.offset, len);
        this.offset += len;
        return bytes;
    }

    readStrZ(filter?: (byte: number) => number): string {
        const begin = this.offset;
        while (this.view.getUint8(this.offset) !== 0) {
            this.offset++;
        }
        this.offset++;
        let bytes = Array.from(new Uint8Array(this.view.buffer, begin, this.offset - 1 - begin));
        if (filter) {
            bytes = bytes.map(filter);
        }
        return String.fromCharCode.apply(null, bytes);
    }

    readVec3(): Vec3 {
        return {
            x: this.readF32(),
            y: this.readF32(),
            z: -this.readF32()
        };
    }

    readQuaternion(): Vec4 {
        return {
            w: this.readF32(),
            x: -this.readF32(),
            y: -this.readF32(),
            z: this.readF32()
        };
    }
}
