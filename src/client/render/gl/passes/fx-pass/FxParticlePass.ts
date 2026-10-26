/**
 * FxParticlePass — high-performance zero-GC instanced GPU particle engine.
 *
 * Renders mushroom cloud fireballs, smoke embers, electric EMP sparks,
 * and vertical sea water splash plumes.
 */

import { DynamicInstanceBuffer } from "../../DynamicBuffer";
import type { RenderSettings } from "../../RenderSettings";
import { createProgram } from "../../utils/GlUtils";

import particleFragSrc from "../../shaders/fx/particles.frag.glsl?raw";
import particleVertSrc from "../../shaders/fx/particles.vert.glsl?raw";

const MAX_PARTICLES = 512;
// Layout: posX, posY, velX, velY, ageMs, maxLifeMs, r, g, b, a, startSize, endSize, style
const FLOATS_PER_PARTICLE = 13;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  startMs: number;
  maxLifeMs: number;
  r: number;
  g: number;
  b: number;
  a: number;
  startSize: number;
  endSize: number;
  style: number; // 0: Fire/Smoke, 1: EMP Spark, 2: Water Splash
}

export class FxParticlePass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;

  private program: WebGLProgram;
  private uCamera: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private instanceBuf: DynamicInstanceBuffer;

  private pool: Particle[] = Array.from({ length: MAX_PARTICLES }, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    startMs: 0,
    maxLifeMs: 0,
    r: 0,
    g: 0,
    b: 0,
    a: 0,
    startSize: 0,
    endSize: 0,
    style: 0,
  }));
  private instanceData = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);
  private activeCount = 0;

  constructor(gl: WebGL2RenderingContext, settings: RenderSettings) {
    this.gl = gl;
    this.settings = settings;

    this.program = createProgram(gl, particleVertSrc, particleFragSrc);
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;

    const glBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(
      gl,
      glBuf,
      MAX_PARTICLES,
      FLOATS_PER_PARTICLE,
    );

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Quad geometry [-0.5 .. 0.5]
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    const quad = new Float32Array([
      -0.5, -0.5,
       0.5, -0.5,
      -0.5,  0.5,
       0.5, -0.5,
       0.5,  0.5,
      -0.5,  0.5,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);

    const stride = FLOATS_PER_PARTICLE * 4;
    // 1: aParticlePos (2 floats)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    // 2: aVelocity (2 floats)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);

    // 3: aLife (2 floats: ageMs, maxLifeMs)
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);

    // 4: aColor (4 floats)
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(4, 1);

    // 5: aSize (2 floats: startSize, endSize)
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, stride, 40);
    gl.vertexAttribDivisor(5, 1);

    // 6: aStyle (1 float)
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 48);
    gl.vertexAttribDivisor(6, 1);

    gl.bindVertexArray(null);
  }

  private allocParticle(): Particle {
    if (this.activeCount < MAX_PARTICLES) {
      return this.pool[this.activeCount++];
    }
    // Evict oldest by taking the first slot and shifting active slots left
    const oldest = this.pool[0];
    for (let i = 1; i < MAX_PARTICLES; i++) {
      this.pool[i - 1] = this.pool[i];
    }
    this.pool[MAX_PARTICLES - 1] = oldest;
    return oldest;
  }

  public spawnNukePlume(
    x: number,
    y: number,
    radius: number,
    isEMP: boolean = false,
    isHydrogen: boolean = false,
  ): void {
    const now = performance.now();
    const count = isHydrogen ? 36 : isEMP ? 28 : 22;

    for (let i = 0; i < count; i++) {
      const p = this.allocParticle();

      const angle = Math.random() * Math.PI * 2;
      const speed = (0.5 + Math.random() * 1.5) * (radius * 0.4);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed - (isEMP ? 0 : 2.5); // thermal lift

      let r = 1.0, g = 0.6, b = 0.1, a = 0.9;
      let style = 0; // Fire/Smoke

      if (isEMP) {
        style = 1; // EMP electric spark
        r = 0.1;
        g = 0.85 + Math.random() * 0.15;
        b = 1.0;
        a = 0.95;
      } else if (Math.random() > 0.6) {
        // Dark smoke ember
        r = 0.25;
        g = 0.22;
        b = 0.2;
        a = 0.7;
      } else if (isHydrogen) {
        // Blinding thermonuclear core
        r = 1.0;
        g = 0.9;
        b = 0.7;
        a = 1.0;
      }

      const maxLifeMs = 900 + Math.random() * (isHydrogen ? 1400 : 900);
      const startSize = 2.0 + Math.random() * 3.0;
      const endSize = isEMP ? 0.5 : startSize * (2.5 + Math.random() * 2.0);

      p.x = x + (Math.random() - 0.5) * 2.0;
      p.y = y + (Math.random() - 0.5) * 2.0;
      p.vx = vx;
      p.vy = vy;
      p.startMs = now;
      p.maxLifeMs = maxLifeMs;
      p.r = r;
      p.g = g;
      p.b = b;
      p.a = a;
      p.startSize = startSize;
      p.endSize = endSize;
      p.style = style;
    }
  }

  public spawnWaterSpout(x: number, y: number, radius: number): void {
    const now = performance.now();
    const count = 30;

    for (let i = 0; i < count; i++) {
      const p = this.allocParticle();

      const angle = (Math.random() - 0.5) * Math.PI * 0.8 - Math.PI * 0.5; // Upward cone
      const speed = 4.0 + Math.random() * 12.0;
      const vx = Math.cos(angle) * speed * 0.6;
      const vy = Math.sin(angle) * speed;

      const maxLifeMs = 800 + Math.random() * 700;
      const startSize = 1.5 + Math.random() * 2.5;
      const endSize = startSize * 2.0;

      // Sea water foam droplets
      const r = 0.85 + Math.random() * 0.15;
      const g = 0.95 + Math.random() * 0.05;
      const b = 1.0;
      const a = 0.85;

      p.x = x + (Math.random() - 0.5) * (radius * 0.5);
      p.y = y + (Math.random() - 0.5) * 2.0;
      p.vx = vx;
      p.vy = vy;
      p.startMs = now;
      p.maxLifeMs = maxLifeMs;
      p.r = r;
      p.g = g;
      p.b = b;
      p.a = a;
      p.startSize = startSize;
      p.endSize = endSize;
      p.style = 2; // Water Splash
    }
  }

  public tick(): void {
    if (this.activeCount === 0) return;
    const now = performance.now();
    let writeIdx = 0;

    for (let i = 0; i < this.activeCount; i++) {
      const p = this.pool[i];
      const age = now - p.startMs;
      if (age < p.maxLifeMs) {
        if (writeIdx !== i) {
          const tmp = this.pool[writeIdx];
          this.pool[writeIdx] = p;
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

    // Populate instance buffer
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.pool[i];
      const off = i * FLOATS_PER_PARTICLE;
      const ageMs = now - p.startMs;

      this.instanceData[off] = p.x;
      this.instanceData[off + 1] = p.y;
      this.instanceData[off + 2] = p.vx;
      this.instanceData[off + 3] = p.vy;
      this.instanceData[off + 4] = ageMs;
      this.instanceData[off + 5] = p.maxLifeMs;
      this.instanceData[off + 6] = p.r;
      this.instanceData[off + 7] = p.g;
      this.instanceData[off + 8] = p.b;
      this.instanceData[off + 9] = p.a;
      this.instanceData[off + 10] = p.startSize;
      this.instanceData[off + 11] = p.endSize;
      this.instanceData[off + 12] = p.style;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      this.activeCount * FLOATS_PER_PARTICLE,
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
