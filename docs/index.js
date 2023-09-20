// src/index.ts
import * as THREE3 from "three";
import {OrbitControls as OrbitControls2} from "three/examples/jsm/controls/OrbitControls.js";

// src/loader.ts
import * as THREE from "three";

// src/buffer.ts
function readFileAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader;
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.onerror = () => {
      reject(reader.error);
    };
    reader.readAsArrayBuffer(blob);
  });
}
var METERS_PER_INCH = 0.0254;

class BufferReader {
  view;
  offset = 0;
  constructor(buf) {
    this.view = new DataView(buf);
  }
  get buffer() {
    return this.view.buffer;
  }
  readU8() {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }
  readU16() {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }
  readU32() {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }
  readS32() {
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }
  readF32() {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }
  readF64() {
    const val = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return val;
  }
  readFourCC() {
    const fourcc = new Uint8Array(this.view.buffer, this.offset, 4);
    this.offset += 4;
    return String.fromCharCode.apply(null, Array.from(fourcc));
  }
  readBytes(len) {
    const bytes = new Uint8Array(this.view.buffer, this.offset, len);
    this.offset += len;
    return bytes;
  }
  readStrZ(filter) {
    const begin = this.offset;
    while (this.view.getUint8(this.offset) !== 0) {
      this.offset++;
    }
    this.offset++;
    let bytes = Array.from(new Uint8Array(this.view.buffer, begin, this.offset - 1 - begin));
    if (filter) {
      bytes = bytes.map(filter);
    }
    return String.fromCharCode.apply(null, bytes);
  }
  readPosition() {
    return {
      x: this.readF32() * METERS_PER_INCH,
      y: this.readF32() * METERS_PER_INCH,
      z: -this.readF32() * METERS_PER_INCH
    };
  }
  readDirection() {
    return {
      x: this.readF32(),
      y: this.readF32(),
      z: -this.readF32()
    };
  }
  readQuaternion() {
    return {
      w: this.readF32(),
      x: -this.readF32(),
      y: -this.readF32(),
      z: this.readF32()
    };
  }
}

// src/aar.ts
var EntryType = {
  Compressed: 0,
  Raw: 1,
  Symlink: -1
};

class Aar {
  blob;
  lib;
  version;
  entries;
  static async create(file, lib) {
    const headerBuf = await readFileAsArrayBuffer(file.slice(0, 16));
    const hr = new BufferReader(headerBuf);
    if (hr.readFourCC() !== "AAR\0") {
      throw new Error("not an AAR file");
    }
    const version = hr.readU32();
    if (version !== 0 && version !== 2) {
      throw new Error("unknown AAR version " + version);
    }
    const nr_entries = hr.readU32();
    const first_entry_offset = hr.readU32();
    const indexBuf = await readFileAsArrayBuffer(file.slice(12, first_entry_offset));
    const r = new BufferReader(indexBuf);
    const entries = [];
    const unmask = version === 2 ? (b) => b - 96 & 255 : undefined;
    for (let i = 0;i < nr_entries; i++) {
      const offset = r.readU32();
      const size = r.readU32();
      const type = r.readS32();
      const name = r.readStrZ(unmask);
      const symlink_target = version == 2 ? r.readStrZ(unmask) : null;
      entries.push({ offset, size, type, name, symlink_target });
    }
    return new Aar(file, lib, version, entries);
  }
  map = new Map;
  constructor(blob, lib, version, entries) {
    this.blob = blob;
    this.lib = lib;
    this.version = version;
    this.entries = entries;
    for (const e of entries) {
      this.map.set(e.name.toLowerCase(), e);
    }
  }
  filenames() {
    return Array.from(this.map.values(), (entry, _) => entry.name);
  }
  load(name) {
    const entry = this.map.get(name.toLowerCase());
    if (!entry) {
      throw new Error(name + " not found");
    }
    switch (entry.type) {
      case EntryType.Compressed:
        return this.inflateEntry(entry);
      case EntryType.Raw:
        return this.readEntry(entry);
      default:
        throw new Error("not implemented");
    }
  }
  async inflateEntry(entry) {
    const buf = await this.readEntry(entry);
    const r = new BufferReader(buf);
    if (r.readFourCC() !== "ZLB\0") {
      throw new Error("not a ZLB entry");
    }
    if (r.readU32() !== 0) {
      throw new Error("unknown ZLB version");
    }
    const outSize = r.readU32();
    const inSize = r.readU32();
    if (inSize + 16 !== entry.size) {
      throw new Error("bad ZLB size");
    }
    const inPtr = this.lib.malloc(inSize);
    if (!inPtr) {
      throw new Error("out of memroy");
    }
    this.lib.memset(inPtr, new Uint8Array(buf, 16));
    const outPtr = this.lib.decompress(inPtr, inSize, outSize);
    this.lib.free(inPtr);
    if (!outPtr) {
      throw new Error("decompress failed");
    }
    const rawBuf = this.lib.memget(outPtr, outSize).buffer;
    this.lib.free(outPtr);
    return rawBuf;
  }
  readEntry(entry) {
    return readFileAsArrayBuffer(this.blob.slice(entry.offset, entry.offset + entry.size));
  }
}

// src/loader.ts
var decodeQnt = function(lib, buf) {
  const ptr = lib.malloc(buf.byteLength);
  lib.memset(ptr, buf);
  const decoded = lib.qnt_extract(ptr);
  lib.free(ptr);
  if (decoded === 0)
    throw new Error("qnt_extract failed");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ofs = dv.getUint32(4, true) === 0 ? 0 : 4;
  const width = dv.getUint32(16 + ofs, true);
  const height = dv.getUint32(20 + ofs, true);
  const hasAlpha = dv.getUint32(36 + ofs, true) !== 0;
  const pixels = lib.memget(decoded, width * height * 4);
  lib.free(decoded);
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.flipY = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, hasAlpha };
};
async function createLoader(files, pendingLibModule) {
  if (files.length === 1 && files[0].name.toLowerCase().endsWith(".red")) {
    const lib = await pendingLibModule;
    const aar2 = await Aar.create(files[0], lib);
    return new AarLoader(aar2, lib);
  }
  return new FilesLoader(files);
}

class FilesLoader {
  files;
  map = new Map;
  constructor(files) {
    this.files = files;
    for (const f of this.files) {
      this.map.set(f.name.toLowerCase(), f);
    }
  }
  filenames() {
    return Array.from(this.map.values(), (f, _) => f.name);
  }
  load(fname) {
    return readFileAsArrayBuffer(this.getBlob(fname));
  }
  async loadImage(fname) {
    const url = URL.createObjectURL(this.getBlob(fname + ".png"));
    const texture = new THREE.TextureLoader().load(url);
    return { texture, hasAlpha: true };
  }
  getBlob(fname) {
    console.log("loading " + fname);
    const f = this.map.get(fname.toLowerCase());
    if (!f) {
      throw new Error(fname + ": not found");
    }
    return f;
  }
}

class AarLoader {
  aar2;
  lib;
  constructor(aar2, lib) {
    this.aar = aar2;
    this.lib = lib;
  }
  filenames() {
    return this.aar.filenames();
  }
  load(fname) {
    console.log("loading " + fname);
    return this.aar.load(fname);
  }
  async loadImage(fname) {
    const qnt = await this.load(fname);
    return decodeQnt(this.lib, new Uint8Array(qnt));
  }
}

// src/model.ts
import * as THREE2 from "three";

// src/pol.ts
var TextureType = {
  ColorMap: 1,
  SpecularMaskMap: 4,
  GlareMap: 5,
  AlphaMap: 6,
  LightMap: 7,
  NormalMap: 8,
  HeightMap: 11
};

class Pol {
  version;
  materials = [];
  meshes = [];
  bones = [];
  constructor(buf) {
    const r = new BufferReader(buf);
    if (r.readFourCC() !== "POL\0") {
      throw new Error("not a POL file");
    }
    this.version = r.readU32();
    if (this.version !== 1 && this.version !== 2) {
      throw new Error("unknown POL version " + this.version);
    }
    const nr_materials = r.readU32();
    for (let i = 0;i < nr_materials; i++) {
      this.materials.push(this.parse_material(r, true));
    }
    const nr_meshes = r.readU32();
    for (let i = 0;i < nr_meshes; i++) {
      this.meshes.push(this.parse_mesh(r, this.materials));
    }
    const nr_bones = r.readU32();
    for (let i = 0;i < nr_bones; i++) {
      this.bones.push(this.parse_bone(r));
    }
    if (r.offset !== buf.byteLength) {
      console.log("extra data at end");
    }
  }
  parse_material(r, can_have_children) {
    const name = r.readStrZ();
    const nr_textures = r.readU32();
    const textures = new Map;
    for (let i = 0;i < nr_textures; i++) {
      const fname = r.readStrZ();
      const type = r.readU32();
      if (type !== 1 && type !== 4 && type !== 5 && type !== 6 && type !== 7 && type !== 8 && type !== 11) {
        console.log("unknown texture type " + type);
      }
      if (textures.has(type)) {
        throw new Error("duplicated texture type " + type);
      }
      textures.set(type, fname);
    }
    if (textures.size > 0 && !textures.has(1)) {
      throw new Error("no basic texture");
    }
    const children = [];
    if (can_have_children) {
      const nr_children = r.readU32();
      if (nr_textures > 0 && nr_children > 0) {
        throw new Error("A material cannot have both textures and children");
      }
      for (let i = 0;i < nr_children; i++) {
        children.push(this.parse_material(r, false));
      }
    }
    return { name, textures, children };
  }
  parse_mesh(r, materials) {
    const type = r.readS32();
    switch (type) {
      case 0:
        break;
      case -1:
        return null;
      default:
        throw new Error("unknown mesh type " + type);
    }
    const name = r.readStrZ();
    const material = r.readS32();
    if (material < -1 || material >= materials.length) {
      throw new Error("Material index out of bounds " + material);
    }
    const nr_vertices = r.readU32();
    const vertices = [];
    for (let i = 0;i < nr_vertices; i++) {
      vertices.push(this.parse_vertex(r));
    }
    const nr_uvs = r.readU32();
    const uvs = [];
    for (let i = 0;i < nr_uvs; i++) {
      const u = r.readF32();
      const v = r.readF32();
      uvs.push({ u, v: -v });
    }
    const nr_light_uvs = r.readU32();
    let light_uvs;
    if (nr_light_uvs > 0) {
      light_uvs = [];
      for (let i = 0;i < nr_light_uvs; i++) {
        const u = r.readF32();
        const v = r.readF32();
        light_uvs.push({ u, v: -v });
      }
    }
    const nr_uk3 = r.readU32();
    const uk3 = [];
    let nr_uk4 = 0;
    const uk4 = [];
    if (this.version === 1) {
      for (let i = 0;i < nr_uk3; i++) {
        const x = r.readF32();
        const y = r.readF32();
        const z = r.readF32();
        uk3.push({ x, y, z });
      }
    } else {
      for (let i = 0;i < nr_uk3; i++) {
        uk3.push(r.readU32());
      }
      nr_uk4 = r.readU32();
      for (let i = 0;i < nr_uk4; i++) {
        uk4.push(r.readU8());
      }
    }
    const nr_triangles = r.readU32();
    const triangles = [];
    for (let i = 0;i < nr_triangles; i++) {
      triangles.push(this.parse_triangle(r, nr_vertices, nr_uvs, nr_light_uvs, nr_uk4, materials[material]));
    }
    if (this.version === 1) {
      if (r.readU32() !== 1) {
        throw new Error("unexpected mesh footer");
      }
      if (r.readU32() !== 0) {
        throw new Error("unexpected mesh footer");
      }
    }
    return { name, material, vertices, uvs, light_uvs, uk3, triangles, uk4 };
  }
  parse_vertex(r) {
    const pos = r.readPosition();
    const nr_weights = this.version === 1 ? r.readU32() : r.readU16();
    const weights = [];
    for (let i = 0;i < nr_weights; i++) {
      const bone = this.version === 1 ? r.readU32() : r.readU16();
      const weight = r.readF32();
      weights.push({ bone, weight });
    }
    weights.sort((a, b) => b.weight - a.weight);
    return { x: pos.x, y: pos.y, z: pos.z, weights };
  }
  parse_triangle(r, nr_vertices, nr_uvs, nr_light_uvs, nr_uk4, material) {
    const vert_index = [
      r.readU32(),
      r.readU32(),
      r.readU32()
    ];
    const uv_index = [
      r.readU32(),
      r.readU32(),
      r.readU32()
    ];
    for (let i = 0;i < 3; i++) {
      if (vert_index[i] >= nr_vertices) {
        throw new Error(`vertex index out of range ${vert_index[i]} / ${nr_vertices}`);
      }
      if (uv_index[i] >= nr_uvs) {
        throw new Error(`texture index out of range ${uv_index[i]} / ${nr_uvs}`);
      }
    }
    let light_uv_index = [];
    if (nr_light_uvs > 0) {
      light_uv_index = [
        r.readU32() - nr_uvs,
        r.readU32() - nr_uvs,
        r.readU32() - nr_uvs
      ];
      for (let i = 0;i < 3; i++) {
        if (light_uv_index[i] < 0 || light_uv_index[i] >= nr_light_uvs) {
          throw new Error(`light uv index out of range ${light_uv_index[i]} / ${nr_light_uvs}`);
        }
      }
    }
    const unknowns = [];
    let n = 3;
    if (nr_uk4)
      n += 3;
    for (let i = 0;i < n; i++) {
      unknowns.push(r.readU32());
    }
    const normals = [];
    for (let i = 0;i < 3; i++) {
      normals.push(r.readDirection());
    }
    let material_index = r.readU32();
    if (material && material.children.length > 0 && material_index >= material.children.length) {
      material_index = 0;
    }
    return { vert_index, uv_index, light_uv_index, unknowns, normals, material_index };
  }
  parse_bone(r) {
    const name = r.readStrZ();
    const id = r.readS32();
    const parent = r.readS32();
    const pos = r.readPosition();
    const rotq = r.readQuaternion();
    return { name, id, parent, pos, rotq };
  }
}

// src/mot.ts
class Mot {
  bones = [];
  constructor(buf) {
    const r = new BufferReader(buf);
    if (r.readFourCC() !== "MOT\0") {
      throw new Error("not a MOT file");
    }
    if (r.readU32() !== 0) {
      throw new Error("unknown MOT version");
    }
    const nr_frames = r.readU32();
    const nr_bones = r.readU32();
    for (let i = 0;i < nr_bones; i++) {
      const name = r.readStrZ();
      const id = r.readU32();
      const parent = r.readU32();
      const frames = [];
      for (let j = 0;j < nr_frames; j++) {
        const pos = r.readPosition();
        const rotq = r.readQuaternion();
        const unknown = r.readQuaternion();
        frames.push({ pos, rotq, unknown });
      }
      this.bones.push({ name, id, parent, frames });
    }
  }
}

// src/model.ts
var toVector3 = function(v) {
  return new THREE2.Vector3(v.x, v.y, v.z);
};

class ResourceManager {
  resources = [];
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

class Model extends ResourceManager {
  constructor() {
    super(...arguments);
  }
  model = new THREE2.Group;
  boneMap = new Map;
  boneNameMap = new Map;
  mot = null;
  async load(loader, polName) {
    const polDir = polName.replace(/(^|\\)[^\\]*$/, "$1");
    const polData = await loader.load(polName);
    const pol2 = new Pol(polData);
    const materials = [];
    for (let i = 0;i < pol2.materials.length; i++) {
      const material = pol2.materials[i];
      const isEnv = pol2.meshes.some((m) => m && m.material === i && m.name.indexOf("(env)") >= 0);
      materials.push(await this.createMaterial(material, isEnv, loader, polDir));
    }
    const skeleton = this.initBones(pol2.bones);
    for (const mesh of pol2.meshes) {
      if (!mesh)
        continue;
      this.model.add(this.initMesh(mesh, materials[mesh.material], skeleton));
    }
  }
  async createMaterial(info, isEnv, loader, polDir) {
    const create = async (info2) => {
      const textureInfo = info2.textures;
      const diffuseMapName = textureInfo.get(TextureType.ColorMap);
      if (!diffuseMapName) {
        console.log(`${info2.name} has no diffuse map.`);
        return this.track(new THREE2.MeshBasicMaterial);
      }
      const diffuseImage = await loader.loadImage(polDir + diffuseMapName);
      const diffuseMap = this.track(diffuseImage.texture);
      diffuseMap.wrapS = diffuseMap.wrapT = THREE2.RepeatWrapping;
      const params = {};
      if (isEnv) {
        params.matcap = diffuseMap;
      } else {
        params.map = diffuseMap;
      }
      const normalMapName = textureInfo.get(TextureType.NormalMap);
      if (normalMapName) {
        const normalImage = await loader.loadImage(polDir + normalMapName);
        const normalMap = this.track(normalImage.texture);
        normalMap.wrapS = normalMap.wrapT = THREE2.RepeatWrapping;
        params.normalMap = normalMap;
      }
      const lightMapName = textureInfo.get(TextureType.LightMap);
      if (lightMapName) {
        const lightImage = await loader.loadImage(polDir + lightMapName);
        const lightMap = this.track(lightImage.texture);
        lightMap.wrapS = lightMap.wrapT = THREE2.RepeatWrapping;
        params.lightMap = lightMap;
        params.lightMapIntensity = 0.5;
      }
      const alphaMapName = textureInfo.get(TextureType.AlphaMap);
      if (alphaMapName) {
        const alphaImage = await loader.loadImage(polDir + alphaMapName);
        const alphaMap = this.track(alphaImage.texture);
        alphaMap.wrapS = alphaMap.wrapT = THREE2.RepeatWrapping;
        params.alphaMap = alphaMap;
      }
      const material = this.track(isEnv ? new THREE2.MeshMatcapMaterial(params) : new THREE2.MeshPhongMaterial(params));
      if (alphaMapName) {
        material.transparent = true;
      } else if (diffuseImage.hasAlpha) {
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
      const bone = new THREE2.Bone;
      this.boneMap.set(b.id, { bone, info: b, skinIndex: bones.length });
      if (this.boneNameMap.has(b.name)) {
        console.log("Non-unique bone name: " + b.name);
        this.boneNameMap.set(b.name, "NONUNIQUE");
      } else {
        this.boneNameMap.set(b.name, b.id);
      }
      bones.push(bone);
      const pos = toVector3(b.pos);
      const rotq = new THREE2.Quaternion(b.rotq.x, b.rotq.y, b.rotq.z, b.rotq.w);
      rotq.normalize();
      pos.applyQuaternion(rotq);
      const inverse = new THREE2.Matrix4;
      inverse.compose(pos, rotq, new THREE2.Vector3(1, 1, 1));
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
    const skeleton = this.track(new THREE2.Skeleton(bones, boneInverses));
    skeleton.pose();
    return skeleton;
  }
  initGroups(materials, triangles) {
    if (materials instanceof THREE2.Material) {
      return null;
    }
    triangles.sort((a, b) => a.material_index - b.material_index);
    let materialIndex = 0;
    let start = 0;
    const result = [];
    for (let i = 0;i < triangles.length; i++) {
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
      for (let i = 0;i < 3; i++) {
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
          for (let j = 0;j < 4; j++) {
            if (j < pos.weights.length) {
              skinIndices.push(this.boneMap.get(pos.weights[j].bone).skinIndex);
              skinWeights.push(pos.weights[j].weight);
            } else {
              skinIndices.push(0);
              skinWeights.push(0);
            }
          }
        }
      }
    }
    const geometry = this.track(new THREE2.BufferGeometry);
    geometry.setAttribute("position", new THREE2.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE2.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE2.Float32BufferAttribute(uvs, 2));
    if (mesh.light_uvs) {
      geometry.setAttribute("uv2", new THREE2.Float32BufferAttribute(light_uvs, 2));
    }
    if (groups) {
      console.log(mesh.name, groups, material);
      for (const g of groups) {
        geometry.addGroup(g.start, g.count, g.materialIndex);
      }
    }
    if (!skeleton) {
      return new THREE2.Mesh(geometry, material);
    }
    geometry.setAttribute("skinIndex", new THREE2.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute("skinWeight", new THREE2.Float32BufferAttribute(skinWeights, 4));
    const result = new THREE2.SkinnedMesh(geometry, material);
    result.normalizeSkinWeights();
    for (const b of this.boneMap.values()) {
      if (!b.bone.parent)
        result.add(b.bone);
    }
    result.bind(skeleton);
    return result;
  }
  async loadMotion(loader, fname) {
    console.log(fname);
    this.mot = new Mot(await loader.load(fname));
    console.log("Motion loaded");
  }
  unloadMotion() {
    this.mot = null;
  }
  async applyMotion(frameCount) {
    if (!this.mot)
      return;
    for (const bm of this.mot.bones) {
      const boneId = this.boneNameMap.get(bm.name);
      const bone = this.boneMap.get(typeof boneId === "number" ? boneId : bm.id)?.bone;
      if (!bone) {
        console.log(`No bone ${bm.name}`);
        continue;
      }
      const i = frameCount % (bm.frames.length - 1) + 1;
      const frame = bm.frames[i];
      bone.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
      bone.quaternion.set(frame.rotq.x, frame.rotq.y, frame.rotq.z, frame.rotq.w);
    }
  }
}

// src/lib.ts
async function createModule() {
  const fetched = fetch(new URL("./lib.wasm", import.meta.url));
  const imports = { env: { emscripten_notify_memory_growth: () => {
  } } };
  const { instance } = await WebAssembly.instantiateStreaming(fetched, imports);
  return {
    malloc: instance.exports.malloc,
    free: instance.exports.free,
    qnt_extract: instance.exports.qnt_extract,
    decompress: instance.exports.decompress,
    memset: (dst, src) => {
      new Uint8Array(instance.exports.memory.buffer).set(src, dst);
    },
    memget: (ptr, len) => {
      return new Uint8Array(instance.exports.memory.buffer).slice(ptr, ptr + len);
    }
  };
}

// src/index.ts
var $ = document.querySelector.bind(document);

class ModelViewer {
  renderer = new THREE3.WebGLRenderer;
  camera = new THREE3.PerspectiveCamera(50, 1.3333333333333333, 0.1, 1e5);
  light = new THREE3.DirectionalLight(16777215, 0.5);
  controls = new OrbitControls2(this.camera, this.renderer.domElement);
  scene = null;
  loader = null;
  model = null;
  running = false;
  frameCount = 0;
  constructor() {
    this.renderer.setSize(800, 600);
    $("#viewer").appendChild(this.renderer.domElement);
    $("#model-select").addEventListener("change", (e) => this.onModelChange(), false);
    $("#motion-select").addEventListener("change", (e) => this.onMotionChange(), false);
  }
  async handleFiles(files) {
    this.loader = await createLoader(files, pendingLibModule);
    const select = $("#model-select");
    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }
    for (const fname of this.loader.filenames()) {
      if (fname.indexOf("ParticleEffect") !== -1) {
        continue;
      }
      if (!fname.toLowerCase().endsWith(".pol")) {
        continue;
      }
      const opt = document.createElement("option");
      opt.value = fname;
      opt.textContent = fname;
      select.appendChild(opt);
      select.hidden = false;
    }
    if (select.firstChild) {
      this.onModelChange();
      $(".usage").hidden = true;
    }
  }
  async onModelChange() {
    if (!this.loader)
      return;
    let input = $("#model-select");
    const fname = input.value;
    const model2 = new Model;
    await model2.load(this.loader, fname);
    this.view(model2);
    const select = $("#motion-select");
    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }
    const empty = document.createElement("option");
    empty.textContent = "--";
    empty.value = "";
    select.appendChild(empty);
    select.hidden = true;
    const dir = fname.replace(/(^|\\)[^\\]*$/, "$1");
    for (const fname2 of this.loader.filenames()) {
      if (!fname2.startsWith(dir) || !fname2.toUpperCase().endsWith(".MOT")) {
        continue;
      }
      const opt = document.createElement("option");
      opt.value = fname2;
      opt.textContent = fname2.replace(/^.*\\/, "");
      select.appendChild(opt);
      select.hidden = false;
    }
  }
  async onMotionChange() {
    if (!this.loader || !this.model)
      return;
    let input = $("#motion-select");
    const fname = input.value;
    if (fname) {
      this.model.loadMotion(this.loader, fname);
    } else {
      this.model.unloadMotion();
    }
  }
  view(model2) {
    if (this.model) {
      this.model.dispose();
    }
    this.model = model2;
    this.scene = new THREE3.Scene;
    this.scene.add(model2.model);
    this.light.position.set(1, 1, 1);
    this.scene.add(this.light);
    this.scene.add(new THREE3.AmbientLight(16777215, 0.5));
    const bbox = new THREE3.Box3().setFromObject(model2.model);
    const center = bbox.getCenter(new THREE3.Vector3);
    const size = bbox.getSize(new THREE3.Vector3);
    console.log("bounding box", bbox);
    console.log("size", size);
    this.camera.position.set(center.x, center.y, center.z + Math.max(size.x, size.y, size.z) * 3);
    this.controls.target.set(center.x, center.y, center.z);
    this.controls.enableDamping = true;
    if (!this.running) {
      requestAnimationFrame(this.renderFrame.bind(this));
      this.running = true;
    }
  }
  renderFrame() {
    if (!this.running) {
      return;
    }
    requestAnimationFrame(this.renderFrame.bind(this));
    this.model.applyMotion(this.frameCount++ >> 1);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
document.body.addEventListener("dragover", (evt) => {
  evt.stopPropagation();
  evt.preventDefault();
  evt.dataTransfer.dropEffect = "copy";
}, false);
document.body.addEventListener("drop", (evt) => {
  evt.stopPropagation();
  evt.preventDefault();
  viewer.handleFiles(evt.dataTransfer.files);
}, false);
$("#file-select").addEventListener("change", (evt) => {
  let input = evt.target;
  viewer.handleFiles(input.files);
}, false);
var viewer = new ModelViewer;
window.viewer = viewer;
var pendingLibModule = createModule();
export {
  $
};
