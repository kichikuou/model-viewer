import * as THREE from "three";
import {Loader} from './loader.js';
import {Pol, TextureType, MaterialInfo, Object, Bone, Triangle} from './pol.js'
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

        const materials: (THREE.Material | THREE.Material[])[] = [];
        for (const material of pol.materials) {
            materials.push(await this.createMaterial(material, loader, polDir));
        }

        const skeleton = this.initBones(pol.bones);

        for (const object of pol.objects) {
            if (!object) continue;
            this.model.add(this.initObject(object, materials[object.material], skeleton));
        }
    }

    private async createMaterial(info: MaterialInfo, loader: Loader, polDir: string): Promise<THREE.Material | THREE.Material[]> {
        const create = async (info: MaterialInfo) => {
            const textureInfo = info.textures;

            // Diffuse map
            const diffuseMapName = textureInfo.get(TextureType.ColorMap);
            if (!diffuseMapName) {
                console.log(`${info.name} has no diffuse map.`);
                return this.track(new THREE.MeshBasicMaterial());
            }
            const diffuseImage = await loader.loadImage(polDir + diffuseMapName);
            const diffuseMap = this.track(diffuseImage.texture);
            diffuseMap.wrapS = diffuseMap.wrapT = THREE.RepeatWrapping;
            const params: THREE.MeshPhongMaterialParameters = { map: diffuseMap };

            // Normal map
            const normalMapName = textureInfo.get(TextureType.NormalMap);
            if (normalMapName) {
                const normalImage = await loader.loadImage(polDir + normalMapName);
                const normalMap = this.track(normalImage.texture);
                normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
                params.normalMap = normalMap;
            }

            // Light map
            const lightMapName = textureInfo.get(TextureType.LightMap);
            if (lightMapName) {
                const lightImage = await loader.loadImage(polDir + lightMapName);
                const lightMap = this.track(lightImage.texture);
                lightMap.wrapS = lightMap.wrapT = THREE.RepeatWrapping;
                params.lightMap = lightMap;
                params.lightMapIntensity = 0.5;
            }

            const material = this.track(new THREE.MeshPhongMaterial(params));
            if (diffuseImage.hasAlpha) {
                material.transparent = true;
                material.alphaTest = 0.1;
            }
            material.normalScale.y *= -1;
            return material;
        };
        if (info.textures.size > 0) {
            return create(info);
        }
        return Promise.all(info.children.map(create));
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
            rotq.normalize();
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
        const skeleton = this.track(new THREE.Skeleton(bones, boneInverses));
        skeleton.pose();  // initialize bones' positions and rotations from the inverse matrices
        return skeleton;
    }

    private initGroups(materials: THREE.Material | THREE.Material[], triangles: Triangle[]): { start: number, count: number, materialIndex: number }[] | null {
        if (materials instanceof THREE.Material) {
            return null;
        }
        triangles.sort((a, b) => a.material_index - b.material_index);
        let materialIndex = 0;
        let start = 0;
        const result = [];
        for (let i = 0; i < triangles.length; i++) {
            while (triangles[i].material_index > materialIndex) {
                const count = i - start;
                result.push({start: start * 3, count: count * 3, materialIndex});
                start = i;
                materialIndex++;
            }
        }
        while (materialIndex < materials.length) {
            const count = triangles.length - start;
            result.push({start: start * 3, count: count * 3, materialIndex});
            start = triangles.length;
            materialIndex++;
        }
        return result;
    }

    private initObject(object: Object, material: THREE.Material | THREE.Material[], skeleton: THREE.Skeleton | null): THREE.Mesh {
        const positions: number[] = [];
        const uvs: number[] = [];
        const light_uvs: number[] = [];
        const normals: number[] = [];
        const skinIndices: number[] = [];
        const skinWeights: number[] = [];
        const groups = this.initGroups(material, object.triangles);
        for (const triangle of object.triangles) {
            for (let i = 0; i < 3; i++) {
                const pos = object.vertices[triangle.vert_index[i]];
                positions.push(pos.x, pos.y, pos.z);
                const uv = object.uvs[triangle.uv_index[i]];
                uvs.push(uv.u, uv.v);
                if (object.light_uvs) {
                    const light_uv = object.light_uvs[triangle.light_uv_index[i]];
                    light_uvs.push(light_uv.u, light_uv.v);
                }
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
        if (object.light_uvs) {
            geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(light_uvs, 2));
        }
        if (groups) {
            console.log(object.name, groups, material);
            for (const g of groups) {
                geometry.addGroup(g.start, g.count, g.materialIndex);
            }
        }
        if (!skeleton) {
            return new THREE.Mesh(geometry, material);
        }
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.normalizeSkinWeights();
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
