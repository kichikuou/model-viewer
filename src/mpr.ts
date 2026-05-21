// Parser and evaluator for `.mpr` files (motion material keyframes).
//
// Sidecar of `.mot`; describes keyframes synchronized to motion playback that
// modulate material properties (alpha multiply, diffuse multiply, ambient
// additive offset, texture index). Plaintext, `Key = (frame, ...)` lines.
// `Mesh = "name"` opens a section scoped to that mesh; `Object*` lines apply
// to the whole object regardless of section.

import * as THREE from "three";
import { Image } from './loader.ts';
import type { AnimatedMaterial } from './model.ts';

export type FloatKey = { frame: number, value: number };
export type Vec3Key  = { frame: number, r: number, g: number, b: number };
export type IntKey   = { frame: number, value: number };

export type MeshTrack = {
    mulAlpha?:     FloatKey[];
    mulDiffuse?:   Vec3Key[];
    addAmbient?:   Vec3Key[];
    textureAnime?: IntKey[];
};

export type ObjectTrack = {
    mulAlpha?:   FloatKey[];
    mulDiffuse?: Vec3Key[];
    addAmbient?: Vec3Key[];
};

export class Mpr {
    readonly meshes: Map<string, MeshTrack> = new Map();
    readonly object: ObjectTrack = {};

    static parse(text: string): Mpr {
        const mpr = new Mpr();
        let current: MeshTrack | null = null;
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            if (key === 'Mesh') {
                const name = value.replace(/^"|"$/g, '');
                let track = mpr.meshes.get(name);
                if (!track) {
                    track = {};
                    mpr.meshes.set(name, track);
                }
                current = track;
                continue;
            }
            const args = parseArgs(value);
            if (!args) {
                console.warn(`mpr: cannot parse value for ${key}: ${value}`);
                continue;
            }
            switch (key) {
                case 'MeshMulAlpha':
                    if (!current) { console.warn('mpr: MeshMulAlpha outside Mesh scope'); break; }
                    (current.mulAlpha ??= []).push({ frame: args[0], value: args[1] });
                    break;
                case 'MeshMulDiffuse':
                    if (!current) { console.warn('mpr: MeshMulDiffuse outside Mesh scope'); break; }
                    (current.mulDiffuse ??= []).push({ frame: args[0], r: args[1], g: args[2], b: args[3] });
                    break;
                case 'MeshAddAmbient':
                    if (!current) { console.warn('mpr: MeshAddAmbient outside Mesh scope'); break; }
                    (current.addAmbient ??= []).push({ frame: args[0], r: args[1], g: args[2], b: args[3] });
                    break;
                case 'MeshTextureAnime':
                    if (!current) { console.warn('mpr: MeshTextureAnime outside Mesh scope'); break; }
                    (current.textureAnime ??= []).push({ frame: args[0] | 0, value: args[1] | 0 });
                    break;
                case 'ObjectMulAlpha':
                    (mpr.object.mulAlpha ??= []).push({ frame: args[0], value: args[1] });
                    break;
                case 'ObjectMulDiffuse':
                    (mpr.object.mulDiffuse ??= []).push({ frame: args[0], r: args[1], g: args[2], b: args[3] });
                    break;
                case 'ObjectAddAmbient':
                    (mpr.object.addAmbient ??= []).push({ frame: args[0], r: args[1], g: args[2], b: args[3] });
                    break;
                default:
                    console.warn(`Unknown mpr key: ${key}`);
            }
        }
        const sortByFrame = <T extends { frame: number }>(a: T[] | undefined) => a?.sort((x, y) => x.frame - y.frame);
        for (const t of mpr.meshes.values()) {
            sortByFrame(t.mulAlpha);
            sortByFrame(t.mulDiffuse);
            sortByFrame(t.addAmbient);
            sortByFrame(t.textureAnime);
        }
        sortByFrame(mpr.object.mulAlpha);
        sortByFrame(mpr.object.mulDiffuse);
        sortByFrame(mpr.object.addAmbient);
        return mpr;
    }

    static evalFloat(keys: FloatKey[] | undefined, frame: number, def: number): number {
        if (!keys || keys.length === 0) return def;
        if (frame <= keys[0].frame) return keys[0].value;
        if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;
        for (let i = 1; i < keys.length; i++) {
            if (frame <= keys[i].frame) {
                const a = keys[i - 1], b = keys[i];
                const t = (frame - a.frame) / (b.frame - a.frame);
                return a.value + (b.value - a.value) * t;
            }
        }
        return keys[keys.length - 1].value;
    }

    static evalVec3(
        keys: Vec3Key[] | undefined, frame: number,
        defR: number, defG: number, defB: number,
    ): { r: number, g: number, b: number } {
        if (!keys || keys.length === 0) return { r: defR, g: defG, b: defB };
        const last = keys[keys.length - 1];
        if (frame <= keys[0].frame) return { r: keys[0].r, g: keys[0].g, b: keys[0].b };
        if (frame >= last.frame) return { r: last.r, g: last.g, b: last.b };
        for (let i = 1; i < keys.length; i++) {
            if (frame <= keys[i].frame) {
                const a = keys[i - 1], b = keys[i];
                const t = (frame - a.frame) / (b.frame - a.frame);
                return {
                    r: a.r + (b.r - a.r) * t,
                    g: a.g + (b.g - a.g) * t,
                    b: a.b + (b.b - a.b) * t,
                };
            }
        }
        return { r: last.r, g: last.g, b: last.b };
    }

    // Step lookup: returns the value of the keyframe whose frame <= given frame.
    // Returns null when there are no keys at or before the frame.
    static evalStep(keys: IntKey[] | undefined, frame: number): number | null {
        if (!keys || keys.length === 0) return null;
        if (frame < keys[0].frame) return null;
        let result = keys[0].value;
        for (let i = 1; i < keys.length; i++) {
            if (frame >= keys[i].frame) result = keys[i].value;
            else break;
        }
        return result;
    }
}

function parseArgs(value: string): number[] | null {
    const m = value.match(/^\(\s*(.*?)\s*\)\s*$/);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.some(n => Number.isNaN(n))) return null;
    return parts;
}

type MaterialBaseline = {
    opacity: number,
    transparent: boolean,
    color: THREE.Color,
    emissive: THREE.Color | null,
    map: THREE.Texture | null,
    matcap: THREE.Texture | null,
};

// Per-mesh override built when a `.mpr` is loaded.
// - `originalMaterials` are the materials the mesh used before mpr (possibly
//   shared with sibling meshes).
// - When the mesh has tint ops (MulAlpha/MulDiffuse/AddAmbient), `clones`
//   holds per-mesh clones and `mesh.material` is swapped to them so tints
//   stay local. Otherwise `clones` is null and texture writes go to the
//   shared original so sibling meshes using the same material animate too.
type MeshOverride = {
    mesh: THREE.Mesh,
    originalMaterials: THREE.Material[],
    clones: THREE.Material[] | null,
    textureImages: (Image[] | null)[],   // parallel to originalMaterials
};

export class MprController {
    private baselines: Map<THREE.Material, MaterialBaseline> = new Map();
    private overrides: Map<string, MeshOverride> = new Map();

    constructor(
        private readonly mpr: Mpr,
        private readonly meshObjects: Map<string, THREE.Mesh>,
        private readonly animatedMaterials: AnimatedMaterial[],
        private readonly modelGroup: THREE.Group,
        private readonly trackMaterial: (m: THREE.Material) => void,
    ) {
        this.prepareMaterials();
    }

    private prepareMaterials() {
        const hasObjAlpha = !!this.mpr.object.mulAlpha;
        for (const [name, track] of this.mpr.meshes) {
            const mesh = this.meshObjects.get(name);
            if (!mesh) continue;
            const origMat = mesh.material;
            const origList: THREE.Material[] = Array.isArray(origMat) ? origMat : [origMat];
            const needsTint = !!(track.mulAlpha || track.mulDiffuse || track.addAmbient);
            const needsTransparent = !!(track.mulAlpha || hasObjAlpha);
            const images = origList.map(m => this.findImagesFor(m));

            // Always capture baselines on the shared originals. They're used
            // by object-scope writes and as the restore target on unload.
            for (const m of origList) {
                if (needsTransparent) m.transparent = true;
                if (!this.baselines.has(m)) {
                    this.baselines.set(m, this.captureBaseline(m));
                }
            }

            // Clone so per-mesh tints don't bleed to meshes sharing this
            // material (e.g. tourin: arrow shares its atlas with bow). When
            // there are no tint ops, skip cloning so texture writes reach
            // sibling meshes (e.g. hanny_black: hibana_R drives hibana_L).
            let clones: THREE.Material[] | null = null;
            if (needsTint) {
                clones = origList.map(m => {
                    const c = m.clone();
                    this.trackMaterial(c);
                    if (needsTransparent) c.transparent = true;
                    this.baselines.set(c, this.captureBaseline(c));
                    return c;
                });
                mesh.material = Array.isArray(origMat) ? clones : clones[0];
            }

            this.overrides.set(name, {
                mesh, originalMaterials: origList, clones, textureImages: images,
            });
        }
        // For Object* scope, also capture baselines on every other material.
        if (this.hasObjectScope()) {
            this.modelGroup.traverse((obj) => {
                if (!(obj instanceof THREE.Mesh)) return;
                const mats: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) {
                    if (this.baselines.has(m)) continue;
                    if (hasObjAlpha) m.transparent = true;
                    this.baselines.set(m, this.captureBaseline(m));
                }
            });
        }
    }

    private hasObjectScope(): boolean {
        const o = this.mpr.object;
        return !!(o.mulAlpha || o.mulDiffuse || o.addAmbient);
    }

    private findImagesFor(material: THREE.Material): Image[] | null {
        for (const am of this.animatedMaterials) {
            if (am.material === material) return am.images;
        }
        return null;
    }

    private captureBaseline(m: THREE.Material): MaterialBaseline {
        const phong = m instanceof THREE.MeshPhongMaterial ? m : null;
        const matcap = m instanceof THREE.MeshMatcapMaterial ? m : null;
        const basic = m as unknown as { color?: THREE.Color, opacity?: number, transparent?: boolean };
        return {
            opacity: basic.opacity ?? 1,
            transparent: basic.transparent ?? false,
            color: basic.color ? basic.color.clone() : new THREE.Color(1, 1, 1),
            emissive: phong ? phong.emissive.clone() : null,
            map: phong ? phong.map : null,
            matcap: matcap ? matcap.matcap : null,
        };
    }

    dispose() {
        // Restore every modified material's baseline values.
        for (const [m, base] of this.baselines) {
            const basic = m as unknown as { color?: THREE.Color, opacity?: number, transparent?: boolean };
            if (basic.color) basic.color.copy(base.color);
            if (basic.opacity !== undefined) basic.opacity = base.opacity;
            if (basic.transparent !== undefined) basic.transparent = base.transparent;
            if (m instanceof THREE.MeshPhongMaterial) {
                if (base.emissive) m.emissive.copy(base.emissive);
                if (base.map) { m.map = base.map; m.map.needsUpdate = true; }
            } else if (m instanceof THREE.MeshMatcapMaterial) {
                if (base.matcap) { m.matcap = base.matcap; m.matcap.needsUpdate = true; }
            }
        }
        // Revert cloned meshes' material assignments back to the originals.
        for (const ov of this.overrides.values()) {
            if (!ov.clones) continue;
            ov.mesh.material = Array.isArray(ov.mesh.material)
                ? ov.originalMaterials
                : ov.originalMaterials[0];
        }
        this.baselines.clear();
        this.overrides.clear();
    }

    apply(frame: number) {
        const obj = this.mpr.object;
        const objA = Mpr.evalFloat(obj.mulAlpha, frame, 1);
        const objD = Mpr.evalVec3(obj.mulDiffuse, frame, 1, 1, 1);
        const objE = Mpr.evalVec3(obj.addAmbient, frame, 0, 0, 0);
        // Pass 1: apply object-scope tint to every tracked material.
        // For cloned meshes both the clone and the original receive the
        // same object-scope values; the per-mesh pass below then stacks
        // mesh-scope on top of the clones only.
        for (const m of this.baselines.keys()) {
            this.applyTintToMaterial(m, objA, objD, objE);
        }
        // Pass 2: per-mesh values. Tints write to clones if any,
        // otherwise to originals. Texture index always writes to the
        // shared originals so sibling meshes animate, and additionally
        // to the clones so the cloned mesh sees the change (after
        // clone() the .map field is a separate reference).
        for (const [name, track] of this.mpr.meshes) {
            const ov = this.overrides.get(name);
            if (!ov) continue;
            const a = objA * Mpr.evalFloat(track.mulAlpha, frame, 1);
            const md = Mpr.evalVec3(track.mulDiffuse, frame, 1, 1, 1);
            const d = { r: objD.r * md.r, g: objD.g * md.g, b: objD.b * md.b };
            const ma = Mpr.evalVec3(track.addAmbient, frame, 0, 0, 0);
            const e = { r: objE.r + ma.r, g: objE.g + ma.g, b: objE.b + ma.b };
            for (const m of ov.clones ?? ov.originalMaterials) {
                this.applyTintToMaterial(m, a, d, e);
            }
            const texIdx = Mpr.evalStep(track.textureAnime, frame);
            if (texIdx !== null) {
                for (let i = 0; i < ov.originalMaterials.length; i++) {
                    this.writeTextureToMaterial(ov.originalMaterials[i], texIdx, ov.textureImages[i]);
                    if (ov.clones) {
                        this.writeTextureToMaterial(ov.clones[i], texIdx, ov.textureImages[i]);
                    }
                }
            }
        }
    }

    private applyTintToMaterial(
        m: THREE.Material,
        alpha: number,
        diffuse: { r: number, g: number, b: number },
        ambient: { r: number, g: number, b: number },
    ) {
        const base = this.baselines.get(m);
        if (!base) return;
        const basic = m as unknown as { color?: THREE.Color, opacity?: number };
        if (basic.opacity !== undefined) basic.opacity = base.opacity * alpha;
        if (basic.color) basic.color.setRGB(base.color.r * diffuse.r, base.color.g * diffuse.g, base.color.b * diffuse.b);
        if (m instanceof THREE.MeshPhongMaterial) {
            m.emissive.setRGB(
                (base.emissive ? base.emissive.r : 0) + ambient.r,
                (base.emissive ? base.emissive.g : 0) + ambient.g,
                (base.emissive ? base.emissive.b : 0) + ambient.b,
            );
        }
    }

    private writeTextureToMaterial(m: THREE.Material, texIdx: number, images: Image[] | null) {
        if (!images) return;
        const img = images[texIdx < images.length ? texIdx : 0];
        if (m instanceof THREE.MeshPhongMaterial) {
            m.map = img.texture;
            m.map.needsUpdate = true;
        } else if (m instanceof THREE.MeshMatcapMaterial) {
            m.matcap = img.texture;
            m.matcap.needsUpdate = true;
        }
    }
}
