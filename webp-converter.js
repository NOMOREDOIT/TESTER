/**
 * Web Worker for converting images to the WebP format.
 */
self.onmessage = async (event) => {
    // --- FIX #1: The name of the variable must match what was sent. ---
    // We now correctly look for the 'blob' property instead of 'file'.
    const { blob, layerId, originalHash, kind } = event.data;

    try {
        // Create an ImageBitmap from the blob. This is a highly efficient
        // way to get image data without adding it to the DOM.

        // --- FIX #2: Use the correct variable here. ---
        const imageBitmap = await createImageBitmap(blob);

        // Create an OffscreenCanvas. This is a canvas that is not visible on the page,
        // perfect for background processing.
        const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);

        // Convert the canvas content to a WebP Blob.
        // We use a quality of 0.9 for a great balance of size and quality.
        // For PNGs with transparency, WebP's lossless mode is used automatically.
        const webpBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });

        // If the new WebP is not smaller, there's no point in using it.
        // This is an edge case for already highly optimized images.
        if (webpBlob.size >= blob.size) {
            self.postMessage({
                status: 'success',
                blob: blob, // Send the original blob back
                layerId: layerId,
                originalHash: originalHash,
                wasOptimized: false,
                kind: kind
            });
            return;
        }

        // Send the successful result back to the main application thread.
        self.postMessage({
            status: 'success',
            blob: webpBlob,
            layerId: layerId,
            originalHash: originalHash,
            wasOptimized: true,
            kind: kind
        });

    } catch (error) {
        console.error('Web Worker conversion failed:', error);
        // Send an error message back to the main thread.
        self.postMessage({
            status: 'error',
            layerId: layerId,
            originalHash: originalHash,
            error: error.message
        });
    }
};