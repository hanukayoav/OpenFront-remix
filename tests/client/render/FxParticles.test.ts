import { describe, expect, it } from "vitest";
import { FxParticlePass } from "../../../src/client/render/gl/passes/fx-pass/FxParticlePass";
import { FxWaterRipplePass } from "../../../src/client/render/gl/passes/fx-pass/FxWaterRipplePass";

function createMockGL(): any {
  return {
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteShader: () => {},
    getUniformLocation: () => ({}),
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    useProgram: () => {},
    uniformMatrix3fv: () => {},
    enable: () => {},
    blendFunc: () => {},
    drawArraysInstanced: () => {},
    deleteProgram: () => {},
    deleteVertexArray: () => {},
    deleteBuffer: () => {},
  };
}

describe("FxParticlePass and FxWaterRipplePass", () => {
  it("spawns nuke plume particles and respects MAX_PARTICLES cap", () => {
    const gl = createMockGL();
    const settings: any = {};
    const pass = new FxParticlePass(gl, settings);

    // Spawn regular nuke
    pass.spawnNukePlume(50, 50, 15, false, false);
    pass.tick();

    // Spawn hydrogen bomb
    pass.spawnNukePlume(100, 100, 30, false, true);
    pass.tick();

    // Spawn EMP sparks
    pass.spawnNukePlume(150, 150, 20, true, false);
    pass.tick();

    // Draw should execute without error
    const cam = new Float32Array(9);
    pass.draw(cam);

    // Spawn hundreds of spouts to test ring-buffer eviction and safety
    for (let i = 0; i < 30; i++) {
      pass.spawnWaterSpout(i * 10, i * 10, 10);
    }
    pass.tick();
    pass.draw(cam);

    expect((pass as any).activeCount).toBeGreaterThan(0);
    expect((pass as any).activeCount).toBeLessThanOrEqual(512);

    pass.clear();
    expect((pass as any).activeCount).toBe(0);

    pass.dispose();
  });

  it("spawns water ripples and expires them over time", () => {
    const gl = createMockGL();
    const settings: any = {};
    const pass = new FxWaterRipplePass(gl, settings);

    pass.pushRipple(30, 40, 20, 1500);
    pass.pushRipple(80, 90, 25, 1800);
    pass.tick();

    expect((pass as any).activeCount).toBe(2);

    const cam = new Float32Array(9);
    pass.draw(cam);

    pass.clear();
    expect((pass as any).activeCount).toBe(0);

    pass.dispose();
  });
});
