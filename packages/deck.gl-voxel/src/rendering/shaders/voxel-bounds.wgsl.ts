/**
 * Draws the twelve edges of the full grid. The grid's corners are fractions along
 * each axis, from 0 to 1, and use the same camera transform as the volume.
 * The binding slot matches the one set in createVoxelBounds. The shader reads
 * its settings at the offsets written by {@link import('../uniforms.js').createVoxelUniforms}.
 * @see https://www.w3.org/TR/WGSL/#memory-layout
 */
export const voxelBoundsShader = /* wgsl */ `
struct OutlineUniforms {
  volumeToClip: mat4x4f,
  camera: vec4f,
  rearPass: f32,
  pixelRatio: f32,
  viewportSize: vec2f,
};

struct EdgeVertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) hidden: u32,
  @location(1) @interpolate(flat) screenDirection: vec2f,
};

@group(0) @binding(0) var<uniform> outline: OutlineUniforms;

/**
 * Projects the selected endpoint and classifies its edge using its two adjoining faces.
 * A face has the same coordinate at both ends of an edge along its normal axis.
 * At coordinate 0 the face points in the negative direction. At 1 it points in the
 * positive direction. If either face points toward the camera, the edge is visible.
 * When the camera is inside the grid, all edges are visible.
 * @param vertex - Vertex number from 0 to 23, in consecutive pairs for each edge.
 * @returns Clip position and values shared by both endpoints for shading the line.
 */
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32) -> EdgeVertex {
  let corners = array(
    vec3f(0, 0, 0), vec3f(1, 0, 0), vec3f(1, 1, 0), vec3f(0, 1, 0),
    vec3f(0, 0, 1), vec3f(1, 0, 1), vec3f(1, 1, 1), vec3f(0, 1, 1),
  );
  let edges = array(
    0u, 1u, 1u, 2u, 2u, 3u, 3u, 0u,
    4u, 5u, 5u, 6u, 6u, 7u, 7u, 4u,
    0u, 4u, 1u, 5u, 2u, 6u, 3u, 7u,
  );
  let firstVertex = (vertex / 2u) * 2u;
  let start = corners[edges[firstVertex]];
  let end = corners[edges[firstVertex + 1u]];
  let clipStart = outline.volumeToClip * vec4f(start, 1.0);
  let clipEnd = outline.volumeToClip * vec4f(end, 1.0);
  let clip = select(clipStart, clipEnd, vertex % 2u == 1u);

  // The camera is a point when w is 1 and a direction when w is 0.
  let facing = (outline.camera.xyz - start * outline.camera.w) * (2.0 * start - 1.0);
  let visibleFace =
    (start.x == end.x && facing.x >= 0.0) ||
    (start.y == end.y && facing.y >= 0.0) ||
    (start.z == end.z && facing.z >= 0.0);
  let inside = outline.camera.w == 1.0 &&
    all(outline.camera.xyz >= vec3f(0.0)) && all(outline.camera.xyz <= vec3f(1.0));

  // Multiply out (end.xy / end.w - start.xy / start.w) to avoid dividing by w.
  // Use the viewport size and flip Y to get a direction in framebuffer pixels.
  let delta = (clipEnd.xy * clipStart.w - clipStart.xy * clipEnd.w) *
    outline.viewportSize * vec2f(1.0, -1.0);
  let direction = delta / max(length(delta), 0.00001);

  // Convert deck.gl's [-w, w] clip depth to WebGPU's [0, w].
  let position = vec4f(clip.xy, (clip.z + clip.w) * 0.5, clip.w);
  return EdgeVertex(position, select(1u, 0u, visibleFace || inside), direction);
}

/**
 * Draws only the edges for the current pass. A rear edge repeats every nine CSS
 * pixels, with five pixels drawn and four skipped. The color is multiplied by
 * its alpha before blending, as it is in the volume shader.
 * @param edge - Framebuffer position and the edge's visibility and direction.
 * @returns The line color with premultiplied alpha.
 */
@fragment fn fragmentMain(edge: EdgeVertex) -> @location(0) vec4f {
  if (edge.hidden != u32(outline.rearPass)) {
    discard;
  }
  if (edge.hidden == 1u) {
    let distance = dot(edge.position.xy, edge.screenDirection) / outline.pixelRatio;
    if (fract(distance / 9.0) >= 5.0 / 9.0) {
      discard;
    }
  }
  let opacity = 0.75;
  return vec4f(vec3f(0.12, 0.22, 0.30) * opacity, opacity);
}
`;
