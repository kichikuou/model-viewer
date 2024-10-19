import {BufferReader} from './buffer.js';
import {Vec2, Vec3, Vec4} from './types.js';

export const TextureType = {
    ColorMap: 1,
    SpecularMaskMap: 4,
    GlareMap: 5,
    AlphaMap: 6,
    LightMap: 7,
    NormalMap: 8,
    HeightMap: 11,
} as const;

export type MaterialInfo = {
    name: string,
    attrs: MatterialAttributes,
    textures: Map<number, string>,
    children: MaterialInfo[]
}
type MatterialAttributes = {
    alpha?: boolean,
    env?: boolean,
    sprite?: boolean,
}

export type Mesh = {
    name: string,
    attrs: MeshAttributes,
    material: number,
    vertices: Vertex[],
    uvs: Vec2[],
    light_uvs?: Vec2[],
    colors?: Vec3[],
    triangles: Triangle[],
    alphas?: number[],
    // Parameters in .opr file
    additiveBlending?: boolean,
    noEdge?: boolean,
    edgeColor?: number[],
    edgeSize?: number,
    uvScroll?: Vec2,
}
type MeshAttributes = {
    alpha?: boolean,
    both?: boolean,
    env?: boolean,
    mirrored?: boolean,
    nolighting?: boolean,
    nomakeshadow?: boolean,
    sprite?: boolean,
    water?: boolean,
}

export type Vertex = {x: number, y: number, z: number, weights: BoneWeight[]}
export type Triangle = {
    vert_index: number[],
    uv_index: number[],
    light_uv_index: number[],
    color_index: number[],
    alpha_index: number[],
    normals: Vec3[],
    material_index: number
};
export type Bone = {name: string, id: number, parent: number, pos: Vec3, rotq: Vec4}
type BoneWeight = {bone: number, weight: number}

export class Pol {
    readonly version: number;
    readonly materials: MaterialInfo[] = [];
    readonly meshes: (Mesh | null)[] = [];
    readonly bones: Bone[] = [];

    constructor(buf: ArrayBuffer, opr?: string) {
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
        const nr_meshes = r.readU32();
        for (let i = 0; i < nr_meshes; i++) {
            this.meshes.push(this.parse_mesh(r, this.materials));
        }
        const nr_bones = r.readU32();
        for (let i = 0; i < nr_bones; i++) {
            this.bones.push(this.parse_bone(r));
        }
        if (r.offset !== buf.byteLength) {
            console.log('extra data at end');
        }

        if (opr) {
            this.loadOpr(opr);
        }
    }

    parse_material(r: BufferReader, can_have_children: boolean): MaterialInfo {
        const name = r.readStrZ();
        const attrs: MatterialAttributes = {};
        const regex = /\([^)]+\)/g;
        let match;
        while ((match = regex.exec(name)) !== null) {
            switch (match[0]) {
                case '(alpha)':
                    attrs.alpha = true;
                    break;
                case '(env)':
                    attrs.env = true;
                    break;
                case '(sprite)':
                    attrs.sprite = true;
                    break;
                default:
                    console.warn(`Unknown material attribute: ${match[0]}`);
            }
        }
        const nr_textures = r.readU32();
        const textures = new Map<number, string>();
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
        const children: MaterialInfo[] = [];
        if (can_have_children) {
            const nr_children = r.readU32();
            if (nr_textures > 0 && nr_children > 0) {
                throw new Error('A material cannot have both textures and children');
            }
            for (let i = 0; i < nr_children; i++) {
                children.push(this.parse_material(r, false));
            }
        }
        return {name, attrs, textures, children};
    }

    parse_mesh(r: BufferReader, materials: MaterialInfo[]): Mesh | null {
        const type = r.readS32();
        switch (type) {
        case 0: break;
        case -1: return null;
        default: throw new Error('unknown mesh type ' + type);
        }
        const name = r.readStrZ();
        const attrs: MeshAttributes = {};
        const regex = /\([^)]+\)/g;
        let match;
        while ((match = regex.exec(name)) !== null) {
            switch (match[0]) {
                case '(alpha)':
                    attrs.alpha = true;
                    break;
                case '(both)':
                    attrs.both = true;
                    break;
                case '(env)':
                    attrs.env = true;
                    break;
                case '(mirrored)':
                    attrs.mirrored = true;
                    break;
                case '(nolighting)':
                    attrs.nolighting = true;
                    break;
                case '(nomakeshadow)':
                    attrs.nomakeshadow = true;
                    break;
                case '(sprite)':
                    attrs.sprite = true;
                    break;
                case '(water)':
                    attrs.water = true;
                    break;
                default:
                    console.warn(`Unknown mesh attribute: ${match[0]}`);
            }
        }
        const material = r.readS32();
        if (material < -1 || material >= materials.length) {
            throw new Error('Material index out of bounds ' + material);
        }
        const nr_vertices = r.readU32();
        const vertices: Vertex[] = [];
        for (let i = 0; i < nr_vertices; i++) {
            vertices.push(this.parse_vertex(r));
        }
        const nr_uvs = r.readU32();
        const uvs: Vec2[] = [];
        for (let i = 0; i < nr_uvs; i++) {
            const u = r.readF32();
            const v = r.readF32();
            uvs.push({u, v: -v});
        }
        const nr_light_uvs = r.readU32();
        let light_uvs: Vec2[] | undefined;
        if (nr_light_uvs > 0) {
            light_uvs = [];
            for (let i = 0; i < nr_light_uvs; i++) {
                const u = r.readF32();
                const v = r.readF32();
                light_uvs.push({u, v: -v});
            }
        }
        const nr_colors = r.readU32();
        let colors: Vec3[] | undefined;
        if (nr_colors > 0) {
            colors = [];
            for (let i = 0; i < nr_colors; i++) {
                if (this.version === 1) {
                    const x = r.readF32();
                    const y = r.readF32();
                    const z = r.readF32();
                    colors.push({x, y, z});
                } else {
                    const R = r.readU8();
                    const G = r.readU8();
                    const B = r.readU8();
                    const A = r.readU8();
                    if (A !== 255) {
                        console.warn('vertex color: unexpected alpha channel');
                    }
                    colors.push({x: R / 255, y: G / 255, z: B / 255});
                }
            }
        }
        let nr_alphas = 0;
        let alphas: number[] | undefined;
        if (this.version >= 2) {
            nr_alphas = r.readU32();
            if (nr_alphas > 0) {
                alphas = [];
                for (let i = 0; i < nr_alphas; i++) {
                    alphas.push(r.readU8() / 255);
                }
            }
        }
        const nr_triangles = r.readU32();
        const triangles: Triangle[] = [];
        for (let i = 0; i < nr_triangles; i++) {
            triangles.push(this.parse_triangle(r, nr_vertices, nr_uvs, nr_light_uvs, nr_colors, nr_alphas, materials[material]));
        }
        if (this.version === 1) {
            if (r.readU32() !== 1) {
                throw new Error('unexpected mesh footer');
            }
            if (r.readU32() !== 0) {
                throw new Error('unexpected mesh footer');
            }
        }
        return {name, attrs, material, vertices, uvs, light_uvs, colors, triangles, alphas};
    }

    parse_vertex(r: BufferReader): Vertex {
        const pos = r.readPosition();
        const nr_weights = this.version === 1 ? r.readU32() : r.readU16();
        const weights: BoneWeight[] = [];
        for (let i = 0; i < nr_weights; i++) {
            const bone = this.version === 1 ? r.readU32() : r.readU16();
            const weight = r.readF32();
            weights.push({bone, weight});
        }
        weights.sort((a, b) => b.weight - a.weight);
        return {x: pos.x, y: pos.y, z: pos.z, weights};
    }

    parse_triangle(r: BufferReader, nr_vertices: number, nr_uvs: number, nr_light_uvs: number, nr_colors: number, nr_alphas: number, material: MaterialInfo): Triangle {
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
        let light_uv_index: number[] = [];
        if (nr_light_uvs > 0) {
            light_uv_index = [
                r.readU32() - nr_uvs,
                r.readU32() - nr_uvs,
                r.readU32() - nr_uvs,
            ];
            for (let i = 0; i < 3; i++) {
                if (light_uv_index[i] < 0 || light_uv_index[i] >= nr_light_uvs) {
                    throw new Error(`light uv index out of range ${light_uv_index[i]} / ${nr_light_uvs}`);
                }
            }
        }
        const color_index = [];
        for (let i = 0; i < 3; i++) {
            const idx = r.readU32();
            if (nr_colors > 0 && idx >= nr_colors) {
                throw new Error(`color index out of range ${idx} / ${nr_colors}`);
            }
            color_index.push(idx);
        }
        const alpha_index = [];
        if (nr_alphas) {
            for (let i = 0; i < 3; i++) {
                const idx = r.readU32();
                if (idx >= nr_alphas) {
                    throw new Error(`alpha index out of range ${idx} / ${nr_alphas}`);
                }
                alpha_index.push(idx);
            }
        }
        const normals: Vec3[] = [];
        for (let i = 0; i < 3; i++) {
            normals.push(r.readDirection());
        }
        let material_index = r.readU32();
        if (material && material.children.length > 0 && material_index >= material.children.length) {
            material_index = 0;
        }
        return {vert_index, uv_index, light_uv_index, color_index, alpha_index, normals, material_index};
    }

    parse_bone(r: BufferReader): Bone {
        const name = r.readStrZ();
        const id = r.readS32();
        const parent = r.readS32();
        const pos = r.readPosition();
        const rotq = r.readQuaternion();
        return {name, id, parent, pos, rotq};
    }

    loadOpr(opr: string) {
        let currentMesh: Mesh | null = null;
        for (const line of opr.split('\n')) {
            const [key, value] = line.split('=').map(s => s.trim());
            if (!key && !value) {
                continue;
            }
            switch (key) {
                case 'BlendMode':
                    if (currentMesh) {
                        currentMesh.additiveBlending = value === 'Add';
                    }
                    break;
                case 'Edge':
                    if (currentMesh) {
                        currentMesh.noEdge = value === '0';
                    }
                    break;
                case 'EdgeColor':
                    if (currentMesh) {
                        currentMesh.edgeColor = value.slice(1, -1).split(',').map(Number);
                    }
                    break;
                case 'EdgeSize':
                    if (currentMesh) {
                        currentMesh.edgeSize = parseFloat(value);
                    }
                    break;
                case 'HeightDetection':
                    // do nothing
                    break;
                case 'Mesh':
                case 'MeshPart':
                    currentMesh = this.meshes.find(mesh => mesh?.name === value.slice(1, -1)) || null;
                    break;
                case 'MeshCombinable':
                    // ???
                    break;
                case 'UVScroll':
                    const [u, v] = value.slice(1, -1).split(',').map(Number);
                    if (currentMesh) {
                        currentMesh.uvScroll = {u, v};
                    }
                    break;
                default:
                    console.warn(`Unknown opr key: ${key}`);
            }
        }
    }
}
