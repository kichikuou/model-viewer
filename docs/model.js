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
        this.boneNameMap = new Map();
        this.mot = null;
    }
    async load(loader, polName) {
        const polDir = polName.replace(/(^|\\)[^\\]*$/, '$1');
        const polData = await loader.load(polName);
        const pol = new Pol(polData);
        const materials = [];
        for (let i = 0; i < pol.materials.length; i++) {
            const material = pol.materials[i];
            const isEnv = pol.meshes.some((m) => m && m.material === i && m.name.indexOf('(env)') >= 0);
            materials.push(await this.createMaterial(material, isEnv, loader, polDir));
        }
        const skeleton = this.initBones(pol.bones);
        for (const mesh of pol.meshes) {
            if (!mesh)
                continue;
            this.model.add(this.initMesh(mesh, materials[mesh.material], skeleton));
        }
    }
    async createMaterial(info, isEnv, loader, polDir) {
        const create = async (info) => {
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
            const params = {};
            if (isEnv) {
                params.matcap = diffuseMap;
            }
            else {
                params.map = diffuseMap;
            }
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
            // Alpha map
            const alphaMapName = textureInfo.get(TextureType.AlphaMap);
            if (alphaMapName) {
                const alphaImage = await loader.loadImage(polDir + alphaMapName);
                const alphaMap = this.track(alphaImage.texture);
                alphaMap.wrapS = alphaMap.wrapT = THREE.RepeatWrapping;
                params.alphaMap = alphaMap;
            }
            const material = this.track(isEnv ? new THREE.MeshMatcapMaterial(params) : new THREE.MeshPhongMaterial(params));
            if (alphaMapName) {
                material.transparent = true;
            }
            else if (diffuseImage.hasAlpha) {
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
    initBones(polBones) {
        if (polBones.length === 0) {
            return null;
        }
        const bones = [];
        const boneInverses = [];
        for (const b of polBones) {
            const bone = new THREE.Bone();
            this.boneMap.set(b.id, { bone, info: b, skinIndex: bones.length });
            if (this.boneNameMap.has(b.name)) {
                console.log('Non-unique bone name: ' + b.name);
                this.boneNameMap.set(b.name, 'NONUNIQUE');
            }
            else {
                this.boneNameMap.set(b.name, b.id);
            }
            bones.push(bone);
            const pos = toVector3(b.pos);
            const rotq = new THREE.Quaternion(b.rotq.x, b.rotq.y, b.rotq.z, b.rotq.w);
            rotq.normalize();
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
        const skeleton = this.track(new THREE.Skeleton(bones, boneInverses));
        skeleton.pose(); // initialize bones' positions and rotations from the inverse matrices
        return skeleton;
    }
    initGroups(materials, triangles) {
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
                result.push({ start: start * 3, count: count * 3, materialIndex });
                start = i;
                materialIndex++;
            }
        }
        while (materialIndex < materials.length) {
            const count = triangles.length - start;
            result.push({ start: start * 3, count: count * 3, materialIndex });
            start = triangles.length;
            materialIndex++;
        }
        return result;
    }
    initMesh(mesh, material, skeleton) {
        const positions = [];
        const uvs = [];
        const light_uvs = [];
        const normals = [];
        const skinIndices = [];
        const skinWeights = [];
        const groups = this.initGroups(material, mesh.triangles);
        for (const triangle of mesh.triangles) {
            for (let i = 0; i < 3; i++) {
                const pos = mesh.vertices[triangle.vert_index[i]];
                positions.push(pos.x, pos.y, pos.z);
                const uv = mesh.uvs[triangle.uv_index[i]];
                uvs.push(uv.u, uv.v);
                if (mesh.light_uvs) {
                    const light_uv = mesh.light_uvs[triangle.light_uv_index[i]];
                    light_uvs.push(light_uv.u, light_uv.v);
                }
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
        if (mesh.light_uvs) {
            geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(light_uvs, 2));
        }
        if (groups) {
            console.log(mesh.name, groups, material);
            for (const g of groups) {
                geometry.addGroup(g.start, g.count, g.materialIndex);
            }
        }
        if (!skeleton) {
            return new THREE.Mesh(geometry, material);
        }
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
        const result = new THREE.SkinnedMesh(geometry, material);
        result.normalizeSkinWeights();
        for (const b of this.boneMap.values()) {
            if (!b.bone.parent)
                result.add(b.bone);
        }
        result.bind(skeleton);
        // this.model.add(new THREE.SkeletonHelper(result));
        return result;
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
        var _a;
        if (!this.mot)
            return;
        for (const bm of this.mot.bones) {
            // Prefer match by name, as some MOT have wrong bm.id (e.g. maidsan_ahoge_*.MOT).
            // On the other hand, match by name does not work for some other POL
            // (e.g. masokan.POL) that have non-unique bone names.
            const boneId = this.boneNameMap.get(bm.name);
            const bone = (_a = this.boneMap.get(typeof (boneId) === 'number' ? boneId : bm.id)) === null || _a === void 0 ? void 0 : _a.bone;
            if (!bone) {
                console.log(`No bone ${bm.name}`);
                continue;
            }
            const i = frameCount % (bm.frames.length - 1) + 1; // frames[0] is a T-pose
            const frame = bm.frames[i];
            bone.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
            bone.quaternion.set(frame.rotq.x, frame.rotq.y, frame.rotq.z, frame.rotq.w);
        }
    }
}
