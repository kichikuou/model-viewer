import * as THREE from "three";
import {Loader} from './loader.js';
import {Pol, TextureType, MaterialInfo, Object, Bone, Vertex} from './pol.js'
import {Mot} from './mot.js';
import {Vec3} from './types.js';

function toVector3(v: Vec3): THREE.Vector3 {
    return new THREE.Vector3(v.x, v.y, v.z);
}

interface Disposable {
    dispose(): void;
}

class ResourceManager {
    private resources: Disposable[] = [];

    protected track<T extends Disposable>(obj: T): T {
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
    readonly model = new THREE.Group();
    readonly boneMap: Map<number, {bone: THREE.Bone, info: Bone, skinIndex: number}> = new Map();
    private mot: Mot | null = null;

    async load(loader: Loader, polName: string) {
        const polDir = polName.replace(/(^|\\)[^\\]*$/, '$1');
        const polData = await loader.load(polName);
        const pol = new Pol(polData);

        const materials: THREE.Material[] = [];
        for (const material of pol.materials) {
            materials.push(await this.createMaterial(material, loader, polDir));
        }

        const skeleton = this.initBones(pol.bones);

        for (const object of pol.objects) {
            if (!object) continue;
            this.model.add(this.initObject(object, materials, skeleton));
        }
    }

    private async createMaterial(info: MaterialInfo, loader: Loader, polDir: string): Promise<THREE.Material> {
        if (info.textures.size === 0)
            info = info.children[0];  // FIXME
        const textureInfo = info.textures;
        const fname = textureInfo.get(TextureType.ColorMap)!
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

    private initBones(polBones: Bone[]): THREE.Skeleton | null {
        if (polBones.length === 0) {
            return null;
        }
        const bones: THREE.Bone[] = [];
        const boneInverses: THREE.Matrix4[] = [];
        for (const b of polBones) {
            const bone = new THREE.Bone();
            this.boneMap.set(b.id, {bone, info: b, skinIndex: bones.length});
            bones.push(bone);
            const pos = toVector3(b.pos);
            const rotq = new THREE.Quaternion(b.rotq.x, b.rotq.y, b.rotq.z, b.rotq.w);
            pos.applyQuaternion(rotq);  // ?
            const inverse = new THREE.Matrix4();
            inverse.compose(pos, rotq, new THREE.Vector3(1, 1, 1));
            boneInverses.push(inverse);
        }
        for (const b of this.boneMap.values()) {
            if (b.info.parent < 0) continue;
            const parent = this.boneMap.get(b.info.parent);
            if (!parent) {
                throw new Error(`Parent bone ${b.info.parent} not found`);
            }
            parent.bone.add(b.bone);
        }
        return this.track(new THREE.Skeleton(bones, boneInverses));
    }

    private initObject(object: Object, materials: THREE.Material[], skeleton: THREE.Skeleton | null): THREE.Mesh {
        const positions: number[] = [];
        const uvs: number[] = [];
        const normals: number[] = [];
        const skinIndices: number[] = [];
        const skinWeights: number[] = [];
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
                            skinIndices.push(this.boneMap.get(pos.weights[i].bone)!.skinIndex);
                            skinWeights.push(pos.weights[i].weight);
                        } else {
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
        skeleton.pose();  // initialize bones' positions and rotations from the inverse matrices
        for (const b of this.boneMap.values()) {
            if (!b.bone.parent)
                mesh.add(b.bone);
        }
        mesh.bind(skeleton);
        // this.model.add(new THREE.SkeletonHelper(mesh));
        return mesh;
    }

    async loadMotion(loader: Loader, fname: string) {
        console.log(fname);
        this.mot = new Mot(await loader.load(fname));
        console.log('Motion loaded');
    }

    unloadMotion() {
        this.mot = null;
    }

    async applyMotion(frameCount: number) {
        if (!this.mot) return;
        for (const bm of this.mot.bones) {
            const bone = this.boneMap.get(bm.id)!.bone;
            const i = frameCount % (bm.frames.length - 1) + 1;  // frames[0] is a T-pose
            const frame = bm.frames[i];
            bone.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
            bone.quaternion.set(frame.rotq.x, frame.rotq.y, frame.rotq.z, frame.rotq.w);
        }
    }
}
