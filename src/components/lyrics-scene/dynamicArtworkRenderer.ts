import { createPinchMesh, pinchMix } from './dynamicArtworkMesh';

// Rotating layers: period (s), scale, offset, and whether the layer also
// follows layer 0's rotation. Values come from third-party reverse engineering
// of iOS Music and are not independently verified.
const LAYERS = [
  { period: 120, scale: 1.4, x: 0, y: 0, followsFirst: false },
  { period: 70, scale: 0.7, x: -0.25, y: 0.15, followsFirst: false },
  { period: 90, scale: 0.7, x: 0.7, y: 0.7, followsFirst: true },
] as const;

const CROSSFADE_MS = 500;
const FRAME_INTERVAL_MS = 1000 / 30;
const MAX_FRAME_STEP_SECONDS = 0.1;
const ARTWORK_TEXTURE_SIZE = 256;
// The blur runs on a fixed-size intermediate, so cost and look do not depend
// on window size. Sigma is relative to the short side: 42.5 in a 4× downsampled
// iPhone-width (1170 px) buffer, i.e. 170 / 1170.
const BACKDROP_SHORT_SIDE = 128;
const BACKDROP_MAX_LONG_SIDE = 512;
const BLUR_SIGMA_PER_SHORT_SIDE = 0.145;
const MAX_BLUR_TAPS = 48;
const LANDSCAPE_TEXTURE_SCALE = 0.8;
// Black scrim behind lyrics (iOS lyrics-mode reference); the backdrop's only
// darkening layer.
export const DYNAMIC_BACKDROP_SCRIM = 0.4;

const QUAD_VERTEX = `#version 300 es
in vec2 a_position;
uniform mat2 u_matrix;
uniform vec2 u_offset;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(u_matrix * a_position + u_offset, 0.0, 1.0);
}`;

const LAYER_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_current;
uniform sampler2D u_previous;
uniform float u_mix;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = vec4(mix(texture(u_previous, v_uv).rgb, texture(u_current, v_uv).rgb, u_mix), 1.0);
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_center;
uniform float u_offsets[${MAX_BLUR_TAPS}];
uniform float u_weights[${MAX_BLUR_TAPS}];
uniform int u_count;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 sum = texture(u_source, v_uv) * u_center;
  for (int i = 0; i < ${MAX_BLUR_TAPS}; i++) {
    if (i >= u_count) break;
    vec2 offset = u_step * u_offsets[i];
    sum += (texture(u_source, v_uv + offset) + texture(u_source, v_uv - offset)) * u_weights[i];
  }
  outColor = sum;
}`;

const COMPOSITE_VERTEX = `#version 300 es
in vec2 a_from;
in vec2 a_to;
in vec2 a_uv;
uniform float u_mix;
uniform float u_textureScale;
out vec2 v_uv;
void main() {
  v_uv = a_uv * u_textureScale + (1.0 - u_textureScale) * 0.5;
  gl_Position = vec4(mix(a_from, a_to, u_mix), 0.0, 1.0);
}`;

// Saturation 1.4 → clamp → saturation 0.7 → scrim, then ±0.5 LSB dither and a
// tone clamp. Constants are third-party inferences of the iOS material.
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform float u_scrim;
in vec2 v_uv;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 saturation(vec3 color, float amount) {
  return mix(vec3(dot(color, LUMA)), color, amount);
}
void main() {
  vec3 color = saturation(texture(u_source, v_uv).rgb, 1.4);
  color = clamp(color, -0.752941, 1.25098);
  color = mix(saturation(color, 0.7), vec3(0.0), u_scrim);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color += (noise - 0.5) / 255.0;
  outColor = vec4(clamp(color, 0.07, 0.97), 1.0);
}`;

interface GaussianTaps {
  center: number;
  offsets: Float32Array;
  weights: Float32Array;
  count: number;
}

/** Normalized Gaussian kernel folded into paired bilinear taps. */
function gaussianTaps(sigma: number): GaussianTaps {
  const radius = Math.min(Math.ceil(sigma * 3), MAX_BLUR_TAPS * 2);
  const weight = (k: number) => (k > radius ? 0 : Math.exp(-(k * k) / (2 * sigma * sigma)));
  let total = weight(0);
  for (let k = 1; k <= radius; k += 1) total += 2 * weight(k);
  const count = Math.ceil(radius / 2);
  const offsets = new Float32Array(MAX_BLUR_TAPS);
  const weights = new Float32Array(MAX_BLUR_TAPS);
  for (let index = 0; index < count; index += 1) {
    const k = index * 2 + 1;
    const pair = weight(k) + weight(k + 1);
    offsets[index] = (k * weight(k) + (k + 1) * weight(k + 1)) / pair;
    weights[index] = pair / total;
  }
  return { center: weight(0) / total, offsets, weights, count };
}

const BLUR_TAPS = gaussianTaps(BLUR_SIGMA_PER_SHORT_SIDE * BACKDROP_SHORT_SIDE);

async function loadArtwork(source: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = ARTWORK_TEXTURE_SIZE;
  canvas.height = ARTWORK_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d context unavailable');
  context.imageSmoothingQuality = 'high';
  const width = image.naturalWidth || ARTWORK_TEXTURE_SIZE;
  const height = image.naturalHeight || ARTWORK_TEXTURE_SIZE;
  const scale = ARTWORK_TEXTURE_SIZE / Math.min(width, height);
  context.drawImage(
    image,
    (ARTWORK_TEXTURE_SIZE - width * scale) / 2,
    (ARTWORK_TEXTURE_SIZE - height * scale) / 2,
    width * scale,
    height * scale,
  );
  return canvas;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

interface Resources {
  layer: Program;
  blur: Program;
  composite: Program;
  quad: WebGLVertexArrayObject;
  fill: WebGLVertexArrayObject;
  mesh: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  meshIndexCount: number;
  meshPortrait: boolean;
  targets: [Target, Target] | null;
  current: WebGLTexture | null;
  previous: WebGLTexture | null;
}

interface DynamicArtworkRendererOptions {
  /** First frame with artwork has been presented. */
  onReady: () => void;
  /** The WebGL context was lost; the caller falls back to the static backdrop. */
  onFailure: () => void;
}

/**
 * Apple Music-style backdrop: rotating artwork layers → separable Gaussian on a
 * small intermediate → pinch-mesh warp with colour treatment and dither.
 *
 * The animation clock advances only while playing and visible, so pauses, track
 * changes, and resizes continue from the same pose. Artwork changes cross-fade
 * in wall-clock time, also while paused.
 */
export class DynamicArtworkRenderer {
  static create(
    canvas: HTMLCanvasElement,
    options: DynamicArtworkRendererOptions,
  ): DynamicArtworkRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) return null;
    try {
      return new DynamicArtworkRenderer(canvas, gl, options);
    } catch {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
  }

  private resources: Resources | null;
  private readonly observer: ResizeObserver;
  private readonly seed = Math.floor(Math.random() * 2 ** 32);
  private readonly halfFloat: boolean;
  private width = 0;
  private height = 0;
  private elapsed = 0;
  private lastTick: number | null = null;
  private frameHandle = 0;
  private playing = false;
  private disposed = false;
  private ready = false;
  private source: string | null = null;
  private generation = 0;
  private transitionStart = -Infinity;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly options: DynamicArtworkRendererOptions,
  ) {
    this.halfFloat = gl.getExtension('EXT_color_buffer_float') !== null;
    this.resources = this.createResources();
    canvas.addEventListener('webglcontextlost', this.options.onFailure);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.lastTick = null;
    this.schedule();
  }

  setArtwork(source: string | null): void {
    // A pending or missing source keeps the last artwork on screen.
    if (!source || source === this.source) return;
    this.source = source;
    const generation = ++this.generation;
    void loadArtwork(source)
      .then((artwork) => {
        if (this.disposed || generation !== this.generation) return;
        if (this.resources) this.pushArtwork(this.resources, artwork);
      })
      .catch(() => {
        // Undecodable or cross-origin artwork: keep the current texture.
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('webglcontextlost', this.options.onFailure);
    if (this.resources) this.deleteResources(this.resources);
    this.resources = null;
    // Chromium caps live contexts per page; release this one immediately.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private animating(): boolean {
    return this.playing;
  }

  private transitioning(now: number): boolean {
    return this.resources?.previous != null && now - this.transitionStart < CROSSFADE_MS;
  }

  private schedule(): void {
    if (this.frameHandle || this.disposed || !this.resources) return;
    if (document.visibilityState === 'hidden') return;
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number) => {
    this.frameHandle = 0;
    if (this.lastTick !== null && now - this.lastTick < FRAME_INTERVAL_MS - 2) {
      this.schedule();
      return;
    }
    if (this.lastTick !== null && this.animating()) {
      this.elapsed += Math.min((now - this.lastTick) / 1000, MAX_FRAME_STEP_SECONDS);
    }
    this.lastTick = now;
    this.draw(now);
    if (this.animating() || this.transitioning(now)) {
      this.schedule();
    } else {
      this.lastTick = null;
    }
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
      this.lastTick = null;
    } else {
      this.schedule();
    }
  };

  private resize(): void {
    const resources = this.resources;
    if (!resources) return;
    const width = Math.max(1, Math.round(this.canvas.clientWidth));
    const height = Math.max(1, Math.round(this.canvas.clientHeight));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.rebuildTargets(resources);
    const portrait = height > width;
    if (portrait !== resources.meshPortrait) this.uploadMesh(resources, portrait);
    // Resizing clears the drawing buffer; redraw before the next paint.
    this.draw(performance.now());
  }

  private pushArtwork(resources: Resources, artwork: HTMLCanvasElement): void {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, artwork);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const now = performance.now();
    if (!resources.current) {
      resources.current = texture;
    } else {
      // Interrupting a cross-fade keeps whichever image is more visible as the
      // outgoing frame, so the jump is at most half a fade.
      if (resources.previous) {
        const keepPrevious = this.mixAt(now) < 0.5;
        gl.deleteTexture(keepPrevious ? resources.current : resources.previous);
        if (!keepPrevious) resources.previous = resources.current;
      } else {
        resources.previous = resources.current;
      }
      resources.current = texture;
      this.transitionStart = now;
    }
    this.draw(now);
    this.schedule();
  }

  private mixAt(now: number): number {
    return Math.min(1, Math.max(0, (now - this.transitionStart) / CROSSFADE_MS));
  }

  private draw(now: number): void {
    const resources = this.resources;
    const gl = this.gl;
    if (!resources?.current || !resources.targets) return;
    if (resources.previous && !this.transitioning(now)) {
      gl.deleteTexture(resources.previous);
      resources.previous = null;
    }
    const [primary, secondary] = resources.targets;
    const backdrop = this.backdropSize();
    const aspect = this.width / this.height;
    const viewX = aspect >= 1 ? 1 : 1 / aspect;
    const viewY = aspect >= 1 ? aspect : 1;

    // 1. Artwork fill plus rotating layers into the small intermediate.
    gl.bindFramebuffer(gl.FRAMEBUFFER, primary.framebuffer);
    gl.viewport(0, 0, backdrop.width, backdrop.height);
    gl.useProgram(resources.layer.program);
    gl.bindVertexArray(resources.quad);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.previous ?? resources.current);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.current);
    gl.uniform1i(resources.layer.uniforms.u_current!, 0);
    gl.uniform1i(resources.layer.uniforms.u_previous!, 1);
    gl.uniform1f(resources.layer.uniforms.u_mix!, resources.previous ? this.mixAt(now) : 1);
    gl.uniformMatrix2fv(resources.layer.uniforms.u_matrix!, false, [viewX, 0, 0, viewY]);
    gl.uniform2f(resources.layer.uniforms.u_offset!, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const firstAngle = (this.elapsed * Math.PI * 2) / LAYERS[0].period;
    for (const layer of LAYERS) {
      const angle = (this.elapsed * Math.PI * 2) / layer.period;
      const parent = layer.followsFirst ? firstAngle : 0;
      const total = angle + parent;
      const cos = Math.cos(total) * layer.scale;
      const sin = Math.sin(total) * layer.scale;
      const offsetX = layer.x * Math.cos(parent) - layer.y * Math.sin(parent);
      const offsetY = layer.x * Math.sin(parent) + layer.y * Math.cos(parent);
      // Column-major: rotation in square space, then the view aspect transform.
      gl.uniformMatrix2fv(resources.layer.uniforms.u_matrix!, false, [
        viewX * cos,
        viewY * sin,
        -viewX * sin,
        viewY * cos,
      ]);
      gl.uniform2f(resources.layer.uniforms.u_offset!, viewX * offsetX, viewY * offsetY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 2. Separable Gaussian: primary → secondary → primary.
    const taps = BLUR_TAPS;
    const blur = resources.blur.uniforms;
    gl.useProgram(resources.blur.program);
    gl.uniformMatrix2fv(blur.u_matrix!, false, [1, 0, 0, 1]);
    gl.uniform2f(blur.u_offset!, 0, 0);
    gl.uniform1i(blur.u_source!, 0);
    gl.uniform1f(blur.u_center!, taps.center);
    gl.uniform1fv(blur.u_offsets!, taps.offsets);
    gl.uniform1fv(blur.u_weights!, taps.weights);
    gl.uniform1i(blur.u_count!, taps.count);
    gl.bindFramebuffer(gl.FRAMEBUFFER, secondary.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, primary.texture);
    gl.uniform2f(blur.u_step!, 1 / backdrop.width, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, primary.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, secondary.texture);
    gl.uniform2f(blur.u_step!, 0, 1 / backdrop.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Treated full-screen layer, then the pinch mesh over it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(resources.composite.program);
    gl.bindTexture(gl.TEXTURE_2D, primary.texture);
    const composite = resources.composite.uniforms;
    gl.uniform1i(composite.u_source!, 0);
    gl.uniform1f(composite.u_scrim!, DYNAMIC_BACKDROP_SCRIM);
    gl.uniform1f(composite.u_mix!, 0);
    gl.uniform1f(composite.u_textureScale!, 1);
    gl.bindVertexArray(resources.fill);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniform1f(composite.u_mix!, pinchMix(this.elapsed));
    gl.uniform1f(composite.u_textureScale!, resources.meshPortrait ? 1 : LANDSCAPE_TEXTURE_SCALE);
    gl.bindVertexArray(resources.mesh);
    gl.drawElements(gl.TRIANGLES, resources.meshIndexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);

    if (!this.ready) {
      this.ready = true;
      this.options.onReady();
    }
  }

  private backdropSize(): { width: number; height: number } {
    const short = Math.min(this.width, this.height);
    const long = Math.min(
      BACKDROP_MAX_LONG_SIDE,
      Math.round((Math.max(this.width, this.height) / short) * BACKDROP_SHORT_SIDE),
    );
    return this.width >= this.height
      ? { width: long, height: BACKDROP_SHORT_SIDE }
      : { width: BACKDROP_SHORT_SIDE, height: long };
  }

  private rebuildTargets(resources: Resources): void {
    const gl = this.gl;
    const { width, height } = this.backdropSize();
    for (const target of resources.targets ?? []) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    const create = (): Target => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.halfFloat ? gl.RGBA16F : gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { framebuffer, texture };
    };
    resources.targets = [create(), create()];
  }

  private uploadMesh(resources: Resources, portrait: boolean): void {
    const gl = this.gl;
    const mesh = createPinchMesh(portrait, this.seed);
    gl.bindVertexArray(resources.mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffers[2]!);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.buffers[3]!);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    resources.meshIndexCount = mesh.indices.length;
    resources.meshPortrait = portrait;
  }

  private createResources(): Resources {
    const gl = this.gl;
    const layer = this.createProgram(
      QUAD_VERTEX,
      LAYER_FRAGMENT,
      ['a_position'],
      ['u_matrix', 'u_offset', 'u_current', 'u_previous', 'u_mix'],
    );
    const blur = this.createProgram(
      QUAD_VERTEX,
      BLUR_FRAGMENT,
      ['a_position'],
      [
        'u_matrix',
        'u_offset',
        'u_source',
        'u_step',
        'u_center',
        'u_offsets',
        'u_weights',
        'u_count',
      ],
    );
    const composite = this.createProgram(
      COMPOSITE_VERTEX,
      COMPOSITE_FRAGMENT,
      ['a_from', 'a_to', 'a_uv'],
      ['u_source', 'u_scrim', 'u_mix', 'u_textureScale'],
    );

    const quadBuffer = gl.createBuffer();
    const quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const compositeLayout = () => {
      const stride = 6 * 4;
      for (let location = 0; location < 3; location += 1) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, stride, location * 8);
      }
    };
    const fillBuffer = gl.createBuffer();
    const fill = gl.createVertexArray();
    gl.bindVertexArray(fill);
    gl.bindBuffer(gl.ARRAY_BUFFER, fillBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      // prettier-ignore
      new Float32Array([
        -1, -1, -1, -1, 0, 0,
        1, -1, 1, -1, 1, 0,
        -1, 1, -1, 1, 0, 1,
        1, 1, 1, 1, 1, 1,
      ]),
      gl.STATIC_DRAW,
    );
    compositeLayout();

    const meshBuffer = gl.createBuffer();
    const meshIndices = gl.createBuffer();
    const mesh = gl.createVertexArray();
    gl.bindVertexArray(mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    compositeLayout();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIndices);
    gl.bindVertexArray(null);

    const resources: Resources = {
      layer,
      blur,
      composite,
      quad,
      fill,
      mesh,
      buffers: [quadBuffer, fillBuffer, meshBuffer, meshIndices],
      meshIndexCount: 0,
      meshPortrait: false,
      targets: null,
      current: null,
      previous: null,
    };
    this.uploadMesh(resources, this.canvas.clientHeight > this.canvas.clientWidth);
    return resources;
  }

  private createProgram(
    vertexSource: string,
    fragmentSource: string,
    attributes: string[],
    uniforms: string[],
  ): Program {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('shader allocation failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
      }
      return shader;
    };
    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    attributes.forEach((name, location) => gl.bindAttribLocation(program, location, name));
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed');
    }
    return {
      program,
      uniforms: Object.fromEntries(
        uniforms.map((name) => [name, gl.getUniformLocation(program, name)]),
      ),
    };
  }

  private deleteResources(resources: Resources): void {
    const gl = this.gl;
    for (const { program } of [resources.layer, resources.blur, resources.composite]) {
      gl.deleteProgram(program);
    }
    for (const array of [resources.quad, resources.fill, resources.mesh]) {
      gl.deleteVertexArray(array);
    }
    for (const buffer of resources.buffers) gl.deleteBuffer(buffer);
    for (const target of resources.targets ?? []) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    gl.deleteTexture(resources.current);
    gl.deleteTexture(resources.previous);
  }
}
