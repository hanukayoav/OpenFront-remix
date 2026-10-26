#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uTileTex;
uniform sampler2D uDensityTex;
uniform usampler2D uTerrainTex;

uniform vec2 uMapSize;
uniform int uMode; // 1: TroopDensity, 2: SAMCoverage, 3: TradeEfficiency, 4: NavalThreat
uniform float uTime;
uniform int uLocalPlayerID;

// Tactical entities
#define MAX_SAMS 64
#define MAX_NAVAL 64
#define MAX_TRADE_NODES 64

uniform vec4 uSAMs[MAX_SAMS]; // x, y, radius, isHostile (1.0 = hostile, 0.0 = friendly/ally)
uniform int uSAMCount;

uniform vec4 uNavalThreats[MAX_NAVAL]; // x, y, range, isHostile
uniform int uNavalThreatCount;

uniform vec4 uTradeNodes[MAX_TRADE_NODES]; // x, y, type (0=City, 1=Factory, 2=Port, 3=Station), active
uniform int uTradeNodeCount;

in vec2 vWorldPos;
in vec2 vUV;

out vec4 fragColor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

vec4 sampleTroopDensity(ivec2 tc) {
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y)) {
    return vec4(0.0);
  }
  uint raw = texelFetch(uTileTex, tc, 0).r;
  uint owner = raw & uint(OWNER_MASK);
  if (owner == 0u) {
    return vec4(0.0);
  }

  float density = texture(uDensityTex, vUV).r;
  
  // Tactical military color ramp:
  // Low: soft cyan-teal -> Mid: amber gold -> High: fiery orange -> Extreme: electric red-white
  vec3 col;
  float alpha;
  if (density < 0.25) {
    float t = density / 0.25;
    col = mix(vec3(0.05, 0.65, 0.8), vec3(0.1, 0.9, 0.4), t);
    alpha = mix(0.15, 0.35, t);
  } else if (density < 0.6) {
    float t = (density - 0.25) / 0.35;
    col = mix(vec3(0.1, 0.9, 0.4), vec3(1.0, 0.75, 0.05), t);
    alpha = mix(0.35, 0.55, t);
  } else if (density < 0.85) {
    float t = (density - 0.6) / 0.25;
    col = mix(vec3(1.0, 0.75, 0.05), vec3(1.0, 0.2, 0.05), t);
    alpha = mix(0.55, 0.75, t);
  } else {
    float t = clamp((density - 0.85) / 0.15, 0.0, 1.0);
    col = mix(vec3(1.0, 0.2, 0.05), vec3(1.0, 0.95, 0.9), t);
    alpha = mix(0.75, 0.85, t);
  }

  // Subtle tactical grid scanlines
  float grid = sin(vWorldPos.x * 3.14159) * sin(vWorldPos.y * 3.14159);
  alpha *= (0.85 + 0.15 * smoothstep(0.0, 0.5, grid));

  return vec4(col, alpha);
}

vec4 sampleSAMCoverage() {
  vec3 friendlyCol = vec3(0.0, 0.9, 0.4);
  vec3 hostileCol = vec3(1.0, 0.15, 0.15);

  float friendlyCoverage = 0.0;
  float hostileCoverage = 0.0;
  float pulse = 0.5 + 0.5 * sin(uTime * 2.5);

  for (int i = 0; i < MAX_SAMS; i++) {
    if (i >= uSAMCount) break;
    vec4 sam = uSAMs[i];
    float dist = length(vWorldPos - sam.xy);
    float r = sam.z;
    if (dist <= r) {
      // Dome falloff from center to edge
      float normDist = dist / r;
      float dome = (1.0 - normDist * normDist * 0.7);
      
      // Animated border ring at the outer edge
      float ring = smoothstep(r - 1.2, r - 0.2, dist) * (1.0 - smoothstep(r - 0.2, r, dist));
      float coverageVal = dome * 0.25 + ring * 0.5 * (0.8 + 0.2 * pulse);

      if (sam.w > 0.5) {
        hostileCoverage = max(hostileCoverage, coverageVal);
      } else {
        friendlyCoverage = max(friendlyCoverage, coverageVal);
      }
    }
  }

  if (friendlyCoverage <= 0.001 && hostileCoverage <= 0.001) {
    return vec4(0.0);
  }

  vec3 outColor = vec3(0.0);
  float totalAlpha = 0.0;
  if (friendlyCoverage > 0.0) {
    outColor += friendlyCol * friendlyCoverage;
    totalAlpha += friendlyCoverage;
  }
  if (hostileCoverage > 0.0) {
    outColor += hostileCol * hostileCoverage;
    totalAlpha += hostileCoverage;
  }
  totalAlpha = clamp(totalAlpha, 0.0, 0.75);

  return vec4(outColor, totalAlpha);
}

vec4 sampleTradeEfficiency() {
  vec4 acc = vec4(0.0);
  float timeOffset = uTime * 3.0;

  // Render glowing trade routes between nearby industrial and city nodes
  for (int i = 0; i < MAX_TRADE_NODES; i++) {
    if (i >= uTradeNodeCount) break;
    vec4 nodeA = uTradeNodes[i];
    if (nodeA.w < 0.5) continue; // inactive

    // Node beacon glow
    float dNode = length(vWorldPos - nodeA.xy);
    if (dNode < 3.5) {
      float halo = (1.0 - dNode / 3.5);
      vec3 haloColor = nodeA.z > 1.5 ? vec3(0.1, 0.8, 1.0) : vec3(1.0, 0.8, 0.1);
      acc += vec4(haloColor * halo * 0.4, halo * 0.4);
    }

    for (int j = i + 1; j < MAX_TRADE_NODES; j++) {
      if (j >= uTradeNodeCount) break;
      vec4 nodeB = uTradeNodes[j];
      if (nodeB.w < 0.5) continue;

      vec2 ab = nodeB.xy - nodeA.xy;
      float len = length(ab);
      if (len > 35.0 || len < 1.0) continue; // max trade distance

      vec2 dir = ab / len;
      vec2 ap = vWorldPos - nodeA.xy;
      float proj = dot(ap, dir);

      if (proj >= 0.0 && proj <= len) {
        vec2 perp = ap - dir * proj;
        float distToLine = length(perp);

        if (distToLine < 1.4) {
          float lineGlow = (1.0 - distToLine / 1.4);
          
          // Flow pulses along the trade line
          float flow = 0.5 + 0.5 * sin(proj * 0.6 - timeOffset);
          vec3 routeCol = mix(vec3(0.1, 0.9, 0.9), vec3(1.0, 0.85, 0.2), flow);
          float lineAlpha = lineGlow * (0.25 + 0.35 * flow);

          acc += vec4(routeCol * lineAlpha, lineAlpha);
        }
      }
    }
  }

  acc.a = clamp(acc.a, 0.0, 0.8);
  return acc;
}

vec4 sampleNavalThreat() {
  // Check if current tile is water/ocean
  ivec2 tc = ivec2(floor(vWorldPos));
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y)) {
    return vec4(0.0);
  }
  uint terrainByte = texelFetch(uTerrainTex, tc, 0).r;
  bool isWater = (terrainByte & 128u) != 0u || terrainByte == 0u; // ocean bit or water tile
  if (!isWater) {
    return vec4(0.0);
  }

  float threatLevel = 0.0;
  float radarSweep = 0.0;

  for (int i = 0; i < MAX_NAVAL; i++) {
    if (i >= uNavalThreatCount) break;
    vec4 naval = uNavalThreats[i];
    float dist = length(vWorldPos - naval.xy);
    float range = naval.z;

    if (dist <= range) {
      float intensity = 1.0 - (dist / range);
      threatLevel = max(threatLevel, intensity);

      // Rotating radar beam effect
      float angle = atan(vWorldPos.y - naval.y, vWorldPos.x - naval.x);
      float sweep = 0.5 + 0.5 * sin(angle * 3.0 - uTime * 4.0);
      radarSweep = max(radarSweep, sweep * intensity);
    }
  }

  if (threatLevel <= 0.001) {
    return vec4(0.0);
  }

  // Deep indigo/magenta naval warning palette
  vec3 baseThreatColor = vec3(0.85, 0.1, 0.55);
  vec3 sweepColor = vec3(1.0, 0.4, 0.85);

  vec3 col = mix(baseThreatColor, sweepColor, radarSweep * 0.6);
  float alpha = clamp(threatLevel * 0.35 + radarSweep * 0.25, 0.0, 0.65);

  return vec4(col, alpha);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
  ivec2 tc = ivec2(floor(vWorldPos));

  if (uMode == 1) {
    fragColor = sampleTroopDensity(tc);
  } else if (uMode == 2) {
    fragColor = sampleSAMCoverage();
  } else if (uMode == 3) {
    fragColor = sampleTradeEfficiency();
  } else if (uMode == 4) {
    fragColor = sampleNavalThreat();
  } else {
    discard;
  }

  if (fragColor.a <= 0.001) {
    discard;
  }
}
