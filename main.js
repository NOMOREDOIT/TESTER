/**
 * @file main.js
 * @description Main application logic, event handling, and initialization for Image Maker Studio.
 */

import { panelManager, collaborationManager, reducer } from './modules.js';
import { libraryManager } from './libraryManager.js';
import { contrastFilterFeature } from './features/contrastFilter.js';

const ImageMakerStudio = {
    config: {
        OVERVIEW_SCALE: 0.5,
        secondaryFontsLoaded: false,
        loadedFonts: new Set(['VT323']),
        themes: {},
        PASTEBOARD_MARGIN: 1500,
        FADE_IN_DURATION: 300,
        DEBOUNCE_DELAY: 500,
        availableFonts: [
            { name: 'VT323', value: "'VT323', monospace" }, { name: 'Yomogi', value: "'Yomogi', cursive" },
            { name: 'Young Serif', value: "'Young Serif', serif" }, { name: 'Special Elite', value: "'Special Elite', cursive" },
            { name: 'Rubik Mono One', value: "'Rubik Mono One', sans-serif" }, { name: 'Rubik Beastly', value: "'Rubik Beastly', cursive" },
            { name: 'Press Start 2P', value: "'Press Start 2P', cursive", style: "font-size: 0.6rem;" }, { name: 'Patua One', value: "'Patua One', cursive" },
            { name: 'Nosifer', value: "'Nosifer', cursive" }, { name: 'Monoton', value: "'Monoton', cursive" },
            { name: 'Modak', value: "'Modak', cursive" }, { name: 'Metal Mania', value: "'Metal Mania', cursive" },
            { name: 'Major Mono Display', value: "'Major Mono Display', monospace", style: "font-size: 0.8rem;" }, { name: 'Luckiest Guy', value: "'Luckiest Guy', cursive" },
            { name: 'Londrina Outline', value: "'Londrina Outline', cursive" }, { name: 'Joti One', value: "'Joti One', cursive" },
            { name: 'Gorditas', value: "'Gorditas', cursive" }, { name: 'Graduate', value: "'Graduate', cursive" },
            { name: 'Gloria Hallelujah', value: "'Gloria Hallelujah', cursive" }, { name: 'Frijole', value: "'Frijole', cursive" },
            { name: 'Erica One', value: "'Erica One', cursive" }, { name: 'Eater', value: "'Eater', cursive" },
            { name: 'DotGothic16', value: "'DotGothic16', sans-serif" }, { name: 'Dokdo', value: "'Dokdo', cursive" },
            { name: 'Cute Font', value: "'Cute Font', cursive" }, { name: 'Creepster', value: "'Creepster', cursive" },
            { name: 'Codystar', value: "'Codystar', cursive" }, { name: 'Barrio', value: "'Barrio', cursive" },
            { name: 'Bahiana', value: "'Bahiana', cursive" }, { name: 'Astloch', value: "'Astloch', cursive" },
            { name: 'Are You Serious', value: "'Are You Serious', cursive" }
        ],
        fontValueToNameMap: new Map(),
        BG_MODELS: { fast: 'model.onnx' },
    },

    features: [
        contrastFilterFeature
    ],

    state: {
        scrubbingMode: 'none',
        layerViewMode: localStorage.getItem('ims-layer-view-mode') || 'grid',
        addAssetMode: 'layer',
        originalTheme: 'classic light',
        themeChosen: false,
        canvasState: { currentProjectId: null, backgroundElement: null, backgroundType: 'none', backgroundHash: null, bgBrightness: 1, bgSaturation: 1, layers: [], dominantColor: null, projectRotation: 0, backgroundFlipX: false },
        assetCache: {},
        activeLayerId: null,
        contextMenuLayerId: null,
        movieInteraction: { active: false, didDrag: false },
        animationFrameId: null,
        isAnimatingRender: false,
        masterWidth: 0,
        masterHeight: 0,
        eraserMode: 'none',
        isEraserArmed: false,
        eraseCanvasPoint: null,
        originalFontOnHover: null,
        toastTimeout: null,
        toastAnimationInterval: null,
        confirmCallback: null,
        lastEraseCanvasPoint: null,
        bgSessionCache: new Map(),
        pendingProjectId: null,
        lastSavedStateHash: null,
        viewState: { scale: 1.0, pan: { x: 0, y: 0 } },
        isPanning: false,
        targetViewState: { scale: 1.0, pan: { x: 0, y: 0 } },
        isAnimatingView: false,
        canvasHasInteractionFocus: true,
        onnxLoaded: false,
        zoomSnapTimeout: null,
        staticBackgroundCacheCanvas: null,
        staticForegroundCacheCanvas: null,
        history: {
            past: [],
            present: null,
            future: []
        }
    },

    dom: {},
    saveStateDebounced: null,

    // MODULES
    panelManager,
    collaborationManager,
    reducer,
    libraryManager,

    dispatch(action, isRemote = false) {
        if (!isRemote && this.collaborationManager.socket) {
            this.collaborationManager.broadcastAction(action);
        }
        const oldState = this.state;
        const newState = this.reducer(this.state, action);
        this.state = newState;

        const structureChanged = ['LAYER_ADDED', 'LAYER_DELETED', 'LAYER_REORDERED', 'LAYER_OPTIMIZATION_COMPLETE', 'LAYER_SELECT_AND_MOVE_TO_FRONT'].includes(action.type);

        if (structureChanged) {
            this.renderLayerPalette();
            this.renderTextLayerPalette();
            this.renderPanelLayerPalettes();
        } else {
            this.updateLayerPaletteSelection();
        }

        if (isRemote) {
            if (newState.canvasState.backgroundHash !== oldState.canvasState.backgroundHash) {
                this.loadAndSetBackgroundFromHash(newState.canvasState.backgroundHash);
            }
            if (action.type === 'LAYER_PROPERTY_CHANGED' && action.payload.property === 'font') {
                const fontName = this.config.fontValueToNameMap.get(action.payload.value);
                if (fontName) { this.loadSpecificFonts([fontName]); }
            }
        }

        if (!this.state.movieInteraction.active && !this.state.isScrubbing) {
            this.drawFrame();
        }
    },

    async loadAndInitializeLayer(layerId) {
        const layer = this.state.canvasState.layers.find(l => l.id === layerId);
        if (!layer || layer.asset) return;

        try {
            const assetRecords = await this.libraryManager.idbFindByHash(layer.originalHash);
            if (assetRecords.length === 0) throw new Error("Asset not found for layer.");

            const img = new Image();
            img.src = URL.createObjectURL(assetRecords[0].full);
            await img.decode();

            layer.asset = img;
            const proxyCanvas = document.createElement('canvas');
            layer.proxyCanvas = proxyCanvas;

            if (layer.cache) {
                layer.cache.isValid = false;
            }

            this.renderLayerPalette();
            this.renderPanelLayerPalettes();
            this.triggerAnimatedRender();
        } catch (error) {
            console.error("Failed to initialize layer:", error);
        }
    }, 

    throttle(func, delay) {
        let inProgress = false;
        return (...args) => {
            if (inProgress) {
                return;
            }
            inProgress = true;
            setTimeout(() => {
                func(...args);
                inProgress = false;
            }, delay);
        };
    },

    generateMipmaps(sourceImage, maxDimension) {
        const mipmaps = [];
        const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
        const sourceHeight = sourceImage.naturalHeight || sourceImage.height;

        const scale = Math.min(maxDimension / sourceWidth, maxDimension / sourceHeight, 1);
        let mipWidth = Math.round(sourceWidth * scale);
        let mipHeight = Math.round(sourceHeight * scale);
        
        let currentCanvas = document.createElement('canvas');
        currentCanvas.width = mipWidth;
        currentCanvas.height = mipHeight;
        
        let ctx = currentCanvas.getContext('2d', { willReadFrequently: true });

        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(sourceImage, 0, 0, mipWidth, mipHeight);
        mipmaps.push(currentCanvas);

        while (mipWidth > 32 && mipHeight > 32) {
            mipWidth = Math.max(32, Math.floor(mipWidth / 2));
            mipHeight = Math.max(32, Math.floor(mipHeight / 2));

            const newCanvas = document.createElement('canvas');
            newCanvas.width = mipWidth;
            newCanvas.height = mipHeight;
            ctx = newCanvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(mipmaps[mipmaps.length - 1], 0, 0, mipWidth, mipHeight);
            mipmaps.push(newCanvas);
        }
        return mipmaps;
    },

    _regenerateMipmapsFromBase(layer) {
        if (!layer.mipmaps || layer.mipmaps.length <= 1) return;
        const baseMip = layer.mipmaps[0];
        for (let i = 1; i < layer.mipmaps.length; i++) {
            const mip = layer.mipmaps[i];
            const prevMip = layer.mipmaps[i-1];
            const ctx = mip.getContext('2d');
            ctx.clearRect(0, 0, mip.width, mip.height);
            ctx.drawImage(prevMip, 0, 0, mip.width, mip.height);
        }
    },

    _getBestMipmapForSize(layer, targetWidth) {
        if (!layer.mipmaps || layer.mipmaps.length === 0) return null;
        for (let i = layer.mipmaps.length - 1; i >= 0; i--) {
            if (layer.mipmaps[i].width >= targetWidth) {
                return layer.mipmaps[i];
            }
        }
        return layer.mipmaps[layer.mipmaps.length - 1];
    },

    loadOnnxRuntime() {
        return new Promise((resolve, reject) => {
            if (window.ort) { resolve(); return; }
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });
    },

    getDominantColor(element) {
        const tempCanvas = document.createElement('canvas');
        const ctx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCanvas.width = 1; tempCanvas.height = 1;
        ctx.drawImage(element, 0, 0, 1, 1);
        const data = ctx.getImageData(0, 0, 1, 1).data;
        return `${data[0]}, ${data[1]}, ${data[2]}`;
    },

    async loadAndSetBackgroundFromHash(hash) {
        if (!hash) {
            this.clearCanvas();
            return;
        }
        try {
            const bgAssets = await this.libraryManager.idbFindByHash(hash);
            if (!bgAssets || bgAssets.length === 0) {
                throw new Error(`Background asset with hash ${hash} not found in library.`);
            }
            const img = new Image();
            img.src = URL.createObjectURL(bgAssets[0].full);
            img.onload = () => {
                this.setBackground(img, hash, true);
            };
            img.onerror = () => { throw new Error("Failed to load background image from blob."); };
        } catch (error) {
            console.error("Failed to load background from hash:", error);
            this.toast("Error: Could not sync background.", 4000);
        }
    },

    _requestViewAnimation() {
        if (!this.state.isAnimatingView) {
            this.state.isAnimatingView = true;
            requestAnimationFrame(() => this._updateViewAnimation());
        }
    },

   _updateViewAnimation() {
        if (!this.state.isAnimatingView) return;
        const { viewState, targetViewState } = this.state;
        const smoothingFactor = 0.3;
        const epsilon = 0.001;
        viewState.scale += (targetViewState.scale - viewState.scale) * smoothingFactor;
        viewState.pan.x += (targetViewState.pan.x - viewState.pan.x) * smoothingFactor;
        viewState.pan.y += (targetViewState.pan.y - viewState.pan.y) * smoothingFactor;
        
        this.drawBackground();
        this.drawFrame();

        const isScaleClose = Math.abs(viewState.scale - targetViewState.scale) < epsilon;
        const isPanXClose = Math.abs(viewState.pan.x - targetViewState.pan.x) < epsilon;
        const isPanYClose = Math.abs(viewState.pan.y - targetViewState.pan.y) < epsilon;
        if (isScaleClose && isPanXClose && isPanYClose) {
            viewState.scale = targetViewState.scale;
            viewState.pan.x = targetViewState.pan.x;
            viewState.pan.y = targetViewState.pan.y;
            this.state.isAnimatingView = false;
            this.drawBackground();
            this.drawFrame();
        } else {
            requestAnimationFrame(() => this._updateViewAnimation());
        }
    },

    updateSliderFill(slider) {
        if (!slider) return;
        const percentage = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
        const bg = `linear-gradient(to right, var(--action-color) ${percentage}%, var(--mid) ${percentage}%)`;
        slider.style.background = bg;
    },

    _constrainPan(panX, panY, scale) {
        if (!this.dom.movieCanvas || this.dom.movieCanvas.width === 0) {
            return { x: 0, y: 0 };
        }
        const canvasWidth = this.dom.movieCanvas.width;
        const canvasHeight = this.dom.movieCanvas.height;
        if (scale < 1.0) {
            const centeredX = (canvasWidth - canvasWidth * scale) / 2;
            const centeredY = (canvasHeight - canvasHeight * scale) / 2;
            return { x: centeredX, y: centeredY };
        } else {
            const maxXOffset = canvasWidth * scale - canvasWidth;
            const maxYOffset = canvasHeight * scale - canvasHeight;
            const minX = -maxXOffset;
            const minY = -maxYOffset;
            const maxX = 0;
            const maxY = 0;
            const constrainedX = Math.max(minX, Math.min(panX, maxX));
            const constrainedY = Math.max(minY, Math.min(panY, maxY));
            return { x: constrainedX, y: constrainedY };
        }
    },

    toggleLayerView() {
        this.state.layerViewMode = this.state.layerViewMode === 'list' ? 'grid' : 'list';
        localStorage.setItem('ims-layer-view-mode', this.state.layerViewMode);
        this.renderLayerPalette();
    },

    updateTransformCaches() {
        if (!this.state.staticBackgroundCacheCanvas) {
            this.state.staticBackgroundCacheCanvas = document.createElement('canvas');
        }
        if (!this.state.staticForegroundCacheCanvas) {
            this.state.staticForegroundCacheCanvas = document.createElement('canvas');
        }

        const bgCacheCanvas = this.state.staticBackgroundCacheCanvas;
        const fgCacheCanvas = this.state.staticForegroundCacheCanvas;
        const mainCanvas = this.dom.movieCanvas;

        [bgCacheCanvas, fgCacheCanvas].forEach(canvas => {
            canvas.width = mainCanvas.width;
            canvas.height = mainCanvas.height;
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        });

        const activeLayerId = this.state.activeLayerId;
        const allLayers = this.state.canvasState.layers;
        const activeIndex = allLayers.findIndex(l => l.id === activeLayerId);

        if (activeIndex === -1) return;

        const backgroundLayers = allLayers.slice(activeIndex + 1);
        const foregroundLayers = allLayers.slice(0, activeIndex);

        if (backgroundLayers.length > 0) {
            this.drawLayers(bgCacheCanvas.getContext('2d'), backgroundLayers);
        }
        if (foregroundLayers.length > 0) {
            this.drawLayers(fgCacheCanvas.getContext('2d'), foregroundLayers);
        }
    },
    
    updateCanvasPanelBackground() {
        if (this.state.viewState.scale >= 1.0) {
            this.dom.canvasPanel.style.overflow = 'visible';
            this.dom.canvasPanel.style.backgroundColor = 'transparent';
            this.dom.canvasPanel.style.backdropFilter = 'none';
            this.dom.canvasPanel.style.webkitBackdropFilter = 'none';
        } else {
            this.dom.canvasPanel.style.overflow = 'hidden';
            if (this.state.canvasState.dominantColor) {
                this.dom.canvasPanel.style.backgroundColor = `rgba(${this.state.canvasState.dominantColor}, 0.4)`;
                this.dom.canvasPanel.style.backdropFilter = 'blur(15px)';
                this.dom.canvasPanel.style.webkitBackdropFilter = 'blur(15px)';
            } else {
                this.dom.canvasPanel.style.backgroundColor = 'var(--mid)';
                this.dom.canvasPanel.style.backdropFilter = 'none';
                this.dom.canvasPanel.style.webkitBackdropFilter = 'none';
            }
        }
    },

    async loadSpecificFonts(fontNames) {
        if (!Array.isArray(fontNames) || fontNames.length === 0) return Promise.resolve();
        const fontsToLoad = fontNames.filter(f => !this.config.loadedFonts.has(f));
        if (fontsToLoad.length === 0) return Promise.resolve();
        
        const batchSize = 10;
        const promises = [];
        
        for (let i = 0; i < fontsToLoad.length; i += batchSize) {
            const batch = fontsToLoad.slice(i, i + batchSize);
            const baseUrl = 'https://fonts.googleapis.com/css2?';
            const familyParams = batch.map(font => `family=${font.replace(/ /g, '+')}`).join('&');
            const url = `${baseUrl}${familyParams}&display=swap`;
            
            const promise = new Promise((resolve, reject) => {
                const link = document.createElement('link');
                link.href = url;
                link.rel = 'stylesheet';
                link.onload = () => { batch.forEach(f => this.config.loadedFonts.add(f)); resolve(); };
                link.onerror = () => { 
                    console.warn('Failed to load font batch:', batch); 
                    resolve(); 
                };
                document.head.appendChild(link);
            });
            promises.push(promise);
        }
        
        await Promise.all(promises);
        
        try {
            const fontReadyPromise = document.fonts.ready;
            const timeoutPromise = new Promise(r => setTimeout(r, 1000));
            await Promise.race([fontReadyPromise, timeoutPromise]);
        } catch (error) {
            console.warn("Fonts took too long or failed to signal ready.", error);
        }
    },

    async loadSecondaryFonts() {
        if (this.config.secondaryFontsLoaded) return Promise.resolve();
        const allFontNames = this.config.availableFonts.map(f => f.name);
        await this.loadSpecificFonts(allFontNames);
        this.config.secondaryFontsLoaded = true;
    },

   injectNonCriticalStyles() {
        const nonCriticalCSS = `
        textarea#text-content, #font-select-trigger span {color:var(--ink)}
        .titlebar button { transform:translateY(-1px); }
        .titlebar button:hover{transform:translateY(-2px);filter:brightness(1.1)}
        .titlebar button:active{transform:translateY(0);border-color:var(--ink) var(--mid) var(--mid) var(--ink)}
        #controls-panel fieldset{background:var(--light);border:1px solid var(--ink);padding:.8rem;margin:0;text-align:left;transition:background-color .3s,border-color .3s,color .3s,opacity .15s;border-radius:3px}
        #controls-panel legend{font-size:1.2rem;font-weight:400;padding:0 .5rem;margin-left:.5rem;background:var(--light)}
        .placeholder-text{color:var(--mid);font-size:1.1rem;text-align:center;padding:1rem;width:100%}
        body[data-theme-is-dark=true] #layer-instructions{color:var(--ink)}
        #mg-asset-palette,#mg-local-asset-palette,#mg-local-background-palette{display:flex;gap:.5rem;flex-wrap:wrap;min-height:70px;align-content:flex-start}
        .palette-overlay-btn{position:absolute;bottom:-6px;right:-6px;width:24px;height:24px;font-size:1.8rem;line-height:1;display:flex;align-items:center;justify-content:center;background:var(--light);border:2px solid var(--ink);color:var(--ink);box-shadow:2px 2px 0 var(--shadow);border-radius:3px;z-index:5;cursor:pointer;transition:all .2s ease-out}.palette-overlay-btn:hover{transform:translate(-1px,-1px) scale(1.1);box-shadow:3px 3px 0 var(--shadow);background:var(--action-color);color:var(--light)}            .palette-slot,.layer-thumb{width:60px;height:60px;border:1px solid var(--ink);background:color-mix(in srgb, var(--light) 90%, var(--ink) 10%);cursor:pointer;position:relative;border-radius:3px;box-shadow:3px 3px 0 var(--ink);transform:translate(0,0);transition:transform .15s ease-out,box-shadow .15s ease-out}
        .palette-slot.empty{display:flex;align-items:center;justify-content:center;font-size:3rem;line-height:1;color:var(--mid)}
        .layer-thumb:hover,.palette-slot.empty:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 var(--ink)}
        .layer-thumb.active{transform:translate(1px,1px);box-shadow:none;border:2px solid var(--action-color)}
        .layer-thumb{cursor:grab}
        .layer-thumb img, .layer-thumb canvas{width:100%;height:100%;object-fit:cover;pointer-events:none}
        .layer-controls{position:absolute;top:-5px;right:-5px;display:flex;gap:2px}
        .layer-btn{background-color:var(--danger-color);border:1px solid var(--ink);color:#fff;font-size:.8rem;font-weight:700;line-height:1;padding:1px 4px;cursor:pointer;width:18px;height:18px;text-align:center}
       #mg-asset-palette, #mg-local-asset-palette, #mg-local-background-palette {
            align-items: center; /* This ensures vertical centering */
        }
        #mg-movie-canvas,#mg-controls-overlay-canvas{position:absolute}
        #mg-controls-overlay-canvas{pointer-events:none}
        #mg-movie-canvas{pointer-events:auto}
        #mg-toast{visibility:hidden;position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--light);border:1px solid var(--ink);padding:.5rem 1rem;color:var(--ink);font-size:1rem;z-index:2000;box-shadow:2px 2px 0 var(--shadow)}
        #canvas-placeholder{position:absolute;width:calc(100% - 20px);height:calc(100% - 20px);border:2px dashed var(--mid);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:pointer;color:var(--mid);transition:all .2s;padding:2rem;overflow:hidden;position:relative}
        #canvas-placeholder h3,#canvas-placeholder p{position:relative;z-index:2}
        #canvas-placeholder img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:.6}
        #canvas-placeholder h3{font-size:2.2rem;margin:0 0 .5rem}
        #canvas-placeholder p{font-size:1.3rem}
        #canvas-placeholder:hover,#canvas-panel.drag-over #canvas-placeholder{border-color:var(--ink);color:var(--ink);background-color:rgba(255,255,255,.5)}
        #canvas-panel.drag-over{background-color:var(--shadow)}
        #layer-instructions{padding:0 0 .5rem 0;margin:0;font-size:1.1rem}
        #mg-confirmation-overlay,#mg-asset-action-overlay{z-index:5000}
        #mg-confirmation-dialog,#mg-asset-action-dialog{padding:1.5rem;text-align:center;width:90%;max-width:400px;height:auto}
        #mg-confirmation-dialog p,#mg-asset-action-dialog p{font-size:1.2rem;margin:0 0 1.5rem}
        #mg-confirmation-dialog .action-buttons,#mg-asset-action-dialog .action-buttons{display:flex;justify-content:center;gap:.5rem}
        #text-content,#text-font{transition:background-color .3s,border-color .3s,color .3s}
        #text-layer-manager{display:flex;gap:.5rem;align-items:center;padding-bottom:.5rem;margin-bottom:.5rem;border-bottom:1px solid var(--mid)}
        #text-layer-palette{display:flex;gap:.5rem;flex-wrap:wrap;flex-grow:1;min-height:44px}
        
        /* --- START MODIFICATION --- */
        #add-new-text-layer-btn{width:40px;height:40px;flex-shrink:0;font-size:2rem;line-height:1;padding:0;background:var(--light);border:1px solid var(--ink);color:var(--ink);cursor:pointer;transition:all .2s ease-out}
        #add-new-text-layer-btn:hover{background-color:var(--action-color);color:var(--light);transform:scale(1.05);}
        /* --- END MODIFICATION --- */

        .text-thumb{width:60px;height:40px;display:flex;align-items:center;justify-content:center;overflow:hidden;background-color:var(--ink);color:var(--light);font-size:.8rem;padding:2px;text-align:center}
        .text-thumb span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
        .palette-slot.empty:disabled{opacity:.4;cursor:default;pointer-events:none;background-color:var(--light)}
        .palette-slot.empty:disabled:hover{background-color:var(--light);color:var(--mid)}
        #shortcuts-btn:disabled,#visuals-btn:disabled,#text-btn:disabled,#erase-tool-btn:disabled,#ai-tools-btn:disabled{opacity:.5;pointer-events:none;cursor:default}
        
        /* --- CHANGED: Just opacity, no rotation, no shrinking --- */
        .layer-thumb.dragging {
            opacity: 0.4;
            box-shadow: none;
            cursor: grabbing;
        }
        
        .layer-thumb.drag-over{border:3px dashed var(--action-color);transform:scale(1.02);background-color:rgba(var(--action-color-rgb),.1)}
        .effects-checkbox{display:flex;align-items:center;margin-top:.5rem}
        .effects-checkbox input{margin-right:.5rem}
        .effects-controls{padding-left:1.5rem;border-left:1px solid var(--mid);margin-left:.5rem}
        .effects-controls.disabled{opacity:.5;pointer-events:none}
        #erase-tool-btn.active{background-color:var(--action-color);color:var(--light)}
        #mg-movie-canvas.erase-cursor{cursor:none}
        .eraser-mode-selector{display:flex;gap:.5rem;margin-bottom:.5rem}
        .eraser-mode-selector .mg-btn{width:50%;margin:0;padding:4px 8px;font-size:16px}
        .eraser-mode-selector .mg-btn:active,.eraser-mode-selector .mg-btn.active{background-color:var(--action-color);color:var(--light);transform:none;box-shadow:inset 1px 1px 0 rgba(0,0,0,.2)}
        #theme-popup-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.5);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:none;justify-content:center;align-items:center;z-index:7000}
        #theme-popup-content{background:var(--bg);border:1px solid var(--ink);box-shadow:2px 2px 0 var(--shadow);padding:1rem;width:90%;max-width:400px;max-height:80vh;display:flex;flex-direction:column;transition:background-color .3s}
        #theme-list{list-style:none;margin:0;padding:0;overflow-y:auto}
        #theme-list li{padding:.75rem 1rem;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background-color .2s;border-radius:4px}
        #theme-list li.active{background-color:var(--action-color);color:var(--light)}
        body[data-theme-is-dark=true] #theme-list li.active{color:var(--bg)}
        #theme-list li.active span{flex-grow:1}
        #theme-list li.active::before{content:'✓';margin-right:.5rem}
        #theme-list li:not(.active):hover{background-color:var(--mid)}
        .theme-colors{display:flex;gap:.5rem}
        .theme-color-dot{width:16px;height:16px;border-radius:50%;border:1px solid var(--ink)}
        #version-popup-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:none;justify-content:center;align-items:center;z-index:6000}
        #version-popup-content{background-color:var(--bg);padding:2rem;border:1px solid var(--ink);box-shadow:2px 2px 0 var(--shadow);width:80%;height:80%;max-width:800px;position:relative;color:var(--ink);overflow-y:auto}
        #version-popup-content h4{font-size:2rem;margin-bottom:.5rem}
        #version-popup-content h6{font-size:1rem;margin-top:0;opacity:.7;margin-bottom:1.5rem}
        #version-popup-content h5{font-size:1.5rem;margin-top:1.5rem;border-bottom:1px solid var(--mid);padding-bottom:.25rem}
        #version-popup-content ul{list-style:none;padding-left:0}
        #version-popup-content li{margin-bottom:.75rem;line-height:1.4}
        #close-popup{position:absolute;top:1rem;right:1.5rem;font-size:2rem;color:var(--ink);cursor:pointer;font-family:'VT323',monospace;line-height:1;transition:opacity .2s}
        #close-popup:hover{opacity:.6}
        #custom-font-select{position:relative}
        #font-select-trigger{background:var(--bg);border:1px solid var(--ink);padding:4px 8px;font-size:1rem;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background-color .3s,border-color .3s}
        #font-select-trigger:focus,#custom-font-select.open #font-select-trigger{border-color:var(--action-color)}
        #font-select-trigger span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #font-select-trigger i{transition:transform .2s ease-in-out;font-size:.8em}
        #custom-font-select.open #font-select-trigger i{transform:rotate(180deg)}
        #font-select-dropdown{position:absolute;top:calc(100% + 2px);left:0;right:0;background:var(--light);border:1px solid var(--ink);z-index:101;max-height:250px;overflow-y:auto;box-shadow:2px 2px 0 var(--shadow)}
        #font-select-list{list-style:none;margin:0;padding:0}
        #font-select-list li{padding:6px 10px;cursor:pointer;transition:background-color .2s;white-space:nowrap;font-size:.9rem}
        #font-select-list li:hover,#font-select-list li.hover-preview{background-color:var(--mid)}
        #font-select-list li.selected{background-color:var(--action-color);color:var(--light)}
        body[data-theme-is-dark=true] #font-select-list li.selected{color:var(--bg)}`;
        const style = document.createElement('style');
        style.textContent = nonCriticalCSS;
        document.head.appendChild(style);
    },

    applyTheme(themeName, isPreview = false) {
        const theme = this.config.themes[themeName];
        if (!theme) return;
        const root = document.documentElement;
        if (isPreview) { root.style.transition = 'none'; }
        for (const [key, value] of Object.entries(theme.css)) {
            root.style.setProperty(key, value);
            if (key === '--light') root.style.setProperty('--light-rgb', this.hexToRgb(value));
            if (key === '--bg') root.style.setProperty('--bg-rgb', this.hexToRgb(value));
            if (key === '--action-color') root.style.setProperty('--action-color-rgb', this.hexToRgb(value));
        }
        document.body.dataset.themeIsDark = theme.isDark;
        document.body.dataset.themeName = themeName;
        if (isPreview) { void root.offsetWidth; root.style.transition = ''; }
    },

    async createOptimizedBlob(blob, maxDimension = 2048, quality = 0.9) {
        try {
            const bmp = await createImageBitmap(blob);
            const { width, height } = bmp;
            if (Math.max(width, height) <= maxDimension && blob.type === 'image/webp') return blob;
            const scale = Math.min(maxDimension / width, maxDimension / height, 1);
            const newWidth = Math.round(width * scale);
            const newHeight = Math.round(height * scale);
            const c = new OffscreenCanvas(newWidth, newHeight);
            c.getContext('2d').drawImage(bmp, 0, 0, newWidth, newHeight);
            return await c.convertToBlob({ type: 'image/webp', quality });
        } catch (e) {
            console.error("Could not optimize image, returning original blob.", e);
            return blob;
        }
    },

    dataURLtoBlob(dataurl) {
        const arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) { u8arr[n] = bstr.charCodeAt(n); }
        return new Blob([u8arr], { type: mime });
    },

    hexToRgb(hex) {
        let r = 0, g = 0, b = 0;
        if (hex.length == 4) { r = parseInt(hex[1] + hex[1], 16); g = parseInt(hex[2] + hex[2], 16); b = parseInt(hex[3] + hex[3], 16) }
        else if (hex.length == 7) { r = parseInt(hex[1] + hex[2], 16); g = parseInt(hex[3] + hex[4], 16); b = parseInt(hex[5] + hex[6], 16) }
        return `${r},${g},${b}`;
    },

    saveAndApplyTheme(themeName) {
        this.state.themeChosen = true;
        this.applyTheme(themeName);
        try {
            localStorage.setItem('selectedTheme', themeName);
        } catch (e) {
            console.error("Could not save theme. Storage may be disabled or full.", e);
            this.toast("Could not save theme preference.", 3000);
        }
        this.state.originalTheme = themeName;
        this.dom.currentThemeNameSpan.textContent = themeName;
        const currentActive = this.dom.themeList.querySelector('.active');
        if (currentActive) currentActive.classList.remove('active');
        const newActive = this.dom.themeList.querySelector(`[data-theme-name="${themeName}"]`);
        if (newActive) newActive.classList.add('active');
        this.dom.themePopupOverlay.style.display = 'none';
    },

    populateThemeList() {
        this.dom.themeList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        const currentTheme = localStorage.getItem('selectedTheme') || 'classic light';
        for (const themeName in this.config.themes) {
            const theme = this.config.themes[themeName];
            const li = document.createElement('li');
            li.dataset.themeName = themeName;
            if (themeName === currentTheme) li.classList.add('active');
            let content = `<span>${theme.name}</span>`;
            let colorDots = '<div class="theme-colors">';
            theme.colors.forEach(color => { colorDots += `<div class="theme-color-dot" style="background-color: ${color};"></div>`; });
            colorDots += '</div>';
            li.innerHTML = content + colorDots;
            li.addEventListener('click', () => this.saveAndApplyTheme(themeName));
            li.addEventListener('mouseenter', () => this.applyTheme(themeName, true));
            fragment.appendChild(li);
        }
        this.dom.themeList.appendChild(fragment);
    },

    showLoadingScreen(message = 'Loading...') {
        this.dom.loadingMessage.textContent = message;
        this.dom.loadingOverlay.style.display = 'flex';
        void this.dom.loadingOverlay.offsetWidth;
        this.dom.loadingOverlay.style.opacity = '1';
    },

    hideLoadingScreen() {
        this.dom.loadingOverlay.style.opacity = '0';
        setTimeout(() => {
            this.dom.loadingOverlay.style.display = 'none';
        }, 500);
    },

    toast(message, duration = 3000) {
        if (!this.dom.toastEl) return;
        clearTimeout(this.state.toastTimeout);
        clearInterval(this.state.toastAnimationInterval);
        this.dom.toastEl.textContent = message;
        this.dom.toastEl.style.visibility = 'visible';
        if (duration !== null) {
            this.state.toastTimeout = setTimeout(() => {
                this.dom.toastEl.style.visibility = 'hidden';
                clearInterval(this.state.toastAnimationInterval);
            }, duration);
        }
    },

    hideToast() {
        if (!this.dom.toastEl) return;
        clearTimeout(this.state.toastTimeout);
        clearInterval(this.state.toastAnimationInterval);
        this.dom.toastEl.style.visibility = 'hidden';
    },

    async sha256Hex(blob) {
        const buf = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const bytes = new Uint8Array(digest);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    
    generateCanvasStateHash() {
        if (!this.state.canvasState.backgroundElement && this.state.canvasState.layers.length === 0) {
            return 'empty';
        }
        const serializableState = {
            bgBrightness: this.state.canvasState.bgBrightness,
            bgSaturation: this.state.canvasState.bgSaturation,
            backgroundHash: this.state.canvasState.backgroundHash,
            layers: this.state.canvasState.layers.map(layer => {
                const { asset, proxyCanvas, proxyCtx, createdAt, cache, ...leanLayer } = layer;
                return leanLayer;
            })
        };
        return JSON.stringify(serializableState);
    },
    
    isCanvasDirty() {
        const currentHash = this.generateCanvasStateHash();
        return currentHash !== this.state.lastSavedStateHash;
    },

    async toBlobFromDataURL(dataURL) { const res = await fetch(dataURL); return await res.blob(); },

     async createThumbBlob(source, max = 256, type = 'image/webp', quality = 0.8) {
        try {
            const bmp = (source instanceof Blob) ? await createImageBitmap(source) : source;
            const scale = Math.min(max / bmp.width, max / bmp.height, 1);
            const w = Math.round(bmp.width * scale);
            const h = Math.round(bmp.height * scale);
            const c = new OffscreenCanvas(w, h);
            c.getContext('2d').drawImage(bmp, 0, 0, w, h);
            return await c.convertToBlob({ type, quality });
        } catch (e) {
            console.error("Could not create thumbnail, possibly a non-image type.", e);
            return await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAmMBb3eGmC0AAAAASUVORK5CYII=')).blob();
        }
    },

    setLocalFolderTab(tab) {
        const isProjects = tab === 'projects', isAssets = tab === 'assets', isBackgrounds = tab === 'backgrounds', isFavorites = tab === 'favorites';
        this.dom.libraryTabProjectsBtn.classList.toggle('active', isProjects);
        this.dom.libraryTabAssetsBtn.classList.toggle('active', isAssets);
        this.dom.libraryTabBackgroundsBtn.classList.toggle('active', isBackgrounds);
        this.dom.libraryTabFavoritesBtn.classList.toggle('active', isFavorites);
        this.dom.projectLibraryGridProjects.classList.toggle('hidden', !isProjects);
        this.dom.projectLibraryGridAssets.classList.toggle('hidden', !isAssets);
        this.dom.projectLibraryGridBackgrounds.classList.toggle('hidden', !isBackgrounds);
        this.dom.projectLibraryGridFavorites.classList.toggle('hidden', !isFavorites);
    },

    switchAndSaveLibraryTab(tabId) {
        this.setLocalFolderTab(tabId);
        localStorage.setItem('ims-last-library-tab', tabId);
    },

    handleFileUpload(files, intendedUse = 'asset') {
        if (files instanceof File) {
            files = [files];
        }

        const validFiles = [...files].filter(file => file.type.startsWith('image/'));

        if (validFiles.length === 0) {
            this.toast('No valid image files were selected.', 3000);
            return;
        }

        const filesToProcess = validFiles.slice(0, 5);
        if (validFiles.length > 5) {
            this.toast(`Processing the first 5 images (max allowed).`, 4000);
        }

        const toastMessage = `Processing ${filesToProcess.length} image(s) as ${intendedUse}s...`;
        this.toast(toastMessage, null);

        let isFirstFile = true;

        (async () => {
            for (const file of filesToProcess) {
                await this._processSingleFile(file, intendedUse, isFirstFile);
                isFirstFile = false;
            }
            this.hideToast(); 
        })();
    },

    async _processSingleFile(file, intendedUse) {
        try {
            const blobHash = await this.sha256Hex(file);

            if (intendedUse === 'background') {
                const optimizedBlob = await this.createOptimizedBlob(file, 2560, 0.85);
                await this.libraryManager.saveAssetToLibrary({
                    blob: optimizedBlob,
                    mime: 'image/webp',
                    hash: blobHash,
                    kind: intendedUse
                });

                const tempUrl = URL.createObjectURL(optimizedBlob);
                const imageEl = new Image();

                await new Promise((resolve, reject) => {
                    imageEl.onload = () => {
                        this.setBackground(imageEl, blobHash);
                        URL.revokeObjectURL(tempUrl);
                        resolve();
                    };
                    imageEl.onerror = () => {
                        URL.revokeObjectURL(tempUrl);
                        reject(new Error("Failed to load image for background."));
                    };
                    imageEl.src = tempUrl;
                });

            } else { 
                if (!this.state.canvasState.backgroundElement) {
                    console.warn("Attempted to add a layer before a background was set. Skipping file:", file.name);
                    return;
                }
                await this.libraryManager.saveAssetToLibrary({ blob: file, mime: file.type, hash: blobHash, kind: intendedUse });
                const needsOptimization = file.type !== 'image/webp';
                await this.addImageLayer(URL.createObjectURL(file), blobHash, needsOptimization);
            }
        } catch (error) {
            console.error("File handling failed for:", file.name, error);
            this.toast(`Error processing ${file.name}.`, 4000);
        }
    },

    calculateContentBounds(canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
        
        const ALPHA_THRESHOLD = 1; 
        
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                if (data[(y * canvas.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX === -1) {
            return { x: 0, y: 0, width: canvas.width, height: canvas.height, isEmpty: true };
        }
        return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, isEmpty: false };
    },

    async addImageLayer(src, hash, needsOptimization = false, visualState = null) {
        if (!this.state.canvasState.backgroundElement) { this.toast('Please add a background image first.', 2000); return; }
        
        const newLayerObject = await this.createLayerFromSrc(src, {
            originalHash: hash,
            type: 'image',
            ...(visualState || {})
        });

        if (needsOptimization && this.state.converterWorker) {
            newLayerObject.isOptimized = false;
            newLayerObject.originalTempSrc = src;
        }

        this.dispatch({ type: 'LAYER_ADDED', payload: { newLayer: newLayerObject } });

        if (hash) {
            const existingAssets = await this.libraryManager.idbFindByHash(hash);
            if (existingAssets.length > 0) {
                const assetToUpdate = existingAssets[0];
                assetToUpdate.createdAt = Date.now();
                await this.libraryManager.idbPut(assetToUpdate, 'assets');
                await this.libraryManager.renderLocalAssetPalette_IDB();
            }
        }

        if (needsOptimization && this.state.converterWorker) {
            const blob = await (await fetch(src)).blob();
            this.state.converterWorker.postMessage({
                blob: blob,
                layerId: newLayerObject.id,
                originalHash: hash,
                kind: 'asset'
            });
        }

        this.triggerAnimatedRender();
    },

    async createLayerFromSrc(src, layerData) {
        const img = new Image();
        img.src = src;
        await img.decode();

        let isOptimized = false;
        if (layerData.originalHash) {
            const assets = await this.libraryManager.idbFindByHash(layerData.originalHash);
            if (assets.length > 0 && assets[0].mime === 'image/webp') {
                isOptimized = true;
            }
        }

        const MAX_PROXY_DIMENSION = 2048;
        const initialMipmaps = this.generateMipmaps(img, MAX_PROXY_DIMENSION);
        const baseProxy = initialMipmaps[0];
        
        baseProxy.getContext('2d', { willReadFrequently: true });
        
        const newBounds = this.calculateContentBounds(baseProxy);
        let finalMipmaps = initialMipmaps;
        let finalContentFrame = newBounds;
        let finalSize = layerData.size !== undefined ? layerData.size : Math.max(20, Math.min(this.dom.movieCanvas.width, this.dom.movieCanvas.height) * 0.4);
        let finalX = layerData.x !== undefined ? layerData.x : this.dom.movieCanvas.width / 2;
        let finalY = layerData.y !== undefined ? layerData.y : this.dom.movieCanvas.height / 2;

        if (!newBounds.isEmpty && (newBounds.width < baseProxy.width || newBounds.height < baseProxy.height)) {
            const croppedCanvas = document.createElement('canvas');
            croppedCanvas.width = newBounds.width;
            croppedCanvas.height = newBounds.height;
            croppedCanvas.getContext('2d').drawImage(baseProxy, newBounds.x, newBounds.y, newBounds.width, newBounds.height, 0, 0, newBounds.width, newBounds.height);
            
            const oldCenter = { x: baseProxy.width / 2, y: baseProxy.height / 2 };
            const newContentCenter = { x: newBounds.x + newBounds.width / 2, y: newBounds.y + newBounds.height / 2 };
            const shiftInLocalSpace = { x: newContentCenter.x - oldCenter.x, y: newContentCenter.y - oldCenter.y };

            const initialScale = finalSize / baseProxy.width;

            finalX += shiftInLocalSpace.x * initialScale;
            finalY += shiftInLocalSpace.y * initialScale;
            finalSize = finalSize * (newBounds.width / baseProxy.width);
            finalMipmaps = this.generateMipmaps(croppedCanvas, MAX_PROXY_DIMENSION);
            finalContentFrame = { x: 0, y: 0, width: croppedCanvas.width, height: croppedCanvas.height, isEmpty: false };
        }
        
        const newLayer = {
            id: layerData.id || (Date.now() + Math.random()).toString(),
            originalHash: layerData.originalHash,
            type: 'image',
            x: finalX,
            y: finalY,
            size: finalSize,
            rot: layerData.rot || 0,
            flipX: layerData.flipX || false,
            opacity: layerData.opacity || 1,
            brightness: layerData.brightness || 1,
            saturation: layerData.saturation || 1,
            contrast: layerData.contrast || 1,
            shadow: layerData.shadow || { enabled: false, color: '#000000', blur: 10, offsetX: 10, offsetY: 10 },
            border: layerData.border || { enabled: false, color: '#FFFFFF', width: 4 },
            createdAt: Date.now(),
            asset: img,
            mipmaps: finalMipmaps,
            contentFrame: finalContentFrame,
            src: src,
            isOptimized: isOptimized,
            isLocked: false,
            cache: { canvas: null, isValid: false }
        };

        if (newLayer.mipmaps && newLayer.mipmaps.length > 0) {
            newLayer.mipmaps[0].getContext('2d', { willReadFrequently: true });
        }

        newLayer.propX = newLayer.x / this.dom.movieCanvas.width;
        newLayer.propY = newLayer.y / this.dom.movieCanvas.height;
        const masterDim = Math.sqrt(this.dom.movieCanvas.width * this.dom.movieCanvas.height);
        newLayer.propSize = newLayer.size / masterDim;
        return newLayer;
    },

    updateControlsState() {
        const hasBackground = !!this.state.canvasState.backgroundElement;
        this.dom.downloadImageBtn.disabled = !hasBackground;
        this.dom.saveProjectBtn.disabled = !hasBackground;
        this.dom.clearCanvasBtn.disabled = !hasBackground;
        this.dom.visualsBtn.disabled = !hasBackground;
        this.dom.textBtn.disabled = !hasBackground;
        this.dom.eraseToolBtn.disabled = !hasBackground;
        this.dom.aiToolsBtn.disabled = !hasBackground;
        this.dom.addNewTextLayerBtn.disabled = !hasBackground;
        this.renderLayerPalette();
        this.renderTextLayerPalette();
        this.renderPanelLayerPalettes();
    },

    setBackground(element, hash, isRestoring = false) {
        if (!isRestoring && hash !== this.state.canvasState.backgroundHash) {
            this.dispatch({ type: 'RESET_PROJECT_ROTATION' });
        }

        this.state.viewState = { scale: 1.0, pan: { x: 0, y: 0 } };
        this.state.targetViewState = { scale: 1.0, pan: { x: 0, y: 0 } };

        if (!isRestoring) {
            this.state.canvasState.bgBrightness = 1;
            this.state.canvasState.bgSaturation = 1;
            this.updateBackgroundVisualsUI();
        }

        const isFirstBackground = !this.state.canvasState.backgroundElement;
        this.state.canvasState.backgroundElement = element;
        this.state.canvasState.backgroundType = 'image';
        this.state.canvasState.backgroundHash = hash;
        this.state.canvasState.dominantColor = this.getDominantColor(element);
        this.updateCanvasPanelBackground();

        const w_orig = element.naturalWidth, h_orig = element.naturalHeight;
        const isTilted = [90, 270].includes(this.state.canvasState.projectRotation);
        const w = isTilted ? h_orig : w_orig;
        const h = isTilted ? w_orig : h_orig;

        this.state.masterWidth = w;
        this.state.masterHeight = h;
        
        const MAX_CANVAS_WIDTH = 1920; 
        const canvasAspectRatio = w / h;
        let newCanvasWidth = w, newCanvasHeight = h;
        if (newCanvasWidth > MAX_CANVAS_WIDTH) {
            newCanvasWidth = MAX_CANVAS_WIDTH;
            newCanvasHeight = newCanvasWidth / canvasAspectRatio;
        }
        newCanvasWidth = Math.round(newCanvasWidth);
        newCanvasHeight = Math.round(newCanvasHeight);

        this.dom.backgroundCanvas.width = newCanvasWidth;
        this.dom.backgroundCanvas.height = newCanvasHeight;
        this.dom.movieCanvas.width = newCanvasWidth;
        this.dom.movieCanvas.height = newCanvasHeight;
        this.dom.controlsOverlayCanvas.width = newCanvasWidth;
        this.dom.controlsOverlayCanvas.height = newCanvasHeight;

        if (!isFirstBackground && this.state.canvasState.layers.length > 0) {
            this.toast('Adapting layers to new background...', 3000);
            const newMasterDim = Math.sqrt(newCanvasWidth * newCanvasHeight);
            this.state.canvasState.layers.forEach(l => {
                if (l.type === 'image') { l.size = l.propSize * newMasterDim; } 
                else { l.fontSize = l.propSize * newMasterDim; }
                l.x = l.propX * newCanvasWidth;
                l.y = l.propY * newCanvasHeight;
                const bbox = this.getRotatedBoundingBox(l);
                let deltaX = 0, deltaY = 0;
                if (bbox.left < 0) deltaX = -bbox.left;
                else if (bbox.right > newCanvasWidth) deltaX = newCanvasWidth - bbox.right;
                if (bbox.top < 0) deltaY = -bbox.top;
                else if (bbox.bottom > newCanvasHeight) deltaY = newCanvasHeight - bbox.bottom;
                l.x += deltaX;
                l.y += deltaY;
                if (l.cache) l.cache.isValid = false;
            });
        }

        this.resizeCanvas();
        this.updateControlsState();
        this.updateEditPanelsUI();
        if (!this.dom.canvasPlaceholder.classList.contains('hidden')) {
            this.dom.canvasPlaceholder.classList.add('hidden');
        }
        
        this.drawBackground();
        this.drawFrame();

        if (isFirstBackground && !isRestoring) {
            this.toast('Background set! Add layers to create your image.', 3000);
        }
        if (!isRestoring) {
            this.dispatch({ type: 'BACKGROUND_CHANGED', payload: { backgroundHash: hash } });
        }
    },

    resizeCanvas() {
        const panelWidth = this.dom.canvasPanel.clientWidth, panelHeight = this.dom.canvasPanel.clientHeight;
        if (panelWidth === 0 || panelHeight === 0 || !this.state.canvasState.backgroundElement) return;

        const canvasAspectRatio = this.dom.movieCanvas.width / this.dom.movieCanvas.height;
        let displayWidth, displayHeight;
        if (panelWidth / panelHeight > canvasAspectRatio) {
            displayHeight = panelHeight;
            displayWidth = displayHeight * canvasAspectRatio;
        } else {
            displayWidth = panelWidth;
            displayHeight = displayWidth / canvasAspectRatio;
        }
        const topOffset = (panelHeight - displayHeight) / 2;
        const leftOffset = (panelWidth - displayWidth) / 2;
        
        [this.dom.backgroundCanvas, this.dom.movieCanvas, this.dom.controlsOverlayCanvas].forEach(c => {
            if (c) {
                c.style.width = `${displayWidth}px`;
                c.style.height = `${displayHeight}px`;
                c.style.top = `${topOffset}px`;
                c.style.left = `${leftOffset}px`;
            }
        });

        this.drawBackground();
        this.drawFrame();
    },

    openAddLayerPopup(mode = 'asset') {
        if (mode === 'asset' && !this.state.canvasState.backgroundElement) {
            this.toast('Please set a background before adding layers.', 2000);
            return;
        }
        this.state.addAssetMode = mode;
        const title = this.dom.addLayerOverlay.querySelector('h4');
        const subtitle = this.dom.addLayerOverlay.querySelector('p');
        if (mode === 'background') {
            if (title) title.textContent = 'Add or Change Background';
            if (subtitle) subtitle.textContent = 'Add a new image to use as the project background.';
        } else {
            if (title) title.textContent = 'Add an Image';
            if (subtitle) subtitle.textContent = 'Add an image layer to your current project.';
        }
        
        this.dom.addLayerOverlay.classList.add('visible');
    },

    closeAddLayerPopup() { this.dom.addLayerOverlay.classList.remove('visible'); },

    updateLayerInstructions() {
        this.dom.layerInstructions.classList.remove('placeholder-text');
        if (!this.state.canvasState.backgroundElement) { this.dom.layerInstructions.textContent = "Add a background to begin."; this.dom.layerInstructions.classList.add('placeholder-text'); }
        else if (this.state.canvasState.layers.filter(l => l.type === 'image').length === 0) { this.dom.layerInstructions.textContent = "Click '+' to add your first visual layer."; }
        else { this.dom.layerInstructions.textContent = "Click & drag layers to re-order them, or use [Q] & [W]."; }
    },

    updateLayerPaletteSelection() {
        const allThumbs = document.querySelectorAll('#mg-asset-palette .layer-thumb, #text-layer-palette .layer-thumb, .panel-layer-palette .layer-thumb');
        allThumbs.forEach(node => {
            node.classList.toggle('active', node.dataset.layerId === this.state.activeLayerId);
        });
        this.scrollToActiveLayerInPalettes();
    },

    scrollToActiveLayerInPalettes() {
        const activeLayerId = this.state.activeLayerId;
        if (!activeLayerId) return;
        const palettes = document.querySelectorAll('.panel-layer-palette');
        palettes.forEach(palette => {
            const activeThumb = palette.querySelector(`.layer-thumb[data-layer-id="${activeLayerId}"]`);
            if (activeThumb) {
                activeThumb.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                    inline: 'nearest'
                });
            }
        });
    },

    renderTextLayerPalette() {
        this.dom.textLayerPalette.innerHTML = '';
        if (!this.state.canvasState.backgroundElement) return;
        const textLayers = this.state.canvasState.layers.filter(l => l.type === 'text');
        textLayers.forEach(layer => {
            const thumb = document.createElement('div');
            thumb.className = 'layer-thumb text-thumb';
            thumb.classList.toggle('active', layer.id === this.state.activeLayerId);
            thumb.dataset.layerId = layer.id;
            thumb.title = "Click to edit text";
            thumb.innerHTML = `<span>${layer.text.split('\n')[0] || "Empty"}</span><div class="layer-controls"><div class="layer-btn delete" title="Delete Layer">x</div></div>`;
            thumb.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.classList.contains('layer-btn')) return;
                if (this.state.activeLayerId !== layer.id) this.deactivateEraser();
                this.state.activeLayerId = layer.id;
                this.updateLayerPaletteSelection();
                this.updateEditPanelsUI();
                this.drawFrame();
    
                this.panelManager.show('text-panel');
                this.dom.textContentInput.focus();
            });
            thumb.querySelector('.delete').onclick = (e) => { e.stopPropagation(); this.deleteMovieLayer(layer.id); };
            this.dom.textLayerPalette.appendChild(thumb);
        });
    }, 

    addDragAndDropHandlers(thumb) {
        thumb.setAttribute('draggable', 'true');
        const animateSwap = (container, swapAction) => {
            const children = Array.from(container.children);
            const firstPositions = new Map();
            children.forEach(child => {
                firstPositions.set(child, child.getBoundingClientRect().top);
            });

            swapAction();

            children.forEach(child => {
                const startTop = firstPositions.get(child);
                const endTop = child.getBoundingClientRect().top;
                const delta = startTop - endTop;

                if (delta !== 0) {
                    child.style.transition = 'none';
                    child.style.transform = `translateY(${delta}px)`;
                    child.getBoundingClientRect(); 
                    child.style.transition = 'transform 0.2s ease-out';
                    child.style.transform = '';
                }
            });
        };

        thumb.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', thumb.dataset.layerId);
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => thumb.classList.add('dragging'), 0);
        });

        thumb.addEventListener('dragend', () => {
            thumb.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            const container = thumb.parentNode;
            Array.from(container.children).forEach(child => {
                child.style.transition = '';
                child.style.transform = '';
            });
        });

        thumb.addEventListener('dragover', (e) => {
            e.preventDefault();
            const container = thumb.parentNode;
            const draggingItem = container.querySelector('.dragging');
            
            if (!draggingItem || draggingItem === thumb) return;

            const targetBox = thumb.getBoundingClientRect();
            const targetMiddle = targetBox.top + (targetBox.height / 2);
            const mouseY = e.clientY;
            const isTargetBelow = draggingItem.compareDocumentPosition(thumb) & Node.DOCUMENT_POSITION_FOLLOWING;
            
            let shouldSwap = false;
            let insertPosition = null;

            if (isTargetBelow) {
                if (mouseY > targetMiddle) {
                    shouldSwap = true;
                    insertPosition = thumb.nextSibling;
                }
            } else {
                if (mouseY < targetMiddle) {
                    shouldSwap = true;
                    insertPosition = thumb;
                }
            }

            if (shouldSwap) {
                animateSwap(container, () => {
                    container.insertBefore(draggingItem, insertPosition);
                });
            }
        });

        thumb.addEventListener('drop', (e) => {
            e.preventDefault();
            const container = thumb.parentNode;
            const newDomOrderIds = Array.from(container.querySelectorAll('.layer-thumb')).map(el => el.dataset.layerId);
            const layerMap = new Map(this.state.canvasState.layers.map(l => [l.id, l]));
            const newLayerOrder = newDomOrderIds.map(id => layerMap.get(id)).reverse();
            this.state.canvasState.layers = newLayerOrder.filter(l => l);
            this.updateTextOrderButtonsState();
            this.drawFrame();
        });
    },

    renderPanelLayerPalettes() {
        const palettes = [this.dom.eraserLayerPalette, this.dom.visualsLayerPalette, this.dom.aiToolsLayerPalette];
        const visualLayers = this.state.canvasState.layers.filter(l => l.type === 'image');
        palettes.forEach(palette => {
            if (!palette) return;
            palette.innerHTML = '';
            if (visualLayers.length === 0) {
                palette.innerHTML = '<p class="placeholder-text">No image layers to select.</p>';
                return;
            }
            visualLayers.forEach(layer => {
                const thumbNode = document.createElement('div');
                thumbNode.className = 'layer-thumb';
                thumbNode.dataset.layerId = layer.id;
                thumbNode.title = "Click to select this layer";
                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = 60;
                thumbCanvas.height = 60;
                thumbNode.appendChild(thumbCanvas);
                const thumbCtx = thumbCanvas.getContext('2d');
                thumbCtx.imageSmoothingQuality = 'high';
                
                const source = (layer.mipmaps && layer.mipmaps.length > 0) ? layer.mipmaps[0] : null; 

                if (source && source.width > 0 && source.height > 0) {
                    const destWidth = 60, destHeight = 60;
                    const sourceWidth = source.width, sourceHeight = source.height;
                    const sourceRatio = sourceWidth / sourceHeight, destRatio = destWidth / destHeight;
                    let sx = 0, sy = 0, sWidth = sourceWidth, sHeight = sourceHeight;
                    if (sourceRatio > destRatio) {
                        sHeight = sourceHeight; sWidth = sHeight * destRatio; sx = (sourceWidth - sWidth) / 2;
                    } else if (sourceRatio < destRatio) {
                        sWidth = sourceWidth; sHeight = sWidth / destRatio; sy = (sourceHeight - sHeight) / 2;
                    }
                    thumbCtx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
                }

                thumbNode.classList.toggle('active', layer.id === this.state.activeLayerId);
                thumbNode.addEventListener('click', () => {
                    this.state.activeLayerId = layer.id;
                    this.updateLayerPaletteSelection();
                    this.updateEditPanelsUI();
                    this.drawFrame();
                });
                palette.appendChild(thumbNode);
            });
        });
    }, 

    renderLayerPalette() {
        this.updateLayerInstructions();
        const hasBackground = !!this.state.canvasState.backgroundElement;
        this.dom.assetPalette.innerHTML = ''; 

        const toggleBtn = document.getElementById('layer-view-toggle');
        if (toggleBtn) {
            toggleBtn.innerHTML = this.state.layerViewMode === 'list' 
                ? '<i class="fas fa-th-large"></i>' 
                : '<i class="fas fa-list"></i>';
        }

        if (this.state.layerViewMode === 'grid') {
            this.dom.assetPalette.classList.add('grid-view');
        } else {
            this.dom.assetPalette.classList.remove('grid-view');
        }

        if (!hasBackground) {
            const addButton = document.createElement('button');
            addButton.className = 'palette-slot empty';
            addButton.innerHTML = '+';
            addButton.title = 'Add a background to enable layers';
            addButton.disabled = true;
            this.dom.assetPalette.appendChild(addButton);
            this.renderPanelLayerPalettes();
            return;
        }

        const visualLayers = this.state.canvasState.layers.filter(l => l.type === 'image');
        const layersToRender = visualLayers.slice().reverse();

        const dpr = window.devicePixelRatio || 1;

        layersToRender.forEach((layer, index) => {
            const thumbNode = document.createElement('div');
            thumbNode.className = 'layer-thumb';
            thumbNode.dataset.layerId = layer.id;

            if (this.state.layerViewMode === 'list') {
                
                const thumbnailContainer = document.createElement('div');
                thumbnailContainer.className = 'thumbnail-container';

                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = 60 * dpr;
                thumbCanvas.height = 60 * dpr;
                thumbCanvas.style.width = '60px';
                thumbCanvas.style.height = '60px';
                
                thumbnailContainer.appendChild(thumbCanvas);

                const controls = document.createElement('div');
                controls.className = 'layer-controls';
                controls.innerHTML = `<div class="layer-btn delete" title="Delete Layer">x</div>`;
                thumbnailContainer.appendChild(controls);

                thumbNode.appendChild(thumbnailContainer);

                const infoBox = document.createElement('div');
                infoBox.className = 'layer-info-box';
                infoBox.innerHTML = `<span class="layer-name">Image Layer ${visualLayers.length - index}</span><i class="layer-drag-handle fas fa-grip-lines"></i>`;
                thumbNode.appendChild(infoBox);

                controls.querySelector('.delete').onclick = (e) => { e.stopPropagation(); this.deleteMovieLayer(layer.id); };
                
                const thumbCtx = thumbCanvas.getContext('2d');
                thumbCtx.scale(dpr, dpr); 
                thumbCtx.imageSmoothingQuality = 'high';
                
                const source = (layer.mipmaps && layer.mipmaps.length > 0) ? layer.mipmaps[0] : null;
                if (source && source.width > 0 && source.height > 0) {
                    const destWidth = 60, destHeight = 60;
                    const sourceWidth = source.width, sourceHeight = source.height;
                    const sourceRatio = sourceWidth / sourceHeight, destRatio = destWidth / destHeight;
                    let sx = 0, sy = 0, sWidth = sourceWidth, sHeight = sourceHeight;
                    if (sourceRatio > destRatio) {
                        sHeight = sourceHeight; sWidth = sHeight * destRatio; sx = (sourceWidth - sWidth) / 2;
                    } else if (sourceRatio < destRatio) {
                        sWidth = sourceWidth; sHeight = sWidth / destRatio; sy = (sourceHeight - sHeight) / 2;
                    }
                    thumbCtx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
                }
                
                this.addDragAndDropHandlers(thumbNode);
            } else {
                thumbNode.classList.toggle('is-a-copy', !!layer.isCopy);

                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = 60 * dpr;
                thumbCanvas.height = 60 * dpr;
                thumbCanvas.style.width = '60px';
                thumbCanvas.style.height = '60px';
                
                thumbNode.appendChild(thumbCanvas);

                const controls = document.createElement('div');
                controls.className = 'layer-controls';
                controls.innerHTML = `<div class="layer-btn delete" title="Delete Layer">x</div>`;
                thumbNode.appendChild(controls);
                
                controls.querySelector('.delete').onclick = (e) => { e.stopPropagation(); this.deleteMovieLayer(layer.id); };

                const thumbCtx = thumbCanvas.getContext('2d');
                thumbCtx.scale(dpr, dpr);
                thumbCtx.imageSmoothingQuality = 'high';
                
                const source = (layer.mipmaps && layer.mipmaps.length > 0) ? layer.mipmaps[0] : null;
                if (source && source.width > 0 && source.height > 0) {
                    const destWidth = 60, destHeight = 60;
                    const sourceWidth = source.width, sourceHeight = source.height;
                    const sourceRatio = sourceWidth / sourceHeight, destRatio = destWidth / destHeight;
                    let sx = 0, sy = 0, sWidth = sourceWidth, sHeight = sourceHeight;
                    if (sourceRatio > destRatio) {
                        sHeight = sourceHeight; sWidth = sHeight * destRatio; sx = (sourceWidth - sWidth) / 2;
                    } else if (sourceRatio < destRatio) {
                        sWidth = sourceWidth; sHeight = sWidth / destRatio; sy = (sourceHeight - sHeight) / 2;
                    }
                    thumbCtx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
                }
                
                this.addDragAndDropHandlers(thumbNode);
            }

            const optimizationIndicator = document.createElement('div');
            optimizationIndicator.className = 'optimization-badge';
            const badgeParent = this.state.layerViewMode === 'list' ? thumbNode.querySelector('.thumbnail-container') : thumbNode;
            badgeParent.appendChild(optimizationIndicator);
            
            const optBadge = badgeParent.querySelector('.optimization-badge');
            if (layer.originalHash) {
                optBadge.style.display = 'flex';
                optBadge.textContent = layer.isOptimized ? '✓' : '...';
                optBadge.title = layer.isOptimized ? 'Asset is optimized (WebP)' : 'Optimizing asset...';
                optBadge.classList.toggle('pending', !layer.isOptimized);
            } else {
                optBadge.style.display = 'none';
            }

            thumbNode.addEventListener('click', (e) => {
                if (e.target.classList.contains('layer-btn')) return;
                if (this.state.activeLayerId !== layer.id) this.deactivateEraser();
                this.state.activeLayerId = layer.id;
                this.updateLayerPaletteSelection();
                this.updateEditPanelsUI();
                this.drawFrame();
            });

            thumbNode.classList.toggle('active', layer.id === this.state.activeLayerId);
            this.dom.assetPalette.appendChild(thumbNode);
        });

        const addButton = document.createElement('button');
        addButton.id = 'add-layer-slot-btn';
        addButton.className = 'palette-slot empty';
        addButton.innerHTML = '+';
        addButton.onclick = () => this.openAddLayerPopup();
        addButton.title = 'Add a new image asset';
        this.dom.assetPalette.appendChild(addButton);

        this.renderPanelLayerPalettes();
    },

    switchVisualsTab(tabToShow) {
        const isAssetTab = tabToShow === 'asset';
        this.dom.visualsTabAssetBtn.classList.toggle('active', isAssetTab);
        this.dom.visualsTabBackgroundBtn.classList.toggle('active', !isAssetTab);
        this.dom.assetTabPanel.classList.toggle('hidden', !isAssetTab);
        this.dom.backgroundTabPanel.classList.toggle('hidden', isAssetTab);
    },

    updateAssetVisualsUI() {
        const activeLayer = this.getActiveLayer();
        if (activeLayer && activeLayer.type === 'image') {
            this.dom.assetVisualsControls.classList.remove('disabled');
            this.dom.assetOpacitySlider.value = activeLayer.opacity;
            this.dom.assetBrightnessSlider.value = activeLayer.brightness;
            this.dom.assetSaturationSlider.value = activeLayer.saturation;
            document.getElementById('shadow-enable').checked = activeLayer.shadow.enabled;
            document.getElementById('shadow-controls').classList.toggle('disabled', !activeLayer.shadow.enabled);
            document.getElementById('shadow-color').value = activeLayer.shadow.color;
            document.getElementById('shadow-blur').value = activeLayer.shadow.blur;
            document.getElementById('shadow-offset-x').value = activeLayer.shadow.offsetX;
            document.getElementById('shadow-offset-y').value = activeLayer.shadow.offsetY;
            document.getElementById('asset-edge-enable').checked = activeLayer.border.enabled;
            document.getElementById('asset-edge-controls').classList.toggle('disabled', !activeLayer.border.enabled);
            document.getElementById('asset-edge-color').value = activeLayer.border.color;
            document.getElementById('asset-edge-width').value = activeLayer.border.width;
        } else {
            this.dom.assetVisualsControls.classList.add('disabled');
        }
    },

    populateCustomFontSelector() {
        this.dom.fontSelectList.innerHTML = '';
        this.config.availableFonts.sort((a, b) => a.name.localeCompare(b.name));
        this.config.availableFonts.forEach(font => {
            const li = document.createElement('li');
            li.textContent = font.name;
            li.dataset.fontValue = font.value;
            li.style.fontFamily = font.value;
            if (font.style) { li.setAttribute('style', `font-family: ${font.value}; ${font.style}`); }
            li.addEventListener('mouseenter', (e) => this.handleFontHoverPreview(e));
            li.addEventListener('click', (e) => this.handleFontSelect(e));
            this.dom.fontSelectList.appendChild(li);
        });
    },

     handleFontHoverPreview(e) {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer || activeLayer.type !== 'text') return;
        
        if (this.state.originalFontOnHover === null) {
            this.state.originalFontOnHover = activeLayer.font;
        }

        this.dispatch({
            type: 'LAYER_PROPERTY_PREVIEW_CHANGED',
            payload: {
                layerId: activeLayer.id,
                property: 'font',
                value: e.target.dataset.fontValue
            }
        });
    },

    handleFontHoverEnd() {
        const activeLayer = this.getActiveLayer();
        if (this.state.originalFontOnHover && activeLayer && activeLayer.type === 'text') {
            this.dispatch({
                type: 'LAYER_PROPERTY_PREVIEW_CHANGED',
                payload: {
                    layerId: activeLayer.id,
                    property: 'font',
                    value: this.state.originalFontOnHover
                }
            });
            this.state.originalFontOnHover = null;
        }
    },

    handleFontSelect(e) {
        const activeLayer = this.getActiveLayer();
        const newFontValue = e.target.dataset.fontValue;
        if (activeLayer && activeLayer.type === 'text') {
            this.dispatch({
                type: 'LAYER_PROPERTY_CHANGED',
                payload: {
                    layerId: activeLayer.id,
                    property: 'font',
                    value: newFontValue
                }
            });
        }
        this.state.originalFontOnHover = null;
        this.dom.fontSelectTrigger.querySelector('span').textContent = e.target.textContent;
        this.dom.fontSelectTrigger.querySelector('span').style.fontFamily = newFontValue;
        if (this.dom.fontSelectList.querySelector('.selected')) this.dom.fontSelectList.querySelector('.selected').classList.remove('selected');
        e.target.classList.add('selected');
        this.closeFontDropdown();
    },

    openFontDropdown() {
        this.dom.customFontSelect.classList.add('open');
        this.dom.fontSelectDropdown.classList.remove('hidden');
        this.state.originalFontOnHover = null;
    },

    closeFontDropdown() {
        if (!this.dom.customFontSelect.classList.contains('open')) return;
        this.handleFontHoverEnd();
        this.dom.customFontSelect.classList.remove('open');
        this.dom.fontSelectDropdown.classList.add('hidden');
    },

    updateTextVisualsUI() {
        const activeLayer = this.getActiveLayer();

        if (activeLayer && activeLayer.type === 'text') {
            this.dom.textVisualsControls.classList.remove('disabled');
            this.dom.textContentInput.value = activeLayer.text;
            this.dom.textContentInput.placeholder = 'Enter your text...';
            
            this.dom.textSizeSlider.value = activeLayer.fontSize;
            this.dom.textColorInput.value = activeLayer.color;
            this.dom.textEdgeColorInput.value = activeLayer.strokeColor;
            this.dom.textEdgeWidthSlider.value = activeLayer.strokeWidth;
            
            document.getElementById('text-shadow-enable').checked = activeLayer.shadow.enabled;
            document.getElementById('text-shadow-controls').classList.toggle('disabled', !activeLayer.shadow.enabled);
            document.getElementById('text-shadow-color').value = activeLayer.shadow.color;
            document.getElementById('text-shadow-blur').value = activeLayer.shadow.blur;
            document.getElementById('text-shadow-offset-x').value = activeLayer.shadow.offsetX;
            document.getElementById('text-shadow-offset-y').value = activeLayer.shadow.offsetY;
            
            const fontName = this.config.availableFonts.find(f => f.value === activeLayer.font)?.name || 'Select Font';
            const fontValue = activeLayer.font;
            this.dom.fontSelectTrigger.querySelector('span').textContent = fontName;
            this.dom.fontSelectTrigger.querySelector('span').style.fontFamily = fontValue;
            
            const currentSelected = this.dom.fontSelectList.querySelector('.selected');
            if (currentSelected) currentSelected.classList.remove('selected');
            const liToSelect = this.dom.fontSelectList.querySelector(`[data-font-value="${fontValue}"]`);
            if (liToSelect) liToSelect.classList.add('selected');

        } else {
            this.dom.textVisualsControls.classList.add('disabled');
            this.dom.textContentInput.value = '';
            this.dom.textContentInput.placeholder = 'Click to add a new text layer'; 
            this.dom.textContentInput.blur();
            
            this.dom.textSizeSlider.value = 100;
            this.dom.textColorInput.value = '#FFFFFF';
            this.dom.textEdgeColorInput.value = '#000000';
            this.dom.textEdgeWidthSlider.value = 0;
            
            document.getElementById('text-shadow-enable').checked = false;
            document.getElementById('text-shadow-controls').classList.add('disabled');
            document.getElementById('text-shadow-color').value = '#000000';
            document.getElementById('text-shadow-blur').value = 10;
            document.getElementById('text-shadow-offset-x').value = 10;
            document.getElementById('text-shadow-offset-y').value = 10;

            this.dom.fontSelectTrigger.querySelector('span').textContent = 'Select Font';
            this.dom.fontSelectTrigger.querySelector('span').style.fontFamily = "'VT323', monospace";

            const currentSelected = this.dom.fontSelectList.querySelector('.selected');
            if (currentSelected) currentSelected.classList.remove('selected');
        }
    },

    updateBackgroundVisualsUI() {
        this.dom.bgBrightnessSlider.value = this.state.canvasState.bgBrightness;
        this.dom.bgSaturationSlider.value = this.state.canvasState.bgSaturation;
    },

    updateEditPanelsUI() {
        this.updateAssetVisualsUI();
        this.updateTextVisualsUI();
        this.updateBackgroundVisualsUI();
        this.updateTextOrderButtonsState();
        document.querySelectorAll('.control-panel input[type="range"]').forEach(slider => this.updateSliderFill(slider));
    },

    addTextLayer() {
        if (!this.state.canvasState.backgroundElement) { this.toast('Add a background first.', 2000); return; }
        const newFontSize = Math.max(20, Math.min(this.dom.movieCanvas.width, this.dom.movieCanvas.height) * 0.15);
        const newTextLayer = {
            id: (Date.now() + Math.random()).toString(),
            type: 'text',
            text: 'New Text',
            font: "'VT323', monospace",
            fontSize: newFontSize,
            color: '#FFFFFF',
            strokeColor: '#000000',
            strokeWidth: 0,
            x: this.dom.movieCanvas.width / 2,
            y: this.dom.movieCanvas.height / 2,
            rot: 0,
            flipX: false,
            opacity: 1, brightness: 1, saturation: 1,
            width: 0, height: 0,
            shadow: { enabled: false, color: '#000000', blur: 10, offsetX: 10, offsetY: 10 },
            border: { enabled: false, color: '#FFFFFF', width: 4 },
            createdAt: Date.now(),
            isLocked: false,
            cache: { canvas: null, isValid: false }
        };
        newTextLayer.propX = newTextLayer.x / this.dom.movieCanvas.width;
        newTextLayer.propY = newTextLayer.y / this.dom.movieCanvas.height;
        const masterDim = Math.sqrt(this.dom.movieCanvas.width * this.dom.movieCanvas.height);
        newTextLayer.propSize = newTextLayer.fontSize / masterDim;

        this.dispatch({ type: 'LAYER_ADDED', payload: { newLayer: newTextLayer } });

        this.updateEditPanelsUI();
        this.triggerAnimatedRender();

        this.panelManager.show('text-panel');
        this.dom.textContentInput.focus();
        this.dom.textContentInput.select();
    },

    deleteMovieLayer(layerId) {
        this.dispatch({ type: 'LAYER_DELETED', payload: { layerId } });
        this.updateControlsState();
        this.updateEditPanelsUI();
    },

    getTextBlockMetrics(ctx, text, font, fontSize) {
        if (!text || text.trim() === '') {
            return { lines: [], lineHeight: 0, maxWidth: 0, totalHeight: 0, ascent: 0 };
        }

        ctx.save();
        ctx.font = `${fontSize}px ${font}`;
        const lines = text.split('\n');
        
        let maxAscent = 0;
        let maxDescent = 0;
        let maxWidth = 0;

        lines.forEach(line => {
            const metrics = ctx.measureText(line);
            maxWidth = Math.max(maxWidth, metrics.width);
            maxAscent = Math.max(maxAscent, metrics.actualBoundingBoxAscent || 0);
            maxDescent = Math.max(maxDescent, metrics.actualBoundingBoxDescent || 0);
        });
        
        const singleLineHeight = maxAscent + maxDescent;
        const finalLineHeight = singleLineHeight > 0 ? singleLineHeight : fontSize * 1.2; 
        const totalHeight = lines.length * finalLineHeight;

        ctx.restore();
        
        return { lines, lineHeight: finalLineHeight, maxWidth, totalHeight, ascent: maxAscent };
    },
    
    nudgeLayerZ(layerId, delta) {
        const i = this.state.canvasState.layers.findIndex(l => l.id === layerId);
        if (i === -1) return false;
        const j = i + delta;
        if (j < 0 || j >= this.state.canvasState.layers.length) return false;
        const [item] = this.state.canvasState.layers.splice(i, 1);
        this.state.canvasState.layers.splice(j, 0, item);
        return true;
    },

    updateLayerCache(layer) {
        if (!layer.cache) {
            layer.cache = { canvas: null, isValid: false };
        }
        
        const ctx = this.dom.movieCtx;
        let contentWidth, contentHeight, padding = 0;

        if (layer.type === 'image') {
            if (!layer.mipmaps || layer.mipmaps.length === 0 || layer.mipmaps[0].width === 0) {
                layer.cache.isValid = false; return;
            }
            const baseProxy = layer.mipmaps[0];
            contentWidth = baseProxy.width;
            contentHeight = baseProxy.height;
        } else {
            const metrics = this.getTextBlockMetrics(ctx, layer.text, layer.font, layer.fontSize);
            layer.width = metrics.maxWidth;
            layer.height = metrics.totalHeight;
            contentWidth = metrics.maxWidth;
            contentHeight = metrics.totalHeight;
        }
        
        if (contentWidth <= 0 || contentHeight <= 0) {
            if (layer.cache.canvas) {
                layer.cache.canvas.width = 0;
                layer.cache.canvas.height = 0;
            }
            layer.cache.isValid = true;
            return;
        }

        if (layer.shadow && layer.shadow.enabled) {
            padding = (layer.shadow.blur * 2) + Math.max(Math.abs(layer.shadow.offsetX), Math.abs(layer.shadow.offsetY));
        }
        if (layer.type === 'image' && layer.border && layer.border.enabled) {
            padding += layer.border.width * 2;
        }

        const cacheWidth = contentWidth + padding * 2;
        const cacheHeight = contentHeight + padding * 2;
        
        if (!layer.cache.canvas) {
            layer.cache.canvas = document.createElement('canvas');
        }
        layer.cache.canvas.width = cacheWidth;
        layer.cache.canvas.height = cacheHeight;
        const cacheCtx = layer.cache.canvas.getContext('2d');
        
        cacheCtx.clearRect(0, 0, cacheWidth, cacheHeight);
        cacheCtx.save();
        cacheCtx.translate(cacheWidth / 2, cacheHeight / 2);

        const filters = `brightness(${layer.brightness}) saturate(${layer.saturation}) contrast(${layer.contrast || 1})`;
        const shadow = layer.shadow.enabled ? `drop-shadow(${layer.shadow.offsetX}px ${layer.shadow.offsetY}px ${layer.shadow.blur}px ${layer.shadow.color})` : '';
        let borderFilters = '';
        if (layer.type === 'image' && layer.border.enabled && layer.border.width > 0) {
            const w = layer.border.width;
            const c = layer.border.color;
            borderFilters = `drop-shadow(${w}px ${w}px 0 ${c}) drop-shadow(-${w}px -${w}px 0 ${c}) drop-shadow(-${w}px ${w}px 0 ${c}) drop-shadow(${w}px -${w}px 0 ${c})`;
        }
        cacheCtx.filter = `${borderFilters} ${shadow} ${filters}`.trim();
        cacheCtx.globalAlpha = layer.opacity;

        if (layer.type === 'image') {
            const assetToDraw = layer.mipmaps[0];
            cacheCtx.drawImage(assetToDraw, -contentWidth / 2, -contentHeight / 2, contentWidth, contentHeight);
        } else { 
            cacheCtx.font = `${layer.fontSize}px ${layer.font}`;
            cacheCtx.fillStyle = layer.color;
            cacheCtx.textAlign = 'center';
            cacheCtx.textBaseline = 'alphabetic';
            if (layer.strokeWidth > 0) {
                cacheCtx.strokeStyle = layer.strokeColor;
                cacheCtx.lineWidth = layer.strokeWidth;
            }
            const metrics = this.getTextBlockMetrics(cacheCtx, layer.text, layer.font, layer.fontSize);
            const topOfBlockY = -metrics.totalHeight / 2;
            metrics.lines.forEach((line, index) => {
                const yPos = topOfBlockY + metrics.ascent + (index * metrics.lineHeight);
                if (layer.strokeWidth > 0) cacheCtx.strokeText(line, 0, yPos);
                cacheCtx.fillText(line, 0, yPos);
            });
        }

        cacheCtx.restore();
        layer.cache.isValid = true;
    },

    drawLayers(ctx, layers, isFinalRender = false) {
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
    
            if (!l.cache || !l.cache.isValid) {
                this.updateLayerCache(l);
            }
    
            if (l.cache && l.cache.canvas && l.cache.canvas.width > 0) {
                ctx.save();
                ctx.translate(l.x, l.y);
                ctx.rotate(l.rot * Math.PI / 180);
    
                const age = Date.now() - l.createdAt;
                if (!isFinalRender && !l.restored && age < this.config.FADE_IN_DURATION) {
                    const animationProgress = age / this.config.FADE_IN_DURATION;
                    const scaleFactor = 0.95 + 0.05 * animationProgress;
                    ctx.globalAlpha = animationProgress;
                    ctx.scale(scaleFactor, scaleFactor);
                }
    
                if (l.flipX) ctx.scale(-1, 1);
                
                let scale = 1;
                if (l.type === 'image') {
                    if (l.mipmaps && l.mipmaps.length > 0) {
                        scale = l.size / l.mipmaps[0].width;
                    }
                }
                ctx.scale(scale, scale);
    
                ctx.drawImage(l.cache.canvas, -l.cache.canvas.width / 2, -l.cache.canvas.height / 2);
    
                ctx.restore();
            }
        }
    },

    animationRenderLoop() {
        if (!this.state.isAnimatingRender) return;
        const stillAnimating = this.state.canvasState.layers.some(l => (Date.now() - l.createdAt) < this.config.FADE_IN_DURATION);
        if (stillAnimating) { this.drawFrame(); requestAnimationFrame(() => this.animationRenderLoop()); }
        else { this.state.isAnimatingRender = false; if (!this.state.movieInteraction.active) { this.drawFrame(); } }
    },

    triggerAnimatedRender() {
        if (this.state.isAnimatingRender || this.state.movieInteraction.active) return;
        this.state.isAnimatingRender = true;
        this.animationRenderLoop();
    },

    drawBackground() {
        if (!this.state.canvasState.backgroundElement) return;

        const bgCtx = this.dom.backgroundCtx;
        const canvas = this.dom.backgroundCanvas;
        const bgImage = this.state.canvasState.backgroundElement;
        const { scale, pan } = this.state.viewState;
        const rotation = this.state.canvasState.projectRotation;
        const rotationRad = rotation * (Math.PI / 180);
        const flip = this.state.canvasState.backgroundFlipX;

        bgCtx.clearRect(0, 0, canvas.width, canvas.height);
        bgCtx.save();
        
        bgCtx.filter = `brightness(${this.state.canvasState.bgBrightness}) saturate(${this.state.canvasState.bgSaturation})`;

        bgCtx.translate(pan.x, pan.y);
        bgCtx.scale(scale, scale);
        
        bgCtx.save();
        bgCtx.translate(canvas.width / 2, canvas.height / 2);
        bgCtx.rotate(rotationRad);
        if (flip) {
            bgCtx.scale(-1, 1);
        }
        
        const isTilted = [90, 270].includes(rotation);
        const destWidth = isTilted ? canvas.height : canvas.width;
        const destHeight = isTilted ? canvas.width : canvas.height;

        bgCtx.drawImage(bgImage, -destWidth / 2, -destHeight / 2, destWidth, destHeight);
        
        bgCtx.restore();
        bgCtx.restore();
    },

    drawFrame() {
        if (!this.state.canvasState.backgroundElement) {
            this.dom.movieCtx.clearRect(0, 0, this.dom.movieCanvas.width, this.dom.movieCanvas.height);
            this.dom.backgroundCtx.clearRect(0, 0, this.dom.backgroundCanvas.width, this.dom.backgroundCanvas.height);
            return;
        }

        const ctx = this.dom.movieCtx;
        const canvasWidth = this.dom.movieCanvas.width;
        const canvasHeight = this.dom.movieCanvas.height;

        this.drawBackground();
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        
        ctx.save();
        ctx.translate(this.state.viewState.pan.x, this.state.viewState.pan.y);
        ctx.scale(this.state.viewState.scale, this.state.viewState.scale);

        if (this.state.scrubbingMode === 'transform') {
            if (this.state.staticBackgroundCacheCanvas) {
                ctx.drawImage(this.state.staticBackgroundCacheCanvas, 0, 0);
            }

            const activeLayer = this.getActiveLayer();
            if (activeLayer) {
                this.drawLayers(ctx, [activeLayer]);
            }

            if (this.state.staticForegroundCacheCanvas) {
                ctx.drawImage(this.state.staticForegroundCacheCanvas, 0, 0);
            }
        } else {
            this.drawLayers(ctx, this.state.canvasState.layers);
        }

        if (this.state.viewState.scale < 1.0) {
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.beginPath();
            const margin = 2000 / this.state.viewState.scale;
            ctx.moveTo(-margin, -margin);
            ctx.lineTo(canvasWidth + margin, -margin);
            ctx.lineTo(canvasWidth + margin, canvasHeight + margin);
            ctx.lineTo(-margin, canvasHeight + margin);
            ctx.closePath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, canvasHeight);
            ctx.lineTo(canvasWidth, canvasHeight);
            ctx.lineTo(canvasWidth, 0);
            ctx.closePath();
            ctx.fill('evenodd');
            ctx.restore();
        }

        ctx.restore();

        this.drawControlsOverlay();
        this.updateContextualToolbar();
        this.updateCanvasPanelBackground();
    }, 
 
    startRenderLoop() {
        if (this.state.animationFrameId) return;
        const loop = () => { this.drawFrame(); this.state.animationFrameId = requestAnimationFrame(loop); };
        loop();
    },
    
    stopRenderLoop() { cancelAnimationFrame(this.state.animationFrameId); this.state.animationFrameId = null; this.drawFrame(); },

    drawControlsOverlay() {
        const ctx = this.dom.controlsCtx;
        const canvas = this.dom.controlsOverlayCanvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    
        ctx.save();
        ctx.translate(this.state.viewState.pan.x, this.state.viewState.pan.y);
        ctx.scale(this.state.viewState.scale, this.state.viewState.scale);
    
        if (this.state.scrubbingMode !== 'none') {
            ctx.restore();
            return;
        }
        
        const activeLayer = this.getActiveLayer();
    
        const isEraserContext = this.state.isEraserArmed || this.panelManager.activePanel === 'eraser-panel';
        const showFullHandles = activeLayer && (this.state.canvasHasInteractionFocus || isEraserContext);
    
        if (activeLayer) {
            ctx.save();
    
            const { dWidth, dHeight } = this.getLayerMetrics(activeLayer);
            if (!dWidth || !dHeight) { ctx.restore(); ctx.restore(); return; }
    
            const scale = this.state.viewState.scale * (this.dom.movieCanvas.getBoundingClientRect().width / this.dom.movieCanvas.width);
            if (scale === 0 || !isFinite(scale)) { ctx.restore(); ctx.restore(); return; }
    
            const HANDLE_SCREEN_SIZE = 12, BORDER_SCREEN_WIDTH = 1.5, ROTATION_HANDLE_SCREEN_OFFSET = 26;
            const handleSize = HANDLE_SCREEN_SIZE / scale, lineWidth = BORDER_SCREEN_WIDTH / scale, rotationHandleOffset = ROTATION_HANDLE_SCREEN_OFFSET / scale;
            const ho = handleSize / 2;
    
            ctx.translate(activeLayer.x, activeLayer.y);
            ctx.rotate(activeLayer.rot * Math.PI / 180);
    
            let offsetX = 0, offsetY = 0;
            if (activeLayer.type === 'image' && activeLayer.contentFrame) {
                const baseProxy = activeLayer.mipmaps[0];
                const fullWidth = activeLayer.size;
                const fullHeight = activeLayer.size * (baseProxy.height / baseProxy.width);
                const frameScale = fullWidth / baseProxy.width;
                const frameCenterX = (activeLayer.contentFrame.x + activeLayer.contentFrame.width / 2) * frameScale;
                const frameCenterY = (activeLayer.contentFrame.y + activeLayer.contentFrame.height / 2) * frameScale;
                offsetX = frameCenterX - (fullWidth / 2);
                offsetY = frameCenterY - (fullHeight / 2);
                ctx.translate(offsetX, offsetY);
            }
    
            ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
            ctx.strokeStyle = '#00FF00';
            ctx.fillStyle = '#00FF00';
            ctx.lineWidth = lineWidth;
            const halfW = dWidth / 2, halfH = dHeight / 2;
    
            if (showFullHandles) {
                ctx.strokeRect(-halfW, -halfH, dWidth, dHeight);
                ctx.beginPath(); ctx.arc(-halfW, -halfH, ho, 0, 2 * Math.PI); ctx.fill();
                ctx.beginPath(); ctx.arc(halfW, -halfH, ho, 0, 2 * Math.PI); ctx.fill();
                ctx.beginPath(); ctx.arc(-halfW, halfH, ho, 0, 2 * Math.PI); ctx.fill();
                ctx.beginPath(); ctx.arc(halfW, halfH, ho, 0, 2 * Math.PI); ctx.fill();
    
                const rotHandleY = -halfH - rotationHandleOffset;
                ctx.beginPath(); ctx.moveTo(0, -halfH); ctx.lineTo(0, rotHandleY); ctx.stroke();
                ctx.beginPath(); ctx.arc(0, rotHandleY, ho, 0, 2 * Math.PI); ctx.fill();
            } else if (activeLayer) {
                ctx.strokeRect(-halfW, -halfH, dWidth, dHeight);
            }
    
            ctx.restore();
        }
    
        if (this.state.isEraserArmed && this.state.eraseCanvasPoint) {
            const canvasPoint = this.state.eraseCanvasPoint;
            ctx.save();
            const brushSize = this.dom.eraserSize.value / this.state.viewState.scale;
            const brushColor = this.state.eraserMode === 'unerase' ? 'rgba(85, 204, 85, 0.9)' : 'white';
            ctx.beginPath();
            ctx.arc(canvasPoint.x, canvasPoint.y, brushSize / 2, 0, 2 * Math.PI);
            ctx.strokeStyle = brushColor;
            ctx.lineWidth = 2 / this.state.viewState.scale;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(canvasPoint.x, canvasPoint.y, brushSize / 2, 0, 2 * Math.PI);
            ctx.setLineDash([5 / this.state.viewState.scale, 5 / this.state.viewState.scale]);
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1 / this.state.viewState.scale;
            ctx.stroke();
            ctx.restore();
        }
    
        ctx.restore();
    },

    getRotatedBoundingBox(layer) {
        const { dWidth, dHeight } = this.getLayerMetrics(layer);
        if (dWidth === 0 || dHeight === 0) {
            return { left: layer.x, top: layer.y, right: layer.x, bottom: layer.y, width: 0, height: 0 };
        }

        const angle = layer.rot * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const halfW = dWidth / 2;
        const halfH = dHeight / 2;

        const corners = [
            { x: -halfW, y: -halfH },
            { x: halfW, y: -halfH },
            { x: halfW, y: halfH },
            { x: -halfW, y: halfH }
        ];

        const rotatedCorners = corners.map(corner => {
            return {
                x: layer.x + (corner.x * cos - corner.y * sin),
                y: layer.y + (corner.x * sin + corner.y * cos)
            };
        });

        const minX = Math.min(...rotatedCorners.map(c => c.x));
        const maxX = Math.max(...rotatedCorners.map(c => c.x));
        const minY = Math.min(...rotatedCorners.map(c => c.y));
        const maxY = Math.max(...rotatedCorners.map(c => c.y));

        return {
            left: minX,
            top: minY,
            right: maxX,
            bottom: maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    },

    downloadImage() {
        if (!this.state.canvasState.backgroundElement) { this.toast("Add a background before downloading.", 3000); return; }
        this.toast("Preparing high-quality image...", null);

        requestAnimationFrame(() => {
            try {
                const tempCanvas = document.createElement('canvas');
                const rotation = this.state.canvasState.projectRotation;
                const rotationRad = rotation * (Math.PI / 180);
                const bgImage = this.state.canvasState.backgroundElement;
                const flip = this.state.canvasState.backgroundFlipX;

                const sourceWidth = bgImage.naturalWidth;
                const sourceHeight = bgImage.naturalHeight;
                const isTilted = [90, 270].includes(rotation);
                const finalWidth = isTilted ? sourceHeight : sourceWidth;
                const finalHeight = isTilted ? sourceWidth : sourceHeight;

                const MAX_EXPORT_DIMENSION = 4096;
                let exportWidth = finalWidth;
                let exportHeight = finalHeight;
                if (exportWidth > MAX_EXPORT_DIMENSION || exportHeight > MAX_EXPORT_DIMENSION) {
                    const aspectRatio = exportWidth / exportHeight;
                    if (aspectRatio >= 1) {
                        exportWidth = MAX_EXPORT_DIMENSION;
                        exportHeight = exportWidth / aspectRatio;
                    } else {
                        exportHeight = MAX_EXPORT_DIMENSION;
                        exportWidth = exportHeight * aspectRatio;
                    }
                }
                tempCanvas.width = Math.round(exportWidth);
                tempCanvas.height = Math.round(exportHeight);

                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.imageSmoothingEnabled = true;
                tempCtx.imageSmoothingQuality = 'high';
                
                tempCtx.save();
                tempCtx.filter = `brightness(${this.state.canvasState.bgBrightness}) saturate(${this.state.canvasState.bgSaturation})`;
                tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
                tempCtx.rotate(rotationRad);
                if (flip) {
                    tempCtx.scale(-1, 1);
                }

                const destWidth = isTilted ? tempCanvas.height : tempCanvas.width;
                const destHeight = isTilted ? tempCanvas.width : tempCanvas.height;
                tempCtx.drawImage(bgImage, -destWidth / 2, -destHeight / 2, destWidth, destHeight);

                tempCtx.restore();

                tempCtx.save();
                const scaleFactor = exportWidth / this.dom.movieCanvas.width;
                tempCtx.scale(scaleFactor, scaleFactor);
                this.drawLayers(tempCtx, this.state.canvasState.layers, true);
                tempCtx.restore();

                const link = document.createElement('a');
                link.download = 'image-maker-creation.png';
                link.href = tempCanvas.toDataURL('image/png');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                this.toast("Image download started!", 4000);
            } catch (error) {
                console.error("Download failed:", error);
                this.toast("Error: Could not generate image. Check console.", 5000);
            }
        });
    },

    getMovieCanvasPoint(e) {
        const referenceCanvas = this.dom.controlsOverlayCanvas;
        const rect = referenceCanvas.getBoundingClientRect();
    
        if (rect.width === 0 || rect.height === 0) {
            return { x: 0, y: 0 };
        }
    
        const scaleX = referenceCanvas.width / rect.width;
        const scaleY = referenceCanvas.height / rect.height;
    
        let canvasX = (e.clientX - rect.left) * scaleX;
        let canvasY = (e.clientY - rect.top) * scaleY;
    
        let worldX = (canvasX - this.state.viewState.pan.x) / this.state.viewState.scale;
        let worldY = (canvasY - this.state.viewState.pan.y) / this.state.viewState.scale;
    
        return { x: worldX, y: worldY };
    },

   processEraseDab(ctx, x, y, radius, strength) {
        if (radius <= 0) return;

        if (strength >= 1.0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        } else {
            const coreRatio = Math.pow(strength, 3);
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);

            gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
            gradient.addColorStop(coreRatio, 'rgba(0, 0, 0, 1)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

            ctx.fillStyle = gradient;
        }

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    },
    
    applyBrushToLayer(layer, canvasPoint) {
        if (!layer || layer.type !== 'image' || !layer.mipmaps) return;

        if (layer.cache) {
            layer.cache.isValid = false;
        }
        
        const baseProxy = layer.mipmaps[0];
        const ctx = baseProxy.getContext('2d');

        const lastX = this.state.movieInteraction.lastProxyX;
        const lastY = this.state.movieInteraction.lastProxyY;

        const dx = canvasPoint.x - layer.x, dy = canvasPoint.y - layer.y;
        const angle = -layer.rot * Math.PI / 180;
        const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
        const localY = dx * Math.sin(angle) + dy * Math.cos(angle);

        let finalLocalX = localX;
        if (layer.flipX) { finalLocalX = -localX; }

        const assetWidth = baseProxy.width;
        const assetHeight = baseProxy.height;
        const layerRenderWidth = layer.size;
        const layerRenderHeight = layer.size * (assetHeight / assetWidth);
        const scaleFactor = assetWidth / layerRenderWidth;

        const proxyX = (finalLocalX + layerRenderWidth / 2) * scaleFactor;
        const proxyY = (localY + layerRenderHeight / 2) * scaleFactor;
        
        const brushSize = (this.dom.eraserSize.value / this.state.viewState.scale) * scaleFactor;

        if (this.state.eraserMode === 'erase') {
            const strength = parseFloat(this.dom.eraserStrength.value);
            const radius = brushSize / 2;
            ctx.globalCompositeOperation = 'destination-out';
            if (lastX !== null && lastY !== null) {
                const dist = Math.hypot(proxyX - lastX, proxyY - lastY);
                const angle = Math.atan2(proxyY - lastY, proxyX - lastX);
                const step = Math.max(1, radius / 3); 
                for (let i = 0; i < dist; i += step) {
                    const x = lastX + Math.cos(angle) * i;
                    const y = lastY + Math.sin(angle) * i;
                    this.processEraseDab(ctx, x, y, radius, strength);
                }
            }
            this.processEraseDab(ctx, proxyX, proxyY, radius, strength);
        } else { 
            const strength = parseFloat(this.dom.eraserStrength.value), radius = brushSize / 2;
            if (radius <= 0 || strength <= 0) return;
            const processUneraseDab = (x, y) => {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = strength * 0.5;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(layer.asset, 0, 0, baseProxy.width, baseProxy.height);
                ctx.restore();
            };
            if (lastX !== null && lastY !== null) {
                const dist = Math.hypot(proxyX - lastX, proxyY - lastY);
                const angle = Math.atan2(proxyY - lastY, proxyX - lastX);
                const step = Math.max(1, radius / 2);
                for (let i = 0; i < dist; i += step) {
                    const x = lastX + Math.cos(angle) * i;
                    const y = lastY + Math.sin(angle) * i;
                    processUneraseDab(x, y);
                }
            }
            processUneraseDab(proxyX, proxyY);
        }

        this.state.movieInteraction.lastProxyX = proxyX;
        this.state.movieInteraction.lastProxyY = proxyY;
        this.state.movieInteraction.didChangeContent = true;

        this._regenerateMipmapsFromBase(layer);

        this.drawFrame();
        this.state.lastEraseCanvasPoint = canvasPoint;
    },

    async runU2NetOnImageLayer(layer, session) {
        const bmp = await createImageBitmap(layer.asset);
        const modelInputSize = [1024, 1024];
        this.toast('Processing image...', null);
        await new Promise(resolve => setTimeout(resolve, 50));
        const preprocessedData = this.preprocess_bria(bmp, modelInputSize);
        const inputTensor = new ort.Tensor('float32', preprocessedData, [1, 3, modelInputSize[0], modelInputSize[1]]);
        const feeds = { [session.inputNames[0]]: inputTensor };
        const results = await session.run(feeds);
        const resultTensor = results[session.outputNames[0]];
        const originalSize = { width: bmp.width, height: bmp.height };
        const finalMask = this.postprocess_bria(resultTensor, originalSize);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = layer.mipmaps[0].width;
        tempCanvas.height = layer.mipmaps[0].height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.drawImage(layer.mipmaps[0], 0, 0); 
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(finalMask, 0, 0, tempCanvas.width, tempCanvas.height);
        const newBounds = this.calculateContentBounds(tempCanvas);
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = newBounds.isEmpty ? 1 : newBounds.width;
        croppedCanvas.height = newBounds.isEmpty ? 1 : newBounds.height;
        if (!newBounds.isEmpty) {
            croppedCanvas.getContext('2d').drawImage(tempCanvas, newBounds.x, newBounds.y, newBounds.width, newBounds.height, 0, 0, newBounds.width, newBounds.height);
        }
        const oldCenter = { x: tempCanvas.width / 2, y: tempCanvas.height / 2 };
        const newContentCenter = { x: newBounds.x + newBounds.width / 2, y: newBounds.y + newBounds.height / 2 };
        const shiftInLocalSpace = { x: newContentCenter.x - oldCenter.x, y: newContentCenter.y - oldCenter.y };
        const scale = layer.size / tempCanvas.width;
        const angle = layer.rot * Math.PI / 180;
        const rotatedShift = {
            x: shiftInLocalSpace.x * Math.cos(angle) - shiftInLocalSpace.y * Math.sin(angle),
            y: shiftInLocalSpace.x * Math.sin(angle) + shiftInLocalSpace.y * Math.cos(angle)
        };
        const newMipmaps = this.generateMipmaps(croppedCanvas, 2048);
        
        const transformPayload = {
            x: layer.x + rotatedShift.x * scale,
            y: layer.y + rotatedShift.y * scale,
            size: layer.size * (croppedCanvas.width / tempCanvas.width),
            mipmaps: newMipmaps,
            contentFrame: { x: 0, y: 0, width: croppedCanvas.width, height: croppedCanvas.height, isEmpty: newBounds.isEmpty },
            cache: { canvas: null, isValid: false },
        };

        const canvasWidth = this.dom.movieCanvas.width;
        const canvasHeight = this.dom.movieCanvas.height;
        const masterDim = Math.sqrt(canvasWidth * canvasHeight);

        transformPayload.propX = transformPayload.x / canvasWidth;
        transformPayload.propY = transformPayload.y / canvasHeight;
        transformPayload.propSize = transformPayload.size / masterDim;
        
        transformPayload.alignX = 'center';
        transformPayload.alignY = 'middle';

        this.dispatch({
            type: 'LAYER_TRANSFORMED',
            payload: { layerId: layer.id, ...transformPayload }
        });
    },

    getHandleWorldPosition(layer, handleName) {
        const { dWidth, dHeight } = this.getLayerMetrics(layer);
        if (!dWidth || !dHeight) return { x: layer.x, y: layer.y };
        let offsetX = 0, offsetY = 0;
        
        if (layer.type === 'image' && layer.contentFrame && layer.mipmaps && layer.mipmaps.length > 0) {
            const baseProxy = layer.mipmaps[0];
            const fullWidth = layer.size;
            const fullHeight = layer.size * (baseProxy.height / baseProxy.width);
            const frameScale = fullWidth / baseProxy.width; 
            const frameCenterX = (layer.contentFrame.x + layer.contentFrame.width / 2) * frameScale;
            const frameCenterY = (layer.contentFrame.y + layer.contentFrame.height / 2) * frameScale;
            offsetX = frameCenterX - (fullWidth / 2);
            offsetY = frameCenterY - (fullHeight / 2);
        }

        const handles = {
            tl: { x: -dWidth / 2, y: -dHeight / 2 }, tr: { x: dWidth / 2, y: -dHeight / 2 },
            bl: { x: -dWidth / 2, y: dHeight / 2 }, br: { x: dWidth / 2, y: dHeight / 2 }
        };
        const h = handles[handleName];
        if (!h) return { x: layer.x, y: layer.y };
        const angle = layer.rot * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
        const handleWorldX = layer.x + ((offsetX + h.x) * cos - (offsetY + h.y) * sin);
        const handleWorldY = layer.y + ((offsetX + h.x) * sin + (offsetY + h.y) * cos);
        return { x: handleWorldX, y: handleWorldY };
    },

    getMovieHandleAtPoint(point, layer) {
        const scale = this.state.viewState.scale * (this.dom.movieCanvas.getBoundingClientRect().width / this.dom.movieCanvas.width);
        if (scale === 0 || !isFinite(scale)) return null;
        const DESIRED_HIT_RADIUS_ON_SCREEN = 16;
        const radius = DESIRED_HIT_RADIUS_ON_SCREEN / scale;
        const { dWidth, dHeight } = this.getLayerMetrics(layer);
        if (!dWidth || !dHeight) return null;
        let offsetX = 0, offsetY = 0;

        if (layer.type === 'image' && layer.contentFrame && layer.mipmaps && layer.mipmaps.length > 0) {
            const baseProxy = layer.mipmaps[0];
            const fullWidth = layer.size;
            const fullHeight = layer.size * (baseProxy.height / baseProxy.width);
            const frameScale = fullWidth / baseProxy.width;
            const frameCenterX = (layer.contentFrame.x + layer.contentFrame.width / 2) * frameScale;
            const frameCenterY = (layer.contentFrame.y + layer.contentFrame.height / 2) * frameScale;
            offsetX = frameCenterX - (fullWidth / 2);
            offsetY = frameCenterY - (fullHeight / 2);
        }

        const angle = layer.rot * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
        const ROTATION_HANDLE_SCREEN_OFFSET = 26;
        const rotationHandleOffset = ROTATION_HANDLE_SCREEN_OFFSET / scale;
        const rotHandleLocalX = 0;
        const rotHandleLocalY = -dHeight / 2 - rotationHandleOffset;
        const rotHandleWorldX = layer.x + ((offsetX + rotHandleLocalX) * cos - (offsetY + rotHandleLocalY) * sin);
        const rotHandleWorldY = layer.y + ((offsetX + rotHandleLocalX) * sin + (offsetY + rotHandleLocalY) * cos);
        if (Math.hypot(point.x - rotHandleWorldX, point.y - rotHandleWorldY) < radius) return 'rotate';
        const handles = { tl: { x: -dWidth / 2, y: -dHeight / 2 }, tr: { x: dWidth / 2, y: -dHeight / 2 }, bl: { x: -dWidth / 2, y: dHeight / 2 }, br: { x: dWidth / 2, y: dHeight / 2 } };
        for (const name in handles) {
            const h = handles[name];
            const handleWorldX = layer.x + ((offsetX + h.x) * cos - (offsetY + h.y) * sin);
            const handleWorldY = layer.y + ((offsetX + h.x) * sin + (offsetY + h.y) * cos);
            if (Math.hypot(point.x - handleWorldX, point.y - handleWorldY) < radius) return name;
        }
        return null;
    },

    isPixelOpaqueAtPoint(layer, point) {
        if (layer.type !== 'image' || !layer.mipmaps || layer.mipmaps.length === 0) { 
            return true; 
        }
        
        const baseProxy = layer.mipmaps[0];
        const dx = point.x - layer.x;
        const dy = point.y - layer.y;
        const angle = -layer.rot * Math.PI / 180;
        const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
        const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
        const assetWidth = baseProxy.width;
        const assetHeight = baseProxy.height;
        const layerRenderWidth = layer.size;
        const layerRenderHeight = layer.size * (assetHeight / assetWidth);
        const scale = assetWidth / layerRenderWidth;
        const proxyX = Math.floor((localX + layerRenderWidth / 2) * scale);
        const proxyY = Math.floor((localY + layerRenderHeight / 2) * scale);

        if (proxyX < 0 || proxyX >= assetWidth || proxyY < 0 || proxyY >= assetHeight) { 
            return false; 
        }
        try {
            const ctx = baseProxy.getContext('2d');
            const pixelData = ctx.getImageData(proxyX, proxyY, 1, 1).data;
            return pixelData[3] > 10;
        } catch (e) {
            console.error("Could not read pixel data:", e);
            return true;
        }
    },

    handleMovieInteractionStart(e) {
        if (e.button === 1) { 
            e.preventDefault();
            this.state.isPanning = true;
            this.state.movieInteraction = { active: true, type: 'pan' };
            this.updateCursor(e);
            this.startRenderLoop();
            return;
        }
        
        const point = this.getMovieCanvasPoint(e);
        const activeLayer = this.getActiveLayer();

        if (this.state.isEraserArmed) {
            e.preventDefault();
            if (activeLayer && activeLayer.isLocked) { this.toast('Layer is locked', 1500); return; }
            if (activeLayer && activeLayer.type === 'image' && this.isPointInMovieLayer(point, activeLayer)) {
                const baseProxy = activeLayer.mipmaps[0];
                const strokeCanvas = new OffscreenCanvas(baseProxy.width, baseProxy.height);
                const strokeCtx = strokeCanvas.getContext('2d');
                this.state.movieInteraction = { 
                    active: true, type: 'erase', layerId: activeLayer.id, 
                    lastProxyX: null, lastProxyY: null, didChangeContent: false,
                    strokeCanvas: strokeCanvas, strokeCtx: strokeCtx
                };
                this.state.lastEraseCanvasPoint = point;
                this.applyBrushToLayer(activeLayer, point);
            }
            return;
        }
        e.preventDefault();
        let interactionFound = false;
        this.state.movieInteraction.didDrag = false;
        const handle = activeLayer ? this.getMovieHandleAtPoint(point, activeLayer) : null;
        
        if (activeLayer && handle) {
            if (activeLayer.isLocked) { this.toast('Layer is locked', 1500); return; }
            interactionFound = true;
            const interactionData = { active: true, type: handle === 'rotate' ? 'rotate' : 'resize', layerId: activeLayer.id, handle: handle, startX: point.x, startY: point.y, initialState: JSON.parse(JSON.stringify(activeLayer)) };
            if (interactionData.type === 'resize') {
                const oppositeHandles = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
                interactionData.anchorPoint = this.getHandleWorldPosition(activeLayer, oppositeHandles[handle]);
                interactionData.startHandlePoint = this.getHandleWorldPosition(activeLayer, handle);
            }
            this.state.movieInteraction = { ...this.state.movieInteraction, ...interactionData };
        } else {
            let layerToSelect = null;
            let topBoundingBoxLayer = null;

            for (const layer of this.state.canvasState.layers) {
                if (this.isPointInMovieLayer(point, layer)) {
                    if (!topBoundingBoxLayer) {
                        topBoundingBoxLayer = layer;
                    }
                    if (this.isPixelOpaqueAtPoint(layer, point)) {
                        layerToSelect = layer;
                        break;
                    }
                }
            }

            if (!layerToSelect) {
                layerToSelect = topBoundingBoxLayer;
            }

            if (layerToSelect) {
                if (layerToSelect.isLocked) {
                    if (this.state.activeLayerId !== layerToSelect.id) {
                        this.state.activeLayerId = layerToSelect.id;
                        this.updateLayerPaletteSelection(); this.updateEditPanelsUI(); this.drawFrame();
                    }
                    return; 
                }
                interactionFound = true;
                if (this.state.activeLayerId !== layerToSelect.id) {
                    this.state.activeLayerId = layerToSelect.id;
                    this.updateLayerPaletteSelection(); this.updateEditPanelsUI();
                }
                this.state.movieInteraction = { active: true, type: 'drag', layerId: layerToSelect.id, offsetX: point.x - layerToSelect.x, offsetY: point.y - layerToSelect.y, startClickPoint: point, initialState: JSON.parse(JSON.stringify(layerToSelect)) };
            } else {
                if (this.state.activeLayerId) {
                    this.state.activeLayerId = null;
                    this.updateLayerPaletteSelection(); this.updateEditPanelsUI();
                }
            }
        }

        this.drawFrame();
        if (interactionFound) {
            this.startRenderLoop(); 
        }
    },

    getLayerMetrics(layer) {
        if (!layer) return { dWidth: 0, dHeight: 0 };

        if (layer.type === 'image') {
            if (!layer.contentFrame || !layer.mipmaps || layer.mipmaps.length === 0) return { dWidth: 0, dHeight: 0 };
            const baseProxy = layer.mipmaps[0];
            const scale = layer.size / baseProxy.width;
            return { dWidth: layer.contentFrame.width * scale, dHeight: layer.contentFrame.height * scale };
        } 
        else if (layer.type === 'text') {
            const metrics = this.getTextBlockMetrics(this.dom.controlsCtx, layer.text, layer.font, layer.fontSize);
            return { dWidth: metrics.maxWidth, dHeight: metrics.totalHeight };
        }

        return { dWidth: 0, dHeight: 0 };
    },

    isPointInMovieLayer(point, layer) {
        if (!layer) return false;
        const { dWidth, dHeight } = this.getLayerMetrics(layer);
        if (dWidth === 0) return false;
        const dx = point.x - layer.x;
        const dy = point.y - layer.y;
        let offsetX = 0, offsetY = 0;

        if (layer.type === 'image' && layer.contentFrame && layer.mipmaps && layer.mipmaps.length > 0) {
            const baseProxy = layer.mipmaps[0];
            const fullWidth = layer.size;
            const scale = fullWidth / baseProxy.width;
            const frameCenterX = (layer.contentFrame.x + layer.contentFrame.width / 2) * scale;
            const frameCenterY = (layer.contentFrame.y + layer.contentFrame.height / 2) * scale;
            offsetX = frameCenterX - (fullWidth / 2);
            offsetY = frameCenterY - (layer.size * (baseProxy.height / baseProxy.width) / 2);
        }

        const angle = -layer.rot * Math.PI / 180;
        const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
        const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
        return (Math.abs(localX - offsetX) < dWidth / 2 && Math.abs(localY - offsetY) < dHeight / 2);
    },

    handleMovieInteractionMove(e) {
        if (this.state.isPanning && this.state.movieInteraction.type === 'pan') {
            const rect = this.dom.movieCanvas.getBoundingClientRect();
            if (rect.width === 0) return;
            const scaleFactor = this.dom.movieCanvas.width / rect.width;
            const newPanX = this.state.targetViewState.pan.x + e.movementX * scaleFactor;
            const newPanY = this.state.targetViewState.pan.y + e.movementY * scaleFactor;
            const constrainedPan = this._constrainPan(newPanX, newPanY, this.state.targetViewState.scale);
            this.state.targetViewState.pan.x = constrainedPan.x;
            this.state.targetViewState.pan.y = constrainedPan.y;
            this._requestViewAnimation();
            return;
        }

        const point = this.getMovieCanvasPoint(e);

        if (!this.state.movieInteraction.active) {
            if (this.state.isEraserArmed) { this.state.eraseCanvasPoint = point; this.drawControlsOverlay(); }
            this.updateCursor(e);
            return;
        }

        e.preventDefault();

        if (!this.state.movieInteraction.didDrag && this.state.movieInteraction.startClickPoint) {
            const dist = Math.hypot(point.x - this.state.movieInteraction.startClickPoint.x, point.y - this.state.movieInteraction.startClickPoint.y);
            if (dist > 3) { 
                this.state.movieInteraction.didDrag = true;
                this.state.scrubbingMode = 'transform';
                this.updateTransformCaches();
            }
        }

        const l = this.getActiveLayer();
        if (!l) return;

        if (this.state.movieInteraction.type === 'erase') {
            this.state.eraseCanvasPoint = point;
            this.applyBrushToLayer(l, point);
            return;
        }

        const iState = this.state.movieInteraction.initialState;
        if (this.state.movieInteraction.type === 'drag') {
            this.dispatch({ type: 'LAYER_TRANSFORMED', payload: { layerId: l.id, x: point.x - this.state.movieInteraction.offsetX, y: point.y - this.state.movieInteraction.offsetY } });
        } else if (this.state.movieInteraction.type === 'rotate') {
            const initialAngle = Math.atan2(this.state.movieInteraction.startY - iState.y, this.state.movieInteraction.startX - iState.x) * 180 / Math.PI;
            const currentAngle = Math.atan2(point.y - iState.y, point.x - iState.x) * 180 / Math.PI;
            this.dispatch({ type: 'LAYER_TRANSFORMED', payload: { layerId: l.id, rot: iState.rot + (currentAngle - initialAngle) } });
        } else if (this.state.movieInteraction.type === 'resize') {
            const { anchorPoint, startHandlePoint, initialState } = this.state.movieInteraction;
            const initialVector = { x: startHandlePoint.x - anchorPoint.x, y: startHandlePoint.y - anchorPoint.y };
            const currentMouseVector = { x: point.x - anchorPoint.x, y: point.y - anchorPoint.y };
            const initialDist = Math.hypot(initialVector.x, initialVector.y);
            if (initialDist > 1) {
                const dotProduct = currentMouseVector.x * initialVector.x + currentMouseVector.y * initialVector.y;
                const projectedDist = dotProduct / initialDist;
                const scaleFactor = Math.max(0.01, projectedDist / initialDist);
                const vectorFromAnchorToCenter = { x: initialState.x - anchorPoint.x, y: initialState.y - anchorPoint.y };
                const newX = anchorPoint.x + vectorFromAnchorToCenter.x * scaleFactor;
                const newY = anchorPoint.y + vectorFromAnchorToCenter.y * scaleFactor;
                this.dispatch({ type: 'LAYER_TRANSFORMED', payload: { layerId: l.id, x: newX, y: newY } });
                if (l.type === 'text') {
                    const newSize = Math.max(10, initialState.fontSize * scaleFactor);
                    this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: l.id, property: 'fontSize', value: newSize } });
                    this.dom.textSizeSlider.value = newSize; this.updateSliderFill(this.dom.textSizeSlider);
                } else {
                    const newSize = Math.max(20, initialState.size * scaleFactor);
                    this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: l.id, property: 'size', value: newSize } });
                }
            }
        }
    },

    handleMovieInteractionEnd(e) {
        if (this.state.isPanning) {
            this.state.isPanning = false;
            this.updateCursor(e);
        }
        if (!this.state.movieInteraction.active) return;

        try {
            const wasTransforming = ['drag', 'rotate', 'resize'].includes(this.state.movieInteraction.type);
            const wasErasing = this.state.movieInteraction.type === 'erase';
            this.stopRenderLoop();
            const l = this.getActiveLayer();

            if (wasTransforming && this.state.movieInteraction.didDrag && l) {
                const finalPayload = {};
                const canvasWidth = this.dom.movieCanvas.width;
                const canvasHeight = this.dom.movieCanvas.height;
                const masterDim = Math.sqrt(canvasWidth * canvasHeight);

                finalPayload.propX = l.x / canvasWidth;
                finalPayload.propY = l.y / canvasHeight;

                if (l.type === 'image') {
                    finalPayload.propSize = l.size / masterDim;
                } else if (l.type === 'text') {
                    finalPayload.propSize = l.fontSize / masterDim;
                }

                const bbox = this.getRotatedBoundingBox(l);
                const threshold = 20;
                finalPayload.alignX = 'center';
                finalPayload.alignY = 'middle';
                if (bbox.left < threshold) finalPayload.alignX = 'left';
                else if (bbox.right > canvasWidth - threshold) finalPayload.alignX = 'right';
                if (bbox.top < threshold) finalPayload.alignY = 'top';
                else if (bbox.bottom > canvasHeight - threshold) finalPayload.alignY = 'bottom';

                this.dispatch({ type: 'LAYER_TRANSFORMED', payload: { layerId: l.id, ...finalPayload } });
            
            } else if (wasErasing && this.state.movieInteraction.didChangeContent && l) {
                l.contentVersion = (l.contentVersion || 0) + 1;
                if (l.cache) l.cache.isValid = false;
                this.renderLayerPalette();
                this.renderPanelLayerPalettes();
            }

            if (!this.state.movieInteraction.didDrag && this.state.movieInteraction.startClickPoint) {
                const clickPoint = this.state.movieInteraction.startClickPoint;
                let finalLayerToSelect = null, topBoundingBoxLayer = null;
                for (const layer of this.state.canvasState.layers) {
                    if (this.isPointInMovieLayer(clickPoint, layer)) {
                        if (!topBoundingBoxLayer) topBoundingBoxLayer = layer;
                        if (this.isPixelOpaqueAtPoint(layer, clickPoint)) {
                            finalLayerToSelect = layer;
                            break;
                        }
                    }
                }
                finalLayerToSelect = finalLayerToSelect || topBoundingBoxLayer;
                if (this.state.activeLayerId !== (finalLayerToSelect ? finalLayerToSelect.id : null)) {
                    this.state.activeLayerId = finalLayerToSelect ? finalLayerToSelect.id : null;
                    this.updateLayerPaletteSelection();
                    this.updateEditPanelsUI();
                }
            }
        } finally {
            this.state.scrubbingMode = 'none';
            this.state.movieInteraction = { active: false, didDrag: false };
            this.drawFrame();
        }
    },

    handleDoubleClick(e) {
        e.preventDefault();

        if (this.panelManager.activePanel !== 'default-panel') {
            this.panelManager.show('default-panel');
            return;
        }

        const point = this.getMovieCanvasPoint(e);
        let topOpaqueLayer = null;
        let topBoundingBoxLayer = null;

        for (const layer of this.state.canvasState.layers) {
            if (this.isPointInMovieLayer(point, layer)) {
                if (!topBoundingBoxLayer) {
                    topBoundingBoxLayer = layer;
                }
                if (this.isPixelOpaqueAtPoint(layer, point)) {
                    topOpaqueLayer = layer;
                    break;
                }
            }
        }

        const targetLayer = topOpaqueLayer || topBoundingBoxLayer;

        if (targetLayer) {
            this.state.activeLayerId = targetLayer.id;
            this.updateLayerPaletteSelection();
            this.updateEditPanelsUI();
            this.drawFrame();

            if (targetLayer.type === 'image') {
                this.panelManager.show('visuals-panel');
                this.switchVisualsTab('asset');
            } else if (targetLayer.type === 'text') {
                this.loadSecondaryFonts();
                this.panelManager.show('text-panel');
            }
            return;
        }

        if (this.state.canvasState.backgroundElement) {
            this.state.activeLayerId = null;
            this.updateLayerPaletteSelection();
            this.updateEditPanelsUI();
            this.drawFrame();
            this.panelManager.show('visuals-panel');
            this.switchVisualsTab('background');
        }
    },

    updateCursor(e) {
        if (this.state.isPanning) {
            this.dom.movieCanvas.style.cursor = 'grabbing';
            return;
        }
        if (this.state.isEraserArmed) {
            this.dom.movieCanvas.style.cursor = 'none';
            return;
        }
    
        const point = this.getMovieCanvasPoint(e);
        let newCursor = 'default';
        const activeLayer = this.getActiveLayer();
    
        if (activeLayer) {
            const handle = this.getMovieHandleAtPoint(point, activeLayer);
            if (handle) {
                newCursor = handle === 'rotate' ? 'grab' : (handle === 'tl' || handle === 'br' ? 'nwse-resize' : 'nesw-resize');
            } else if (this.isPointInMovieLayer(point, activeLayer)) {
                newCursor = 'move';
            }
        } else {
            for (let i = 0; i < this.state.canvasState.layers.length; i++) {
                if (this.isPointInMovieLayer(point, this.state.canvasState.layers[i])) {
                    newCursor = 'pointer';
                    break;
                }
            }
        }
    
        this.dom.movieCanvas.style.cursor = newCursor;
    },

    handleKeyDown(e) {
        const key = e.key.toLowerCase();
        const isCmdOrCtrl = e.metaKey || e.ctrlKey;

        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
            if (key === 'escape') document.activeElement.blur();
            if (isCmdOrCtrl && key === 'z') {
                e.preventDefault();
                this.dispatch({ type: 'UNDO' });
                return;
            }
            if (isCmdOrCtrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
                e.preventDefault();
                this.dispatch({ type: 'REDO' });
                return;
            }
            return;
        }

        if (key === 't' && !isCmdOrCtrl) {
            e.preventDefault();
            if (this.state.canvasState.backgroundElement) {
                this.dispatch({ type: 'TOGGLE_BACKGROUND_FLIP' });
                this.drawFrame();
            }
            return;
        }

        if (key === 'r' && !isCmdOrCtrl) {
            e.preventDefault();
            this.rotateProject();
            return;
        }

        if (isCmdOrCtrl && key === 's') { e.preventDefault(); if (!this.dom.saveProjectBtn.disabled) this.libraryManager.saveProjectToLibrary(); return; }
        if (isCmdOrCtrl && key === 'z') { e.preventDefault(); this.dispatch({ type: 'UNDO' }); return; }
        if (isCmdOrCtrl && (key === 'y' || (e.shiftKey && key === 'z'))) { e.preventDefault(); this.dispatch({ type: 'REDO' }); return; }
        if (key === 'z' && !isCmdOrCtrl) { e.preventDefault(); this.resetView(); return; }
        if (key === 'escape' && this.state.isEraserArmed) { e.preventDefault(); this.deactivateEraser(); return; }
        
        const activeLayer = this.getActiveLayer();
        if (!activeLayer) return;

        if (key === 'q' || key === 'w') {
            e.preventDefault();
            const delta = key === 'q' ? -1 : 1;
            this.dispatch({ type: 'LAYER_REORDERED', payload: { layerId: activeLayer.id, delta: delta } });
            this.updateTextOrderButtonsState();
            return;
        }

        if (key === 'd' || key === 'f' || key === 's') {
            e.preventDefault();
            if (key === 'd' || key === 'f') {
                const scaleFactor = key === 'd' ? 1.05 : 0.95;
                if (activeLayer.type === 'image') {
                    const newSize = activeLayer.size * scaleFactor;
                    this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: activeLayer.id, property: 'size', value: newSize } });
                } else if (activeLayer.type === 'text') {
                    const newSize = activeLayer.fontSize * scaleFactor;
                    this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: activeLayer.id, property: 'fontSize', value: newSize } });
                    this.dom.textSizeSlider.value = newSize;
                    this.updateSliderFill(this.dom.textSizeSlider);
                }
            } else if (key === 's') {
                this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: activeLayer.id, property: 'flipX', value: !activeLayer.flipX } });
            }
        }
        
        else if (key === 'delete' || key === 'backspace') { 
            e.preventDefault(); 
            this.deleteMovieLayer(activeLayer.id); 
            this.toast('Layer deleted', 3000); 
            return; 
        }
    },

    clearCanvas(isSoft = false) {
        this.state.canvasState.layers.forEach(layer => {
            if (layer.type === 'image' && layer.src.startsWith('blob:')) {
                URL.revokeObjectURL(layer.src);
                if (layer.originalTempSrc) URL.revokeObjectURL(layer.originalTempSrc);
            }
        });
        this.state.canvasState = { currentProjectId: null, backgroundElement: null, backgroundType: 'none', backgroundHash: null, bgBrightness: 1, bgSaturation: 1, layers: [], dominantColor: null };
        this.state.activeLayerId = null;
        this.deactivateEraser();
        this.updateCanvasPanelBackground();

        this.dom.backgroundCtx.clearRect(0, 0, this.dom.backgroundCanvas.width, this.dom.backgroundCanvas.height);
        this.dom.movieCtx.clearRect(0, 0, this.dom.movieCanvas.width, this.dom.movieCanvas.height);
        this.dom.controlsCtx.clearRect(0, 0, this.dom.controlsOverlayCanvas.width, this.dom.controlsOverlayCanvas.height);
        
        this.dom.canvasPlaceholder.classList.remove('hidden');
        try { localStorage.removeItem('ims-autosave-project'); } catch (e) { console.warn("Could not clear autosave data from storage.", e); }
        this.updateControlsState();
        this.updateEditPanelsUI();
        this.drawFrame();
        if (!isSoft) {
            this.toast("Canvas cleared. Saved projects are safe.", 2000);
            this.state.lastSavedStateHash = this.generateCanvasStateHash();
        }
    },

    deactivateEraser() {
        if (!this.state.isEraserArmed) return;
        this.state.isEraserArmed = false;
        if (this.dom.eraserControlsWrapper) this.dom.eraserControlsWrapper.classList.add('disabled');
        if (this.dom.eraseBtn) this.dom.eraseBtn.classList.remove('active');
        if (this.dom.uneraseBtn) this.dom.uneraseBtn.classList.remove('active');
        if (this.dom.eraseToolBtn) this.dom.eraseToolBtn.classList.remove('btn-active');
        if (this.dom.movieCanvas) this.dom.movieCanvas.classList.remove('erase-cursor');
        this.hideToast(); this.drawFrame();
        if (this.panelManager.activePanel === 'eraser-panel') { this.panelManager.show('default-panel'); }
    },

    setEraserMode(newMode) {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer || activeLayer.type !== 'image') {
            this.toast('Select an image layer to use the eraser.', 3000);
            return;
        }

        if (this.state.isEraserArmed && this.state.eraserMode === newMode) {
            this.state.isEraserArmed = false;
        } else {
            this.state.isEraserArmed = true;
            this.state.eraserMode = newMode;
        }

        this.dom.movieCanvas.classList.toggle('erase-cursor', this.state.isEraserArmed);
        this.dom.eraseBtn.classList.toggle('active', this.state.isEraserArmed && this.state.eraserMode === 'erase');
        this.dom.uneraseBtn.classList.toggle('active', this.state.isEraserArmed && this.state.eraserMode === 'unerase');
        this.dom.eraseToolBtn.classList.add('btn-active');
        this.dom.eraserControlsWrapper.classList.remove('disabled');

        if (this.state.isEraserArmed) {
            this.toast(`${this.state.eraserMode.charAt(0).toUpperCase() + this.state.eraserMode.slice(1)} Mode Armed.`, 2500);
        } else {
            this.hideToast();
        }
        this.drawFrame();
    },

    openConfirmationModal(text, onConfirm) { this.dom.confirmationText.textContent = text; this.state.confirmCallback = onConfirm; this.dom.confirmationOverlay.classList.add('visible'); },
    closeConfirmationModal() { this.dom.confirmationOverlay.classList.remove('visible'); this.state.confirmCallback = null; },

    updateTextOrderButtonsState() {
        const textMoveBackBtn = document.getElementById('text-move-back');
        const textMoveForwardBtn = document.getElementById('text-move-forward');
        if (!textMoveBackBtn || !textMoveForwardBtn) return;
        const l = this.getActiveLayer();
        if (!l || l.type !== 'text') { textMoveBackBtn.disabled = true; textMoveForwardBtn.disabled = true; return; }
        const idx = this.state.canvasState.layers.findIndex(x => x.id === l.id);
        textMoveForwardBtn.disabled = (idx === 0);
        textMoveBackBtn.disabled = (idx === this.state.canvasState.layers.length - 1);
    },

    async getBgSession(mode) {
        if (this.state.bgSessionCache.has(mode)) return this.state.bgSessionCache.get(mode);
        const url = this.config.BG_MODELS[mode] || this.config.BG_MODELS.fast;
        const modelName = mode.charAt(0).toUpperCase() + mode.slice(1);
        this.toast(`Loading ${modelName} model`, null);
        try {
            const resp = await fetch(url, { mode: 'cors', cache: 'force-cache' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = await resp.arrayBuffer();
            const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            this.state.bgSessionCache.set(mode, session);
            this.hideToast();
            return session;
        } catch (e) {
            this.hideToast();
            console.error(`Failed to load '${mode}' model from ${url}. Error: ${e.message}`);
            this.toast('Critical: Background removal model failed to load.', 5000);
            throw new Error("Could not load the background removal model.");
        }
    },

    rgbaToCHWFloat32(imgData, size = 320) {
        const { data } = imgData;
        const chw = new Float32Array(3 * size * size);
        let p = 0, rOff = 0, gOff = size * size, bOff = 2 * size * size;
        for (let i = 0; i < data.length; i += 4) {
            chw[rOff + p] = data[i] / 255;
            chw[gOff + p] = data[i + 1] / 255;
            chw[bOff + p] = data[i + 2] / 255;
            p++;
        }
        return chw;
    },

    preprocess_bria: function (imgBitmap, modelInputSize) {
        const canvas = new OffscreenCanvas(modelInputSize[0], modelInputSize[1]);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgBitmap, 0, 0, modelInputSize[0], modelInputSize[1]);
        const imageData = ctx.getImageData(0, 0, modelInputSize[0], modelInputSize[1]);
        const { data } = imageData;
        const float32Data = new Float32Array(3 * modelInputSize[0] * modelInputSize[1]);

        for (let i = 0; i < data.length / 4; i++) {
            const R = data[i * 4 + 0];
            const G = data[i * 4 + 1];
            const B = data[i * 4 + 2];
            float32Data[i] = R / 255.0 - 0.5;
            float32Data[i + modelInputSize[0] * modelInputSize[1]] = G / 255.0 - 0.5;
            float32Data[i + 2 * modelInputSize[0] * modelInputSize[1]] = B / 255.0 - 0.5;
        }
        return float32Data;
    },

    postprocess_bria: function (resultTensor, originalSize) {
        const outputData = resultTensor.data;
        const maskCanvas = new OffscreenCanvas(resultTensor.dims[3], resultTensor.dims[2]);
        const maskCtx = maskCanvas.getContext('2d');
        const maskImageData = maskCtx.createImageData(resultTensor.dims[3], resultTensor.dims[2]);

        let minValue = Infinity;
        let maxValue = -Infinity;
        for (let i = 0; i < outputData.length; i++) {
            if (outputData[i] < minValue) minValue = outputData[i];
            if (outputData[i] > maxValue) maxValue = outputData[i];
        }
        const range = maxValue - minValue;

        for (let i = 0; i < outputData.length; i++) {
            const normalizedValue = (outputData[i] - minValue) / range;
            let sharpenedValue = normalizedValue * normalizedValue * (3.0 - 2.0 * normalizedValue);
            const pixelValue = Math.round(sharpenedValue * 255);

            maskImageData.data[i * 4 + 0] = 0;
            maskImageData.data[i * 4 + 1] = 0;
            maskImageData.data[i * 4 + 2] = 0;
            maskImageData.data[i * 4 + 3] = pixelValue;
        }
        maskCtx.putImageData(maskImageData, 0, 0);

        const finalMask = new OffscreenCanvas(originalSize.width, originalSize.height);
        const finalCtx = finalMask.getContext('2d');
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.drawImage(maskCanvas, 0, 0, originalSize.width, originalSize.height);
        return finalMask;
    },

    letterboxToSquareBitmap(imgBitmap, size = 320) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const scale = Math.min(size / imgBitmap.width, size / imgBitmap.height);
        const dw = Math.round(imgBitmap.width * scale), dh = Math.round(imgBitmap.height * scale);
        const dx = Math.floor((size - dw) / 2), dy = Math.floor((size - dh) / 2);
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(imgBitmap, 0, 0, imgBitmap.width, imgBitmap.height, dx, dy, dw, dh);
        return { canvas, dx, dy, dw, dh };
    },

    async removeBgForActiveImageLayer() {
        this.panelManager.show('default-panel');
        const active = this.getActiveLayer();
        if (!active || active.type !== 'image') { this.toast('Select an image layer first.', 2500); return; }
        const mode = 'fast';
        try {
            const session = await this.getBgSession(mode);
            if (!session) return;
            this.toast(`Removing background`, null);
            await new Promise(resolve => setTimeout(resolve, 50));
            await this.runU2NetOnImageLayer(active, session);
            this.toast(`Background removed.`, 2500);
            if (this.renderLayerPalette) this.renderLayerPalette();
            if (this.drawFrame) this.drawFrame();
        } catch (err) {
            console.error(err);
            this.hideToast();
            this.toast('BG removal failed. See console.', 4000);
        }
    },

    upscaleMaskToLayer(maskBitmap, boxed, layerWidth, layerHeight) {
        const { dx, dy, dw, dh } = boxed;
        const tempMaskCanvas = new OffscreenCanvas(maskBitmap.width, maskBitmap.height);
        tempMaskCanvas.getContext('2d').drawImage(maskBitmap, 0, 0);
        const croppedMaskCanvas = new OffscreenCanvas(dw, dh);
        croppedMaskCanvas.getContext('2d').drawImage(tempMaskCanvas, dx, dy, dw, dh, 0, 0, dw, dh);
        const finalMaskCanvas = new OffscreenCanvas(layerWidth, layerHeight);
        const finalCtx = finalMaskCanvas.getContext('2d');
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.drawImage(croppedMaskCanvas, 0, 0, dw, dh, 0, 0, layerWidth, layerHeight);
        return finalMaskCanvas;
    },

    featherMask(canvas, amount = 1.2) {
        const ctx = canvas.getContext('2d');
        if (amount > 0) {
            ctx.filter = `blur(${amount}px)`;
            ctx.drawImage(canvas, 0, 0);
            ctx.filter = 'none';
        }
    },

    async getSavableState(includeAssetData = false) {
        const savableState = {
            currentProjectId: this.state.canvasState.currentProjectId,
            backgroundHash: this.state.canvasState.backgroundHash,
            bgBrightness: this.state.canvasState.bgBrightness,
            bgSaturation: this.state.canvasState.bgSaturation,
            projectRotation: this.state.canvasState.projectRotation || 0,
            backgroundFlipX: this.state.canvasState.backgroundFlipX || false,
            layers: []
        };

        if (includeAssetData && this.state.canvasState.backgroundHash) {
            savableState.assetData = {};
            const backgroundAsset = await this.libraryManager.idbFindByHash(this.state.canvasState.backgroundHash);
            if (backgroundAsset.length > 0) {
                savableState.assetData[this.state.canvasState.backgroundHash] = await this.toDataURL(backgroundAsset[0].full);
            }
        }

        for (const layer of this.state.canvasState.layers) {
            const { asset, mipmaps, cache, proxyCanvas, proxyCtx, ...serializableLayer } = layer;
            if (layer.type === 'image') {
                if (mipmaps && mipmaps.length > 0) {
                    serializableLayer.proxyCanvasDataURL = mipmaps[0].toDataURL('image/webp', 0.9);
                } else if (proxyCanvas) {
                    serializableLayer.proxyCanvasDataURL = proxyCanvas.toDataURL('image/webp', 0.9);
                }
                if (includeAssetData && layer.originalHash && savableState.assetData) {
                    if (!savableState.assetData[layer.originalHash]) {
                        const layerAsset = await this.libraryManager.idbFindByHash(layer.originalHash);
                        if (layerAsset.length > 0) {
                            savableState.assetData[layer.originalHash] = await this.toDataURL(layerAsset[0].full);
                        }
                    }
                }
            }
            savableState.layers.push(serializableLayer);
        }
        return savableState;
    },

    async saveCurrentWork() {
        if (!this.state.canvasState.backgroundElement) return;
        try {
            const state = await this.getSavableState();
            localStorage.setItem('ims-autosave-project', JSON.stringify(state));
        } catch (e) {
            console.warn("Autosave failed. Storage may be inaccessible.", e);
        }
    },

    async _updateAssetReferences(newHashes, oldHashes = new Set()) {
        const addedHashes = [...newHashes].filter(h => !oldHashes.has(h));
        const removedHashes = [...oldHashes].filter(h => !newHashes.has(h));

        for (const hash of addedHashes) {
            const assets = await this.idbFindByHash(hash);
            if (assets.length > 0) {
                const asset = assets[0];
                asset.referenceCount = (asset.referenceCount || 0) + 1;
                asset.isUserDeleted = false;
                await this.idbPut(asset, 'assets');
            }
        }

        for (const hash of removedHashes) {
            const assets = await this.idbFindByHash(hash);
            if (assets.length > 0) {
                const asset = assets[0];
                asset.referenceCount = Math.max(0, (asset.referenceCount || 1) - 1);
                
                if (asset.referenceCount === 0 && asset.isUserDeleted) {
                    await this.idbDelete(asset.id, 'assets');
                } else {
                    await this.idbPut(asset, 'assets');
                }
            }
        }
    },

    async createLayerFromSave(savedLayer) {
        const layerWithCache = { ...savedLayer, cache: { canvas: null, isValid: false } };
        
        if (layerWithCache.type === 'text') {
            return { ...layerWithCache, createdAt: Date.now(), restored: true };
        }

        if (layerWithCache.type === 'image') {
            try {
                const assetRecords = await this.libraryManager.idbFindByHash(layerWithCache.originalHash);
                if (!assetRecords || assetRecords.length === 0) { throw new Error(`Asset with hash ${layerWithCache.originalHash} not in library.`); }
                const originalAssetBlob = assetRecords[0].full;
                const originalAsset = new Image();
                originalAsset.src = URL.createObjectURL(originalAssetBlob);

                const proxyImage = new Image();
                const decodingPromise = new Promise((resolve, reject) => {
                    proxyImage.onload = resolve;
                    proxyImage.onerror = reject;
                    proxyImage.src = layerWithCache.proxyCanvasDataURL;
                });

                await Promise.all([originalAsset.decode().catch(e=>e), decodingPromise]);
                
                const mipmaps = this.generateMipmaps(proxyImage, 2048);

                const restoredLayer = {
                    ...layerWithCache,
                    asset: originalAsset,
                    mipmaps: mipmaps,
                    createdAt: Date.now(),
                    restored: true,
                    isOptimized: true,
                    src: originalAsset.src
                };

                restoredLayer.contentFrame = { 
                    x: 0, 
                    y: 0, 
                    width: mipmaps[0].width, 
                    height: mipmaps[0].height, 
                    isEmpty: false 
                };
                
                delete restoredLayer.proxyCanvasDataURL;

                return restoredLayer;
            } catch (error) {
                console.error("Error restoring image layer:", error);
                this.toast(`Skipping a layer: Invalid image data.`, 3500);
                return null;
            }
        }
        return null;
    },

    async restoreProjectState(projectState) {
        const textLayers = projectState.layers.filter(l => l.type === 'text' && l.font);
        const uniqueFontValues = [...new Set(textLayers.map(l => l.font))];
        const fontNamesToLoad = uniqueFontValues.map(value => this.config.fontValueToNameMap.get(value)).filter(name => name && name !== 'VT323');

        await this.loadSpecificFonts(fontNamesToLoad);

        await new Promise(resolve => requestAnimationFrame(() => {
            const primingCtx = this.dom.movieCtx;
            if (primingCtx) {
                primingCtx.save();
                uniqueFontValues.forEach(fontValue => {
                    primingCtx.font = `1px ${fontValue}`;
                    primingCtx.fillText('', 0, 0);
                });
                primingCtx.restore();
            }
            resolve();
        }));

        if (!projectState.backgroundHash) { throw new Error("Saved project is missing a background."); }

        let bgAssets = await this.libraryManager.idbFindByHash(projectState.backgroundHash);
        if (!bgAssets || bgAssets.length === 0) {
            throw new Error("Background asset for saved project not found in library.");
        }
        const img = new Image();
        const bgDecodingPromise = new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(bgAssets[0].full);
        });
        await bgDecodingPromise;

        this.clearCanvas(true);

        this.state.canvasState.projectRotation = projectState.projectRotation || 0;
        this.state.canvasState.backgroundFlipX = projectState.backgroundFlipX || false;

        this.setBackground(img, projectState.backgroundHash, true);
        
        this.state.canvasState.bgBrightness = projectState.bgBrightness || 1;
        this.state.canvasState.bgSaturation = projectState.bgSaturation || 1;
        this.state.canvasState.currentProjectId = projectState.currentProjectId || null;
        this.state.canvasState.dominantColor = this.getDominantColor(img);
        this.updateCanvasPanelBackground();
        this.updateBackgroundVisualsUI();
        this.drawBackground();

        const layerPromises = projectState.layers.map(l => this.createLayerFromSave(l));
        const loadedLayers = await Promise.all(layerPromises);
        this.state.canvasState.layers = loadedLayers.filter(l => l !== null);

        this.updateControlsState();
        this.updateEditPanelsUI();
        await this.saveCurrentWork();
        requestAnimationFrame(() => {
            this.drawFrame();
        });
    },

    toDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    },

    async restoreCurrentWork() {
        const savedData = localStorage.getItem('ims-autosave-project');
        if (!savedData) {
            return;
        }
        try {
            const projectState = JSON.parse(savedData);
            this.toast("Restoring previous work...", null);
            await this.restoreProjectState(projectState);
            this.toast("Work restored!", 2000);
        } catch (error) {
            console.error("Failed to restore project:", error);
            this.toast(`Could not restore work: ${error.message}`, 4000);
            localStorage.removeItem('ims-autosave-project');
        }
    },

    debounce(func, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    },

    addBgUI() {
        const panel = document.getElementById('ai-tools-panel');
        if (!panel || panel.querySelector('.mg-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'mg-btn';
        btn.textContent = 'Remove Background';
        btn.style.marginTop = '0.5rem';
        btn.addEventListener('click', () => this.removeBgForActiveImageLayer());
        panel.appendChild(btn);
    },

    openFontPreviewModal() {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer || activeLayer.type !== 'text') {
            this.toast('Select a text layer first.', 3000);
            return;
        }
        this.loadSecondaryFonts().then(() => {
            this.populateFontPreviewGrid();
            this.dom.fontPreviewOverlay.classList.add('visible');
        }).catch(err => {
            console.error("Could not load fonts for preview:", err);
            this.toast("Error: Could not load fonts for preview.", 4000);
        });
    },

    setupEraserSlider(slider) {
        slider.addEventListener('input', () => {
            this.updateSliderFill(slider);
            this.drawControlsOverlay();
        });
    },

    closeFontPreviewModal() {
        this.dom.fontPreviewOverlay.classList.remove('visible');
    },

    populateFontPreviewGrid() {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer) return;
        this.dom.fontPreviewGrid.innerHTML = '';
        const previewText = activeLayer.text.trim() || 'Sample Text';
        const fragment = document.createDocumentFragment();
        this.config.availableFonts.forEach(font => {
            const item = document.createElement('div');
            item.className = 'font-preview-item';
            item.textContent = previewText;
            item.style.fontFamily = font.value;
            if (font.style) {
                item.setAttribute('style', `font-family: ${font.value}; ${font.style}`);
            }
            item.dataset.fontValue = font.value;
            item.dataset.fontName = font.name;
            item.title = font.name;
            item.addEventListener('click', () => {
                this.dispatch({
                    type: 'LAYER_PROPERTY_CHANGED',
                    payload: { layerId: activeLayer.id, property: 'font', value: font.value }
                });
                this.updateTextVisualsUI();
                this.drawFrame();
                this.closeFontPreviewModal();
            });
            fragment.appendChild(item);
        });
        this.dom.fontPreviewGrid.appendChild(fragment);
    },

    updateContextualToolbar() {
        const activeLayer = this.getActiveLayer();
        const toolbar = this.dom.contextualToolbar;

        const shouldBeVisible = activeLayer && activeLayer.type === 'image' && this.state.canvasHasInteractionFocus;

        if (!shouldBeVisible) {
            toolbar.classList.remove('visible');
            return;
        }

        const canvasRect = this.dom.movieCanvas.getBoundingClientRect();

        const toolbarWidth = toolbar.offsetWidth;
        const rightOffset = 10;
        const bottomOffset = 10;

        const targetX = (canvasRect.right - toolbarWidth - rightOffset);
        const targetY = (canvasRect.bottom - toolbar.offsetHeight - bottomOffset);

        toolbar.style.left = `${targetX}px`;
        toolbar.style.top = `${targetY}px`;
        toolbar.classList.add('visible');
    },

    duplicateLayer(layerId) {
        const sourceLayer = this.state.canvasState.layers.find(l => l.id === layerId);
        if (!sourceLayer) return;

        const { asset, mipmaps, cache, ...serializableLayer } = sourceLayer;
        const newLayer = JSON.parse(JSON.stringify(serializableLayer));

        newLayer.id = (Date.now() + Math.random()).toString();
        newLayer.x += 20;
        newLayer.y += 20;
        newLayer.isCopy = true;
        newLayer.isLocked = false;

        newLayer.mipmaps = sourceLayer.mipmaps.map(mip => {
            const newMipCanvas = document.createElement('canvas');
            newMipCanvas.width = mip.width;
            newMipCanvas.height = mip.height;
            newMipCanvas.getContext('2d').drawImage(mip, 0, 0);
            return newMipCanvas;
        });

        newLayer.asset = sourceLayer.asset; 
        newLayer.cache = { canvas: null, isValid: false }; 

        this.dispatch({ type: 'LAYER_ADDED', payload: { newLayer: newLayer } });

        this.toast('Layer duplicated', 2000);
        this.triggerAnimatedRender();
    },

    async saveActiveAssetToLibrary() {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer || activeLayer.type !== 'image' || !activeLayer.mipmaps || activeLayer.mipmaps.length === 0) {
            this.toast('Please select an image layer to save.', 2500);
            return;
        }

        this.toast('Saving asset to library...', null);

        try {
            const baseMipmap = activeLayer.mipmaps[0];
            const baseBlob = await new Promise(resolve => baseMipmap.toBlob(resolve, 'image/webp', 0.9));
            const newHash = await this.sha256Hex(baseBlob);

            const visualState = {
                opacity: activeLayer.opacity,
                brightness: activeLayer.brightness,
                saturation: activeLayer.saturation,
                contrast: activeLayer.contrast,
                shadow: JSON.parse(JSON.stringify(activeLayer.shadow)),
                border: JSON.parse(JSON.stringify(activeLayer.border)),
            };

            const thumbRenderCanvas = document.createElement('canvas');
            const sourceCanvas = baseMipmap;
            
            let padding = 0;
            if (visualState.shadow.enabled) {
                padding = (visualState.shadow.blur * 2) + Math.max(Math.abs(visualState.shadow.offsetX), Math.abs(visualState.shadow.offsetY));
            }
            if (visualState.border.enabled) {
                padding += visualState.border.width * 2;
            }

            thumbRenderCanvas.width = sourceCanvas.width + padding * 2;
            thumbRenderCanvas.height = sourceCanvas.height + padding * 2;
            const thumbCtx = thumbRenderCanvas.getContext('2d');
            
            thumbCtx.translate(thumbRenderCanvas.width / 2, thumbRenderCanvas.height / 2);

            const filters = `brightness(${visualState.brightness}) saturate(${visualState.saturation}) contrast(${visualState.contrast || 1})`;
            const shadow = visualState.shadow.enabled ? `drop-shadow(${visualState.shadow.offsetX}px ${visualState.shadow.offsetY}px ${visualState.shadow.blur}px ${visualState.shadow.color})` : '';
            let borderFilters = '';
            if (visualState.border.enabled && visualState.border.width > 0) {
                const w = visualState.border.width;
                const c = visualState.border.color;
                borderFilters = `drop-shadow(${w}px ${w}px 0 ${c}) drop-shadow(-${w}px -${w}px 0 ${c}) drop-shadow(-${w}px ${w}px 0 ${c}) drop-shadow(${w}px -${w}px 0 ${c})`;
            }
            
            thumbCtx.filter = `${borderFilters} ${shadow} ${filters}`.trim();
            thumbCtx.globalAlpha = visualState.opacity;

            thumbCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
            
            const finalThumbBlob = await this.createThumbBlob(thumbRenderCanvas);

            await this.libraryManager.saveAssetToLibrary({
                blob: baseBlob,
                thumbBlob: finalThumbBlob,
                mime: 'image/webp',
                hash: newHash,
                kind: 'asset',
                visualState: visualState
            });

            this.toast('Asset saved to Project Library!', 3000);
        } catch (error) {
            console.error("Failed to save asset to library:", error);
            this.toast("Error: Could not save asset.", 4000);
        }
    },

    async downloadActiveAsset() {
        const activeLayer = this.getActiveLayer();
        if (!activeLayer || activeLayer.type !== 'image' || !activeLayer.mipmaps || activeLayer.mipmaps.length === 0) {
            this.toast('Please select a valid image layer to download.', 2500);
            return;
        }

        this.toast('Generating asset...', null);

        try {
            const sourceCanvas = activeLayer.mipmaps[0];
            const tempCanvas = document.createElement('canvas');
            
            let padding = 0;
            if (activeLayer.shadow.enabled) {
                padding = (activeLayer.shadow.blur * 2) + Math.max(Math.abs(activeLayer.shadow.offsetX), Math.abs(activeLayer.shadow.offsetY));
            }
            if (activeLayer.border.enabled) {
                padding += activeLayer.border.width * 2;
            }

            tempCanvas.width = sourceCanvas.width + padding * 2;
            tempCanvas.height = sourceCanvas.height + padding * 2;
            const tempCtx = tempCanvas.getContext('2d');
            
            tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);

            const filters = `brightness(${activeLayer.brightness}) saturate(${activeLayer.saturation}) contrast(${activeLayer.contrast || 1})`;
            const shadow = activeLayer.shadow.enabled ? `drop-shadow(${activeLayer.shadow.offsetX}px ${activeLayer.shadow.offsetY}px ${activeLayer.shadow.blur}px ${activeLayer.shadow.color})` : '';
            let borderFilters = '';
            if (activeLayer.border.enabled && activeLayer.border.width > 0) {
                const w = activeLayer.border.width;
                const c = activeLayer.border.color;
                borderFilters = `drop-shadow(${w}px ${w}px 0 ${c}) drop-shadow(-${w}px -${w}px 0 ${c}) drop-shadow(-${w}px ${w}px 0 ${c}) drop-shadow(${w}px -${w}px 0 ${c})`;
            }

            tempCtx.filter = `${borderFilters} ${shadow} ${filters}`.trim();
            tempCtx.globalAlpha = activeLayer.opacity;

            tempCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);

            const link = document.createElement('a');
            link.download = `asset-${activeLayer.id.substring(0, 5)}.png`;
            link.href = tempCanvas.toDataURL('image/png');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            this.toast('Asset download started!', 3000);
        } catch (error) {
            console.error("Failed to download asset:", error);
            this.toast("Error: Could not generate asset.", 4000);
        }
    },
    
    handleContextMenu(e) {
        e.preventDefault();

        const point = this.getMovieCanvasPoint(e);
        let targetLayer = null;
        for (const layer of this.state.canvasState.layers) {
            if (this.isPointInMovieLayer(point, layer)) {
                targetLayer = layer;
                break;
            }
        }

        if (!targetLayer) {
            this.dom.contextMenu.classList.remove('visible');
            return;
        }

        this.state.contextMenuLayerId = targetLayer.id;

        const lockToggle = this.dom.contextMenu.querySelector('[data-action="toggle-lock"]');
        if (targetLayer.isLocked) {
            lockToggle.innerHTML = `<i class="fas fa-lock-open"></i> Unlock Layer`;
        } else {
            lockToggle.innerHTML = `<i class="fas fa-lock"></i> Lock Layer`;
        }

        const menu = this.dom.contextMenu;
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('visible');
    },

    resetView() {
        this.state.targetViewState.scale = 1.0;
        this.state.targetViewState.pan.x = 0;
        this.state.targetViewState.pan.y = 0;
        this._requestViewAnimation();
    },

    handleCanvasWheel(e) {
        e.preventDefault();

        const SNAP_DELAY = 150;

        clearTimeout(this.state.zoomSnapTimeout);

        const { targetViewState } = this.state;
        const oldScale = targetViewState.scale;

        if (e.ctrlKey) {
            const sensitivity = 0.01; 
            const delta = -e.deltaY * (e.deltaMode === 1 ? 33 : 1) * sensitivity;
            
            const newScale = oldScale * Math.pow(2, delta);

            const clampedScale = Math.max(this.config.OVERVIEW_SCALE, Math.min(newScale, 5));

            const SNAP_ZONE_LOWER = 0.97;
            const SNAP_THRESHOLD_UPPER = 1.03;

            if (clampedScale > SNAP_ZONE_LOWER && clampedScale < SNAP_THRESHOLD_UPPER) {
                this.state.zoomSnapTimeout = setTimeout(() => {
                    this.resetView();
                }, SNAP_DELAY);
            }
            
            if (clampedScale === oldScale) return;

            const point = this.getMovieCanvasPoint(e);
            let zoomAnchor;

            if (point.x < 0 || point.x > this.dom.movieCanvas.width || point.y < 0 || point.y > this.dom.movieCanvas.height) {
                const viewRect = this.dom.canvasPanel.getBoundingClientRect();
                const centerX = viewRect.width / 2;
                const centerY = viewRect.height / 2;
                zoomAnchor = this.getMovieCanvasPoint({ clientX: viewRect.left + centerX, clientY: viewRect.top + centerY });
            } else {
                zoomAnchor = point;
            }

            let panX = zoomAnchor.x - (zoomAnchor.x - targetViewState.pan.x) * (clampedScale / oldScale);
            let panY = zoomAnchor.y - (zoomAnchor.y - targetViewState.pan.y) * (clampedScale / oldScale);
            
            const constrainedPan = this._constrainPan(panX, panY, clampedScale);

            targetViewState.scale = clampedScale;
            targetViewState.pan.x = constrainedPan.x;
            targetViewState.pan.y = constrainedPan.y;

        } else {
            if (targetViewState.scale <= 1.0) return;

            const panSensitivity = 2.4;
            const newPanX = targetViewState.pan.x - (e.deltaX * panSensitivity);
            const newPanY = targetViewState.pan.y - (e.deltaY * panSensitivity);
            
            const constrainedPan = this._constrainPan(newPanX, newPanY, targetViewState.scale);
            targetViewState.pan.x = constrainedPan.x;
            targetViewState.pan.y = constrainedPan.y;
        }

        this._requestViewAnimation();
        this.updateCursor(e);
    },

    setupEventListeners() {
        const setupComplexScrubbingEvents = (slider) => {
            if (!slider) return;
            slider.addEventListener('dragstart', (e) => e.preventDefault());
            let animationFrameId = null;

            const scrubLoop = () => {
                if (this.state.scrubbingMode !== 'filter') {
                    cancelAnimationFrame(animationFrameId);
                    return;
                }
                this.drawFrame();
                animationFrameId = requestAnimationFrame(scrubLoop);
            };

            const onScrubEnd = (e) => {
                if (this.state.scrubbingMode === 'filter') {
                    this.state.scrubbingMode = 'none';
                    cancelAnimationFrame(animationFrameId);
                    
                    const changeEvent = new Event('change', { bubbles: true });
                    e.target.dispatchEvent(changeEvent);

                    this.drawFrame();
                }
                window.removeEventListener('mouseup', onScrubEnd, { once: true });
            };
            slider.addEventListener('mousedown', () => {
                this.state.scrubbingMode = 'filter';
                animationFrameId = requestAnimationFrame(scrubLoop);
                window.addEventListener('mouseup', onScrubEnd, { once: true });
            });
        };
        this.setupComplexScrubbingEvents = setupComplexScrubbingEvents;
        
        const setupLayerSlider = (slider, propertyName) => {
            if (!slider) return;
            slider.addEventListener('input', (e) => {
                const activeLayer = this.getActiveLayer();
                if (!activeLayer) return;
                this.dispatch({ type: 'LAYER_PROPERTY_PREVIEW_CHANGED', payload: { layerId: activeLayer.id, property: propertyName, value: parseFloat(e.target.value) } });
                this.updateSliderFill(e.target);
            });
            slider.addEventListener('change', (e) => {
                const activeLayer = this.getActiveLayer();
                if (!activeLayer) return;
                this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: activeLayer.id, property: propertyName, value: parseFloat(e.target.value) } });
                this.saveStateDebounced();
            });
            setupComplexScrubbingEvents(slider);
        };
        const setupEffectControl = (elementId, effect, property, valueExtractor, isSlider = false) => {
            const element = document.getElementById(elementId);
            if (!element) return;
            element.addEventListener('input', (e) => {
                const activeLayer = this.getActiveLayer();
                if (!activeLayer) return;
                const value = valueExtractor(e.target);
                this.dispatch({ type: `LAYER_${effect.toUpperCase()}_PREVIEW_CHANGED`, payload: { layerId: activeLayer.id, property, value } });
                if (isSlider) { this.updateSliderFill(e.target); } else { if (activeLayer.cache) activeLayer.cache.isValid = false; this.drawFrame(); }
                if (elementId.includes('-enable')) {
                    const controlsId = elementId.replace('enable', 'controls');
                    const controlsEl = document.getElementById(controlsId);
                    if(controlsEl) controlsEl.classList.toggle('disabled', !value);
                }
            });
            element.addEventListener('change', (e) => {
                const activeLayer = this.getActiveLayer();
                if (!activeLayer) return;
                const value = valueExtractor(e.target);
                this.dispatch({ type: `LAYER_${effect.toUpperCase()}_CHANGED`, payload: { layerId: activeLayer.id, property, value } });
                this.saveStateDebounced();
            });
            if (isSlider) { setupComplexScrubbingEvents(element); }
        };
        const setupBgFilterSlider = (slider, propertyName) => {
            if (!slider) return;
            const onScrub = (e) => {
                this.dispatch({ type: 'BACKGROUND_FILTER_PREVIEW_CHANGED', payload: { property: propertyName, value: parseFloat(e.target.value) } });
                this.updateSliderFill(e.target);
                this.drawBackground();
            };
            const onScrubEnd = (e) => {
                this.dispatch({ type: 'BACKGROUND_FILTER_CHANGED', payload: { property: propertyName, value: parseFloat(e.target.value) } });
                this.saveStateDebounced();
                window.removeEventListener('mouseup', onScrubEnd, { once: true });
            };
            slider.addEventListener('input', onScrub);
            slider.addEventListener('mousedown', () => { window.addEventListener('mouseup', onScrubEnd, { once: true }); });
        };

        this.dom.textContentInput.addEventListener('click', () => { if (!this.getActiveLayer() || this.getActiveLayer().type !== 'text') { this.addTextLayer(); } });
        this.dom.textContentInput.addEventListener('input', (e) => { const l = this.getActiveLayer(); if (!l || l.type !== 'text') return; this.dispatch({ type: 'LAYER_PROPERTY_PREVIEW_CHANGED', payload: { layerId: l.id, property: 'text', value: e.target.value } }); if (l.cache) { l.cache.isValid = false; } this.drawFrame(); this.renderTextLayerPalette(); });
        this.dom.textContentInput.addEventListener('change', (e) => { const l = this.getActiveLayer(); if (!l || l.type !== 'text') return; this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: l.id, property: 'text', value: e.target.value } }); this.saveStateDebounced(); });
        const setupTextColorListener = (input, property) => {
            input.addEventListener('input', (e) => { const l = this.getActiveLayer(); if (!l || l.type !== 'text') return; this.dispatch({ type: 'LAYER_PROPERTY_PREVIEW_CHANGED', payload: { layerId: l.id, property, value: e.target.value } }); if (l.cache) l.cache.isValid = false; this.drawFrame(); });
            input.addEventListener('change', (e) => { const l = this.getActiveLayer(); if (!l || l.type !== 'text') return; this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId: l.id, property, value: e.target.value } }); this.saveStateDebounced(); });
        };
        setupLayerSlider(this.dom.assetOpacitySlider, 'opacity');
        setupLayerSlider(this.dom.assetBrightnessSlider, 'brightness');
        setupLayerSlider(this.dom.assetSaturationSlider, 'saturation');
        setupEffectControl('shadow-enable', 'shadow', 'enabled', target => target.checked);
        setupEffectControl('shadow-color', 'shadow', 'color', target => target.value);
        setupEffectControl('shadow-blur', 'shadow', 'blur', target => parseFloat(target.value), true);
        setupEffectControl('shadow-offset-x', 'shadow', 'offsetX', target => parseFloat(target.value), true);
        setupEffectControl('shadow-offset-y', 'shadow', 'offsetY', target => parseFloat(target.value), true);
        setupEffectControl('asset-edge-enable', 'border', 'enabled', target => target.checked);
        setupEffectControl('asset-edge-color', 'border', 'color', target => target.value);
        setupEffectControl('asset-edge-width', 'border', 'width', target => parseFloat(target.value), true);
        setupBgFilterSlider(this.dom.bgBrightnessSlider, 'bgBrightness');
        setupBgFilterSlider(this.dom.bgSaturationSlider, 'bgSaturation');
        setupLayerSlider(this.dom.textSizeSlider, 'fontSize');
        setupLayerSlider(this.dom.textEdgeWidthSlider, 'strokeWidth');
        setupTextColorListener(this.dom.textColorInput, 'color');
        setupTextColorListener(this.dom.textEdgeColorInput, 'strokeColor');
        setupEffectControl('text-shadow-enable', 'shadow', 'enabled', target => target.checked);
        setupEffectControl('text-shadow-color', 'shadow', 'color', target => target.value);
        setupEffectControl('text-shadow-blur', 'shadow', 'blur', target => parseFloat(target.value), true);
        setupEffectControl('text-shadow-offset-x', 'shadow', 'offsetX', target => parseFloat(target.value), true);
        setupEffectControl('text-shadow-offset-y', 'shadow', 'offsetY', target => parseFloat(target.value), true);
        this.setupEraserSlider(this.dom.eraserSize);
        this.setupEraserSlider(this.dom.eraserStrength);
        const vLink = document.getElementById('version-link'), vOverlay = document.getElementById('version-popup-overlay'), vClose = document.getElementById('close-popup');
        vLink.addEventListener('click', (e) => { e.preventDefault(); vOverlay.style.display = 'flex'; });
        vClose.addEventListener('click', () => { vOverlay.style.display = 'none'; });
        vOverlay.addEventListener('click', (e) => { if (e.target === vOverlay) vOverlay.style.display = 'none'; });
        this.dom.themeSelectLink.addEventListener('click', (e) => { e.preventDefault(); this.state.themeChosen = false; this.dom.themePopupOverlay.style.display = 'flex'; });
        this.dom.themePopupContent.addEventListener('mouseleave', () => { if (!this.state.themeChosen) this.applyTheme(this.state.originalTheme, true); });
        this.dom.themePopupOverlay.addEventListener('click', (e) => { if (e.target === this.dom.themePopupOverlay) { if (!this.state.themeChosen) this.applyTheme(this.state.originalTheme); this.dom.themePopupOverlay.style.display = 'none'; } });
        this.dom.canvasPlaceholder.addEventListener('click', () => this.dom.initialBackgroundInput.click());
        
        this.dom.initialBackgroundInput.addEventListener('change', e => { if (e.target.files.length) this.libraryManager.handleFileUpload(e.target.files, 'background'); e.target.value = null; });
        
        this.dom.downloadImageBtn.addEventListener('click', () => this.downloadImage());
        this.dom.saveProjectBtn.addEventListener('click', () => this.libraryManager.saveProjectToLibrary());
        this.dom.clearCanvasBtn.addEventListener('click', () => this.openConfirmationModal("This will clear the canvas and start a new project. Are you sure?", () => { this.clearCanvas(); this.closeConfirmationModal(); }));
        const addLayerCloseBtn = document.getElementById('mg-asset-library-close'), dropZone = document.getElementById('mg-asset-drop-zone');
        addLayerCloseBtn.addEventListener('click', () => this.closeAddLayerPopup());
        this.dom.addLayerOverlay.addEventListener('click', e => { if (e.target === this.dom.addLayerOverlay) this.closeAddLayerPopup() });
        dropZone.addEventListener('click', () => this.dom.addLayerFileInput.click());
        
        this.dom.addLayerFileInput.addEventListener('change', e => { if (e.target.files.length) this.libraryManager.handleFileUpload(e.target.files, this.state.addAssetMode); e.target.value = null; this.closeAddLayerPopup(); });
        
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

        dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); const files = e.dataTransfer.files; if (files.length > 0) { this.libraryManager.handleFileUpload(files, this.state.addAssetMode); this.closeAddLayerPopup(); } });
        
        this.dom.visualsBtn.addEventListener('click', () => { this.dom.shortcutsDropdown.classList.remove('visible'); this.dom.settingsDropdown.classList.remove('visible'); const target = 'visuals-panel'; if (this.panelManager.activePanel === target) { this.panelManager.show('default-panel'); } else { this.panelManager.show(target); if (this.getActiveLayer()?.type === 'image') { this.switchVisualsTab('asset'); } else { this.switchVisualsTab('background'); } } });
        this.dom.textBtn.addEventListener('click', () => { this.dom.shortcutsDropdown.classList.remove('visible'); this.dom.settingsDropdown.classList.remove('visible'); this.loadSecondaryFonts(); const target = 'text-panel'; if (this.panelManager.activePanel === target) { this.panelManager.show('default-panel'); } else { this.panelManager.show(target); } });
        this.dom.eraseToolBtn.addEventListener('click', () => { this.dom.shortcutsDropdown.classList.remove('visible'); this.dom.settingsDropdown.classList.remove('visible'); const target = 'eraser-panel'; if (this.panelManager.activePanel === target) { this.panelManager.show('default-panel'); } else { this.panelManager.show(target); } });
        this.dom.aiToolsBtn.addEventListener('click', async () => { this.dom.shortcutsDropdown.classList.remove('visible'); this.dom.settingsDropdown.classList.remove('visible'); const target = 'ai-tools-panel'; if (this.panelManager.activePanel === target) { this.panelManager.show('default-panel'); } else { if (!this.state.onnxLoaded) { this.toast('Loading AI engine...', null); try { await this.loadOnnxRuntime(); ort.env.wasm.simd = true; ort.env.wasm.numThreads = 1; this.state.onnxLoaded = true; this.hideToast(); } catch (error) { console.error("Failed to load ONNX Runtime:", error); this.toast('Error: Could not load the AI engine.', 4000); return; } } this.panelManager.show(target); } });
        document.querySelectorAll('.back-button').forEach(button => { button.addEventListener('click', () => { this.panelManager.show(button.dataset.target); }); });
        this.dom.shortcutsBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.settingsDropdown.classList.remove('visible'); this.panelManager.show('default-panel'); this.dom.shortcutsDropdown.classList.toggle('visible'); });
        this.dom.settingsBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.shortcutsDropdown.classList.remove('visible'); this.panelManager.show('default-panel'); const isVisible = this.dom.settingsDropdown.classList.toggle('visible'); if (isVisible) { this.libraryManager.updateStorageUsage(); } });
        this.dom.clearLibraryBtn.addEventListener('click', () => this.openConfirmationModal("This will permanently delete ALL saved projects, assets, and current work. This action cannot be undone. Are you sure?", async () => { this.showLoadingScreen('Clearing Image Maker Data'); await new Promise(r => requestAnimationFrame(r)); const minTime = new Promise(r => setTimeout(r, 3000)); const clearPromise = (async () => { await this.libraryManager.clearProjectLibrary(); this.clearCanvas(true); })(); await Promise.all([minTime, clearPromise]); this.hideLoadingScreen(); }));
        this.dom.addNewTextLayerBtn.addEventListener('click', () => this.addTextLayer());
        this.dom.confirmYesBtn.addEventListener('click', async (e) => { e.stopPropagation(); const fn = this.state.confirmCallback; this.state.confirmCallback = null; this.closeConfirmationModal(); try { if (typeof fn === 'function') await fn(); } catch (err) { console.error('Confirmation action failed:', err); this.toast('Error: Could not complete the action.', 4000); } });
        this.dom.confirmNoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirmationModal(); });
        this.dom.confirmationOverlay.addEventListener('click', (e) => { if (e.target === this.dom.confirmationOverlay) this.closeConfirmationModal(); });
        this.dom.canvasPanel.addEventListener('wheel', (e) => this.handleCanvasWheel(e), { passive: false });
        this.dom.canvasPanel.addEventListener('mousedown', (e) => this.handleMovieInteractionStart(e));
        this.dom.canvasPanel.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
        window.addEventListener('mousemove', (e) => this.handleMovieInteractionMove(e));
        window.addEventListener('mouseup', (e) => this.handleMovieInteractionEnd(e));
        this.dom.canvasPanel.addEventListener('mousedown', () => { if (!this.state.canvasHasInteractionFocus) { this.state.canvasHasInteractionFocus = true; this.drawFrame(); } }, true);
        document.getElementById('controls-panel').addEventListener('mousedown', () => { if (this.state.canvasHasInteractionFocus) { this.state.canvasHasInteractionFocus = false; this.drawFrame(); } });
        this.dom.canvasPanel.addEventListener('mouseleave', () => { if (!this.state.movieInteraction.active) { this.dom.movieCanvas.style.cursor = 'default'; } if (this.state.isEraserArmed) { this.state.eraseCanvasPoint = null; this.drawControlsOverlay(); } });
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('beforeunload', () => this.saveCurrentWork());
        this.dom.canvasPanel.addEventListener('dragover', e => { e.preventDefault(); this.dom.canvasPanel.classList.add('drag-over') });
        this.dom.canvasPanel.addEventListener('dragleave', () => this.dom.canvasPanel.classList.remove('drag-over'));
        
        this.dom.canvasPanel.addEventListener('drop', e => { e.preventDefault(); this.dom.canvasPanel.classList.remove('drag-over'); const files = e.dataTransfer.files; if (files.length > 0) { const intendedUse = this.state.canvasState.backgroundElement ? 'asset' : 'background'; this.libraryManager.handleFileUpload(files, intendedUse); } });
        
        window.addEventListener('paste', e => { const items = e.clipboardData?.items; if (!items) return; const imageFiles = []; for (let i = 0; i < items.length; i++) { if (items[i].type.includes('image')) { const file = items[i].getAsFile(); if (file) imageFiles.push(file); } } if (imageFiles.length > 0) { e.preventDefault(); const intendedUse = this.dom.addLayerOverlay.classList.contains('visible') || this.state.canvasState.backgroundElement ? 'asset' : 'background'; this.libraryManager.handleFileUpload(imageFiles, intendedUse); } });
        
        this.dom.visualsTabAssetBtn.addEventListener('click', () => { this.switchVisualsTab('asset'); if (!this.getActiveLayer() || this.getActiveLayer().type !== 'image') { this.toast('Select an image layer to enable asset editing.', 3000); } });
        this.dom.visualsTabBackgroundBtn.addEventListener('click', () => this.switchVisualsTab('background'));
        this.dom.fontSelectTrigger.addEventListener('click', (e) => { e.stopPropagation(); if (this.dom.customFontSelect.classList.contains('open')) { this.closeFontDropdown(); } else { this.openFontDropdown(); } });
        this.dom.fontSelectDropdown.addEventListener('mouseleave', () => this.handleFontHoverEnd());
        this.dom.eraseBtn.addEventListener('click', () => this.setEraserMode('erase'));
        this.dom.uneraseBtn.addEventListener('click', () => this.setEraserMode('unerase'));
        this.dom.startSessionBtn.addEventListener('click', () => { this.collaborationManager.startSession(); });
        this.dom.shareSessionCloseBtn.addEventListener('click', () => { this.collaborationManager.hideShareLinkModal(); });
        this.dom.copyShareLinkBtn.addEventListener('click', () => { const btn = this.dom.copyShareLinkBtn; const originalText = btn.textContent; navigator.clipboard.writeText(this.dom.shareLinkInput.value).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = originalText; }, 2000); }).catch(err => { console.error('Failed to copy link: ', err); this.toast("Could not copy link.", 3000); }); });
        this.dom.shareSessionOverlay.addEventListener('click', (e) => { if (e.target === this.dom.shareSessionOverlay) { this.collaborationManager.hideShareLinkModal(); } });
        const textMoveForwardBtn = document.getElementById('text-move-forward'), textMoveBackBtn = document.getElementById('text-move-back');
        if (textMoveForwardBtn) textMoveForwardBtn.addEventListener('click', () => { const l = this.getActiveLayer(); if (l?.type === 'text') { this.dispatch({ type: 'LAYER_REORDERED', payload: { layerId: l.id, delta: -1 } }); this.updateTextOrderButtonsState(); } });
        if (textMoveBackBtn) textMoveBackBtn.addEventListener('click', () => { const l = this.getActiveLayer(); if (l?.type === 'text') { this.dispatch({ type: 'LAYER_REORDERED', payload: { layerId: l.id, delta: 1 } }); this.updateTextOrderButtonsState(); } });
        this.dom.viewAllLocalAssetsBtn.addEventListener('click', () => { this.libraryManager.populateProjectLibraryPopup(); const lastTab = localStorage.getItem('ims-last-library-tab') || 'assets'; this.setLocalFolderTab(lastTab); this.dom.projectLibraryPopupOverlay.classList.add('visible'); });
        this.dom.projectLibraryPopupCloseBtn.addEventListener('click', () => this.dom.projectLibraryPopupOverlay.classList.remove('visible'));
        this.dom.projectLibraryPopupOverlay.addEventListener('click', (e) => {
            if (e.target === this.dom.projectLibraryPopupOverlay) {
                this.dom.projectLibraryPopupOverlay.classList.remove('visible');
            }
            if (e.target.id === 'add-asset-to-library-btn') {
                this.dom.addAssetToLibraryInput.click();
            }
            if (e.target.id === 'add-bg-to-library-btn') {
                this.dom.addBgToLibraryInput.click();
            }
        });

        this.dom.addAssetToLibraryInput.addEventListener('change', e => { if (e.target.files.length > 0) { this.libraryManager.addFilesToLibraryOnly(e.target.files, 'asset'); e.target.value = null; } });
        
        this.dom.addBgToLibraryInput.addEventListener('change', e => { if (e.target.files.length > 0) { this.libraryManager.addFilesToLibraryOnly(e.target.files, 'background'); e.target.value = null; } });
        
        this.dom.libraryTabProjectsBtn.addEventListener('click', () => this.switchAndSaveLibraryTab('projects'));
        this.dom.libraryTabAssetsBtn.addEventListener('click', () => this.switchAndSaveLibraryTab('assets'));
        this.dom.libraryTabBackgroundsBtn.addEventListener('click', () => this.switchAndSaveLibraryTab('backgrounds'));
        this.dom.libraryTabFavoritesBtn.addEventListener('click', () => this.switchAndSaveLibraryTab('favorites'));
        this.dom.confirmSaveContinueBtn.addEventListener('click', async () => { this.dom.saveChangesOverlay.classList.remove('visible'); await this.libraryManager.saveProjectToLibrary(); if (this.state.pendingProjectId) { await this.libraryManager._actuallyLoadProject(this.state.pendingProjectId); this.state.pendingProjectId = null; } });
        this.dom.confirmDiscardContinueBtn.addEventListener('click', async () => { this.dom.saveChangesOverlay.classList.remove('visible'); if (this.state.pendingProjectId) { await this.libraryManager._actuallyLoadProject(this.state.pendingProjectId); this.state.pendingProjectId = null; } });
        this.dom.confirmCancelLoadBtn.addEventListener('click', () => { this.dom.saveChangesOverlay.classList.remove('visible'); this.state.pendingProjectId = null; });
        this.dom.openFontPreviewBtn.addEventListener('click', () => this.openFontPreviewModal());
        this.dom.fontPreviewCloseBtn.addEventListener('click', () => this.closeFontPreviewModal());
        this.dom.fontPreviewOverlay.addEventListener('click', (e) => { if (e.target === this.dom.fontPreviewOverlay) { this.closeFontPreviewModal(); } });
        window.addEventListener('click', (e) => { if (this.dom.shortcutsDropdown.classList.contains('visible') && !this.dom.shortcutsDropdown.contains(e.target) && !this.dom.shortcutsBtn.contains(e.target)) { this.dom.shortcutsDropdown.classList.remove('visible'); } if (this.dom.customFontSelect.classList.contains('open') && !this.dom.customFontSelect.contains(e.target)) { this.closeFontDropdown(); } if (this.dom.settingsDropdown.classList.contains('visible') && !this.dom.settingsDropdown.contains(e.target) && !this.dom.settingsBtn.contains(e.target)) { this.dom.settingsDropdown.classList.remove('visible'); } });
        const canvasResizeObserver = new ResizeObserver(() => { this.drawBackground(); this.drawFrame(); this.resizeCanvas(); });
        canvasResizeObserver.observe(this.dom.canvasPanel);
        const toggleViewBtn = document.getElementById('layer-view-toggle');
        if (toggleViewBtn) {
            toggleViewBtn.addEventListener('click', () => this.toggleLayerView());
        }
        document.getElementById('toolbar-duplicate').addEventListener('click', () => { if (this.getActiveLayer()) { this.duplicateLayer(this.getActiveLayer().id); } });
        document.getElementById('toolbar-save-asset').addEventListener('click', () => this.saveActiveAssetToLibrary());
        document.getElementById('toolbar-download-asset').addEventListener('click', () => this.downloadActiveAsset());
        this.dom.canvasPanel.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
        window.addEventListener('click', (e) => { if (this.dom.contextMenu && !this.dom.contextMenu.contains(e.target)) { this.dom.contextMenu.classList.remove('visible'); } });
        this.dom.contextMenu.addEventListener('click', (e) => {
            const actionItem = e.target.closest('li');
            if (!actionItem) return;
            const action = actionItem.dataset.action;
            const layerId = this.state.contextMenuLayerId;
            if (!action || !layerId) return;
            const layer = this.state.canvasState.layers.find(l => l.id === layerId);
            switch (action) {
                case 'duplicate': this.duplicateLayer(layerId); this.dom.contextMenu.classList.remove('visible'); break;
                case 'delete': this.deleteMovieLayer(layerId); this.dom.contextMenu.classList.remove('visible'); break;
                case 'move-forward': this.dispatch({ type: 'LAYER_REORDERED', payload: { layerId, delta: -1 } }); break;
                case 'move-backward': this.dispatch({ type: 'LAYER_REORDERED', payload: { layerId, delta: 1 } }); break;
                case 'toggle-lock': if (layer) { const newLockedState = !layer.isLocked; this.dispatch({ type: 'LAYER_PROPERTY_CHANGED', payload: { layerId, property: 'isLocked', value: newLockedState } }); this.drawControlsOverlay(); } this.dom.contextMenu.classList.remove('visible'); break;
            }
        });
        for (const feature of this.features) { if(feature.setupEventListeners) feature.setupEventListeners(); }
    },

    getActiveLayer() {
        return this.state.canvasState.layers.find(l => l.id === this.state.activeLayerId);
    },

    rotateProject() {
        if (!this.state.canvasState.backgroundElement) {
            this.toast("Add a background to rotate the project.", 2000);
            return;
        }

        this.dispatch({ type: 'PROJECT_ROTATED' });

        this.setBackground(
            this.state.canvasState.backgroundElement,
            this.state.canvasState.backgroundHash,
            true
        );
    },

    async init() {
        this.dom.loadingOverlay = document.getElementById('loading-overlay');
        this.dom.loadingMessage = this.dom.loadingOverlay.querySelector('h1');
        this.dom.toastEl = document.getElementById('mg-toast');
        this.dom.addLayerOverlay = document.getElementById('mg-asset-library-overlay');
        this.dom.assetPalette = document.getElementById('mg-asset-palette');
        this.dom.addLayerFileInput = document.getElementById('mg-asset-picker-file');
        this.dom.canvasPanel = document.getElementById('canvas-panel');
        this.dom.canvasPlaceholder = document.getElementById('canvas-placeholder');
        this.dom.controlsOverlayCanvas = document.getElementById('mg-controls-overlay-canvas');
        this.dom.initialBackgroundInput = document.getElementById('initial-background-input');
        this.dom.initialBackgroundInput.multiple = true;
        this.dom.addLayerFileInput.multiple = true;
        this.dom.layerInstructions = document.getElementById('layer-instructions');
        this.dom.movieCanvas = document.getElementById('mg-movie-canvas');
        this.dom.backgroundCanvas = document.getElementById('mg-background-canvas'); 
        this.dom.downloadImageBtn = document.getElementById('mg-download-image-btn');
        this.dom.saveProjectBtn = document.getElementById('mg-save-project-btn');
        this.dom.clearCanvasBtn = document.getElementById('mg-clear-canvas-btn');
        this.dom.confirmationOverlay = document.getElementById('mg-confirmation-overlay');
        this.dom.confirmationText = document.getElementById('mg-confirmation-text');
        this.dom.confirmYesBtn = document.getElementById('mg-confirm-yes-btn');
        this.dom.confirmNoBtn = document.getElementById('mg-confirm-no-btn');
        this.dom.shortcutsBtn = document.getElementById('shortcuts-btn');
        this.dom.shortcutsDropdown = document.getElementById('shortcuts-dropdown');
        this.dom.settingsBtn = document.getElementById('settings-btn');
        this.dom.settingsDropdown = document.getElementById('settings-dropdown');
        this.dom.storageUsageDisplay = document.getElementById('storage-usage-display');
        this.dom.clearLibraryBtn = document.getElementById('clear-library-btn');
        this.dom.visualsBtn = document.getElementById('visuals-btn');
        this.dom.textBtn = document.getElementById('text-btn');
        this.dom.eraseToolBtn = document.getElementById('erase-tool-btn');
        this.dom.aiToolsBtn = document.getElementById('ai-tools-btn');
        this.dom.visualsPanel = document.getElementById('visuals-panel');
        this.dom.textPanel = document.getElementById('text-panel');
        this.dom.eraserPanel = document.getElementById('eraser-panel');
        this.dom.assetVisualsControls = document.getElementById('asset-visuals-controls');
        this.dom.assetOpacitySlider = document.getElementById('asset-opacity');
        this.dom.assetBrightnessSlider = document.getElementById('asset-brightness');
        this.dom.assetSaturationSlider = document.getElementById('asset-saturation');
        this.dom.bgBrightnessSlider = document.getElementById('bg-brightness');
        this.dom.bgSaturationSlider = document.getElementById('bg-saturation');
        this.dom.textVisualsControls = document.getElementById('text-visuals-controls');
        this.dom.textContentInput = document.getElementById('text-content');
        this.dom.textSizeSlider = document.getElementById('text-size');
        this.dom.textColorInput = document.getElementById('text-color');
        this.dom.textEdgeColorInput = document.getElementById('text-edge-color');
        this.dom.textEdgeWidthSlider = document.getElementById('text-edge-width');
        this.dom.addNewTextLayerBtn = document.getElementById('add-new-text-layer-btn');
        this.dom.textLayerPalette = document.getElementById('text-layer-palette');
        this.dom.eraseBtn = document.getElementById('erase-btn');
        this.dom.uneraseBtn = document.getElementById('unerase-btn');
        this.dom.eraserControlsWrapper = document.getElementById('eraser-controls-wrapper');
        this.dom.eraserSize = document.getElementById('eraser-size');
        this.dom.eraserStrength = document.getElementById('eraser-strength');
        this.dom.assetsFolderFieldset = document.getElementById('assets-folder-fieldset');
        this.dom.localAssetPalette = document.getElementById('mg-local-asset-palette');
        this.dom.localBackgroundPalette = document.getElementById('mg-local-background-palette');
        this.dom.viewAllLocalAssetsBtn = document.getElementById('mg-view-all-local-assets-btn');
        this.dom.projectLibraryPopupOverlay = document.getElementById('project-library-popup-overlay');
        this.dom.projectLibraryGridProjects = document.getElementById('project-library-grid-projects');
        this.dom.projectLibraryGridAssets = document.getElementById('project-library-grid-assets');
        this.dom.projectLibraryGridBackgrounds = document.getElementById('project-library-grid-backgrounds');
        this.dom.projectLibraryGridFavorites = document.getElementById('project-library-grid-favorites');
        this.dom.libraryTabProjectsBtn = document.getElementById('library-tab-projects');
        this.dom.libraryTabAssetsBtn = document.getElementById('library-tab-assets');
        this.dom.libraryTabBackgroundsBtn = document.getElementById('library-tab-backgrounds');
        this.dom.libraryTabFavoritesBtn = document.getElementById('library-tab-favorites');
        this.dom.projectLibraryPopupCloseBtn = document.getElementById('project-library-popup-close');
        this.dom.visualsTabAssetBtn = document.getElementById('visuals-tab-asset');
        this.dom.visualsTabBackgroundBtn = document.getElementById('visuals-tab-background');
        this.dom.assetTabPanel = document.getElementById('asset-tab-panel');
        this.dom.backgroundTabPanel = document.getElementById('background-tab-panel');
        this.dom.customFontSelect = document.getElementById('custom-font-select');
        this.dom.fontSelectTrigger = document.getElementById('font-select-trigger');
        this.dom.fontSelectDropdown = document.getElementById('font-select-dropdown');
        this.dom.fontSelectList = document.getElementById('font-select-list');
        this.dom.themePopupOverlay = document.getElementById('theme-popup-overlay');
        this.dom.themePopupContent = document.getElementById('theme-popup-content');
        this.dom.themeList = document.getElementById('theme-list');
        this.dom.themeSelectLink = document.getElementById('theme-select-link');
        this.dom.currentThemeNameSpan = document.getElementById('current-theme-name');
        this.dom.saveChangesOverlay = document.getElementById('save-changes-overlay');
        this.dom.confirmSaveContinueBtn = document.getElementById('confirm-save-continue-btn');
        this.dom.confirmDiscardContinueBtn = document.getElementById('confirm-discard-continue-btn');
        this.dom.confirmCancelLoadBtn = document.getElementById('confirm-cancel-load-btn');
        this.dom.openFontPreviewBtn = document.getElementById('open-font-preview-btn');
        this.dom.fontPreviewOverlay = document.getElementById('font-preview-overlay');
        this.dom.fontPreviewGrid = document.getElementById('font-preview-grid');
        this.dom.fontPreviewCloseBtn = document.getElementById('font-preview-close-btn');
        this.dom.startSessionBtn = document.getElementById('mg-start-session-btn');
        this.dom.shareSessionOverlay = document.getElementById('share-session-overlay');
        this.dom.shareSessionCloseBtn = document.getElementById('share-session-close-btn');
        this.dom.shareLinkInput = document.getElementById('share-link-input');
        this.dom.copyShareLinkBtn = document.getElementById('copy-share-link-btn');
        this.dom.visualsLayerPalette = document.getElementById('visuals-layer-palette');
        this.dom.eraserLayerPalette = document.getElementById('eraser-layer-palette');
        this.dom.aiToolsLayerPalette = document.getElementById('ai-tools-layer-palette');
        this.dom.contextualToolbar = document.getElementById('mg-contextual-toolbar');
        this.dom.contextMenu = document.getElementById('mg-context-menu');
        this.dom.confirmDiscardContinueBtn = document.getElementById('confirm-discard-continue-btn');
        this.dom.addAssetToLibraryInput = document.getElementById('add-asset-to-library-input');
        this.dom.addBgToLibraryInput = document.getElementById('add-bg-to-library-input');

        this.saveStateDebounced = this.debounce(this.saveCurrentWork, this.config.DEBOUNCE_DELAY);

        this.dom.movieCtx = this.dom.movieCanvas.getContext('2d');
        this.dom.backgroundCtx = this.dom.backgroundCanvas.getContext('2d');
        this.dom.controlsCtx = this.dom.controlsOverlayCanvas.getContext('2d');
        
        this.config.themes = window.themes; 
        
        const featuresHook = document.getElementById('feature-filters-hook');
        if (featuresHook) {
            let featuresUI = '';
            for (const feature of this.features) {
                feature.init(this);
                featuresUI += feature.createUI();
            }
            featuresHook.innerHTML = featuresUI;
        }

        this.panelManager.init(this);
        this.collaborationManager.init(this);
        this.libraryManager.init(this);
        this.collaborationManager.checkForSessionInUrl();

        this.throttledBroadcast = this.throttle((action) => this.collaborationManager.broadcastAction(action), 50);

        try {
            this.state.converterWorker = new Worker(new URL('./webp-converter.js', import.meta.url), { type: 'module' });
            this.state.converterWorker.onmessage = async (event) => {
                const { status, blob, layerId, originalHash, wasOptimized, kind, error } = event.data;
                
                if (status === 'error') {
                    this.toast(`Could not optimize asset: ${error}`, 3000);
                    return;
                }

                await this.libraryManager.saveAssetToLibrary({ blob, mime: blob.type, hash: originalHash, kind });
                
                if (!layerId) return;
                
                const layer = this.state.canvasState.layers.find(l => l.id === layerId);
                if (!layer) {
                    URL.revokeObjectURL(URL.createObjectURL(blob));
                    return;
                }

                const newImage = new Image();
                const newImageURL = URL.createObjectURL(blob);
                newImage.src = newImageURL;
                await newImage.decode();

                const MAX_PROXY_DIMENSION = 2048;
                const scale = Math.min(MAX_PROXY_DIMENSION / newImage.naturalWidth, MAX_PROXY_DIMENSION / newImage.naturalHeight, 1);
                
                const proxyWidth = Math.round(newImage.naturalWidth * scale);
                const proxyHeight = Math.round(newImage.naturalHeight * scale);

                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = proxyWidth;
                tempCanvas.height = proxyHeight;
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                
                tempCtx.drawImage(newImage, 0, 0, proxyWidth, proxyHeight);

                const getSafeContentBounds = (canvas) => {
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    const { width, height } = canvas;
                    const data = ctx.getImageData(0, 0, width, height).data;
                    let minX = width, minY = height, maxX = -1, maxY = -1;
                    
                    const SAFE_THRESHOLD = 15; 
                    
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            if (data[(y * width + x) * 4 + 3] > SAFE_THRESHOLD) {
                                if (x < minX) minX = x;
                                if (x > maxX) maxX = x;
                                if (y < minY) minY = y;
                                if (y > maxY) maxY = y;
                            }
                        }
                    }
                    if (maxX === -1) return { x: 0, y: 0, width, height, isEmpty: true };
                    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, isEmpty: false };
                };

                const newBounds = getSafeContentBounds(tempCanvas);
                
                let finalCanvas = tempCanvas;
                let finalCtx = tempCtx;
                let finalContentFrame = newBounds;

                if (!newBounds.isEmpty && (newBounds.width < tempCanvas.width || newBounds.height < tempCanvas.height)) {
                    const croppedCanvas = document.createElement('canvas');
                    croppedCanvas.width = newBounds.width;
                    croppedCanvas.height = newBounds.height;
                    const croppedCtx = croppedCanvas.getContext('2d', { willReadFrequently: true });
                    
                    croppedCtx.drawImage(tempCanvas, 
                        newBounds.x, newBounds.y, newBounds.width, newBounds.height, 
                        0, 0, newBounds.width, newBounds.height
                    );
                    
                    finalCanvas = croppedCanvas;
                    finalCtx = croppedCtx;
                    finalContentFrame = { x: 0, y: 0, width: croppedCanvas.width, height: croppedCanvas.height, isEmpty: false };
                }

                this.dispatch({
                    type: 'LAYER_OPTIMIZATION_COMPLETE',
                    payload: {
                        layerId: layerId, 
                        newAsset: newImage, 
                        newSrc: newImageURL,
                        newProxyCanvas: finalCanvas, 
                        newProxyCtx: finalCtx,
                        newContentFrame: finalContentFrame, 
                        wasOptimized: wasOptimized
                    }
                });
            };
        } catch (e) {
            console.warn("Could not initialize the webp-converter worker. Asset optimization will be disabled.", e);
        }

        const savedThemeName = localStorage.getItem('selectedTheme') || 'Midnight';
        this.applyTheme(savedThemeName);
        this.state.originalTheme = savedThemeName;
        if (this.dom.currentThemeNameSpan) { this.dom.currentThemeNameSpan.textContent = savedThemeName; }
        this.config.availableFonts.forEach(font => this.config.fontValueToNameMap.set(font.value, font.name));

        const minDisplayTime = new Promise(resolve => setTimeout(resolve, 1500));
        const setupPromise = (async () => {
            this.injectNonCriticalStyles();
            this.populateThemeList();
            this.populateCustomFontSelector();
            this.addBgUI();
            await this.libraryManager.dedupeExistingAssetsByHashKeepNewest();
            const isJoiningSession = window.location.hash.startsWith('#room=');
            if (!isJoiningSession) {
                await this.restoreCurrentWork();
            }
            this.updateControlsState();
            this.updateEditPanelsUI();
            this.setupEventListeners();
            this.drawFrame();
            this.state.lastSavedStateHash = this.generateCanvasStateHash();
        })();

        const safetyTimeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Initialization timed out")), 8000)
        );

        try { 
            await Promise.race([
                Promise.all([minDisplayTime, setupPromise]),
                safetyTimeout
            ]);
        } 
        catch (error) { 
            console.error("Initialization warning:", error); 
            if (error.message === "Initialization timed out") {
                this.toast("Loading took a while, but you can start working.", 4000);
            } else {
                this.toast("Could not restore a previous session.", 4000); 
            }
        } 
        finally { 
            this.hideLoadingScreen(); 
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    ImageMakerStudio.init();
});