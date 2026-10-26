import { describe, expect, it } from "vitest";
import {
  TacticalOverlayMode,
  TacticalOverlayPass,
} from "../../../src/client/render/gl/passes/TacticalOverlayPass";
import { UT_CITY, UT_SAM_LAUNCHER, UT_WARSHIP } from "../../../src/client/render/types";

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
    createTexture: () => ({}),
    bindTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    texParameteri: () => {},
    activeTexture: () => {},
    useProgram: () => {},
    uniformMatrix3fv: () => {},
    uniform2f: () => {},
    uniform1i: () => {},
    uniform1f: () => {},
    uniform4fv: () => {},
    enable: () => {},
    blendFunc: () => {},
    drawArrays: () => {},
    deleteProgram: () => {},
    deleteVertexArray: () => {},
    deleteBuffer: () => {},
    deleteTexture: () => {},
    R8: 0x8229,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE2: 0x84c2,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
  };
}

describe("TacticalOverlayPass", () => {
  it("initializes densityBuffer without throwing and updates density from tile states", () => {
    const gl = createMockGL();
    const settings: any = {};
    const mapW = 32;
    const mapH = 32;
    const tileTex: any = {};
    const terrainTex: any = {};

    const pass = new TacticalOverlayPass(
      gl,
      mapW,
      mapH,
      tileTex,
      terrainTex,
      settings,
    );

    expect(pass.getMode()).toBe(TacticalOverlayMode.Off);

    const tileState = new Uint16Array(mapW * mapH);
    tileState[mapW * 5 + 5] = 1;
    tileState[mapW * 5 + 6] = 1;
    tileState[mapW * 6 + 5] = 1;
    tileState[mapW * 6 + 6] = 1;

    pass.updateDensityFromTiles(tileState, mapW, mapH);

    pass.setMode(TacticalOverlayMode.TroopDensity);
    expect(pass.getMode()).toBe(TacticalOverlayMode.TroopDensity);

    const cam = new Float32Array(9);
    pass.draw(cam);

    pass.dispose();
  });

  it("extracts SAMs, warships, and trade nodes from active units", () => {
    const gl = createMockGL();
    const settings: any = {};
    const mapW = 64;
    const mapH = 64;
    const tileTex: any = {};
    const terrainTex: any = {};

    const pass = new TacticalOverlayPass(
      gl,
      mapW,
      mapH,
      tileTex,
      terrainTex,
      settings,
    );

    pass.setLocalPlayer(1);
    pass.setAllies(new Set([2]));

    const units = new Map<number, any>();
    units.set(1, {
      id: 1,
      unitType: UT_SAM_LAUNCHER,
      ownerID: 1,
      pos: mapW * 10 + 10,
      isActive: true,
      level: 2,
    });
    units.set(2, {
      id: 2,
      unitType: UT_WARSHIP,
      ownerID: 3,
      pos: mapW * 20 + 20,
      isActive: true,
    });
    units.set(3, {
      id: 3,
      unitType: UT_CITY,
      ownerID: 2,
      pos: mapW * 30 + 30,
      isActive: true,
    });

    pass.updateStructuresAndUnits(units);

    pass.setMode(TacticalOverlayMode.SAMCoverage);
    const cam = new Float32Array(9);
    pass.draw(cam);

    pass.setMode(TacticalOverlayMode.NavalThreat);
    pass.draw(cam);

    pass.setMode(TacticalOverlayMode.TradeEfficiency);
    pass.draw(cam);

    pass.dispose();
  });
});
