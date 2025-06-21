import {BufferReader} from './buffer.js';
import {Vec3, Vec4} from './types.js';

type MotionFrame = {pos: Vec3, rotq: Vec4, unknown: Vec4}
type BoneMotion = {name: string, id: number, parent: number, frames: MotionFrame[]}

export class Mot {
    readonly nr_frames: number;
    readonly bones: BoneMotion[] = [];

    constructor(buf: ArrayBuffer) {
        const r = new BufferReader(buf);
        if (r.readFourCC() !== "MOT\0") {
            throw new Error('not a MOT file');
        }
        if (r.readU32() !== 0) {
            throw new Error('unknown MOT version');
        }
        this.nr_frames = r.readU32();
        const nr_bones = r.readU32();
        for (let i = 0; i < nr_bones; i++) {
            const name = r.readStrZ();
            const id = r.readU32();
            const parent = r.readU32();
            const frames: MotionFrame[] = [];
            for (let j = 0; j < this.nr_frames; j++) {
                const pos = r.readPosition();
                const rotq = r.readQuaternion();
                const unknown = r.readQuaternion();
                frames.push({pos, rotq, unknown});
            }
            this.bones.push({name, id, parent, frames});
        }
    }
}

export function loadTxa(buf: ArrayBuffer): number[] {
    const txa = new TextDecoder().decode(buf);
    const lines = txa.split(/\r?\n/);
    const result: number[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
            const num = parseInt(trimmed, 10);
            if (!isNaN(num)) {
                result.push(num);
            }
        }
    }
    return result;
}
