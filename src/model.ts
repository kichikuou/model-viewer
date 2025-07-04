import * as THREE from "three";
import { Image, Loader, loadImageList } from './loader.js';
import { Pol, TextureType, MaterialInfo, Mesh, Bone, Triangle } from './pol.js'
import { Mot, loadTxa } from './mot.js';
import { Vec3 } from './types.js';

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

type AnimatedMaterial = { material: THREE.Material, images: Image[] };

export class Model extends ResourceManager {
    readonly model = new THREE.Group();
    readonly boneMap: Map<number, {bone: THREE.Bone, info: Bone, skinIndex: number}> = new Map();
    readonly boneNameMap: Map<string, number | 'NONUNIQUE'> = new Map();
    public collisionMesh: THREE.Mesh | null = null;
    private animatedMaterials: AnimatedMaterial[] = [];
    private mot: Mot | null = null;
    private txa: number[] | null = null;
    private uvScollCallbacks: ((frameCount: number) => void)[] = [];

    async load(loader: Loader, polName: string) {
        const polDir = polName.replace(/(^|\\)[^\\]*$/, '$1');
        const oprName = polName.replace(/\.pol$/i, '.opr');
        const polData = await loader.load(polName);
        const opr = loader.exists(oprName) ? new TextDecoder('shift-jis').decode(await loader.load(oprName)) : undefined;
        const pol = new Pol(polData, opr);
        console.log(polName, pol);

        const materials: (THREE.Material | THREE.Material[])[] = [];
        for (let i = 0; i < pol.materials.length; i++) {
            const material = pol.materials[i];
            const isEnv = pol.meshes.some((m) => m && m.material === i && m.attrs.env)
            materials.push(await this.createMaterial(material, isEnv, loader, polDir));
        }

        const skeleton = this.initBones(pol.bones);

        for (const mesh of pol.meshes) {
            if (!mesh) continue;
            if (mesh.material === -1) {
                // kage_esuka.POL in TT3 and mapS_0a.POL in RQ. Junk mesh, ignore.
                console.log(`${polName}: Mesh "${mesh.name}" has no material.`);
                continue;
            }
            const obj = this.initMesh(mesh, materials[mesh.material], skeleton);
            if (mesh.name === 'collision') {
                this.collisionMesh = obj;
            } else {
                this.model.add(obj);
            }
        }
    }

    private async createMaterial(info: MaterialInfo, isEnv: boolean, loader: Loader, polDir: string): Promise<THREE.Material | THREE.Material[]> {
        const create = async (info: MaterialInfo) => {
            const textureInfo = info.textures;

            // Diffuse map
            const diffuseMapName = textureInfo.get(TextureType.ColorMap);
            if (!diffuseMapName) {
                console.log(`${info.name} has no diffuse map.`);
                return this.track(new THREE.MeshBasicMaterial());
            }
            const diffuseImages = await loadImageList(loader, polDir + diffuseMapName);
            for (const { texture } of diffuseImages) {
                this.track(texture);
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            }
            const diffuseImage = diffuseImages[0];
            const params: THREE.MeshPhongMaterialParameters & THREE.MeshMatcapMaterialParameters = {
                vertexColors: true
            };
            if (isEnv) {
                params.matcap = diffuseImage.texture;
            } else {
                params.map = diffuseImage.texture;
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
            if (alphaMapName && alphaMapName !== diffuseMapName) {
                const alphaImage = await loader.loadImage(polDir + alphaMapName);
                if (alphaImage.hasAlpha) {
                    console.warn(`Alpha image ${info.name} is not grayscale.`);
                }
                const alphaMap = this.track(alphaImage.texture);
                alphaMap.wrapS = alphaMap.wrapT = THREE.RepeatWrapping;
                params.alphaMap = alphaMap;
            }

            const material = this.track(isEnv ? new THREE.MeshMatcapMaterial(params) : new THREE.MeshPhongMaterial(params));
            if (params.alphaMap) {
                material.transparent = true;
            } else if (diffuseImage.hasAlpha) {
                material.alphaTest = 0.1;
            }
            material.normalScale.y *= -1;
            if (diffuseImages.length > 1) {
                this.animatedMaterials.push({ material, images: diffuseImages});
            }
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
            if (this.boneNameMap.has(b.name)) {
                console.log('Non-unique bone name: ' + b.name);
                this.boneNameMap.set(b.name, 'NONUNIQUE');
            } else {
                this.boneNameMap.set(b.name, b.id);
            }
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

    private initMesh(mesh: Mesh, material: THREE.Material | THREE.Material[], skeleton: THREE.Skeleton | null): THREE.Mesh {
        const positions: number[] = [];
        const uvs: number[] = [];
        const light_uvs: number[] = [];
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
        const txaName = fname.replace(/\.mot$/i, '.txa');
        if (loader.exists(txaName)) {
            this.txa = loadTxa(await loader.load(txaName));
        } else {
            this.txa = null;
        }
    }

    unloadMotion() {
        this.mot = null;
    }

    async applyMotion(frameCount: number) {
        for (const scroll of this.uvScollCallbacks) {
            scroll(frameCount);
        }
        if (!this.mot) return;
        for (const bm of this.mot.bones) {
            // Prefer match by name, as some MOT have wrong bm.id (e.g. maidsan_ahoge_*.MOT).
            // On the other hand, match by name does not work for some other POL
            // (e.g. masokan.POL) that have non-unique bone names.
            const boneId = this.boneNameMap.get(bm.name);
            const bone = this.boneMap.get(typeof(boneId) === 'number' ? boneId : bm.id)?.bone;
            if (!bone) {
                console.log(`No bone ${bm.name}`);
                continue;
            }
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
    }
}
