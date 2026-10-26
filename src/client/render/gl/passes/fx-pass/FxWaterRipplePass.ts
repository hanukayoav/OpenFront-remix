/**
 * FxWaterRipplePass — instanced concentric circular wave rings on water.
 */

import { DynamicInstanceBuffer } from "../../DynamicBuffer";
import type { RenderSettings } from "../../RenderSettings";
import { createProgram } from "../../utils/GlUtils";

import rippleFragSrc from "../../shaders/fx/water-ripple.frag.glsl?raw";
import rippleVertSrc from "../../shaders/fx/water-ripple.vert.glsl?raw";

const MAX_RIPPLES = 64;
// Layout: centerX, centerY, currentRadius, alpha, progress
const FLOATS_PER_RIPPLE = 5;

interface WaterRipple {
  x: number;
  y: number;
  startMs: number;
  durationMs: number;
  maxRadius: number;
}

export class FxWaterRipplePass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;

  private program: WebGLProgram;
  private uCamera: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private instanceBuf: DynamicInstanceBuffer;

  private pool: WaterRipple[] = Array.from({ length: MAX_RIPPLES }, () => ({
    x: 0,
    y: 0,
    startMs: 0,
    durationMs: 0,
    maxRadius: 0,
  }));
  private instanceData = new Float32Array(MAX_RIPPLES * FLOATS_PER_RIPPLE);
  private activeCount = 0;

  constructor(gl: WebGL2RenderingContext, settings: RenderSettings) {
    this.gl = gl;
    this.settings = settings;

    this.program = createProgram(gl, rippleVertSrc, rippleFragSrc);
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;

    const glBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(
      gl,
      glBuf,
      MAX_RIPPLES,
      FLOATS_PER_RIPPLE,
    );

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Quad geometry [-1.0 .. 1.0]
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    const quad = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0,
      -1.0,  1.0,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);

    const stride = FLOATS_PER_RIPPLE * 4;
    // 1: aCenter (2 floats)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    // 2: aRadius (1 float)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);

    // 3: aAlpha (1 float)
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);

    // 4: aProgress (1 float)
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);
  }

  public pushRipple(
    x: number,
    y: number,
    maxRadius: number = 18.0,
    durationMs: number = 1600,
  ): void {
    let r: WaterRipple;
    if (this.activeCount < MAX_RIPPLES) {
      r = this.pool[this.activeCount++];
    } else {
      // Evict oldest by shifting slots left
      r = this.pool[0];
      for (let i = 1; i < MAX_RIPPLES; i++) {
        this.pool[i - 1] = this.pool[i];
      }
      this.pool[MAX_RIPPLES - 1] = r;
    }
    r.x = x;
    r.y = y;
    r.startMs = performance.now();
    r.durationMs = durationMs;
    r.maxRadius = maxRadius;
  }

  public tick(): void {
    if (this.activeCount === 0) return;
    const now = performance.now();
    let writeIdx = 0;

    for (let i = 0; i < this.activeCount; i++) {
      const r = this.pool[i];
      const age = now - r.startMs;
      if (age < r.durationMs) {
        if (writeIdx !== i) {
          const tmp = this.pool[writeIdx];
          this.pool[writeIdx] = r;
          this.pool[i] = tmp;
        }
        writeIdx++;
      }
    }
    this.activeCount = writeIdx;
  }

  public draw(cameraMatrix: Float32Array): void {
    if (this.activeCount === 0) return;

    const gl = this.gl;
    const now = performance.now();

    for (let i = 0; i < this.activeCount; i++) {
      const r = this.pool[i];
      const off = i * FLOATS_PER_RIPPLE;
      const progress = Math.min(1.0, (now - r.startMs) / r.durationMs);
      const currentRadius = r.maxRadius * Math.pow(progress, 0.7);
      const alpha = 1.0 - progress;

      this.instanceData[off] = r.x;
      this.instanceData[off + 1] = r.y;
      this.instanceData[off + 2] = currentRadius;
      this.instanceData[off + 3] = alpha;
      this.instanceData[off + 4] = progress;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      this.activeCount * FLOATS_PER_RIPPLE,
    );

    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.activeCount);
    gl.bindVertexArray(null);
  }

  public clear(): void {
    this.activeCount = 0;
  }

  public dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quadVbo);
    this.instanceBuf.dispose();
  }
}
