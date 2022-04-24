import { BufferReader } from './buffer.js';
export const TextureType = {
    ColorMap: 1,
    SpecularMaskMap: 4,
    GlareMap: 5,
    AlphaMap: 6,
    sdMap: 7,
    NormalMap: 8,
    HeightMap: 11,
};
export class Pol {
    constructor(buf) {
        this.materials = [];
        this.objects = [];
        this.bones = [];
        const r = new BufferReader(buf);
        if (r.readFourCC() !== "POL\0") {
            throw new Error('not a POL file');
        }
        this.version = r.readU32();
        if (this.version !== 1 && this.version !== 2) {
            throw new Error('unknown POL version ' + this.version);
        }
        const nr_materials = r.readU32();
        for (let i = 0; i < nr_materials; i++) {
            this.materials.push(this.parse_material(r, true));
        }
        const nr_objects = r.readU32();
        for (let i = 0; i < nr_objects; i++) {
            this.objects.push(this.parse_object(r, this.materials));
        }
        const nr_bones = r.readU32();
        for (let i = 0; i < nr_bones; i++) {
            this.bones.push(this.parse_bone(r));
        }
        if (r.offset !== buf.byteLength) {
            console.log('extra data at end');
        }
    }
    parse_material(r, can_have_children) {
        const name = r.readStrZ();
        const nr_textures = r.readU32();
        const textures = new Map();
        for (let i = 0; i < nr_textures; i++) {
            const fname = r.readStrZ();
            const type = r.readU32();
            if (type !== 1 && type !== 4 && type !== 5 && type !== 6 && type !== 7 && type !== 8 && type !== 11) {
                console.log('unknown texture type ' + type);
            }
            if (textures.has(type)) {
                throw new Error('duplicated texture type ' + type);
            }
            textures.set(type, fname);
        }
        if (textures.size > 0 && !textures.has(1)) {
            throw new Error('no basic texture');
        }
        const children = [];
        if (can_have_children) {
            const nr_children = r.readU32();
            for (let i = 0; i < nr_children; i++) {
                children.push(this.parse_material(r, false));
            }
        }
        return { name, textures, children };
    }
    parse_object(r, materials) {
        const type = r.readS32();
        switch (type) {
            case 0: break;
            case -1: return null;
            default: throw new Error('unknown object type ' + type);
        }
        const name = r.readStrZ();
        const material = r.readS32();
        if (material < -1 || material >= materials.length) {
            throw new Error('Material index out of bounds ' + material);
        }
        const nr_vertices = r.readU32();
        const vertices = [];
        for (let i = 0; i < nr_vertices; i++) {
            vertices.push(this.parse_vertex(r));
        }
        const nr_uvs = r.readU32();
        const uvs = [];
        for (let i = 0; i < nr_uvs; i++) {
            const u = r.readF32();
            const v = r.readF32();
            uvs.push({ u, v: -v });
        }
        const nr_uk2 = r.readU32();
        const uk2 = [];
        for (let i = 0; i < nr_uk2; i++) {
            uk2.push(r.readF64());
        }
        const nr_uk3 = r.readU32();
        const uk3 = [];
        let nr_uk4 = 0;
        const uk4 = [];
        if (this.version === 1) {
            for (let i = 0; i < nr_uk3; i++) {
                const x = r.readF32();
                const y = r.readF32();
                const z = r.readF32();
                uk3.push({ x, y, z });
            }
        }
        else {
            for (let i = 0; i < nr_uk3; i++) {
                uk3.push(r.readU32());
            }
            nr_uk4 = r.readU32();
            for (let i = 0; i < nr_uk4; i++) {
                uk4.push(r.readU8());
            }
        }
        const nr_triangles = r.readU32();
        const triangles = [];
        for (let i = 0; i < nr_triangles; i++) {
            triangles.push(this.parse_triangle(r, nr_vertices, nr_uvs, nr_uk2, nr_uk4));
        }
        if (this.version === 1) {
            if (r.readU32() !== 1) {
                throw new Error('unexpected object footer');
            }
            if (r.readU32() !== 0) {
                throw new Error('unexpected object footer');
            }
        }
        return { name, material, vertices, uvs, uk2, uk3, triangles, uk4 };
    }
    parse_vertex(r) {
        const x = r.readF32();
        const y = r.readF32();
        const z = -r.readF32();
        const nr_weights = this.version === 1 ? r.readU32() : r.readU16();
        const weights = [];
        for (let i = 0; i < nr_weights; i++) {
            const bone = this.version === 1 ? r.readU32() : r.readU16();
            const weight = r.readF32();
            weights.push({ bone, weight });
        }
        weights.sort((a, b) => b.weight - a.weight);
        return { x, y, z, weights };
    }
    parse_triangle(r, nr_vertices, nr_uvs, nr_uk2, nr_uk4) {
        const vert_index = [
            r.readU32(),
            r.readU32(),
            r.readU32(),
        ];
        const uv_index = [
            r.readU32(),
            r.readU32(),
            r.readU32(),
        ];
        for (let i = 0; i < 3; i++) {
            if (vert_index[i] >= nr_vertices) {
                throw new Error(`vertex index out of range ${vert_index[i]} / ${nr_vertices}`);
            }
            if (uv_index[i] >= nr_uvs) {
                throw new Error(`texture index out of range ${uv_index[i]} / ${nr_uvs}`);
            }
        }
        const unknowns = [];
        let n = 3;
        if (nr_uk2)
            n += 3;
        if (nr_uk4)
            n += 3;
        for (let i = 0; i < n; i++) {
            unknowns.push(r.readU32());
        }
        const normals = [];
        for (let i = 0; i < 3; i++) {
            normals.push(r.readVec3());
        }
        const unknown = r.readU32(); // sub-material index?
        return { vert_index, uv_index, unknowns, normals, unknown };
    }
    parse_bone(r) {
        const name = r.readStrZ();
        const id = r.readS32();
        const parent = r.readS32();
        const pos = r.readVec3();
        const rotq = r.readQuaternion();
        return { name, id, parent, pos, rotq };
    }
}