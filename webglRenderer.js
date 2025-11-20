/**
 * @file webglRenderer.js
 * @description A high-performance, GPU-accelerated rendering engine for Image Maker Studio.
 * This module handles all WebGL setup, shader compilation, texture management, and scene rendering.
 */
export const WebGLRenderer = {
    gl: null,
    program: null,
    locations: {},
    textureCache: new Map(),
    positionBuffer: null,
    texCoordBuffer: null,

    /**
     * Initializes the WebGL context, shaders, and default buffers.
     * @param {HTMLCanvasElement} canvas The canvas element to render to.
     * @returns {boolean} True if initialization was successful, false otherwise.
     */
    init(canvas) {
        // Use { preserveDrawingBuffer: true } to allow canvas.toDataURL() for downloads.
         this.gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true });
        if (!this.gl) {
            console.error("Critical: WebGL is not supported. Cannot initialize GPU renderer.");
            return false;
        }
        const gl = this.gl;

        const vertexShaderSource = `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            uniform mat3 u_matrix;
            varying vec2 v_texCoord;
            void main() {
                // Transform the vertex position by the matrix.
                gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
                // Pass the texture coordinate to the fragment shader.
                v_texCoord = a_texCoord;
            }
        `;

        const fragmentShaderSource = `
            precision highp float;
            
            // Input from vertex shader
            varying vec2 v_texCoord;

            // Texture and its size
            uniform sampler2D u_image;
            uniform vec2 u_texture_size;

            // Basic Properties
            uniform float u_opacity;
            uniform float u_brightness;
            uniform float u_saturation;

            // Border Properties
            uniform bool u_border_enabled;
            uniform vec3 u_border_color;
            uniform float u_border_width;

            // Shadow Properties
            uniform bool u_shadow_enabled;
            uniform vec4 u_shadow_color; // Using vec4 for color + opacity
            uniform vec2 u_shadow_offset;
            uniform float u_shadow_blur;

            // Luminance constants for saturation calculation
            const vec3 lum = vec3(0.2126, 0.7152, 0.0722);

            void main() {
                // Sample the main texture color at the current fragment's coordinate
                vec4 texColor = texture2D(u_image, v_texCoord);
                
                vec4 finalColor = vec4(0.0);

                // 1. CALCULATE SHADOW
                if (u_shadow_enabled) {
                    float shadowAlpha = 0.0;
                    vec2 pixelSize = 1.0 / u_texture_size;
                    float blurAmount = u_shadow_blur * pixelSize.x;
                    vec2 shadowOffset = u_shadow_offset * pixelSize;

                    // Simple 9-tap box blur for a soft shadow effect.
                    // This samples the alpha from surrounding pixels at an offset.
                    for (float y = -1.0; y <= 1.0; y += 1.0) {
                        for (float x = -1.0; x <= 1.0; x += 1.0) {
                            shadowAlpha += texture2D(u_image, v_texCoord - shadowOffset + vec2(x, y) * blurAmount).a;
                        }
                    }
                    shadowAlpha /= 9.0;
                    
                    // The final shadow color is the uniform color multiplied by the calculated alpha.
                    finalColor = vec4(u_shadow_color.rgb, u_shadow_color.a * shadowAlpha);
                }

                // 2. APPLY FILTERS TO THE MAIN TEXTURE COLOR
                vec3 filteredRgb = texColor.rgb;
                if (texColor.a > 0.0) {
                    // Apply Brightness
                    filteredRgb += (u_brightness - 1.0);
                    // Apply Saturation
                    vec3 gray = vec3(dot(filteredRgb, lum));
                    filteredRgb = mix(gray, filteredRgb, u_saturation);
                }
                
                // Create the final layer color, pre-multiplying alpha for correct blending
                vec4 layerColor = vec4(filteredRgb * texColor.a, texColor.a);
                
                // 3. BLEND LAYER ON TOP OF SHADOW
                // Standard "over" blending: final = foreground + background * (1 - foreground.alpha)
                finalColor = layerColor + finalColor * (1.0 - layerColor.a);
                
                // 4. APPLY BORDER (Basic Implementation)
                // This simple version draws a border on the edge of the texture's bounding box.
                if (u_border_enabled && texColor.a > 0.5) {
                    float bx = u_border_width / u_texture_size.x;
                    float by = u_border_width / u_texture_size.y;
                    if (v_texCoord.x < bx || v_texCoord.x > 1.0 - bx || v_texCoord.y < by || v_texCoord.y > 1.0 - by) {
                        finalColor = vec4(u_border_color, 1.0);
                    }
                }

                // 5. APPLY FINAL OPACITY
                finalColor *= u_opacity;
                
                gl_FragColor = finalColor;
            }
        `;

        const vertexShader = this._createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this._createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
        this.program = this._createProgram(gl, vertexShader, fragmentShader);

        // Get locations of all attributes and uniforms
        this.locations = {
            position: gl.getAttribLocation(this.program, 'a_position'),
            texCoord: gl.getAttribLocation(this.program, 'a_texCoord'),
            matrix: gl.getUniformLocation(this.program, 'u_matrix'),
            image: gl.getUniformLocation(this.program, 'u_image'),
            texture_size: gl.getUniformLocation(this.program, 'u_texture_size'),
            opacity: gl.getUniformLocation(this.program, 'u_opacity'),
            brightness: gl.getUniformLocation(this.program, 'u_brightness'),
            saturation: gl.getUniformLocation(this.program, 'u_saturation'),
            border_enabled: gl.getUniformLocation(this.program, 'u_border_enabled'),
            border_color: gl.getUniformLocation(this.program, 'u_border_color'),
            border_width: gl.getUniformLocation(this.program, 'u_border_width'),
            shadow_enabled: gl.getUniformLocation(this.program, 'u_shadow_enabled'),
            shadow_color: gl.getUniformLocation(this.program, 'u_shadow_color'),
            shadow_offset: gl.getUniformLocation(this.program, 'u_shadow_offset'),
            shadow_blur: gl.getUniformLocation(this.program, 'u_shadow_blur'),
        };

        // Create a buffer for a unit quad (a 1x1 square)
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

        // Create a buffer for texture coordinates
        this.texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

        // Enable alpha blending
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        return true;
    },
    
    /**
     * Loads an image or canvas into a WebGL texture, using a cache to avoid re-uploads.
     * @param {HTMLImageElement|HTMLCanvasElement} imageSource The source to upload.
     * @param {boolean} [forceUpdate=false] If true, re-uploads the pixel data to an existing texture.
     * @returns {WebGLTexture} The WebGL texture object.
     */
    loadTexture(imageSource, forceUpdate = false) {
        // Use a unique key for caching. Canvases need a manually assigned key.
        const cacheKey = imageSource.src || imageSource.__cacheKey;
        if (!cacheKey) {
            forceUpdate = true; // No key, can't cache, always treat as new
        }

        const gl = this.gl;
        const existingTexture = cacheKey ? this.textureCache.get(cacheKey) : null;

        if (existingTexture && !forceUpdate) {
            return existingTexture;
        }

        const texture = existingTexture || gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (!existingTexture) {
            // New texture: set parameters and upload data
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageSource);
        } else if (forceUpdate) {
            // Existing texture that needs updating (e.g., after erasing)
            // Use texSubImage2D for a much faster update.
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageSource);
        }
        
        if (cacheKey && !existingTexture) {
            this.textureCache.set(cacheKey, texture);
        }
        return texture;
    },

    /**
     * Renders the entire scene, including background and all layers.
     * @param {HTMLImageElement} background The background image element.
     * @param {Object} bgFilters Filters for the background.
     * @param {Array} layers An array of layer objects to render.
     */
    // In webglRenderer.js, REPLACE this entire function
renderScene(viewState, background, bgFilters, layers, activeStrokeCanvas = null, activeLayerId = null) {
    const gl = this.gl;
    if (!gl) return;
    
    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.program);

    gl.enableVertexAttribArray(this.locations.position);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);

    gl.enableVertexAttribArray(this.locations.texCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.vertexAttribPointer(this.locations.texCoord, 2, gl.FLOAT, false, 0, 0);

    if (background && background.complete && background.naturalWidth > 0) {
        this._drawLayer({
            viewState: viewState,
            texture: this.loadTexture(background),
            x: gl.canvas.width / 2, y: gl.canvas.height / 2,
            width: gl.canvas.width, height: gl.canvas.height,
            rot: 0,
            flipX: false,
            opacity: 1.0,
            brightness: bgFilters.bgBrightness || 1.0,
            saturation: bgFilters.bgSaturation || 1.0,
            imageWidth: background.naturalWidth, imageHeight: background.naturalHeight,
            shadow: { enabled: false }, 
            border: { enabled: false }
        });
    }
    
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const assetSource = layer.type === 'image' ? layer.asset : layer.textureCanvas;

        if (assetSource && assetSource.width > 0 && assetSource.height > 0) {
            const texture = this.loadTexture(assetSource);
            let renderWidth, renderHeight;

            if (layer.type === 'image') {
                const aspectRatio = assetSource.height / assetSource.width;
                renderWidth = layer.size;
                renderHeight = layer.size * aspectRatio;
            } else {
                renderWidth = assetSource.width;
                renderHeight = assetSource.height;
            }

            this._drawLayer({
                viewState: viewState, texture, x: layer.x, y: layer.y,
                width: renderWidth, height: renderHeight, rot: layer.rot,
                flipX: layer.flipX, opacity: layer.opacity,
                brightness: layer.brightness || 1.0, saturation: layer.saturation || 1.0,
                imageWidth: assetSource.width, imageHeight: assetSource.height,
                shadow: layer.shadow, border: layer.border
            });

            if (activeStrokeCanvas && layer.id === activeLayerId) {
                
                gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
                
                this._drawLayer({
                    viewState: viewState,
                    texture: this.loadTexture(activeStrokeCanvas, true),
                    x: layer.x, y: layer.y,
                    width: renderWidth, height: renderHeight, rot: layer.rot,
                    flipX: layer.flipX,
                    opacity: 1.0, brightness: 1.0, saturation: 1.0, 
                    imageWidth: activeStrokeCanvas.width, imageHeight: activeStrokeCanvas.height,
                    shadow: { enabled: false }, border: { enabled: false }
                });
                
                gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            }
        }
    }
},

// In webglRenderer.js, add this entire new function.
// It can go right after the renderScene function.

deleteTexture(cacheKey) {
    if (this.textureCache.has(cacheKey)) {
        const texture = this.textureCache.get(cacheKey);
        this.gl.deleteTexture(texture); // This is the crucial GPU cleanup command
        this.textureCache.delete(cacheKey); // Clean up the JavaScript cache
    }
},

deleteTexture(cacheKey) {
    if (this.textureCache.has(cacheKey)) {
        const texture = this.textureCache.get(cacheKey);
        this.gl.deleteTexture(texture); // This is the crucial GPU cleanup command
        this.textureCache.delete(cacheKey); // Clean up the JavaScript cache
    }
},
    
    /**
     * Internal function to draw a single textured quad with all effects.
     * @param {Object} props The properties for the layer being drawn.
     * @private
     */
   // In webglRenderer.js, REPLACE this entire function
// In webglRenderer.js, REPLACE this entire function
// In webglRenderer.js, REPLACE this entire function
_drawLayer(props) {
    const gl = this.gl;

    // --- 1. Bind the texture for this specific layer ---
    gl.bindTexture(gl.TEXTURE_2D, props.texture);

    // --- 2. Set all shader uniforms based on layer properties ---
    
    // Texture information
    gl.uniform1i(this.locations.image, 0); // Tell the shader to use texture unit 0
    gl.uniform2f(this.locations.texture_size, props.imageWidth, props.imageHeight);

    // Basic filters
    gl.uniform1f(this.locations.opacity, props.opacity);
    gl.uniform1f(this.locations.brightness, props.brightness);
    gl.uniform1f(this.locations.saturation, props.saturation);
    
    // Border uniforms (only set if enabled)
    gl.uniform1i(this.locations.border_enabled, props.border && props.border.enabled ? 1 : 0);
    if (props.border && props.border.enabled) {
        gl.uniform3fv(this.locations.border_color, this._hexToRgb(props.border.color || '#000000'));
        gl.uniform1f(this.locations.border_width, props.border.width || 0);
    }
    
    // Shadow uniforms (only set if enabled)
    gl.uniform1i(this.locations.shadow_enabled, props.shadow && props.shadow.enabled ? 1 : 0);
    if (props.shadow && props.shadow.enabled) {
        const shadowRgb = this._hexToRgb(props.shadow.color || '#000000');
        // Pass color (RGB) and alpha (A) as a vec4
        gl.uniform4f(this.locations.shadow_color, shadowRgb[0], shadowRgb[1], shadowRgb[2], 1.0);
        gl.uniform2f(this.locations.shadow_offset, props.shadow.offsetX || 0, props.shadow.offsetY || 0);
        gl.uniform1f(this.locations.shadow_blur, props.shadow.blur || 0);
    }

    // --- 3. Build the final transformation matrix (Model-View-Projection) ---
    // The order of multiplication is critical and is applied in reverse.
    
    // Start with a fresh identity matrix
    let matrix = this._createMatrix();
    
    // a) Apply the PROJECTION matrix (converts world pixels to clip space)
    matrix = this._matrixMultiply(matrix, this._projection(gl.canvas.width, gl.canvas.height));

    // b) Apply the VIEW (camera) matrix from the application's view state (pan & zoom)
    matrix = this._matrixMultiply(matrix, this._translation(props.viewState.pan.x, props.viewState.pan.y));
    matrix = this._matrixMultiply(matrix, this._scaling(props.viewState.scale, props.viewState.scale));

    // c) Apply the individual layer's MODEL matrix transformations
    matrix = this._matrixMultiply(matrix, this._translation(props.x, props.y));
    matrix = this._matrixMultiply(matrix, this._rotation(props.rot * Math.PI / 180));
    
    // ===================================================================
    // --- THIS IS THE FLIP FIX ---
    // We determine the scaleX based on the flipX property before applying it.
    const scaleX = props.flipX ? -props.width : props.width;
    const scaleY = props.height;
    matrix = this._matrixMultiply(matrix, this._scaling(scaleX, scaleY));
    // ===================================================================
    
    // d) Finally, translate the unit quad so its origin (0,0) is at its center.
    // This ensures rotation and scaling happen around the center of the image.
    matrix = this._matrixMultiply(matrix, this._translation(-0.5, -0.5));
    
    // --- 4. Send the final matrix to the GPU and draw ---
    gl.uniformMatrix3fv(this.locations.matrix, false, matrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6); // Draw the 2 triangles that form our quad
},

    // --- Helper Functions ---

    _hexToRgb(hex) {
        if (!hex || typeof hex !== 'string' || hex.charAt(0) !== '#') return [0, 0, 0];
        const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
        return result ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ] : [0, 0, 0];
    },

    _createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
        console.error(`Error compiling ${type === gl.VERTEX_SHADER ? "Vertex" : "Fragment"} Shader:`, gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    },

    _createProgram(gl, vertexShader, fragmentShader) {
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
        console.error('Error linking shader program:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    },
    
    // --- Matrix Math Helpers ---
    _createMatrix() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; },
    _projection(width, height) { return [2 / width, 0, 0, 0, -2 / height, 0, -1, 1, 1]; },
    _translation(tx, ty) { return [1, 0, 0, 0, 1, 0, tx, ty, 1]; },
    _rotation(angle) { const c = Math.cos(angle); const s = Math.sin(angle); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
    _scaling(sx, sy) { return [sx, 0, 0, 0, sy, 0, 0, 0, 1]; },
    _matrixMultiply(a, b) {
        const a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8];
        const b00 = b[0], b01 = b[1], b02 = b[2], b10 = b[3], b11 = b[4], b12 = b[5], b20 = b[6], b21 = b[7], b22 = b[8];
        return [
            b00 * a00 + b01 * a10 + b02 * a20, b00 * a01 + b01 * a11 + b02 * a21, b00 * a02 + b01 * a12 + b02 * a22,
            b10 * a00 + b11 * a10 + b12 * a20, b10 * a01 + b11 * a11 + b12 * a21, b10 * a02 + b11 * a12 + b12 * a22,
            b20 * a00 + b21 * a10 + b22 * a20, b20 * a01 + b21 * a11 + b22 * a21, b20 * a02 + b21 * a12 + b22 * a22,
        ];
    }
};