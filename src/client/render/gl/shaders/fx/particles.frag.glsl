#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
flat in float vStyle;
in float vProgress;

out vec4 fragColor;

void main() {
  vec2 d = vUV - vec2(0.5);
  float dist = length(d);
  if (dist > 0.5) {
    discard;
  }

  float alpha = vColor.a;

  if (vStyle < 0.5) {
    // Fire / Smoke Mushroom Cloud Ember: hot bright core, smoky soft edge
    float core = 1.0 - smoothstep(0.0, 0.48, dist);
    float glow = exp(-dist * 5.0);
    vec3 col = mix(vColor.rgb, vec3(1.0, 1.0, 0.8), core * 0.7);
    fragColor = vec4(col, alpha * (core * 0.6 + glow * 0.4));
  } else if (vStyle < 1.5) {
    // Electric Spark / EMP: sharp diamond spark with bright center
    float spark = 1.0 - smoothstep(0.0, 0.4, dist);
    vec3 col = mix(vColor.rgb, vec3(1.0, 1.0, 1.0), spark * 0.9);
    fragColor = vec4(col, alpha * spark);
  } else {
    // Water Splash / Foam Droplet: crisp bubbly droplet with highlight
    float droplet = 1.0 - smoothstep(0.35, 0.5, dist);
    float highlight = 1.0 - smoothstep(0.0, 0.2, length(vUV - vec2(0.38, 0.38)));
    vec3 col = mix(vColor.rgb, vec3(1.0, 1.0, 1.0), highlight * 0.7);
    fragColor = vec4(col, alpha * droplet);
  }

  if (fragColor.a <= 0.002) {
    discard;
  }
}
