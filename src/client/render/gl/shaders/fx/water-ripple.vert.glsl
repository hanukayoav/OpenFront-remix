#version 300 es
precision highp float;

// Unit quad [-1.0 .. 1.0]
layout(location = 0) in vec2 aCorner;

// Per-instance ripple data
layout(location = 1) in vec2 aCenter;
layout(location = 2) in float aRadius;
layout(location = 3) in float aAlpha;
layout(location = 4) in float aProgress; // 0..1

uniform mat3 uCamera;

out vec2 vLocalPos;
out float vAlpha;
out float vProgress;

void main() {
  vLocalPos = aCorner;
  vAlpha = aAlpha;
  vProgress = aProgress;

  vec2 worldPos = aCenter + aCorner * aRadius;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
