import * as THREE from "three";
import { Loader } from './loader.ts';
import { Pol, Mesh, Bone, Triangle } from './pol.ts'
import { Mot, loadTxa } from './mot.ts';
import { Mpr, MprController } from './mpr.ts';
import { AnimatedMaterial, MaterialFactory } from './material_factory.ts';
import type { Vec3 } from './types.ts';

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
    private bonesByPolIndex: THREE.Bone[] = [];
    public collisionMesh: THREE.Mesh | null = null;
    private animatedMaterials: AnimatedMaterial[] = [];
    private meshObjects: Map<string, THREE.Mesh> = new Map();
    private mot: Mot | null = null;
    private txa: number[] | null = null;
    private mprController: MprController | null = null;
    private uvScollCallbacks: ((frameCount: number) => void)[] = [];

    async load(loader: Loader, polName: string) {
        const polDir = polName.replace(/(^|\\)[^\\]*$/, '$1');
        const oprName = polName.replace(/\.pol$/i, '.opr');
        const polData = await loader.load(polName);
        const opr = loader.exists(oprName) ? new TextDecoder('shift-jis').decode(await loader.load(oprName)) : undefined;
        const pol = new Pol(polData, opr);
        console.log(polName, pol);

        const factory = new MaterialFactory(loader, polDir, (o) => this.track(o));
        const materials: (THREE.Material | THREE.Material[])[] = [];
        for (let i = 0; i < pol.materials.length; i++) {
            const material = pol.materials[i];
            const isEnv = pol.meshes.some((m) => m && m.material === i && m.attrs.env)
            materials.push(await factory.create(material, isEnv));
        }
        this.animatedMaterials = factory.animatedMaterials;

        const skeleton = this.initBones(pol.bones);

        for (const mesh of pol.meshes) {
            if (!mesh) continue;
            if (mesh.material === -1) {
                // kage_esuka.POL in TT3 and mapS_0a.POL in RQ. Junk mesh, ignore.
                console.log(`${polName}: Mesh "${mesh.name}" has no material.`);
                continue;
            }
            const obj = this.initMesh(mesh, materials[mesh.material], skeleton);
            obj.name = mesh.name;
            if (mesh.name === 'collision') {
                this.collisionMesh = obj;
            } else {
                this.model.add(obj);
                this.meshObjects.set(mesh.name, obj);
            }
        }
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
        this.bonesByPolIndex = bones;
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

    private initMesh(mesh: Mesh, material: THREE.Material | THREE.Material[], skeleton: THREE.Skeleton | null): THREE.Mesh {
        const positions: number[] = [];
        const uvs: number[] = [];
        const light_uvs: number[] = [];
        const blend_uvs: number[] = [];
        const blend_weights: number[] = [];
        const colors: number[] = [];
        const normals: number[] = [];
        const skinIndices: number[] = [];
        const skinWeights: number[] = [];
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
                if (mesh.blendUvs) {
                    if (triangle.blend_uv_index.length > 0) {
                        const blend_uv = mesh.blendUvs[triangle.blend_uv_index[i]];
                        blend_uvs.push(blend_uv.u, blend_uv.v);
                    } else {
                        blend_uvs.push(uv.u, uv.v);
                    }
                }
                if (mesh.blendWeights) {
                    if (triangle.blend_weight_index.length > 0) {
                        blend_weights.push(mesh.blendWeights[triangle.blend_weight_index[i]]);
                    } else {
                        blend_weights.push(0);
                    }
                }
                if (mesh.colors) {
                    const color = mesh.colors[triangle.color_index[i]];
                    colors.push(color.x, color.y, color.z);
                } else {
                    colors.push(1, 1, 1);
                }
                if (mesh.alphas) {
                    colors.push(mesh.alphas[triangle.alpha_index[i]]);
                } else {
                    colors.push(1);
                }
                normals.push(triangle.normals[i].x, triangle.normals[i].y, triangle.normals[i].z);
                if (skeleton) {
                    for (let j = 0; j < 4; j++) {
                        if (j < pos.weights.length) {
                            skinIndices.push(this.boneMap.get(pos.weights[j].bone)!.skinIndex);
                            skinWeights.push(pos.weights[j].weight);
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
        if (mesh.light_uvs) {
            geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(light_uvs, 2));
        }
        if (mesh.blendUvs) {
            geometry.setAttribute('blendUv', new THREE.Float32BufferAttribute(blend_uvs, 2));
        }
        if (mesh.blendWeights) {
            geometry.setAttribute('blendWeight', new THREE.Float32BufferAttribute(blend_weights, 1));
        }
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
        if (groups) {
            for (const g of groups) {
                geometry.addGroup(g.start, g.count, g.materialIndex);
            }
        }
        if (mesh.uvScroll) {
            if (material instanceof THREE.Material) {
                const uvScroll = mesh.uvScroll;
                this.uvScollCallbacks.push((frameCount: number) => {
                    const t = frameCount / 30;
                    (material as THREE.MeshPhongMaterial).map?.offset.set(uvScroll.u * t, uvScroll.v * t);
                });
            } else {
                console.warn('UV scroll not supported for multi-material meshes');
            }
        }
        if (mesh.name.includes('(alpha)')) {
            if (material instanceof THREE.Material) {
                material.transparent = true;
            } else {
                console.warn('(alpha) attribute not supported for multi-material meshes');
            }
        }
        if (mesh.attrs.both) {
            if (material instanceof THREE.Material) {
                material.side = THREE.DoubleSide;
            } else {
                console.warn('(both) attribute not supported for multi-material meshes');
            }
        }
        if (mesh.specularColor || mesh.specularPower !== undefined) {
            const mats = Array.isArray(material) ? material : [material];
            for (const mat of mats) {
                if (mat instanceof THREE.MeshPhongMaterial) {
                    if (mesh.specularColor) {
                        mat.specular.setRGB(mesh.specularColor.x, mesh.specularColor.y, mesh.specularColor.z);
                    }
                    if (mesh.specularPower !== undefined) {
                        mat.shininess = mesh.specularPower;
                    }
                }
            }
        }
        if (mesh.additiveBlending) {
            if (material instanceof THREE.Material) {
                material.blending = THREE.AdditiveBlending;
            }
            else {
                console.warn('Additive blending not supported for multi-material meshes');
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

    async loadMotion(loader: Loader, fname: string) {
        this.mot = new Mot(await loader.load(fname));
        this.mprController?.dispose();
        this.mprController = null;
        this.txa = null;
        // .mpr (SealEngine) and .txa (TapirEngine) are mutually exclusive.
        const mprName = fname.replace(/\.mot$/i, '.mpr');
        const txaName = fname.replace(/\.mot$/i, '.txa');
        if (loader.exists(mprName)) {
            const text = new TextDecoder('shift-jis').decode(await loader.load(mprName));
            const mpr = Mpr.parse(text);
            this.mprController = new MprController(
                mpr, this.meshObjects, this.animatedMaterials, this.model,
                (m) => { this.track(m); },
            );
        } else if (loader.exists(txaName)) {
            this.txa = loadTxa(await loader.load(txaName));
        }
    }

    unloadMotion() {
        this.mot = null;
        this.mprController?.dispose();
        this.mprController = null;
    }

    async applyMotion(frameCount: number) {
        for (const scroll of this.uvScollCallbacks) {
            scroll(frameCount);
        }
        if (!this.mot) return;
        if (this.mot.bones.length !== this.bonesByPolIndex.length) {
            return;
        }
        for (let b = 0; b < this.mot.bones.length; b++) {
            // MOT bones are applied to POL bones purely by array index;
            // bone name and bone id are never used for matching.
            const bm = this.mot.bones[b];
            const bone = this.bonesByPolIndex[b];
            const i = frameCount % (bm.frames.length - 1) + 1;  // frames[0] is a T-pose
            const frame = bm.frames[i];
            bone.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
            bone.quaternion.set(frame.rotq.x, frame.rotq.y, frame.rotq.z, frame.rotq.w);
        }
        if (this.txa) {
            const textureIndex = this.txa[frameCount % this.txa.length];
            for (const { material, images } of this.animatedMaterials) {
                // Fallback to first image if index is out of bounds
                const image = images[textureIndex < images.length ? textureIndex : 0];
                if (material instanceof THREE.MeshPhongMaterial) {
                    material.map = image.texture;
                    material.map.needsUpdate = true;
                } else if (material instanceof THREE.MeshMatcapMaterial) {
                    material.matcap = image.texture;
                    material.matcap.needsUpdate = true;
                }
            }
        }
        if (this.mprController) {
            const f = frameCount % (this.mot.nr_frames - 1) + 1;
            this.mprController.apply(f);
        }
    }
}
