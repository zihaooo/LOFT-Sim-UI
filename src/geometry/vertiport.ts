import * as THREE from "three";
import {
  VERTIPORT_CIRCLE_SEGMENTS,
  VERTIPORT_FILL_COLOR,
  VERTIPORT_LETTER,
  VERTIPORT_LETTER_FONT,
  VERTIPORT_OUTLINE_COLOR,
  VERTIPORT_OUTLINE_WIDTH_RATIO,
  VERTIPORT_RADIUS_METERS,
  VERTIPORT_TEXTURE_SIZE,
} from "../constant";

/**
 * Builds the flat disc geometry shared by every vertiport marker. A CircleGeometry is born in the XY
 * plane facing +Z; baking `rotateX(-π/2)` lays it on the ground (XZ plane, facing +Y) so the marker is
 * a true ground decal whose only remaining degree of freedom is a spin about the world up axis.
 *
 * UV note for the billboard: CircleGeometry maps the +Y rim to uv.y = 1, which (with the texture's
 * default flipY) samples the TOP of the marking canvas. After the bake, geometry +Y points to world
 * -Z, so at `rotation.y = 0` the letter's top faces -Z — the assumption the layer's billboard math relies on.
 */
export function createVertiportGeometry(): THREE.CircleGeometry {
  const geometry = new THREE.CircleGeometry(VERTIPORT_RADIUS_METERS, VERTIPORT_CIRCLE_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Paints the helipad marking — white fill, blue outline ring, centered blue "V" — onto a canvas and
 * returns it as a texture. The marking is drawn within the inscribed circle of the square canvas so it
 * aligns with the CircleGeometry's rim; the corners fall outside the disc and are never sampled.
 */
export function createVertiportTexture(): THREE.CanvasTexture {
  const size = VERTIPORT_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (context) {
    const center = size / 2;
    const outlineWidth = size * VERTIPORT_OUTLINE_WIDTH_RATIO;
    // Keep the whole ring inside the canvas so the stroke is not clipped at the edge.
    const outerRadius = center - outlineWidth / 2;

    context.fillStyle = VERTIPORT_FILL_COLOR;
    context.beginPath();
    context.arc(center, center, outerRadius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = VERTIPORT_OUTLINE_COLOR;
    context.lineWidth = outlineWidth;
    context.beginPath();
    context.arc(center, center, outerRadius, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = VERTIPORT_OUTLINE_COLOR;
    context.font = VERTIPORT_LETTER_FONT;
    context.textAlign = "center";
    // "middle"/"alphabetic" baselines center the font's em box, not the glyph: a capital "V" has no
    // descender, so the reserved descender space would push it visually high. Measure the actual glyph
    // box and offset the baseline so the glyph itself is centered in the disc.
    context.textBaseline = "alphabetic";
    const metrics = context.measureText(VERTIPORT_LETTER);
    const baselineY = center + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
    context.fillText(VERTIPORT_LETTER, center, baselineY);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
