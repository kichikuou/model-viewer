import * as THREE from "three";
import { Image, Loader, loadImageList } from './loader.ts';
import { TextureType, MaterialInfo } from './pol.ts';

export type AnimatedMaterial = { material: THREE.Material, images: Image[] };

interface Disposable { dispose(): void; }

// Builds three.js materials from POL `MaterialInfo` nodes. Owns texture
// loading via `Loader` and reports cloning-eligible animated materials
// (multi-frame diffuse) through `animatedMaterials` for later TXA/MPR use.
export class MaterialFactory {
    readonly animatedMaterials: AnimatedMaterial[] = [];

    constructor(
        private readonly loader: Loader,
        private readonly polDir: string,
        private readonly track: <T extends Disposable>(obj: T) => T,
    ) {}

    async create(info: MaterialInfo, isEnv: boolean): Promise<THREE.Material | THREE.Material[]> {
        if (info.textures.size > 0) {
            return this.createLeaf(info, isEnv);
        }
        return Promise.all(info.children.map((child) => {
            if (child.children.length > 0 && child.textures.size === 0) {
                return this.createBlended(child, isEnv);
            }
            return this.createLeaf(child, isEnv);
        }));
    }

    private async createLeaf(info: MaterialInfo, isEnv: boolean): Promise<THREE.Material> {
        const textureInfo = info.textures;

        // Diffuse map
        const diffuseMapName = textureInfo.get(TextureType.ColorMap);
        if (!diffuseMapName) {
            console.log(`${info.name} has no diffuse map.`);
            return this.track(new THREE.MeshBasicMaterial());
        }
        const diffuseImages = await loadImageList(this.loader, this.polDir + diffuseMapName);
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
            const normalImage = await this.loader.loadImage(this.polDir + normalMapName);
            const normalMap = this.track(normalImage.texture);
            normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
            params.normalMap = normalMap;
        }

        // Light map
        const lightMapName = textureInfo.get(TextureType.LightMap);
        if (lightMapName) {
            const lightImage = await this.loader.loadImage(this.polDir + lightMapName);
            const lightMap = this.track(lightImage.texture);
            lightMap.wrapS = lightMap.wrapT = THREE.RepeatWrapping;
            params.lightMap = lightMap;
            params.lightMapIntensity = 0.5;
        }

        // Alpha map
        const alphaMapName = textureInfo.get(TextureType.AlphaMap);
        if (alphaMapName && alphaMapName !== diffuseMapName) {
            const alphaImage = await this.loader.loadImage(this.polDir + alphaMapName);
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
    }

    // Group node: blend grandchild[0] (base) and grandchild[1] (blend) textures.
    private async createBlended(group: MaterialInfo, isEnv: boolean): Promise<THREE.Material> {
        const baseMat = group.children[0];
        const blendMat = group.children[1];
        const material = await this.createLeaf(baseMat, isEnv) as THREE.MeshPhongMaterial;

        const blendDiffuseName = blendMat.textures.get(TextureType.ColorMap);
        if (!blendDiffuseName) {
            return material;
        }
        const blendImage = await this.loader.loadImage(this.polDir + blendDiffuseName);
        const blendMap = this.track(blendImage.texture);
        blendMap.wrapS = blendMap.wrapT = THREE.RepeatWrapping;

        material.onBeforeCompile = (shader) => {
            shader.uniforms.blendMap = { value: blendMap };
            shader.vertexShader = shader.vertexShader.replace(
                'void main() {',
                `attribute vec2 blendUv;
attribute float blendWeight;
varying vec2 vBlendUv;
varying float vBlendWeight;
void main() {
    vBlendUv = blendUv;
    vBlendWeight = blendWeight;`
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                'void main() {',
                `uniform sampler2D blendMap;
varying vec2 vBlendUv;
varying float vBlendWeight;
void main() {`
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `#include <map_fragment>
    {
        vec4 blendTexel = texture2D(blendMap, vBlendUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, blendTexel.rgb, vBlendWeight);
    }`
            );
        };
        return material;
    }
}
