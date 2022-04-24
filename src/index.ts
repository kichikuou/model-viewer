import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {createLoader, Loader} from './loader.js';
import {Model} from './model.js';
import createLib, {LibModule} from './lib.js';

export const $: (selector: string) => HTMLElement = document.querySelector.bind(document);

class ModelViewer {
    private renderer = new THREE.WebGLRenderer();
    private camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100000);
    private light = new THREE.DirectionalLight(0xFFFFFF, 0.5);
    private controls = new OrbitControls(this.camera, this.renderer.domElement);
    private scene: THREE.Scene | null = null;
    private loader: Loader | null = null;
    private model: Model | null = null;
    private running = false;
    private frameCount = 0;

    constructor() {
        this.renderer.setSize(800, 600);
        $('#viewer').appendChild(this.renderer.domElement);
        $('#model-select').addEventListener('change', (e) => this.onModelChange(), false);
        $('#motion-select').addEventListener('change', (e) => this.onMotionChange(), false);
    }

    async handleFiles(files: FileList) {
        this.loader = await createLoader(files, pendingLibModule);

        const select = $('#model-select');
        while (select.firstChild) {
            select.removeChild(select.firstChild);
        }

        for (const fname of this.loader.filenames()) {
            if (fname.indexOf('ParticleEffect') !== -1) {
                continue;  // because these are not very interesting...
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

    private async onModelChange() {
        if (!this.loader) return;
        let input = <HTMLSelectElement>$('#model-select');
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

    private async onMotionChange() {
        if (!this.loader || !this.model) return;
        let input = <HTMLSelectElement>$('#motion-select');
        const fname = input.value;
        if (fname) {
            this.model.loadMotion(this.loader, fname);
        } else {
            this.model.unloadMotion();
        }
    }

    private view(model: Model) {
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

    private renderFrame() {
        if (!this.running) {
            return;
        }
        requestAnimationFrame(this.renderFrame.bind(this));
        this.model!.applyMotion(this.frameCount++ >> 1);
        this.controls.update();
        this.renderer.render(this.scene!, this.camera);
    }
}

document.body.addEventListener('dragover', (evt: DragEvent) => {
    evt.stopPropagation();
    evt.preventDefault();
    evt.dataTransfer!.dropEffect = 'copy';
}, false);

document.body.addEventListener('drop', (evt: DragEvent) => {
    evt.stopPropagation();
    evt.preventDefault();
    viewer.handleFiles(evt.dataTransfer!.files);
}, false);

$('#file-select').addEventListener('change', (evt: Event) => {
    let input = <HTMLInputElement>evt.target;
    viewer.handleFiles(input.files!);
}, false);

const viewer = new ModelViewer();
(window as any).viewer = viewer;
const pendingLibModule: Promise<LibModule> = createLib();
