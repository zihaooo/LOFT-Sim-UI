import profilesJson from "../../public/data/model/shadow_profiles.json";
import { BLOB_SHADOW_EDGE_BLUR, BLOB_SHADOW_QUAD_HALF_EXTENT, BLOB_SHADOW_UNION_SMOOTH } from "../constant";

/**
 * Per-type drone shadow profiles, precomputed by scripts/compute_shadow_params.py from the glTF model
 * geometry. Each type's silhouette is approximated by a few oriented rectangles (in the model's local
 * frame: +z forward, ±1 = the footprint half-span); the renderer unions them into a soft ground decal. The
 * numbers live in shadow_profiles.json (regenerate with the script) — here we only consume them.
 */
type ShadowRect = { cx: number; cz: number; a: number; b: number; angleDeg: number };
type ShadowProfile = { name: string; rects: ShadowRect[] };

const profiles = profilesJson as Record<string, ShadowProfile>;
const typeCodes = Object.keys(profiles).map(Number).sort((a, b) => a - b);

/** Vehicle type code → shadow-profile index (the branch order baked into the shader). */
export const SHADOW_PROFILE_INDEX_BY_TYPE: ReadonlyMap<number, number> = new Map(
  typeCodes.map((code, index) => [code, index]),
);

/** GLSL float literal — always carries a decimal point so it parses as a float, not an int. */
function glsl(value: number): string {
  return value.toFixed(5);
}

/**
 * Builds the GLSL that unions a drone type's rectangles into a soft shadow mask: a `shadowAlpha(vec2
 * quadCoord, float typeF)` returning [0,1], with every type's rect constants baked in (no uniforms). The
 * rects are merged with a smooth-min in signed-distance space (so joints round over instead of creasing),
 * then converted to alpha once. `quadCoord` is the unit-quad coordinate in [-0.5, 0.5]; it is scaled into
 * profile space here, so the profile's ±1 maps to the quad's configured half-extent.
 */
export function buildShadowAlphaGLSL(): string {
  const blur = glsl(BLOB_SHADOW_EDGE_BLUR); // soft-band half-width in profile units (1 = footprint half-span)
  const smooth = glsl(BLOB_SHADOW_UNION_SMOOTH); // smooth-union rounding radius in profile units
  const branches = typeCodes
    .map((code, index) => {
      const lines = profiles[String(code)].rects
        .map((e) => {
          const cos = glsl(Math.cos((e.angleDeg * Math.PI) / 180));
          const sin = glsl(Math.sin((e.angleDeg * Math.PI) / 180));
          return `d = smin(d, rectSDF(p, vec2(${glsl(e.cx)}, ${glsl(e.cz)}), vec2(${glsl(e.a)}, ${glsl(e.b)}), vec2(${cos}, ${sin})), ${smooth});`;
        })
        .join("\n      ");
      return `${index > 0 ? "else " : ""}if (t == ${index}) {\n      ${lines}\n    }`;
    })
    .join("\n    ");

  return `
  float rectSDF(vec2 p, vec2 c, vec2 ab, vec2 cs) {
    vec2 d = p - c;
    vec2 r = vec2(d.x * cs.x + d.y * cs.y, -d.x * cs.y + d.y * cs.x); // rotate into the rect's frame
    vec2 q = abs(r) - ab;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);           // 2D box SDF: <0 inside, 0 at edge, >0 out
  }
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);             // smooth union of two SDFs (rounds the joint)
    return mix(b, a, h) - k * h * (1.0 - h);
  }
  float shadowAlpha(vec2 quadCoord, float typeF) {
    vec2 p = quadCoord * ${glsl(2.0 * BLOB_SHADOW_QUAD_HALF_EXTENT)};
    int t = int(typeF + 0.5);
    float d = 1.0e4;                                                // +inf-ish: smin with the first rect yields that rect
    ${branches}
    return smoothstep(${blur}, -${blur}, d);                       // single soft edge over the merged silhouette
  }`;
}
