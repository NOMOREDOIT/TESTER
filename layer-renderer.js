/**
 * @file layer-renderer.js
 * @description Web Worker for asynchronously rendering layer caches with expensive filters.
 */

// This function performs the heavy lifting inside the worker
function renderLayer(layerData) {
    const { imageData, type, properties, contentWidth, contentHeight } = layerData;
    let padding = 0;

    // Calculate the extra space needed for effects like shadows and borders
    if (properties.shadow && properties.shadow.enabled) {
        // Use a generous multiplier for blur to avoid clipping
        padding = (properties.shadow.blur * 2.5) + Math.max(Math.abs(properties.shadow.offsetX), Math.abs(properties.shadow.offsetY));
    }
    if (type === 'image' && properties.border && properties.border.enabled) {
        padding += properties.border.width * 2;
    }

    const cacheWidth = Math.round(contentWidth + padding * 2);
    const cacheHeight = Math.round(contentHeight + padding * 2);

    if (cacheWidth <= 0 || cacheHeight <= 0) {
        throw new Error("Invalid cache dimensions.");
    }

    // OffscreenCanvas is designed for use in workers and is highly efficient
    const cacheCanvas = new OffscreenCanvas(cacheWidth, cacheHeight);
    const cacheCtx = cacheCanvas.getContext('2d');

    cacheCtx.save();
    cacheCtx.translate(cacheWidth / 2, cacheHeight / 2);

    // --- APPLY EXPENSIVE FILTERS OFF THE MAIN THREAD ---
    const filters = `brightness(${properties.brightness}) saturate(${properties.saturation})`;
    const shadow = properties.shadow.enabled ? `drop-shadow(${properties.shadow.offsetX}px ${properties.shadow.offsetY}px ${properties.shadow.blur}px ${properties.shadow.color})` : '';
    let borderFilters = '';
    if (type === 'image' && properties.border.enabled && properties.border.width > 0) {
        const w = properties.border.width;
        const c = properties.border.color;
        borderFilters = `drop-shadow(${w}px ${w}px 0 ${c}) drop-shadow(-${w}px -${w}px 0 ${c}) drop-shadow(-${w}px ${w}px 0 ${c}) drop-shadow(${w}px -${w}px 0 ${c})`;
    }
    cacheCtx.filter = `${borderFilters} ${shadow} ${filters}`.trim();
    cacheCtx.globalAlpha = properties.opacity;

    // Draw the source image (from either an image layer or a pre-rendered text layer)
    cacheCtx.drawImage(imageData, -contentWidth / 2, -contentHeight / 2, contentWidth, contentHeight);
    cacheCtx.restore();

    // Convert the result to an ImageBitmap for a high-performance, zero-copy transfer back to the main thread
    return cacheCanvas.transferToImageBitmap();
}

// Listen for messages (render jobs) from the main thread
self.onmessage = async (event) => {
    const layerData = event.data;
    try {
        const renderedBitmap = renderLayer(layerData);
        // Send the finished product back
        self.postMessage({
            status: 'success',
            layerId: layerData.id,
            renderedBitmap: renderedBitmap,
        }, [renderedBitmap]); // The second argument transfers ownership, which is extremely fast
    } catch (e) {
        self.postMessage({
            status: 'error',
            layerId: layerData.id,
            error: e.message,
        });
    }
};