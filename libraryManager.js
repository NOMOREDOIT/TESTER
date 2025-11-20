/**
 * @file libraryManager.js
 * @description Manages all interactions with IndexedDB and file handling for the local asset and project library.
 */

export const libraryManager = {
    app: null,

    init(app) {
        this.app = app;
    },

    // ===================================================================================
    // NEWLY MOVED & CENTRALIZED FUNCTIONS (From main.js)
    // ===================================================================================

    async loadProjectFromLibrary(projectId) {
        if (this.app.isCanvasDirty()) {
            this.app.state.pendingProjectId = projectId;
            this.app.dom.saveChangesOverlay.classList.add('visible');
        } else {
            await this._actuallyLoadProject(projectId);
        }
    },

    async _actuallyLoadProject(projectId) {
        this.app.showLoadingScreen('Loading Project');
        const minDisplayTime = new Promise(resolve => setTimeout(resolve, 1200));
        const loadingPromise = (async () => {
            const projectRecord = await this.idbGet(projectId, 'projects');
            if (!projectRecord) throw new Error("Project not found.");
            
            projectRecord.projectState.currentProjectId = projectId;
            await this.app.restoreProjectState(projectRecord.projectState);

            const loadedHashes = new Set();
            if (projectRecord.projectState.backgroundHash) {
                loadedHashes.add(projectRecord.projectState.backgroundHash);
            }
            projectRecord.projectState.layers.forEach(l => {
                if (l.type === 'image' && l.originalHash) {
                    loadedHashes.add(l.originalHash);
                }
            });
            await this._updateAssetReferences(loadedHashes);
            await this.renderLocalAssetPalette_IDB();
            await this.renderLocalBackgroundPalette_IDB();
        })();
        try {
            await Promise.all([minDisplayTime, loadingPromise]);
            this.app.dom.projectLibraryPopupOverlay.classList.remove('visible');
            this.app.toast("Project loaded.", 2000);
        } catch (e) {
            console.error("Failed to load project from library:", e);
            this.app.toast(`Error: Could not load project. ${e.message}`, 4000);
        } finally {
            this.app.hideLoadingScreen();
            this.app.state.lastSavedStateHash = this.app.generateCanvasStateHash();
        }
    },

   async addFilesToLibraryOnly(files, intendedUse) {
    const validFiles = [...files].filter(file => file.type.startsWith('image/'));
    if (validFiles.length === 0) {
        this.app.toast('No valid image files were selected.', 3000);
        return;
    }

    const toastMessage = `Adding ${validFiles.length} image(s) to library...`;
    this.app.toast(toastMessage, null);

    const _processSingleFileForLibrary = async (file, use) => {
        try {
            const blobHash = await this.app.sha256Hex(file);
            
            if (use === 'background') {
                const optimizedBlob = await this.app.createOptimizedBlob(file, 2560, 0.85);
                await this.saveAssetToLibrary({
                    blob: optimizedBlob,
                    mime: 'image/webp',
                    hash: blobHash,
                    kind: 'background'
                });
            } else { // 'asset'
                await this.saveAssetToLibrary({ 
                    blob: file, 
                    mime: file.type, 
                    hash: blobHash, 
                    kind: 'asset' 
                });
            }
        } catch (error) {
            console.error("File saving to library failed for:", file.name, error);
            this.app.toast(`Error processing ${file.name}.`, 4000);
        }
    };

    const processingPromises = validFiles.map(file => _processSingleFileForLibrary(file, intendedUse));
    await Promise.all(processingPromises);

    if (this.app.dom.projectLibraryPopupOverlay.classList.contains('visible')) {
        await this.populateProjectLibraryPopup();
    }
    
    await this.renderLocalAssetPalette_IDB();
    await this.renderLocalBackgroundPalette_IDB();
    
    this.app.toast(`${validFiles.length} item(s) added to your library!`, 3000);
},
    
    handleFileUpload(files, intendedUse = 'asset') {
        if (files instanceof File) {
            files = [files];
        }

        const validFiles = [...files].filter(file => file.type.startsWith('image/'));

        if (validFiles.length === 0) {
            this.app.toast('No valid image files were selected.', 3000);
            return;
        }

        const filesToProcess = validFiles.slice(0, 5);
        if (validFiles.length > 5) {
            this.app.toast(`Processing the first 5 images (max allowed).`, 4000);
        }

        const toastMessage = `Processing ${filesToProcess.length} image(s) as ${intendedUse}s...`;
        this.app.toast(toastMessage, null);

        let isFirstFile = true;

        (async () => {
            for (const file of filesToProcess) {
                await this._processSingleFile(file, intendedUse, isFirstFile);
                isFirstFile = false;
            }
            this.app.hideToast();
        })();
    },

    async _processSingleFile(file, intendedUse, setOnCanvas) {
        try {
            const blobHash = await this.app.sha256Hex(file);

            if (intendedUse === 'background') {
                const optimizedBlob = await this.app.createOptimizedBlob(file, 2560, 0.85);
                await this.saveAssetToLibrary({
                    blob: optimizedBlob,
                    mime: 'image/webp',
                    hash: blobHash,
                    kind: 'background'
                });

                if (setOnCanvas) {
                    const tempUrl = URL.createObjectURL(optimizedBlob);
                    const imageEl = new Image();
                    await new Promise((resolve, reject) => {
                        imageEl.onload = () => {
                            this.app.setBackground(imageEl, blobHash);
                            URL.revokeObjectURL(tempUrl);
                            resolve();
                        };
                        imageEl.onerror = reject;
                        imageEl.src = tempUrl;
                    });
                }
            } 
            else { 
                if (!this.app.state.canvasState.backgroundElement) {
                    console.warn("Attempted to add a layer before a background was set. Treating as background instead:", file.name);
                    if (setOnCanvas) {
                       await this._processSingleFile(file, 'background', true);
                    }
                    return;
                }

                await this.saveAssetToLibrary({ 
                    blob: file, 
                    mime: file.type, 
                    hash: blobHash, 
                    kind: 'asset'
                });

                const needsOptimization = file.type !== 'image/webp';
                await this.app.addImageLayer(URL.createObjectURL(file), blobHash, needsOptimization);
            }
        } catch (error) {
            console.error("File handling failed for:", file.name, error);
            this.app.toast(`Error processing ${file.name}.`, 4000);
        }
    },

    // ===================================================================================
    // CORE LIBRARY MANAGER FUNCTIONS
    // ===================================================================================

    idbOpen(dbName = 'ims-db') {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                this.app.toast("Project Library is not available.", 4000);
                return reject(new Error("IndexedDB not supported."));
            }
            const req = indexedDB.open(dbName, 6);
            req.onupgradeneeded = (e) => {
                const db = req.result;
                if (!db.objectStoreNames.contains('assets')) {
                    const assetsStore = db.createObjectStore('assets', { keyPath: 'id', autoIncrement: true });
                    assetsStore.createIndex('hash', 'hash', { unique: false });
                    assetsStore.createIndex('kind', 'kind', { unique: false });
                    assetsStore.createIndex('isFavorite', 'isFavorite');
                }
                if (!db.objectStoreNames.contains('projects')) {
                    db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                console.error("IndexedDB error:", req.error);
                this.app.toast("Could not access Project Library.", 4000);
                reject(req.error);
            };
        });
    },

    async idbGet(id, storeName) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.objectStore(storeName).get(id).onsuccess = (e) => resolve(e.target.result);
            tx.onerror = () => reject(tx.error);
        });
    },

    async idbPut(record, storeName) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const isUpdate = record.id != null;
            const req = isUpdate ? tx.objectStore(storeName).put(record) : tx.objectStore(storeName).add(record);
            if (!isUpdate) {
                req.onsuccess = (e) => { record.id = e.target.result; };
            }
            tx.oncomplete = () => resolve(record);
            tx.onerror = () => reject(tx.error);
        });
    },
    
    async idbGetAll(storeName) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.objectStore(storeName).getAll().onsuccess = (e) => resolve(e.target.result);
            tx.onerror = () => reject(tx.error);
        });
    },

    async idbDelete(id, storeName) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async idbFindByHash(hash) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('assets', 'readonly');
            tx.objectStore('assets').index('hash').getAll(hash).onsuccess = (e) => resolve(e.target.result || []);
            tx.onerror = () => reject(tx.error);
        });
    },

    async saveAssetToLibrary({ blob, mime, hash, kind = 'asset', visualState, thumbBlob = null }) {
        const allExistingWithHash = await this.idbFindByHash(hash);
        const specificExistingAsset = allExistingWithHash.find(asset => (asset.kind || 'asset') === kind);

        if (specificExistingAsset) {
            const assetToUpdate = specificExistingAsset;
            assetToUpdate.createdAt = Date.now();
            assetToUpdate.isUserDeleted = false;
            
            if (visualState) assetToUpdate.visualState = visualState;
            if (thumbBlob) assetToUpdate.thumb = thumbBlob;
            
            await this.idbPut(assetToUpdate, 'assets');
            this.app.toast(`${kind.charAt(0).toUpperCase() + kind.slice(1)} is already in the library. Updated timestamp.`, 2500);

        } else {
            const finalThumbBlob = thumbBlob || await this.app.createThumbBlob(blob);
            const record = {
                full: blob,
                thumb: finalThumbBlob,
                mime,
                createdAt: Date.now(),
                hash,
                kind,
                isFavorite: false,
                isUserDeleted: false,
                referenceCount: 0,
                visualState: visualState
            };
            await this.idbPut(record, 'assets');
        }

        if (kind === 'asset') await this.renderLocalAssetPalette_IDB();
        else if (kind === 'background') await this.renderLocalBackgroundPalette_IDB();

        if (this.app.dom.projectLibraryPopupOverlay.classList.contains('visible')) {
            await this.populateProjectLibraryPopup();
        }

        await this.enforceQuota(500 * 1024 * 1024);
        return hash;
    },

    async saveProjectToLibrary() {
        if (!this.app.state.canvasState.backgroundElement) { this.app.toast("A background is required to save a project.", 3000); return; }
        this.app.toast("Saving project to library...", null);

        let oldHashes = new Set();
        if (this.app.state.canvasState.currentProjectId) {
            const oldRecord = await this.idbGet(this.app.state.canvasState.currentProjectId, 'projects');
            if (oldRecord) {
                if (oldRecord.projectState.backgroundHash) oldHashes.add(oldRecord.projectState.backgroundHash);
                oldRecord.projectState.layers.forEach(l => { if (l.type === 'image' && l.originalHash) oldHashes.add(l.originalHash); });
            }
        }
        const projectState = await this.app.getSavableState();
        const newHashes = new Set();
        if (projectState.backgroundHash) newHashes.add(projectState.backgroundHash);
        projectState.layers.forEach(l => { if (l.type === 'image' && l.originalHash) newHashes.add(l.originalHash); });
        await this._updateAssetReferences(newHashes, oldHashes);
        
        const renderCanvas = document.createElement('canvas');
        const rotation = this.app.state.canvasState.projectRotation;
        const rotationRad = rotation * (Math.PI / 180);
        const bgImage = this.app.state.canvasState.backgroundElement;
        const flip = this.app.state.canvasState.backgroundFlipX;
        const sourceWidth = bgImage.naturalWidth;
        const sourceHeight = bgImage.naturalHeight;
        const isTilted = [90, 270].includes(rotation);
        renderCanvas.width = isTilted ? sourceHeight : sourceWidth;
        renderCanvas.height = isTilted ? sourceWidth : sourceHeight;
        const renderCtx = renderCanvas.getContext('2d');
        renderCtx.imageSmoothingQuality = 'high';

        renderCtx.filter = `brightness(${this.app.state.canvasState.bgBrightness}) saturate(${this.app.state.canvasState.bgSaturation})`;
        renderCtx.save();
        renderCtx.translate(renderCanvas.width / 2, renderCanvas.height / 2);
        renderCtx.rotate(rotationRad);
        if (flip) {
            renderCtx.scale(-1, 1);
        }
        renderCtx.drawImage(bgImage, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
        renderCtx.restore();
        renderCtx.filter = 'none';

        renderCtx.save();
        const scaleFactor = renderCanvas.width / this.app.dom.movieCanvas.width;
        renderCtx.scale(scaleFactor, scaleFactor);
        this.app.drawLayers(renderCtx, this.app.state.canvasState.layers, true);
        renderCtx.restore();

        const thumbCanvas = document.createElement('canvas');
        const THUMB_MAX_SIZE = 256;
        const aspect = renderCanvas.width / renderCanvas.height;
        thumbCanvas.width = aspect >= 1 ? THUMB_MAX_SIZE : THUMB_MAX_SIZE * aspect;
        thumbCanvas.height = aspect < 1 ? THUMB_MAX_SIZE : THUMB_MAX_SIZE / aspect;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.imageSmoothingQuality = 'high';
        thumbCtx.drawImage(renderCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
        
        const thumbnailBlob = await new Promise(resolve => thumbCanvas.toBlob(resolve, 'image/webp', 0.8));
        const record = { createdAt: Date.now(), thumbnail: thumbnailBlob, projectState };
        let toastMessage = "Project saved to library!";
        if (this.app.state.canvasState.currentProjectId) {
            record.id = this.app.state.canvasState.currentProjectId;
            toastMessage = "Project updated in library!";
        }
        
        const savedRecord = await this.idbPut(record, 'projects');
        this.app.state.canvasState.currentProjectId = savedRecord.id;
        await this.app.saveCurrentWork();
        this.app.state.lastSavedStateHash = this.app.generateCanvasStateHash();
        this.app.toast(toastMessage, 2500);
        
        await this.populateProjectLibraryPopup();
        await this.enforceQuota(500 * 1024 * 1024);
    },

    async dedupeExistingAssetsByHashKeepNewest() {
        const all = await this.idbGetAll('assets');
        for (const rec of all) {
            if (!rec.hash && rec.full) {
                try {
                    if (!(rec.full instanceof Blob)) { throw new Error("Asset data is not a valid Blob."); }
                    rec.hash = await this.app.sha256Hex(rec.full);
                    await this.idbPut(rec, 'assets');
                } catch (error) {
                    console.error(`A corrupted or invalid asset record (ID: ${rec.id}) was detected and will be deleted.`, { record: rec, error: error });
                    if (rec.id) { await this.idbDelete(rec.id, 'assets'); }
                }
            }
        }
        const byHash = new Map();
        const cleanAssets = await this.idbGetAll('assets');
        for (const rec of cleanAssets) {
            if (!rec.hash) continue;
            const best = byHash.get(rec.hash);
            if (!best || rec.createdAt > best.createdAt) { byHash.set(rec.hash, rec); }
        }
        for (const rec of cleanAssets) {
            if (rec.hash && byHash.has(rec.hash) && byHash.get(rec.hash).id !== rec.id) {
                await this.idbDelete(rec.id, 'assets');
            }
        }
        await this.renderLocalAssetPalette_IDB();
        await this.renderLocalBackgroundPalette_IDB();
    },

    async deleteProjectFromLibrary(projectId) {
        const projectRecord = await this.idbGet(projectId, 'projects');
        if (!projectRecord) return;
        
        const hashesToDecrement = new Set();
        if (projectRecord.projectState.backgroundHash) hashesToDecrement.add(projectRecord.projectState.backgroundHash);
        projectRecord.projectState.layers.forEach(l => {
            if (l.type === 'image' && l.originalHash) hashesToDecrement.add(l.originalHash);
        });
        
        await this.idbDelete(projectId, 'projects');
        this.app.toast('Project deleted from library.', 2000);
        
        for (const hash of hashesToDecrement) {
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
        await this.populateProjectLibraryPopup();
    },

    async deleteAssetFromLibrary(assetId) {
        const idNum = Number(assetId);
        const asset = await this.idbGet(idNum, 'assets');
        if (!asset) return;
        if (asset.referenceCount > 0) {
            asset.isUserDeleted = true;
            await this.idbPut(asset, 'assets');
            this.app.toast('Asset hidden. It will be fully deleted once no projects use it.', 3000);
        } else {
            await this.idbDelete(idNum, 'assets');
            this.app.toast('Asset removed from folder.', 1500);
        }
        await this.renderLocalAssetPalette_IDB();
        await this.renderLocalBackgroundPalette_IDB();
        if (this.app.dom.projectLibraryPopupOverlay.classList.contains('visible')) { 
            await this.populateProjectLibraryPopup(); 
        }
    },

    async renderLocalAssetPalette_IDB() {
        const all = await this.idbGetAll('assets');
        const assetsOnly = all.filter(r => !r.isUserDeleted && (r.kind || 'asset') === 'asset').sort((a, b) => b.createdAt - a.createdAt);
        this.app.dom.localAssetPalette.innerHTML = '';
        
        const toShow = assetsOnly.slice(0, 4);
        if (toShow.length === 0) {
            const placeholder = document.createElement('p');
            placeholder.className = 'placeholder-text';
            placeholder.textContent = 'Your recent assets will appear here.';
            this.app.dom.localAssetPalette.appendChild(placeholder);
        } else {
            toShow.forEach((asset, index) => {
                const thumb = document.createElement('div');
                thumb.className = 'layer-thumb';
                thumb.title = "Add asset as a new layer";
                const thumbUrl = URL.createObjectURL(asset.thumb);
                const img = new Image();
                img.src = thumbUrl;
                img.onload = () => URL.revokeObjectURL(thumbUrl);
                thumb.appendChild(img);
                thumb.addEventListener('click', () => {
                    if (!this.app.state.canvasState.backgroundElement) { this.app.toast('Please set a background before adding layers.', 2000); return; }
                    this.app.addImageLayer(URL.createObjectURL(asset.full), asset.hash, asset.mime !== 'image/webp', asset.visualState);
                });
                if (toShow.length === 4 && index === toShow.length - 1) {
                    const addAssetBtn = document.createElement('button');
                    addAssetBtn.className = 'palette-overlay-btn';
                    addAssetBtn.innerHTML = '+';
                    addAssetBtn.title = "Add a new image asset";
                    addAssetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.app.openAddLayerPopup(); });
                    thumb.appendChild(addAssetBtn);
                }
                this.app.dom.localAssetPalette.appendChild(thumb);
            });
        }
        if (toShow.length < 4) {
            const addAssetBtn = document.createElement('button');
            addAssetBtn.className = 'palette-slot empty';
            addAssetBtn.innerHTML = '+';
            addAssetBtn.title = 'Add a new image asset';
            addAssetBtn.addEventListener('click', () => this.app.openAddLayerPopup());
            this.app.dom.localAssetPalette.appendChild(addAssetBtn);
        }
    },
    
    async renderLocalBackgroundPalette_IDB() {
        const all = await this.idbGetAll('assets');
        const backgroundsOnly = all.filter(r => !r.isUserDeleted && r.kind === 'background').sort((a, b) => b.createdAt - a.createdAt);
        this.app.dom.localBackgroundPalette.innerHTML = '';
        
        const toShow = backgroundsOnly.slice(0, 4);
        if (toShow.length === 0) {
            const placeholder = document.createElement('p');
            placeholder.className = 'placeholder-text';
            placeholder.textContent = 'Your recent backgrounds will appear here.';
            this.app.dom.localBackgroundPalette.appendChild(placeholder);
        } else {
            toShow.forEach((bg, index) => {
                const thumb = document.createElement('div');
                thumb.className = 'layer-thumb';
                thumb.title = "Set as background";
                const thumbUrl = URL.createObjectURL(bg.thumb);
                const img = new Image();
                img.src = thumbUrl;
                img.onload = () => URL.revokeObjectURL(thumbUrl);
                thumb.appendChild(img);
                thumb.addEventListener('click', () => {
                    const fullUrl = URL.createObjectURL(bg.full);
                    const fullImage = new Image();
                    fullImage.onload = () => { this.app.setBackground(fullImage, bg.hash); URL.revokeObjectURL(fullUrl); };
                    fullImage.onerror = () => { this.app.toast('Error loading this background.'); URL.revokeObjectURL(fullUrl); }
                    fullImage.src = fullUrl;
                });
                if (toShow.length === 4 && index === toShow.length - 1) {
                    const addBgBtn = document.createElement('button');
                    addBgBtn.className = 'palette-overlay-btn';
                    addBgBtn.innerHTML = '+';
                    addBgBtn.title = "Add or change background";
                    addBgBtn.addEventListener('click', (e) => { 
                        e.stopPropagation(); 
                        this.app.openAddLayerPopup('background');
                    });
                    thumb.appendChild(addBgBtn);
                }
                this.app.dom.localBackgroundPalette.appendChild(thumb);
            });
        }
        if (toShow.length < 4) {
            const addBgBtn = document.createElement('button');
            addBgBtn.className = 'palette-slot empty';
            addBgBtn.innerHTML = '+';
            addBgBtn.title = "Add or change background";
            addBgBtn.addEventListener('click', () => this.app.openAddLayerPopup('background'));
            this.app.dom.localBackgroundPalette.appendChild(addBgBtn);
        }
    },

    async populateProjectLibraryPopup() {
        const allAssets = await this.idbGetAll('assets');
        const createAssetGridItem = async (rec, onClick, context = 'recents') => {
            const item = document.createElement('div');
            item.className = 'library-grid-item';
            item.dataset.assetId = String(rec.id);
            const content = document.createElement('div');
            const thumbUrl = URL.createObjectURL(rec.thumb);
            const img = document.createElement('img');
            img.src = thumbUrl;
            img.alt = rec.kind;
            img.onload = () => { URL.revokeObjectURL(thumbUrl); };
            content.appendChild(img);
            content.addEventListener('click', () => { onClick(rec); this.app.dom.projectLibraryPopupOverlay.classList.remove('visible'); });
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = '&times;';
            const favoriteBtn = document.createElement('button');
            favoriteBtn.className = 'favorite-btn';
            favoriteBtn.classList.toggle('is-favorite', !!rec.isFavorite);
            favoriteBtn.title = rec.isFavorite ? 'Remove from favorites' : 'Add to favorites';
            if (context === 'favorites') {
                deleteBtn.style.display = 'none';
                favoriteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.app.openConfirmationModal('Remove this from your favorites?', async () => {
                        const assetToUpdate = await this.idbGet(rec.id, 'assets');
                        assetToUpdate.isFavorite = false;
                        await this.idbPut(assetToUpdate, 'assets');
                        this.app.toast('Removed from favorites.', 2000);
                        await this.populateProjectLibraryPopup();
                        this.app.closeConfirmationModal();
                    });
                });
            } else {
                deleteBtn.title = `Permanently delete from storage`;
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.app.openConfirmationModal('Permanently delete this item?', async () => {
                        await this.deleteAssetFromLibrary(rec.id);
                        this.app.closeConfirmationModal();
                    });
                });
                favoriteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const assetToUpdate = await this.idbGet(rec.id, 'assets');
                    assetToUpdate.isFavorite = !assetToUpdate.isFavorite;
                    await this.idbPut(assetToUpdate, 'assets');
                    await this.populateProjectLibraryPopup();
                    this.app.toast(assetToUpdate.isFavorite ? `${assetToUpdate.kind.charAt(0).toUpperCase() + assetToUpdate.kind.slice(1)} added to favorites!` : 'Removed from favorites.', 2000);
                });
            }
            item.appendChild(content);
            item.appendChild(deleteBtn);
            item.appendChild(favoriteBtn);
            return item;
        };

        const createSectionHeader = (title, buttonId, buttonText) => {
            const header = document.createElement('div');
            header.className = 'library-section-header';
            header.innerHTML = `<h5>${title}</h5>`;
            
            const button = document.createElement('button');
            button.id = buttonId;
            button.className = 'add-to-library-btn';
            button.innerHTML = `<i class="fas fa-plus"></i> ${buttonText}`;
            header.appendChild(button);
            
            return header;
        };

        const createPlaceholder = (iconClass, title, text) => {
            const placeholder = document.createElement('div');
            placeholder.className = 'empty-library-placeholder';
            placeholder.innerHTML = `<i class="fas ${iconClass}"></i><h3>${title}</h3><p>${text}</p>`;
            return placeholder;
        };

        const assets = allAssets.filter(r => !r.isUserDeleted && (r.kind || 'asset') === 'asset').sort((a,b) => b.createdAt - a.createdAt);
        const bgs = allAssets.filter(r => !r.isUserDeleted && r.kind === 'background').sort((a,b) => b.createdAt - a.createdAt);
        const favoriteAssets = allAssets.filter(r => r.isFavorite && (r.kind || 'asset') === 'asset').sort((a,b) => b.createdAt - a.createdAt);
        const favoriteBgs = allAssets.filter(r => r.isFavorite && r.kind === 'background').sort((a,b) => b.createdAt - a.createdAt);
        const allProjects = await this.idbGetAll('projects');

        this.app.dom.projectLibraryGridAssets.innerHTML = '';
        this.app.dom.projectLibraryGridAssets.appendChild(createSectionHeader('Recent Assets', 'add-asset-to-library-btn', 'Add from Computer'));
        if (assets.length === 0) { 
            const placeholder = createPlaceholder('fa-image', 'No Recent Assets', 'Assets you add to your creations will appear here for re-use.');
            placeholder.style.gridColumn = '1 / -1';
            this.app.dom.projectLibraryGridAssets.appendChild(placeholder);
        } 
        else { for (const rec of assets) { this.app.dom.projectLibraryGridAssets.appendChild(await createAssetGridItem(rec, r => { if (!this.app.state.canvasState.backgroundElement) { this.app.toast('Please set a background before adding layers.', 2000); return; } this.app.addImageLayer(URL.createObjectURL(r.full), r.hash, r.mime !== 'image/webp', r.visualState); })); } }

        this.app.dom.projectLibraryGridBackgrounds.innerHTML = '';
        this.app.dom.projectLibraryGridBackgrounds.appendChild(createSectionHeader('Recent Backgrounds', 'add-bg-to-library-btn', 'Add from Computer'));
        if (bgs.length === 0) { 
            const placeholder = createPlaceholder('fa-panorama', 'No Recent Backgrounds', 'The backgrounds you use in your projects will be automatically saved here.');
            placeholder.style.gridColumn = '1 / -1';
            this.app.dom.projectLibraryGridBackgrounds.appendChild(placeholder);
        }
        else { for(const rec of bgs) { this.app.dom.projectLibraryGridBackgrounds.appendChild(await createAssetGridItem(rec, r => { const fullUrl = URL.createObjectURL(r.full); const imgEl = new Image(); imgEl.onload = () => { this.app.setBackground(imgEl, r.hash); URL.revokeObjectURL(fullUrl); }; imgEl.onerror = () => { URL.revokeObjectURL(fullUrl); this.app.toast('Could not load background image.', 3000); }; imgEl.src = fullUrl; })); } }
        
        this.app.dom.projectLibraryGridFavorites.innerHTML = '';
        if (favoriteAssets.length > 0) { this.app.dom.projectLibraryGridFavorites.insertAdjacentHTML('beforeend', '<h5>Favorite Assets</h5>'); for(const rec of favoriteAssets) { this.app.dom.projectLibraryGridFavorites.appendChild(await createAssetGridItem(rec, r => { if (!this.app.state.canvasState.backgroundElement) { this.app.toast('Please set a background before adding layers.', 2000); return; } this.app.addImageLayer(URL.createObjectURL(r.full), r.hash, r.mime !== 'image/webp', r.visualState); }, 'favorites')); } }
        if (favoriteBgs.length > 0) { this.app.dom.projectLibraryGridFavorites.insertAdjacentHTML('beforeend', '<h5>Favorite Backgrounds</h5>'); for(const rec of favoriteBgs) { this.app.dom.projectLibraryGridFavorites.appendChild(await createAssetGridItem(rec, r => { const fullUrl = URL.createObjectURL(r.full); const imgEl = new Image(); imgEl.onload = () => { this.app.setBackground(imgEl, r.hash); URL.revokeObjectURL(fullUrl); }; imgEl.onerror = () => { URL.revokeObjectURL(fullUrl); this.app.toast('Could not load background image.', 3000); }; imgEl.src = fullUrl; }, 'favorites')); } }
        if (favoriteAssets.length === 0 && favoriteBgs.length === 0) { 
            this.app.dom.projectLibraryGridFavorites.appendChild(createPlaceholder('fa-star', 'Your Favorites are Empty', 'Click the star icon on any asset or background to save it here for quick access.'));
        }

        this.app.dom.projectLibraryGridProjects.innerHTML = '<h5>Saved Projects</h5>';
        if (allProjects.length === 0) { 
            this.app.dom.projectLibraryGridProjects.appendChild(createPlaceholder('fa-save', 'No Saved Projects', 'Click the \'Save Project\' button on the main screen to save your work here.'));
        }
        else { allProjects.sort((a, b) => b.createdAt - a.createdAt).forEach(rec => { const item = document.createElement('div'); item.className = 'library-grid-item'; item.dataset.projectId = String(rec.id); const content = document.createElement('div'); const thumbUrl = URL.createObjectURL(rec.thumbnail); content.innerHTML = `<img src="${thumbUrl}" alt="Saved Project">`; content.addEventListener('click', () => this.loadProjectFromLibrary(rec.id)); const deleteBtn = document.createElement('button'); deleteBtn.className = 'delete-btn'; deleteBtn.innerHTML = '&times;'; deleteBtn.title = `Delete project`; deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this.app.openConfirmationModal('Permanently delete this project?', async () => { await this.deleteProjectFromLibrary(rec.id); this.app.closeConfirmationModal(); }); }); item.appendChild(content); item.appendChild(deleteBtn); this.app.dom.projectLibraryGridProjects.appendChild(item); }); }
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

    async enforceQuota(limitBytes) {
        const assets = await this.idbGetAll('assets');
        let totalBytes = assets.reduce((sum, r) => sum + (r.full?.size || 0) + (r.thumb?.size || 0), 0);
        if (totalBytes <= limitBytes) return;
        const nonFavorites = assets.filter(a => !a.isFavorite);
        nonFavorites.sort((a, b) => a.createdAt - b.createdAt);
        for (const rec of nonFavorites) {
            if (totalBytes <= limitBytes) break;
            await this.idbDelete(rec.id, 'assets');
            totalBytes -= (rec.full?.size || 0) + (rec.thumb?.size || 0);
            this.app.toast('Oldest non-favorite asset removed to free space.', 3000);
        }
    },

    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },

    async updateStorageUsage() {
        if (!this.app.dom.storageUsageDisplay) return;
        this.app.dom.storageUsageDisplay.textContent = 'Calculating...';
        try {
            const assets = await this.idbGetAll('assets');
            const projects = await this.idbGetAll('projects');
            let totalBytes = 0;
            assets.forEach(r => { totalBytes += (r.full?.size || 0) + (r.thumb?.size || 0); });
            projects.forEach(r => { totalBytes += (r.projectState ? JSON.stringify(r.projectState).length : 0) + (r.thumbnail?.size || 0); });
            this.app.dom.storageUsageDisplay.textContent = `${this.formatBytes(totalBytes)} / 500 MB`;
        } catch (error) {
            console.error("Could not calculate storage usage:", error);
            this.app.dom.storageUsageDisplay.textContent = 'Error';
        }
    },

    async clearProjectLibrary() {
        this.app.toast('Clearing entire library...', null);
        try {
            const db = await this.idbOpen();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['assets', 'projects'], 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.objectStore('assets').clear();
                tx.objectStore('projects').clear();
            });
            localStorage.removeItem('ims-autosave-project');
            this.app.toast('Library cleared successfully.', 2000);
            await this.renderLocalAssetPalette_IDB();
            await this.renderLocalBackgroundPalette_IDB();
            if (this.app.dom.projectLibraryPopupOverlay.classList.contains('visible')) {
                await this.populateProjectLibraryPopup();
            }
        } catch (error) {
            console.error("Failed to clear project library:", error);
            this.app.toast(`Error: Could not clear library data.`, 4000);
        }
    }
};