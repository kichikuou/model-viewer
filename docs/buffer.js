const METERS_PER_INCH = 0.0254;
export function readFileAsArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => { resolve(reader.result); };
        reader.onerror = () => { reject(reader.error); };
        reader.readAsArrayBuffer(blob);
    });
}
export class BufferReader {
    constructor(buf) {
        this.offset = 0;
        this.view = new DataView(buf);
    }
    get buffer() {
        return this.view.buffer;
    }
    readU8() {
        const val = this.view.getUint8(this.offset);
        this.offset += 1;
        return val;
    }
    readU16() {
        const val = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return val;
    }
    readU32() {
        const val = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return val;
    }
    readS32() {
        const val = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return val;
    }
    readF32() {
        const val = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return val;
    }
    readF64() {
        const val = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return val;
    }
    readFourCC() {
        const fourcc = new Uint8Array(this.view.buffer, this.offset, 4);
        this.offset += 4;
        return String.fromCharCode.apply(null, Array.from(fourcc));
    }
    readBytes(len) {
        const bytes = new Uint8Array(this.view.buffer, this.offset, len);
        this.offset += len;
        return bytes;
    }
    readStrZ(filter) {
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
    readPosition() {
        return {
            x: this.readF32() * METERS_PER_INCH,
            y: this.readF32() * METERS_PER_INCH,
            z: -this.readF32() * METERS_PER_INCH
        };
    }
    readDirection() {
        return {
            x: this.readF32(),
            y: this.readF32(),
            z: -this.readF32()
        };
    }
    readQuaternion() {
        return {
            w: this.readF32(),
            x: -this.readF32(),
            y: -this.readF32(),
            z: this.readF32()
        };
    }
}
