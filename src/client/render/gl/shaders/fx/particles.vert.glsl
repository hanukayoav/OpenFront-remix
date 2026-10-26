#version 300 es
precision highp float;

// Unit quad [-0.5 .. 0.5]
layout(location = 0) in vec2 aCorner;

// Per-instance particle data
layout(location = 1) in vec2 aParticlePos;
layout(location = 2) in vec2 aVelocity;
layout(location = 3) in vec2 aLife; // x = ageMs, y = maxLifeMs
layout(location = 4) in vec4 aColor;
layout(location = 5) in vec2 aSize; // x = startSize, y = endSize
layout(location = 6) in float aStyle; // 0 = Fire/Smoke, 1 = Electric Spark, 2 = Water Splash

uniform mat3 uCamera;

out vec2 vUV;
out vec4 vColor;
flat out float vStyle;
out float vProgress;

void main() {
  float progress = clamp(aLife.x / max(aLife.y, 1.0), 0.0, 1.0);
  vProgress = progress;
  vStyle = aStyle;

  // Compute animated position with gravity or buoyancy
  float tSec = aLife.x / 1000.0;
  vec2 currentPos = aParticlePos + aVelocity * tSec;

  if (aStyle > 1.5) {
    // Water splash: upward spout then gravitational arc downward
    currentPos.y += 12.0 * tSec - 28.0 * tSec * tSec;
  } else if (aStyle < 0.5) {
    // Fire/Smoke: rising mushroom cloud thermal buoyancy
    currentPos.y -= 4.5 * tSec;
  }

  // Size interpolation
  float size = mix(aSize.x, aSize.y, progress);

  // Rotate sparks or tumble embers
  float angle = progress * 4.0;
  float s = sin(angle);
  float c = cos(angle);
  mat2 rot = mat2(c, -s, s, c);
  vec2 rotatedOffset = rot * (aCorner * size);

  vec2 worldPos = currentPos + rotatedOffset;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vUV = aCorner + vec2(0.5);

  // Alpha fade out near end of life
  float fade = 1.0 - smoothstep(0.7, 1.0, progress);
  vColor = vec4(aColor.rgb, aColor.a * fade);
}
