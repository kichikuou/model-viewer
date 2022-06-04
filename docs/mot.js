import { BufferReader } from './buffer.js';
export class Mot {
    constructor(buf) {
        this.bones = [];
        const r = new BufferReader(buf);
        if (r.readFourCC() !== "MOT\0") {
            throw new Error('not a MOT file');
        }
        if (r.readU32() !== 0) {
            throw new Error('unknown MOT version');
        }
        const nr_frames = r.readU32();
        const nr_bones = r.readU32();
        for (let i = 0; i < nr_bones; i++) {
            const name = r.readStrZ();
            const id = r.readU32();
            const parent = r.readU32();
            const frames = [];
            for (let j = 0; j < nr_frames; j++) {
                const pos = r.readPosition();
                const rotq = r.readQuaternion();
                const unknown = r.readQuaternion();
                frames.push({ pos, rotq, unknown });
            }
            this.bones.push({ name, id, parent, frames });
        }
    }
}
