#!/usr/bin/env node
/**
 * Generate human-friendly HTML docs from docs/*.md, written alongside them as docs/*.html
 * (the markdown sources are tracked; the generated HTML is gitignored, local-only).
 *
 *   npm run docs
 *
 * Enrichment applied while converting:
 *  - Code spans naming repo files/dirs link to GitHub (origin) blobs pinned to the current HEAD SHA.
 *  - Code spans naming a symbol (function/class/const/method…) resolve through a TypeScript-AST
 *    declaration index over src/ and link to the exact declaration line. Ambiguous names stay plain.
 *  - Known 3D/graphics/web jargon gets a dotted underline, a pure-CSS hover definition, and a
 *    click-through to Wikipedia / three.js docs / MDN. First occurrence per h2/h3 section only.
 *  - `CONTEXT.md` / `RENDER.md` cross-references become local page links.
 *
 * Drift guards (warnings, non-fatal): referenced paths that no longer exist or are gitignored,
 * and a HEAD that isn't pushed to origin yet (blob links would 404 until pushed).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import ts from "typescript";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
// Markdown sources and generated HTML share this directory; only the HTML is gitignored.
const DOCS_DIR = path.join(ROOT, "docs");
const REPO_URL = "https://github.com/michigan-traffic-lab/LOFT-Sim-UI";

const warnings = [];
const warn = (msg) => warnings.push(msg);

// ---------------------------------------------------------------------------
// Git facts: pinned SHA for blob links, tracked-file set (never link a 404).
// ---------------------------------------------------------------------------
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const HEAD_SHA = git("rev-parse", "HEAD");
const SHA_SHORT = HEAD_SHA.slice(0, 7);
if (!git("branch", "-r", "--contains", HEAD_SHA)) {
  warn(`HEAD ${SHA_SHORT} is not on any remote branch — GitHub links will 404 until you push.`);
}
const trackedFiles = new Set(git("ls-files").split("\n").filter(Boolean));
const basenameIndex = new Map(); // basename -> [tracked paths]
for (const f of trackedFiles) {
  const b = path.basename(f);
  if (!basenameIndex.has(b)) basenameIndex.set(b, []);
  basenameIndex.get(b).push(f);
}
const blobUrl = (file, line) => `${REPO_URL}/blob/${HEAD_SHA}/${file}${line ? `#L${line}` : ""}`;
const treeUrl = (dir) => `${REPO_URL}/tree/${HEAD_SHA}/${dir}`;
/** Docs often write paths relative to a directory named in prose (`scene/cameraRig.ts` for
 *  `src/scene/cameraRig.ts`). Resolve those against tracked files by unique path suffix. */
const uniqueTrackedSuffix = (rel) => {
  const hits = [...trackedFiles].filter((f) => f === rel || f.endsWith("/" + rel));
  return hits.length === 1 ? hits[0] : null;
};
// Disk index (untracked files included) — only for classifying warnings accurately.
const diskFiles = [];
(function walkDisk(dir) {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name.startsWith(".") || ["node_modules", "dist", "docs"].includes(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walkDisk(rel);
    else diskFiles.push(rel);
  }
})("");
const onDisk = (rel) => diskFiles.some((f) => f === rel || f.endsWith("/" + rel));

// ---------------------------------------------------------------------------
// Symbol index: TypeScript AST over tracked src/**/*.ts. name -> [{file, line}]
// Only names with exactly one declaration are linkable.
// ---------------------------------------------------------------------------
const symbolIndex = new Map();
function recordSymbol(name, file, sf, nameNode) {
  const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
  if (!symbolIndex.has(name)) symbolIndex.set(name, []);
  symbolIndex.get(name).push({ file, line });
}
function indexSourceFile(file) {
  const sf = ts.createSourceFile(file, readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const named = (n) => n.name && ts.isIdentifier(n.name) && recordSymbol(n.name.text, file, sf, n.name);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      named(node);
    } else if (ts.isVariableStatement(node) && node.parent === sf) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) recordSymbol(d.name.text, file, sf, d.name);
    } else if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node) ||
                ts.isMethodSignature(node) || ts.isPropertySignature(node)) && node.name && ts.isIdentifier(node.name)) {
      recordSymbol(node.name.text, file, sf, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const f of trackedFiles) if (f.startsWith("src/") && f.endsWith(".ts")) indexSourceFile(f);
const uniqueSymbol = (name) => {
  const hits = symbolIndex.get(name);
  return hits && hits.length === 1 ? hits[0] : null;
};

// ---------------------------------------------------------------------------
// Curated link map for library API names appearing in code spans.
// ---------------------------------------------------------------------------
const T = "https://threejs.org/docs/#api/en/";
const TE = "https://threejs.org/docs/#examples/en/";
const TSRC = "https://github.com/mrdoob/three.js/blob/master/examples/jsm/";
const CODE_LINKS = {
  WebGLRenderer: `${T}renderers/WebGLRenderer`,
  InstancedMesh: `${T}objects/InstancedMesh`,
  setMatrixAt: `${T}objects/InstancedMesh.setMatrixAt`,
  setColorAt: `${T}objects/InstancedMesh.setColorAt`,
  instanceMatrix: `${T}objects/InstancedMesh.instanceMatrix`,
  instanceColor: `${T}objects/InstancedMesh.instanceColor`,
  LineSegments: `${T}objects/LineSegments`,
  Mesh: `${T}objects/Mesh`,
  Object3D: `${T}core/Object3D`,
  frustumCulled: `${T}core/Object3D.frustumCulled`,
  castShadow: `${T}core/Object3D.castShadow`,
  receiveShadow: `${T}core/Object3D.receiveShadow`,
  renderOrder: `${T}core/Object3D.renderOrder`,
  MeshBasicMaterial: `${T}materials/MeshBasicMaterial`,
  MeshStandardMaterial: `${T}materials/MeshStandardMaterial`,
  ShaderMaterial: `${T}materials/ShaderMaterial`,
  LineMaterial: `${TSRC}lines/LineMaterial.js`,
  LineSegments2: `${TSRC}lines/LineSegments2.js`,
  LineSegmentsGeometry: `${TSRC}lines/LineSegmentsGeometry.js`,
  OrbitControls: `${TE}controls/OrbitControls`,
  EffectComposer: `${TE}postprocessing/EffectComposer`,
  mergeGeometries: `${TE}utils/BufferGeometryUtils`,
  HemisphereLight: `${T}lights/HemisphereLight`,
  DirectionalLight: `${T}lights/DirectionalLight`,
  SphereGeometry: `${T}geometries/SphereGeometry`,
  PlaneGeometry: `${T}geometries/PlaneGeometry`,
  CircleGeometry: `${T}geometries/CircleGeometry`,
  ConeGeometry: `${T}geometries/ConeGeometry`,
  ExtrudeGeometry: `${T}geometries/ExtrudeGeometry`,
  Plane: `${T}math/Plane`,
  Vector3: `${T}math/Vector3`,
  Matrix4: `${T}math/Matrix4`,
  Quaternion: `${T}math/Quaternion`,
  Color: `${T}math/Color`,
  Raycaster: `${T}core/Raycaster`,
  onBeforeCompile: `${T}materials/Material.onBeforeCompile`,
  depthWrite: `${T}materials/Material.depthWrite`,
  depthFunc: `${T}materials/Material.depthFunc`,
  polygonOffset: `${T}materials/Material.polygonOffset`,
  vertexColors: `${T}materials/Material.vertexColors`,
  transparent: `${T}materials/Material.transparent`,
  BackSide: `${T}constants/Materials`,
  DoubleSide: `${T}constants/Materials`,
  AlwaysDepth: `${T}constants/Materials`,
  DynamicDrawUsage: `${T}constants/BufferAttributeUsage`,
  localClippingEnabled: `${T}renderers/WebGLRenderer.localClippingEnabled`,
  clippingPlanes: `${T}renderers/WebGLRenderer.clippingPlanes`,
  shadowMap: `${T}renderers/WebGLRenderer.shadowMap`,
  requestAnimationFrame: "https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame",
  Manifold: "https://manifoldcad.org/docs/jsapi/",
  Tweakpane: "https://tweakpane.github.io/docs/",
};
// npm package names in code spans -> their homes
const PKG_LINKS = {
  "manifold-3d": "https://github.com/elalish/manifold",
  "stats.js": "https://github.com/mrdoob/stats.js",
  tweakpane: "https://tweakpane.github.io/docs/",
  "tweakpane-plugin-file-import": "https://github.com/LuchoTurtle/tweakpane-plugin-file-import",
  three: "https://threejs.org/docs/",
};

// ---------------------------------------------------------------------------
// Glossary: 3D/render/web jargon in prose. Dotted underline + hover definition
// + click-through. Matched case-sensitively via regex, first hit per section.
// ---------------------------------------------------------------------------
const W = "https://en.wikipedia.org/wiki/";
const MDN = "https://developer.mozilla.org/en-US/docs/";
const TERM_DEFS = [
  ["CSG", /\bCSG\b/, "Constructive Solid Geometry — building complex solids by boolean union/intersection/subtraction of simpler shapes.", `${W}Constructive_solid_geometry`],
  ["BVH", /\bBVH\b/, "Bounding Volume Hierarchy — a tree of nested bounding boxes that makes spatial queries (raycasts, mesh booleans) fast.", `${W}Bounding_volume_hierarchy`],
  ["SDF", /\bSDF\b|\bsigned[- ]distance\b/, "Signed Distance Function — for any point, the distance to a shape's surface (negative inside); lets shapes be combined per-pixel with math instead of geometry.", `${W}Signed_distance_function`],
  ["smooth-min", /\bsmooth-min\b|\bsmin\b/, "Polynomial smooth minimum — blends two distance fields so their union gets a rounded fillet instead of a hard crease.", "https://iquilezles.org/articles/smin/"],
  ["frustum", /\bfrustum\b/, "The camera's (or light's) pyramid-shaped viewing volume; geometry outside it can be skipped entirely.", `${W}Viewing_frustum`],
  ["MSAA", /\bMSAA\b/, "Multisample Anti-Aliasing — hardware AA that samples coverage several times per pixel along triangle edges.", `${W}Multisample_anti-aliasing`],
  ["FXAA", /\bFXAA\b/, "Fast Approximate Anti-Aliasing — a cheap post-process pass that smooths edges in the finished image.", `${W}Fast_approximate_anti-aliasing`],
  ["LOD", /\bLOD\b/, "Level of Detail — swapping in cheaper geometry as an object gets farther away or smaller on screen.", `${W}Level_of_detail_(computer_graphics)`],
  ["PCF", /\bPCF\b/, "Percentage-Closer Filtering — averaging several shadow-map samples to soften shadow edges.", `${W}Shadow_mapping`],
  ["shadow map", /\bshadow[- ]map(?:s|ping)?\b/, "A depth image rendered from the light's viewpoint; a pixel is in shadow if something sits closer to the light in that image.", `${W}Shadow_mapping`],
  ["z-fight", /\bz-fight(?:s|ing)?\b/, "Flicker between two coplanar surfaces when the depth buffer can't decide which is in front.", `${W}Z-fighting`],
  ["depth test", /\bdepth (?:test|buffer)\b/, "Per-pixel comparison against the depth buffer that decides whether a new fragment is in front of what's already drawn.", `${W}Z-buffering`],
  ["union-find", /\bunion-find\b/, "Disjoint-set data structure — near-O(1) grouping of items into connected components.", `${W}Disjoint-set_data_structure`],
  ["Sutherland-Hodgman", /\bSutherland-Hodgman(?:-clipped)?\b/, "Classic algorithm that clips a polygon against each edge of a convex boundary in turn.", `${W}Sutherland%E2%80%93Hodgman_algorithm`],
  ["parallel transport", /\bparallel[- ]transport(?:ed)?\b/, "Sliding an orientation frame along a curve without introducing twist — gives stable tube cross-sections.", `${W}Parallel_transport`],
  ["miter", /\bmiter(?:s|ed)?\b/, "Joining two segments on their shared angle-bisector plane, like a picture-frame corner — no gap, no bevel band.", `${W}Miter_joint`],
  ["quaternion", /\bquaternions?\b/, "A 4-component rotation representation that interpolates smoothly and avoids gimbal lock.", `${W}Quaternions_and_spatial_rotation`],
  ["orthographic", /\borthographic\b/, "Projection with parallel rays and no perspective — distant objects stay the same size; used for sun/shadow cameras.", `${W}Orthographic_projection`],
  ["NDC", /\bNDC\b/, "Normalized Device Coordinates — the post-projection −1…+1 coordinate cube the GPU clips against.", "https://learnopengl.com/Getting-started/Coordinate-Systems"],
  ["VBO", /\bVBOs?\b/, "Vertex Buffer Object — a GPU-resident buffer holding vertex data so it isn't re-sent every frame.", `${W}Vertex_buffer_object`],
  ["IBO", /\bIBOs?\b/, "Index Buffer Object — a GPU buffer of vertex indices describing which vertices form each triangle.", `${W}Vertex_buffer_object`],
  ["FBO", /\bFBOs?\b/, "Framebuffer Object — an off-screen render target (e.g. the shadow map) that later passes read as a texture.", `${W}Framebuffer_object`],
  ["draw call", /\bdraw calls?\b/, "One CPU→GPU command drawing a batch of triangles; per-call overhead makes 'few big draws' the core batching goal.", `${W}Glossary_of_computer_graphics#draw_call`],
  ["billboard", /\bbillboards?(?:ing)?\b/, "A flat quad kept oriented toward (or aligned with) the camera so it always reads correctly.", `${W}2.5D#Billboarding`],
  ["decal", /\bdecals?\b/, "Flat geometry or texture projected onto a surface like a sticker — here, the drones' ground shadows.", `${W}Decal`],
  ["instancing", /\binstanc(?:ed|ing)\b/, "Geometry instancing — drawing many copies of one mesh in a single draw call, with a per-copy transform/color.", `${W}Geometry_instancing`],
  ["raycast", /\brayca(?:st(?:s|ing)?)\b/, "Shooting a ray through the scene to find what it hits — e.g. what's under the mouse click.", `${W}Ray_casting`],
  ["GLSL", /\bGLSL\b/, "OpenGL Shading Language — the C-like language shaders are written in.", `${W}OpenGL_Shading_Language`],
  ["fragment shader", /\bfragment (?:shader|ALU)\b/, "The GPU program run once per covered pixel to compute its color.", `${W}Shader#Pixel_shaders`],
  ["vertex shader", /\bvertex shader\b/, "The GPU program run once per vertex to compute its screen position.", `${W}Shader#Vertex_shaders`],
  ["glTF", /\bgl[tT][fF]\b/, "Khronos' JSON+binary 3D asset format — 'the JPEG of 3D'.", "https://www.khronos.org/gltf/"],
  ["OSM", /\bOSM\b/, "OpenStreetMap XML — map data as nodes, ways, and relations with free-form tags.", "https://wiki.openstreetmap.org/wiki/OSM_XML"],
  ["UAV", /\bUAVs?\b/, "Unmanned Aerial Vehicle — a drone.", `${W}Unmanned_aerial_vehicle`],
  ["UAM", /\bUAM\b/, "Urban Air Mobility — passenger/cargo aviation over cities, typically electric VTOL aircraft.", `${W}Urban_air_mobility`],
  ["vertiport", /\bvertiports?\b/, "A take-off/landing site for VTOL aircraft — the heliport of urban air mobility.", `${W}Vertiport`],
  ["contingency landing site", /\bcontingency (?:landing )?sites?\b/, "A pre-surveyed spot a UAV can divert to and land at when it cannot continue to its destination.", `${W}Emergency_landing`],
  ["flat-earth projection", /\bflat-earth projection\b/, "Treating a city-sized patch of the globe as a flat plane — accurate enough at this scale, and far simpler than geodesy.", `${W}Local_tangent_plane_coordinates`],
  ["texel", /\btexels?\b/, "One pixel of a texture — here, one cell of the shadow map.", `${W}Texel_(graphics)`],
  ["CSM", /\bCSM\b|\bcascade(?:s|d)?\b/, "Cascaded Shadow Maps — several shadow maps covering increasing distance bands, so near shadows get more resolution.", "https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps"],
  ["watertight", /\bwatertight\b/, "A closed mesh with no holes — every edge shared by exactly two faces — so inside/outside is well-defined (required for CSG).", `${W}Polygon_mesh`],
  ["little-endian", /\blittle-endian\b/, "Multi-byte numbers stored least-significant byte first.", `${W}Endianness`],
  ["HSL", /\bHSL\b/, "Hue/Saturation/Lightness color model — convenient for generating natural color variation.", `${W}HSL_and_HSV`],
  ["ease-in-out cubic", /\bease-in-out(?: cubic)?\b/, "An easing curve that starts slow, speeds up, and settles slowly — the classic smooth animation timing.", "https://easings.net/#easeInOutCubic"],
  ["rAF", /\brAF\b/, "requestAnimationFrame — the browser callback fired once per display refresh, the heartbeat of the render loop.", `${MDN}Web/API/Window/requestAnimationFrame`],
  ["websocket", /\b[wW]ebsockets?\b/, "A persistent two-way browser↔server connection — how live telemetry streams in.", `${MDN}Web/API/WebSockets_API`],
  ["ETag", /\bETags?\b/, "An HTTP response fingerprint the browser uses to revalidate its cache without re-downloading.", `${MDN}Web/HTTP/Headers/ETag`],
  ["GC", /\bGC\b|\bgarbage collect(?:ion|or)\b/, "Garbage collection — automatic memory reclamation; its pauses show up as frame-time spikes.", `${MDN}Web/JavaScript/Memory_management`],
  ["PCIe", /\bPCIe\b/, "The bus between CPU and GPU — every buffer upload crosses it, which is why partial uploads matter.", `${W}PCI_Express`],
  ["triangle fan", /\btriangle-fan\b/, "Triangles sharing one center vertex — the cheap way to cap a tube's circular end.", `${W}Triangle_fan`],
  ["bounding sphere", /\bbounding spheres?\b/, "A sphere enclosing an object, used for cheap 'could this possibly intersect?' tests before precise ones.", `${W}Bounding_sphere`],
  ["vsync", /\bvsync\b/, "Synchronizing frame presentation to the display's refresh so frames pace evenly and never tear.", `${W}Screen_tearing#Vertical_synchronization`],
  ["antialiasing", /\b[aA]ntialias(?:ing)?\b/, "Smoothing the stair-step look of edges, either while rasterizing (MSAA) or as a post-process (FXAA).", `${W}Spatial_anti-aliasing`],
  ["DTO", /\bDTOs?\b/, "Data Transfer Object — a plain data shape that mirrors the wire protocol, kept separate from domain types.", `${W}Data_transfer_object`],
  ["HUD", /\bHUD\b/, "Heads-Up Display — the always-visible stats overlay drawn on top of the scene.", `${W}Head-up_display`],
];

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const DOC_PAGES = { "CONTEXT.md": "context.html", "RENDER.md": "render.html" };

function codeLinkHtml(href, codeText, { external = true } = {}) {
  const attrs = external ? ' target="_blank" rel="noopener"' : "";
  return `<a class="src" href="${href}"${attrs}><code>${escapeHtml(codeText)}</code></a>`;
}

/** Resolve one code span to enriched HTML, or null to leave it plain. */
function resolveCodeSpan(rawText, docName, seen) {
  const text = rawText.trim();
  const seenKey = `code:${text}`;
  if (seen.has(seenKey)) return null;
  const emit = (html) => { seen.add(seenKey); return html; };

  if (DOC_PAGES[text]) return emit(codeLinkHtml(DOC_PAGES[text], text, { external: false }));

  // --- repo paths ---
  const norm = text.replace(/^\.\//, "");
  if (/^[\w@.-]+(\/[\w@.-]+)*\/?$/.test(norm) && norm.includes("/")) {
    const clean = norm.replace(/\/$/, "");
    if (trackedFiles.has(clean)) return emit(codeLinkHtml(blobUrl(clean), text));
    const isTrackedDir = [...trackedFiles].some((f) => f.startsWith(clean + "/"));
    if (isTrackedDir) return emit(codeLinkHtml(treeUrl(clean), text));
    const suffixHit = uniqueTrackedSuffix(clean);
    if (suffixHit) return emit(codeLinkHtml(blobUrl(suffixHit), text));
    if (existsSync(path.join(ROOT, clean)) || onDisk(clean)) {
      warn(`${docName}: \`${text}\` exists locally but is gitignored — left unlinked.`);
    } else {
      warn(`${docName}: \`${text}\` — path not found (doc drift?), left unlinked.`);
    }
    return null;
  }
  // --- bare filenames (unique basename among tracked files) ---
  if (/^[\w@-][\w@.-]*\.[a-z0-9]+$/i.test(norm) && !norm.includes("/")) {
    if (PKG_LINKS[norm]) return emit(codeLinkHtml(PKG_LINKS[norm], text));
    const hits = basenameIndex.get(norm);
    if (hits?.length === 1) return emit(codeLinkHtml(blobUrl(hits[0]), text));
    if (!hits && /\.(ts|mjs|js|py|json|gltf|osm|md|html|css)$/.test(norm)) {
      if (onDisk(norm)) {
        warn(`${docName}: \`${text}\` exists locally but is gitignored — left unlinked.`);
      } else {
        warn(`${docName}: \`${text}\` — no such file anywhere (doc drift?), left unlinked.`);
      }
    }
    return null; // ambiguous or unknown basename
  }
  // --- packages / library API / project symbols ---
  if (PKG_LINKS[text]) return emit(codeLinkHtml(PKG_LINKS[text], text));
  const name = text.replace(/^THREE\./, "");
  const lead = /^[A-Za-z_$][\w$]*/.exec(name)?.[0];
  for (const candidate of [name, lead].filter(Boolean)) {
    if (CODE_LINKS[candidate]) return emit(codeLinkHtml(CODE_LINKS[candidate], text));
    const sym = uniqueSymbol(candidate);
    if (sym) return emit(codeLinkHtml(blobUrl(sym.file, sym.line), text));
  }
  return null;
}

/** Wrap glossary terms in a raw text string; returns escaped HTML. */
function linkTerms(raw, seen) {
  const candidates = [];
  for (const [key, re, def, url] of TERM_DEFS) {
    if (seen.has(`term:${key}`)) continue;
    const m = re.exec(raw);
    if (m) candidates.push({ start: m.index, end: m.index + m[0].length, text: m[0], key, def, url });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start >= cursor) { chosen.push(c); cursor = c.end; }
  }
  let out = "";
  cursor = 0;
  for (const c of chosen) {
    seen.add(`term:${c.key}`);
    out += escapeHtml(raw.slice(cursor, c.start));
    out += `<a class="term" href="${c.url}" target="_blank" rel="noopener" data-def="${escapeHtml(c.def)}">${escapeHtml(c.text)}</a>`;
    cursor = c.end;
  }
  out += escapeHtml(raw.slice(cursor));
  return out;
}

// ---------------------------------------------------------------------------
// Token-tree transformation (marked lexer -> enriched tokens -> parser)
// ---------------------------------------------------------------------------
function slugify(text, taken) {
  let slug = text.toLowerCase().replace(/`/g, "").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-");
  let unique = slug, i = 1;
  while (taken.has(unique)) unique = `${slug}-${i++}`;
  taken.add(unique);
  return unique;
}

function walkInline(tokens, ctx, opts = {}) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "codespan" && !opts.inLink) {
      const html = resolveCodeSpan(tok.text, ctx.docName, ctx.seen);
      if (html) tokens[i] = { type: "html", raw: tok.raw, text: html, block: false };
    } else if (tok.type === "text" && !tok.tokens && !opts.inLink && !opts.inHeading) {
      const html = linkTerms(tok.text, ctx.seen);
      if (html) tokens[i] = { type: "html", raw: tok.raw, text: html, block: false };
    } else if (tok.tokens) {
      walkInline(tok.tokens, ctx, { ...opts, inLink: opts.inLink || tok.type === "link" });
    }
  }
}

function walkBlocks(tokens, ctx) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case "heading": {
        if (tok.depth <= 3) ctx.seen.clear(); // new section: terms/symbols may link again
        walkInline(tok.tokens, ctx, { inHeading: true });
        const plain = tok.text.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
        const id = slugify(tok.text, ctx.slugs);
        if (tok.depth === 1) ctx.title = plain;
        else ctx.headings.push({ depth: tok.depth, text: plain, id });
        const rendered = marked.parser([tok]).replace(/^<h(\d)>/, `<h$1 id="${id}">`);
        tokens[i] = { type: "html", raw: tok.raw, text: rendered, block: true };
        break;
      }
      case "table": {
        for (const cell of tok.header) walkInline(cell.tokens, ctx);
        for (const row of tok.rows) for (const cell of row) walkInline(cell.tokens, ctx);
        tokens[i] = { type: "html", raw: tok.raw, text: `<div class="table-wrap">${marked.parser([tok])}</div>`, block: true };
        break;
      }
      case "paragraph":
        walkInline(tok.tokens, ctx);
        break;
      case "list":
        for (const item of tok.items) walkBlocks(item.tokens, ctx);
        break;
      case "blockquote":
        walkBlocks(tok.tokens, ctx);
        break;
      case "text": // loose list-item content
        if (tok.tokens) walkInline(tok.tokens, ctx);
        break;
      default:
        break; // code fences, hr, space: untouched
    }
  }
}

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------
const CSS = `
:root {
  --bg: #ffffff; --fg: #1c2128; --muted: #57606a; --border: #d8dee4;
  --accent: #0969da; --code-bg: #f0f2f5; --sidebar-bg: #f7f8fa;
  --tooltip-bg: #1c2128; --tooltip-fg: #f0f2f5; --mark: #b08800;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --fg: #d5dce3; --muted: #8b949e; --border: #2d333b;
    --accent: #539bf5; --code-bg: #1c2128; --sidebar-bg: #12161c;
    --tooltip-bg: #2d333b; --tooltip-fg: #e6edf3; --mark: #d4a72c;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 1.5rem; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: grid; grid-template-columns: 300px minmax(0, 1fr);
}
aside {
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  background: var(--sidebar-bg); border-right: 1px solid var(--border);
  padding: 1.25rem 1rem 2rem; font-size: 0.86rem;
}
aside .site { font-weight: 700; font-size: 0.95rem; margin-bottom: 0.75rem; }
aside .site a { color: var(--fg); text-decoration: none; }
aside nav.docs { display: flex; flex-direction: column; gap: 2px; margin-bottom: 1.25rem; }
aside nav.docs a {
  color: var(--muted); text-decoration: none; padding: 4px 8px; border-radius: 6px;
}
aside nav.docs a:hover { color: var(--fg); background: var(--code-bg); }
aside nav.docs a.current { color: var(--accent); font-weight: 600; background: var(--code-bg); }
aside .toc-title { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.7rem; color: var(--muted); margin: 0 0 0.4rem 8px; }
aside nav.toc { display: flex; flex-direction: column; gap: 1px; }
aside nav.toc a {
  color: var(--muted); text-decoration: none; padding: 3px 8px; border-radius: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
aside nav.toc a.d3 { padding-left: 22px; }
aside nav.toc a.d4 { padding-left: 36px; font-size: 0.8rem; }
aside nav.toc a:hover { color: var(--fg); }
aside nav.toc a.active { color: var(--accent); font-weight: 600; }
main { padding: 2.25rem 3rem 5rem; max-width: 54rem; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.4rem; }
h2 { font-size: 1.4rem; margin: 2.4rem 0 0.8rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.13rem; margin: 1.8rem 0 0.6rem; }
h4 { font-size: 1rem; margin: 1.4rem 0 0.5rem; }
p { margin: 0.75rem 0; }
a { color: var(--accent); }
li { margin: 0.3rem 0; }
code {
  font: 0.86em/1.5 ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  background: var(--code-bg); padding: 0.12em 0.35em; border-radius: 5px;
}
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1.1rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
a.src { text-decoration: none; }
a.src code { color: var(--accent); }
a.src:hover code { text-decoration: underline; }
.table-wrap { overflow-x: auto; margin: 1rem 0; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
th { background: var(--sidebar-bg); font-weight: 600; white-space: nowrap; }
a.term {
  color: inherit; text-decoration: underline dotted var(--mark) 1.5px; text-underline-offset: 3px;
  position: relative; cursor: help;
}
a.term:hover { text-decoration-style: solid; }
#tip {
  position: fixed; max-width: 340px; background: var(--tooltip-bg); color: var(--tooltip-fg);
  font-size: 0.82rem; line-height: 1.45; padding: 0.5rem 0.7rem; border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25); opacity: 0; visibility: hidden;
  transition: opacity 120ms ease; z-index: 10; pointer-events: none;
}
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.82rem; }
@media (max-width: 900px) {
  body { display: block; }
  aside { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  main { padding: 1.5rem 1.25rem 4rem; }
}
`;

const SPY_JS = `
// Glossary tooltip: one shared fixed-position element, so it can't be clipped
// by the tables' overflow-x scroll containers.
const tip = document.createElement("div");
tip.id = "tip";
document.body.appendChild(tip);
document.addEventListener("mouseover", (e) => {
  const term = e.target.closest("a.term");
  if (!term) { tip.style.opacity = 0; tip.style.visibility = "hidden"; return; }
  tip.textContent = term.dataset.def;
  tip.style.visibility = "visible";
  tip.style.opacity = 1;
  const r = term.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
  const above = r.top - tip.offsetHeight - 8;
  tip.style.top = (above >= 8 ? above : r.bottom + 8) + "px";
});

const tocLinks = [...document.querySelectorAll("nav.toc a")];
const heads = tocLinks.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
function spy() {
  let current = heads[0];
  for (const h of heads) { if (h.getBoundingClientRect().top <= 90) current = h; else break; }
  tocLinks.forEach((a) => a.classList.toggle("active", current && a.hash === "#" + current.id));
}
document.addEventListener("scroll", spy, { passive: true });
spy();
`;

function sidebarHtml(currentPage, headings) {
  const docNav = Object.entries(DOC_PAGES)
    .map(([md, page]) => `<a href="${page}"${page === currentPage ? ' class="current"' : ""}>${PAGE_TITLES[page]}</a>`)
    .join("\n      ");
  const toc = headings
    .map((h) => `<a class="d${h.depth}" href="#${h.id}">${escapeHtml(h.text)}</a>`)
    .join("\n      ");
  return `<aside>
    <div class="site"><a href="index.html">LOFT-Sim-UI Docs</a></div>
    <nav class="docs">
      ${docNav}
    </nav>
    ${headings.length ? `<div class="toc-title">On this page</div>\n    <nav class="toc">\n      ${toc}\n    </nav>` : ""}
  </aside>`;
}

const PAGE_TITLES = { "context.html": "Project Context", "render.html": "Rendering Pipeline" };

function footerHtml(sourceName) {
  return `<footer>Generated ${new Date().toISOString().slice(0, 10)} from <code>docs/${sourceName}</code> at <a href="${REPO_URL}/commit/${HEAD_SHA}" target="_blank" rel="noopener"><code>${SHA_SHORT}</code></a> · regenerate with <code>npm run docs</code></footer>`;
}

function pageHtml({ title, page, headings, bodyHtml, sourceName }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LOFT-Sim-UI Docs</title>
<style>${CSS}</style>
</head>
<body>
${sidebarHtml(page, headings)}
<main>
${bodyHtml}
${footerHtml(sourceName)}
</main>
<script>${SPY_JS}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
mkdirSync(DOCS_DIR, { recursive: true });
for (const f of readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))) {
  if (!DOC_PAGES[f]) warn(`docs/${f} has no page mapping in gen-docs.mjs — skipped.`);
}
const cards = [];
for (const [sourceName, page] of Object.entries(DOC_PAGES)) {
  if (!existsSync(path.join(DOCS_DIR, sourceName))) { warn(`docs/${sourceName} is missing — page not generated.`); continue; }
  const md = readFileSync(path.join(DOCS_DIR, sourceName), "utf8");
  const tokens = marked.lexer(md);
  const ctx = { docName: sourceName, seen: new Set(), slugs: new Set(), headings: [], title: PAGE_TITLES[page] };
  walkBlocks(tokens, ctx);
  const bodyHtml = marked.parser(tokens);
  writeFileSync(path.join(DOCS_DIR, page), pageHtml({ title: ctx.title, page, headings: ctx.headings, bodyHtml, sourceName }));
  const firstPara = md.split(/\n\n+/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
  const excerpt = (firstPara ?? "").replace(/[*_`>]|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").slice(0, 180);
  cards.push({ page, title: ctx.title, excerpt: excerpt + (firstPara && firstPara.length > 180 ? "…" : ""), sections: ctx.headings.length });
  console.log(`✓ docs/${page}  (${ctx.headings.length} sections)`);
}

const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOFT-Sim-UI Docs</title>
<style>${CSS}
body { display: block; }
.wrap { max-width: 46rem; margin: 0 auto; padding: 3.5rem 1.5rem 4rem; }
.cards { display: flex; flex-direction: column; gap: 1rem; margin-top: 2rem; }
a.card { display: block; border: 1px solid var(--border); border-radius: 10px; padding: 1.1rem 1.4rem; text-decoration: none; color: var(--fg); }
a.card:hover { border-color: var(--accent); }
a.card h2 { margin: 0 0 0.35rem; border: none; padding: 0; font-size: 1.15rem; color: var(--accent); }
a.card p { margin: 0; color: var(--muted); font-size: 0.92rem; }
a.card .meta { margin-top: 0.5rem; font-size: 0.78rem; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
<h1>LOFT-Sim-UI Docs</h1>
<p>Human-friendly rendering of the <code>docs/*.md</code> working docs — with source-code links pinned to <a href="${REPO_URL}/commit/${HEAD_SHA}" target="_blank" rel="noopener"><code>${SHA_SHORT}</code></a> and hoverable explanations of 3D/rendering jargon.</p>
<div class="cards">
${cards.map((c) => `<a class="card" href="${c.page}"><h2>${escapeHtml(c.title)}</h2><p>${escapeHtml(c.excerpt)}</p><div class="meta">${c.sections} sections · source: docs/${Object.entries(DOC_PAGES).find(([, p]) => p === c.page)[0]}</div></a>`).join("\n")}
</div>
${footerHtml("*.md")}
</div>
</body>
</html>
`;
writeFileSync(path.join(DOCS_DIR, "index.html"), indexHtml);
console.log(`✓ docs/index.html`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
} else {
  console.log("\nNo warnings — every reference resolved.");
}
