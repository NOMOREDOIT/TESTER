/**
 * @file modules.js
 * @description Contains reusable, self-contained modules, utilities, and the state reducer for Image Maker Studio.
 */

// ===================================================================================
// ARCHITECTURAL REFACTOR: SPLIT REDUCERS
// ===================================================================================

/**
 * Manages the state of the `layers` array within canvasState.
 * It handles adding, removing, reordering, and modifying individual layers.
 * @param {Array} layers - The current array of layer objects.
 * @param {Object} action - The dispatched action.
 * @returns {Array} The new layers array.
 */
function layersReducer(layers = [], action) {
    switch (action.type) {
        case 'LAYER_ADDED':
            return [action.payload.newLayer, ...layers];

        case 'LAYER_DELETED':
            return layers.filter(l => l.id !== action.payload.layerId);

        case 'LAYER_REORDERED': {
            const { layerId, delta } = action.payload;
            const newLayers = [...layers];
            const i = newLayers.findIndex(l => l.id === layerId);
            if (i === -1) return layers;
            const j = i + delta;
            if (j < 0 || j >= newLayers.length) return layers;
            const [item] = newLayers.splice(i, 1);
            newLayers.splice(j, 0, item);
            return newLayers;
        }
        
        case 'LAYER_PROPERTY_PREVIEW_CHANGED':
        case 'LAYER_SHADOW_PREVIEW_CHANGED':
        case 'LAYER_BORDER_PREVIEW_CHANGED': {
            const { layerId, property, value } = action.payload;
            const isShadow = action.type === 'LAYER_SHADOW_PREVIEW_CHANGED';
            const isBorder = action.type === 'LAYER_BORDER_PREVIEW_CHANGED';

            return layers.map(l => {
                if (l.id !== layerId) return l;
                const newCache = { ...l.cache, isValid: false }; 
                if (isShadow) return { ...l, shadow: { ...l.shadow, [property]: value }, cache: newCache };
                if (isBorder) return { ...l, border: { ...l.border, [property]: value }, cache: newCache };
                return { ...l, [property]: value, cache: newCache };
            });
        }

        case 'LAYER_PROPERTY_CHANGED':
        case 'LAYER_SHADOW_CHANGED':
        case 'LAYER_BORDER_CHANGED': {
            const { layerId, property, value } = action.payload;
            const isShadow = action.type === 'LAYER_SHADOW_CHANGED';
            const isBorder = action.type === 'LAYER_BORDER_CHANGED';

            return layers.map(l => {
                if (l.id !== layerId) return l;
                const newCache = { ...l.cache, isValid: false };
                if (isShadow) return { ...l, shadow: { ...l.shadow, [property]: value }, cache: newCache };
                if (isBorder) return { ...l, border: { ...l.border, [property]: value }, cache: newCache };
                return { ...l, [property]: value, cache: newCache };
            });
        }

        case 'LAYER_TRANSFORMED': {
            const { layerId, ...transformProps } = action.payload;
            return layers.map(layer => {
                if (layer.id !== layerId) return layer;
                return { ...layer, ...transformProps };
            });
        }
        
        case 'LAYER_REFIT_AND_TRANSFORM': {
            const { layerId, transform } = action.payload;
            return layers.map(l => {
                if (l.id !== layerId) return l;
                const newOriginalAsset = document.createElement('canvas');
                newOriginalAsset.width = transform.proxyCanvas.width;
                newOriginalAsset.height = transform.proxyCanvas.height;
                newOriginalAsset.getContext('2d').drawImage(transform.proxyCanvas, 0, 0);
                return {
                    ...l,
                    ...transform,
                    asset: transform.proxyCanvas,
                    originalAsset: newOriginalAsset,
                    contentVersion: (l.contentVersion || 0) + 1,
                    cache: { ...l.cache, isValid: false }
                };
            });
        }
        
        case 'LAYER_OPTIMIZATION_COMPLETE': {
            const { layerId, ...payload } = action.payload;
            return layers.map(l => {
                if (l.id !== layerId) return l;
                if (l.originalTempSrc) URL.revokeObjectURL(l.originalTempSrc);
                return {
                    ...l,
                    asset: payload.newProxyCanvas, 
                    proxyCanvas: payload.newProxyCanvas, 
                    src: payload.newSrc,
                    originalTempSrc: null,
                    proxyCtx: payload.newProxyCtx,
                    contentFrame: payload.newContentFrame,
                    isOptimized: payload.wasOptimized,
                    cache: { ...l.cache, isValid: false }
                };
            });
        }
        
        case 'INVALIDATE_LAYER_CACHE': {
            const { layerId } = action.payload;
            return layers.map(l => l.id !== layerId ? l : { ...l, cache: { ...l.cache, isValid: false } });
        }

        default:
            return layers;
    }
}

/**
 * Manages the state of the `canvasState` object.
 * It delegates layer-specific actions to `layersReducer`.
 * @param {Object} canvasState - The current canvasState object.
 * @param {Object} action - The dispatched action.
 * @returns {Object} The new canvasState object.
 */
function canvasStateReducer(canvasState = {}, action) {
    // First, always run the layersReducer to get the new layers array
    const newLayers = layersReducer(canvasState.layers, action);

    // Then, handle actions that modify other properties of canvasState
    switch (action.type) {
        case 'BACKGROUND_FILTER_PREVIEW_CHANGED':
        case 'BACKGROUND_FILTER_CHANGED': {
            const { property, value } = action.payload;
            return { ...canvasState, layers: newLayers, [property]: value };
        }
        case 'BACKGROUND_CHANGED': {
            const { backgroundHash } = action.payload;
            // When a new background is set, reset filters, rotation, and flip state
            return { ...canvasState, layers: newLayers, backgroundHash, bgBrightness: 1, bgSaturation: 1, projectRotation: 0, backgroundFlipX: false };
        }
        case 'PROJECT_ROTATED': {
            const newRotation = ((canvasState.projectRotation || 0) + 90) % 360;
            return { ...canvasState, layers: newLayers, projectRotation: newRotation };
        }
        case 'TOGGLE_BACKGROUND_FLIP': {
            return { ...canvasState, layers: newLayers, backgroundFlipX: !canvasState.backgroundFlipX };
        }
        case 'RESET_PROJECT_ROTATION': {
            return { ...canvasState, layers: newLayers, projectRotation: 0 };
        }
        default:
            // If the action didn't change canvasState directly, but it might have
            // changed the layers, we still need to return a new object with the new layers.
            if (newLayers !== canvasState.layers) {
                return { ...canvasState, layers: newLayers };
            }
            return canvasState;
    }
}

/**
 * The main root reducer for the entire application.
 * Manages top-level state and delegates to specialized reducers for nested state.
 * @param {Object} state - The entire application state.
 * @param {Object} action - The dispatched action.
 * @returns {Object} The new, complete application state.
 */
function rootReducer(state = {}, action) {
    const newCanvasState = canvasStateReducer(state.canvasState, action);

    let newState = state;
    if (newCanvasState !== state.canvasState) {
        newState = { ...state, canvasState: newCanvasState };
    }

    switch (action.type) {
        case 'SELECT_LAYER':
            return { ...newState, activeLayerId: action.payload.layerId };

        case 'LAYER_ADDED':
            return { ...newState, activeLayerId: action.payload.newLayer.id };
        
        case 'LAYER_DELETED':
            if (state.activeLayerId === action.payload.layerId) {
                return { ...newState, activeLayerId: null };
            }
            return newState;
        
        case 'CLEAR_CANVAS':
            return {
                ...state,
                activeLayerId: null,
                viewState: { scale: 1.0, pan: { x: 0, y: 0 } },
                targetViewState: { scale: 1.0, pan: { x: 0, y: 0 } },
                canvasState: {
                    currentProjectId: null,
                    backgroundElement: null,
                    backgroundType: 'none',
                    backgroundHash: null,
                    bgBrightness: 1,
                    bgSaturation: 1,
                    layers: [],
                    dominantColor: null,
                    projectRotation: 0 // Also reset rotation on clear
                },
                history: {
                    past: [],
                    present: null,
                    future: []
                }
            };

        default:
            return newState;
    }
}

// Export the single, combined root reducer as `reducer` for main.js to use.
export { rootReducer as reducer };

// ===================================================================================
// UNCHANGED MODULES
// ===================================================================================

export const panelManager = {
    app: null,
    activePanel: 'default-panel',
    panels: {},
    buttonMap: {},

    init(app) {
        this.app = app;
        this.panels = {
            'default-panel': document.getElementById('default-panel'),
            'visuals-panel': document.getElementById('visuals-panel'),
            'text-panel': document.getElementById('text-panel'),
            'eraser-panel': document.getElementById('eraser-panel'),
            'ai-tools-panel': document.getElementById('ai-tools-panel'),
        };
        this.buttonMap = {
            'visuals-panel': this.app.dom.visualsBtn,
            'text-panel': this.app.dom.textBtn,
            'eraser-panel': this.app.dom.eraseToolBtn,
            'ai-tools-panel': this.app.dom.aiToolsBtn,
        };
    },

    show(panelId, options = {}) {
        if (this.activePanel === panelId) return;

        Object.values(this.buttonMap).forEach(btn => btn.classList.remove('btn-active'));
        if (this.buttonMap[panelId]) {
            this.buttonMap[panelId].classList.add('btn-active');
        }

        if (this.activePanel === 'eraser-panel' && panelId !== 'eraser-panel') {
            this.app.deactivateEraser();
        }

        if (!options.preserveCanvasFocus) {
            this.app.state.canvasHasInteractionFocus = false;
        }

        const currentPanel = this.panels[this.activePanel];
        if (currentPanel) {
            currentPanel.classList.remove('active');
        }
        const nextPanel = this.panels[panelId];
        if (nextPanel) {
            setTimeout(() => {
                nextPanel.classList.add('active');
                this.app.renderPanelLayerPalettes();
            }, 10);
            this.activePanel = panelId;
        }
    }
};

export const collaborationManager = {
    app: null,
    socket: null,
    roomId: null,
    encryptionKey: null,
    init(app) { this.app = app; },
    _arrayBufferToBase64(buffer) { let b = ''; const B = new Uint8Array(buffer); for (let i = 0; i < B.byteLength; i++) { b += String.fromCharCode(B[i]); } return window.btoa(b); },
    _base64ToArrayBuffer(base64) { const s = window.atob(base64); const l = s.length; const b = new Uint8Array(l); for (let i = 0; i < l; i++) { b[i] = s.charCodeAt(i); } return b.buffer; },
    async _encrypt(data) { const iv = window.crypto.getRandomValues(new Uint8Array(12)); const encoded = new TextEncoder().encode(JSON.stringify(data)); const enc = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.encryptionKey, encoded); return `${this._arrayBufferToBase64(iv)}.${this._arrayBufferToBase64(enc)}`; },
    async _decrypt(encryptedString) { try { const [iv64, d64] = encryptedString.split('.'); if (!iv64 || !d64) throw new Error("Invalid format."); const iv = this._base64ToArrayBuffer(iv64); const d = this._base64ToArrayBuffer(d64); const dec = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.encryptionKey, d); return JSON.parse(new TextDecoder().decode(dec)); } catch (e) { console.error("Decryption failed:", e); return null; } },
    async generateEncryptionKey() { const k = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); this.encryptionKey = k; return this._arrayBufferToBase64(await window.crypto.subtle.exportKey("raw", k)); },

    async startSession() {
        if (this.socket) {
            console.warn("A session is already active.");
            return;
        }

        const startTime = Date.now();
        const startBtn = this.app.dom.startSessionBtn;
        const originalBtnText = startBtn.textContent;

        startBtn.textContent = 'Starting';
        startBtn.classList.add('is-loading');
        startBtn.disabled = true;
        this.app.showLoadingScreen('Establishing Encrypted E2E Connection');

        const resetUI = (errorMessage) => {
            this.app.hideLoadingScreen();
            if (errorMessage) {
                this.app.toast(errorMessage, 5000);
            }
            startBtn.textContent = originalBtnText;
            startBtn.classList.remove('is-loading');
            startBtn.disabled = false;
            this.socket = null;
        };

        try {
            const keyString = await this.generateEncryptionKey();

            const connectionPromise = new Promise((resolve, reject) => {
                const ws = new WebSocket('wss://vella-interjectural-defiantly.ngrok-free.dev');

                const connectionTimeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('Connection timed out.'));
                }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify({ type: 'create_room' }));
                };

                ws.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    if (message.type === 'room_created') {
                        clearTimeout(connectionTimeout);
                        resolve({ roomId: message.roomId, keyString, ws });
                    }
                };

                ws.onerror = (event) => {
                    clearTimeout(connectionTimeout);
                    reject(new Error('Connection failed. Is the server running?'));
                };
                ws.onclose = () => {
                    clearTimeout(connectionTimeout);
                    if (!this.roomId) {
                        reject(new Error('Connection was closed before setup completed.'));
                    }
                };
            });

            const sessionData = await connectionPromise;

            const elapsedTime = Date.now() - startTime;
            const remainingTime = 3500 - elapsedTime;
            if (remainingTime > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingTime));
            }

            this.socket = sessionData.ws;
            this.roomId = sessionData.roomId;

            this.socket.onmessage = (event) => this.handleServerMessage(event);
            this.socket.onclose = () => {
                this.app.toast("Live session disconnected.", 3000);
                resetUI(null);
            };

            this.app.hideLoadingScreen();
            startBtn.textContent = 'Session Active';
            startBtn.classList.remove('is-loading');

            setTimeout(() => this.showShareLinkModal(this.roomId, sessionData.keyString), 250);

        } catch (error) {
            const elapsedTime = Date.now() - startTime;
            const remainingTime = 3500 - elapsedTime;
            if (remainingTime > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingTime));
            }

            resetUI(error.message);
        }
    },

    async joinSession(roomId, keyString) {
        if (this.socket) { return; }
        try {
            const keyData = this._base64ToArrayBuffer(keyString);
            this.encryptionKey = await window.crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
            this.roomId = roomId;
            this.socket = new WebSocket('wss://vella-interjectural-defiantly.ngrok-free.dev');
            this.socket.onopen = () => { this.socket.send(JSON.stringify({ type: 'join', roomId: this.roomId })); };
            this.socket.onmessage = (event) => this.handleServerMessage(event);
            this.socket.onerror = (error) => { console.error("WebSocket Error:", error); this.socket = null; };
            this.socket.onclose = () => { this.socket = null; this.roomId = null; this.encryptionKey = null; };
        } catch (e) { console.error("Failed to join session:", e); window.location.hash = ''; }
    },
    

    async handleServerMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch (e) {
            const decryptedAction = await this._decrypt(event.data);
            if (decryptedAction) {
                if (decryptedAction.type === 'LAYER_ADDED' && decryptedAction.payload.newLayer.type === 'image' && decryptedAction.payload.newLayer.assetDataUrl) {
                    const blob = this.app.dataURLtoBlob(decryptedAction.payload.newLayer.assetDataUrl);
                    await this.app.saveAssetToLibrary({ blob, mime: blob.type, hash: decryptedAction.payload.newLayer.originalHash, kind: 'asset' });
                    const hydratedLayer = await this.app.createLayerFromSrc(URL.createObjectURL(blob), decryptedAction.payload.newLayer);
                    this.app.dispatch({ type: 'LAYER_ADDED', payload: { newLayer: hydratedLayer } }, true);
                } else {
                    this.app.dispatch(decryptedAction, true);
                }
            }
            return;
        }
        switch (message.type) {
            case 'new_user_joined': this.app.toast("A new user joined.", 1500); const s = await this.app.getSavableState(true); const e = await this._encrypt(s); this.socket.send(JSON.stringify({ type: 'sync_data', roomId: this.roomId, payload: e })); break;
            case 'sync_data': this.app.toast("Receiving current state...", null); const d = await this._decrypt(message.payload); if (d) { await this.app.restoreProjectState(d); this.app.toast("✅ Session Synced!", 2000); } break;
        }
    },

    checkForSessionInUrl() { const h = window.location.hash; if (h.startsWith('#room=')) { const [r, k] = h.substring(6).split(','); if (r && k) { setTimeout(() => this.joinSession(r, k), 100); } } },

    showShareLinkModal(r, k) { const u = `${window.location.href.split('#')[0]}#room=${r},${k}`; this.app.dom.shareLinkInput.value = u; this.app.dom.shareSessionOverlay.classList.add('visible'); },

    hideShareLinkModal() { this.app.dom.shareSessionOverlay.classList.remove('visible'); },

    async broadcastAction(action) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        if (action.type === 'LAYER_ADDED' && action.payload.newLayer.type === 'image' && action.payload.newLayer.originalHash) {
            const assetRecords = await this.app.idbFindByHash(action.payload.newLayer.originalHash);
            if (assetRecords.length > 0) {
                action.payload.newLayer.assetDataUrl = await this.app.toDataURL(assetRecords[0].full);
            }
        }
        const e = await this._encrypt(action);
        this.socket.send(JSON.stringify({ type: 'message', roomId: this.roomId, payload: e }));
    }
};