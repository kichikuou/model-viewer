import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createLoader } from './loader.js';
import { Model } from './model.js';
import createLib from './lib.js';
export const $ = document.querySelector.bind(document);
class ModelViewer {
    constructor() {
        this.renderer = new THREE.WebGLRenderer();
        this.camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100000);
        this.light = new THREE.DirectionalLight(0xFFFFFF, 0.5);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.scene = null;
        this.loader = null;
        this.model = null;
        this.running = false;
        this.frameCount = 0;
        this.renderer.setSize(800, 600);
        $('#viewer').appendChild(this.renderer.domElement);
        $('#model-select').addEventListener('change', (e) => this.onModelChange(), false);
        $('#motion-select').addEventListener('change', (e) => this.onMotionChange(), false);
    }
    async handleFiles(files) {
        this.loader = await createLoader(files, pendingLibModule);
        const select = $('#model-select');
        while (select.firstChild) {
            select.removeChild(select.firstChild);
        }
        for (const fname of this.loader.filenames()) {
            if (fname.indexOf('ParticleEffect') !== -1) {
                continue; // because these are not very interesting...
            }
            if (!fname.toLowerCase().endsWith('.pol')) {
                continue;
            }
            const opt = document.createElement('option');
            opt.value = fname;
            opt.textContent = fname;
            select.appendChild(opt);
            select.hidden = false;
        }
        if (select.firstChild) {
            this.onModelChange();
            $('.usage').hidden = true;
        }
    }
    async onModelChange() {
        if (!this.loader)
            return;
        let input = $('#model-select');
        const fname = input.value;
        const model = new Model();
        await model.load(this.loader, fname);
        this.view(model);
        const select = $('#motion-select');
        while (select.firstChild) {
            select.removeChild(select.firstChild);
        }
        const empty = document.createElement('option');
        empty.textContent = '--';
        empty.value = '';
        select.appendChild(empty);
        select.hidden = true;
        const dir = fname.replace(/(^|\\)[^\\]*$/, '$1');
        for (const fname of this.loader.filenames()) {
            if (!fname.startsWith(dir) || !fname.toUpperCase().endsWith('.MOT')) {
                continue;
            }
            const opt = document.createElement('option');
            opt.value = fname;
            opt.textContent = fname.replace(/^.*\\/, '');
            select.appendChild(opt);
            select.hidden = false;
        }
    }
    async onMotionChange() {
        if (!this.loader || !this.model)
            return;
        let input = $('#motion-select');
        const fname = input.value;
        if (fname) {
            this.model.loadMotion(this.loader, fname);
        }
        else {
            this.model.unloadMotion();
        }
    }
    view(model) {
        if (this.model) {
            this.model.dispose();
        }
        this.model = model;
        this.scene = new THREE.Scene();
        this.scene.add(model.model);
        this.light.position.set(1, 1, 1);
        this.scene.add(this.light);
        this.scene.add(new THREE.AmbientLight(0xFFFFFF, 0.5));
        const bbox = new THREE.Box3().setFromObject(model.model);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        console.log('bounding box', bbox);
        console.log('size', size);
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
document.body.addEventListener('dragover', (evt) => {
    evt.stopPropagation();
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
}, false);
document.body.addEventListener('drop', (evt) => {
    evt.stopPropagation();
    evt.preventDefault();
    viewer.handleFiles(evt.dataTransfer.files);
}, false);
$('#file-select').addEventListener('change', (evt) => {
    let input = evt.target;
    viewer.handleFiles(input.files);
}, false);
const viewer = new ModelViewer();
window.viewer = viewer;
const pendingLibModule = createLib();
