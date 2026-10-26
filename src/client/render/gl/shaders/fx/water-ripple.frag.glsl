#version 300 es
precision highp float;

in vec2 vLocalPos;
in float vAlpha;
in float vProgress;

out vec4 fragColor;

void main() {
  float dist = length(vLocalPos);
  if (dist > 1.0) {
    discard;
  }

  // Concentric wave crests
  float wave = sin(dist * 18.849 - vProgress * 6.283); // 3 waves
  float crest = smoothstep(0.4, 0.9, wave) * (1.0 - dist);

  // Outer foam edge
  float edge = smoothstep(0.85, 0.98, dist) * (1.0 - smoothstep(0.98, 1.0, dist));

  // Sea water ripple foam color: translucent cyan-white
  vec3 waterFoam = mix(vec3(0.5, 0.85, 0.95), vec3(0.9, 0.98, 1.0), edge);
  float alpha = (crest * 0.45 + edge * 0.7) * vAlpha;

  fragColor = vec4(waterFoam, alpha);

  if (fragColor.a <= 0.002) {
    discard;
  }
}
