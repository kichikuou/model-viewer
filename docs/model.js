import * as THREE from "three";
import { Pol, TextureType } from './pol.js';
import { Mot } from './mot.js';
function toVector3(v) {
    return new THREE.Vector3(v.x, v.y, v.z);
}
class ResourceManager {
    constructor() {
        this.resources = [];
    }
    track(obj) {
        this.resources.push(obj);
        return obj;
    }
    dispose() {
        for (const obj of this.resources) {
            obj.dispose();
        }
        this.resources = [];
    }
}
export class Model extends ResourceManager {
    constructor() {
        super(...arguments);
        this.model = new THREE.Group();
        this.boneMap = new Map();
        this.mot = null;
    }
    async load(loader, polName) {
        const polDir = polName.replace(/(^|\\)[^\\]*$/, '$1');
        const polData = await loader.load(polName);
        const pol = new Pol(polData);
        const materials = [];
        for (const material of pol.materials) {
            materials.push(await this.createMaterial(material, loader, polDir));
        }
        const skeleton = this.initBones(pol.bones);
        for (const object of pol.objects) {
            if (!object)
                continue;
            this.model.add(this.initObject(object, materials, skeleton));
        }
    }
    async createMaterial(info, loader, polDir) {
        if (info.textures.size === 0)
            info = info.children[0]; // FIXME
        const textureInfo = info.textures;
        const fname = textureInfo.get(TextureType.ColorMap);
        const image = await loader.loadImage(polDir + fname);
        const texture = this.track(image.texture);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        // FIXME: Apply other textures
        const material = this.track(new THREE.MeshPhongMaterial({ map: texture }));
        if (image.hasAlpha) {
            material.transparent = true;
            material.alphaTest = 0.1;
        }
        return material;
    }
    initBones(polBones) {
        if (polBones.length === 0) {
            return null;
        }
        const bones = [];
        const boneInverses = [];
        for (const b of polBones) {
            const bone = new THREE.Bone();
            this.boneMap.set(b.id, { bone, info: b, skinIndex: bones.length });
            bones.push(bone);
            const pos = toVector3(b.pos);
            const rotq = new THREE.Quaternion(b.rotq.x, b.rotq.y, b.rotq.z, b.rotq.w);
            pos.applyQuaternion(rotq); // ?
            const inverse = new THREE.Matrix4();
            inverse.compose(pos, rotq, new THREE.Vector3(1, 1, 1));
            boneInverses.push(inverse);
        }
        for (const b of this.boneMap.values()) {
            if (b.info.parent < 0)
                continue;
            const parent = this.boneMap.get(b.info.parent);
            if (!parent) {
                throw new Error(`Parent bone ${b.info.parent} not found`);
            }
            parent.bone.add(b.bone);
        }
        return this.track(new THREE.Skeleton(bones, boneInverses));
    }
    initObject(object, materials, skeleton) {
        const positions = [];
        const uvs = [];
        const normals = [];
        const skinIndices = [];
        const skinWeights = [];
        for (const triangle of object.triangles) {
            for (let i = 0; i < 3; i++) {
                const pos = object.vertices[triangle.vert_index[i]];
                positions.push(pos.x, pos.y, pos.z);
                const uv = object.uvs[triangle.uv_index[i]];
                uvs.push(uv.u, uv.v);
                normals.push(triangle.normals[i].x, triangle.normals[i].y, triangle.normals[i].z);
                if (skeleton) {
                    for (let i = 0; i < 4; i++) {
                        if (i < pos.weights.length) {
                            skinIndices.push(this.boneMap.get(pos.weights[i].bone).skinIndex);
                            skinWeights.push(pos.weights[i].weight);
                        }
                        else {
                            skinIndices.push(0);
                            skinWeights.push(0);
                        }
                    }
                }
            }
        }
        const geometry = this.track(new THREE.BufferGeometry());
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        if (!skeleton) {
            return new THREE.Mesh(geometry, materials[object.material]);
        }
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
        const mesh = new THREE.SkinnedMesh(geometry, materials[object.material]);
        mesh.normalizeSkinWeights();
        skeleton.pose(); // initialize bones' positions and rotations from the inverse matrices
        for (const b of this.boneMap.values()) {
            if (!b.bone.parent)
                mesh.add(b.bone);
        }
        mesh.bind(skeleton);
        // this.model.add(new THREE.SkeletonHelper(mesh));
        return mesh;
    }
    async loadMotion(loader, fname) {
        console.log(fname);
        this.mot = new Mot(await loader.load(fname));
        console.log('Motion loaded');
    }
    unloadMotion() {
        this.mot = null;
    }
    async applyMotion(frameCount) {
        if (!this.mot)
            return;
        for (const bm of this.mot.bones) {
            const bone = this.boneMap.get(bm.id).bone;
            const i = frameCount % (bm.frames.length - 1) + 1; // frames[0] is a T-pose
            const frame = bm.frames[i];
            bone.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
            bone.quaternion.set(frame.rotq.x, frame.rotq.y, frame.rotq.z, frame.rotq.w);
        }
    }
}
