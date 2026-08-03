import * as THREE from "three";
import {
  GROUND_ICON_ANISOTROPY,
  GROUND_ICON_ASSETS,
  GROUND_ICON_CIRCLE_SEGMENTS,
  GROUND_ICON_TEXTURE_SIZE,
} from "../constant";

/** Asset key of a ground-icon SVG; see GROUND_ICON_ASSETS. */
export type GroundIconKey = keyof typeof GROUND_ICON_ASSETS;

/** Rasterized icon markings, keyed by asset. */
export type GroundIconTextures = Map<GroundIconKey, THREE.CanvasTexture>;

/**
 * Rasterizes the requested icon SVGs into marker textures, once, at startup. An icon is a declarative
 * asset rather than drawing code: the browser's SVG renderer paints it into a canvas, and the result is
 * uploaded as an ordinary CanvasTexture — so mipmapping, filtering and anisotropy behave exactly as they
 * would for any bitmap. Adding an icon is an entry in GROUND_ICON_ASSETS plus a key at the call site.
 *
 * Only the requested keys are loaded, so an authored-but-unplaced icon costs no texture memory. A missing
 * asset is a deployment error rather than a degraded mode, so this rejects and the caller's loading
 * overlay reports it.
 *
 * Ownership: these textures outlive any single FleetScene and are deliberately never disposed. Scene
 * teardown disposes geometries and materials only (Material.dispose() does not touch textures), so a
 * rebuilt scene re-creates its icon materials around these same shared textures.
 */
export async function loadGroundIconTextures(keys: readonly GroundIconKey[]): Promise<GroundIconTextures> {
  const entries = await Promise.all(
    keys.map(async (key) => [key, await loadGroundIconTexture(GROUND_ICON_ASSETS[key])] as const),
  );
  return new Map(entries);
}

/**
 * Builds the flat disc shared by every marker of one icon type. A CircleGeometry is born in the XY plane
 * facing +Z; baking `rotateX(-π/2)` lays it on the ground (XZ plane, facing +Y) so the marker is a true
 * ground decal whose only remaining degree of freedom is a spin about the world up axis.
 *
 * The disc is the artwork's silhouette, so the mesh never samples a transparent texel and the material can
 * stay fully opaque — no alpha test, no alpha-to-coverage — which keeps the marker in the opaque pass with
 * an MSAA-antialiased rim (see the layer's material notes). Every icon asset must therefore be a circular
 * badge that fills its viewBox: a badge inset inside its box leaves a ring of transparent (and so black)
 * texels inside the disc.
 *
 * UV note for the billboard: CircleGeometry maps the +Y rim to uv.y = 1, which (with the texture's default
 * flipY) samples the TOP of the artwork. After the bake, geometry +Y points to world -Z, so at
 * `rotation.y = 0` the artwork's top faces -Z — the assumption the layer's billboard math relies on.
 */
export function createGroundIconGeometry(sizeMeters: number): THREE.CircleGeometry {
  const geometry = new THREE.CircleGeometry(sizeMeters / 2, GROUND_ICON_CIRCLE_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Fetches one SVG asset and rasterizes it into a texture at GROUND_ICON_TEXTURE_SIZE. */
async function loadGroundIconTexture(url: string): Promise<THREE.CanvasTexture> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ground icon ${url}: ${response.status}`);
  }

  const size = GROUND_ICON_TEXTURE_SIZE;
  const markup = sizeSvgMarkup(await response.text(), size);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Ground icon rasterization requires a 2D canvas context.");
  }
  context.drawImage(image, 0, 0, size, size);

  // CanvasTexture's inherited defaults already give a full mipmap chain (minFilter LinearMipmapLinear,
  // generateMipmaps true); that chain, plus anisotropy, is what keeps a fine-lined icon stable rather
  // than crawling once the camera pulls back and the marker shrinks to a few dozen pixels.
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = GROUND_ICON_ANISOTROPY;
  return texture;
}

/**
 * Stamps the raster size onto the <svg> root. An <img> rasterizes an SVG at its *declared* width/height, so
 * the assets' authored `width="32" height="32"` would bake a 32px bitmap for drawImage to upscale into a
 * blur. The viewBox is left alone and does the scaling. Stripping first keeps the attributes from appearing
 * twice; the leading `\s` means compound names such as `stroke-width` are not matched.
 */
function sizeSvgMarkup(markup: string, size: number): string {
  return markup.replace(/<svg\b[^>]*>/, (openTag) =>
    openTag
      .replace(/\s(?:width|height)="[^"]*"/g, "")
      .replace("<svg", `<svg width="${size}" height="${size}"`),
  );
}
