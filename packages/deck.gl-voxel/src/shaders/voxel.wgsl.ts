/**
 * Draws a 3D grid by tracing a line from the camera through each pixel.
 * Positions inside the grid are fractions along three axes. For example,
 * (0.5, 0.5, 0.5) is the center, regardless of the grid's size or location on the map.
 * Each binding is a numbered slot for a GPU buffer or texture. The slots here match the
 * ones set in createVoxelResources, where TypeScript supplies the actual GPU objects.
 * The shader reads camera and style settings at the offsets written by
 * {@link import('../voxel-uniforms.js').createVoxelUniforms}.
 * @see https://www.w3.org/TR/WGSL/#memory-layout
 */
export const voxelShader = /* wgsl */ `
struct VoxelUniforms {
  clipToVolume: mat4x4f,
  viewport: vec4f,
  dimensions: vec3f,
  maxSteps: f32,
  extent: vec3f,
  opacityUnitDistance: f32,
  clipMin: vec3f,
  clipMax: vec3f,
  valueRange: vec2f,
  density: f32,
  opacity: f32,
  stepSize: f32,
  nearestSampling: f32,
  hasSceneDepth: f32,
  colorCoordinate: f32,
  renderMode: f32,
  isovalue: f32,
  volumeToView: mat4x4f,
  normalToView: mat4x4f,
  volumeToOpacity: mat4x4f,
};

@group(0) @binding(0) var<uniform> voxel: VoxelUniforms;
@group(0) @binding(1) var scalars: texture_3d<f32>;
@group(0) @binding(2) var transfer: texture_2d<f32>;
@group(0) @binding(3) var sceneDepth: texture_depth_2d;

/**
 * Covers the whole view with one triangle. Each covered pixel runs fragmentMain,
 * which checks where its ray hits the grid. This also works with the camera inside the grid.
 * @param index - Vertex number from 0 to 2.
 * @returns The four-number vertex position the GPU uses to place the triangle on screen.
 */
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);

  return vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

/**
 * Works backward from a screen position and depth to a point in the 3D grid.
 * NDC means normalized device coordinates. X and Y go from -1 to 1 across the
 * current view, with (0, 0) in the center. This is the coordinate range the camera
 * projection uses, so convert from pixels first. The center is still (0, 0) when
 * the view changes size, for example at pixel (400, 300) in an 800 by 600 view.
 *
 * The matrix returns (x, y, z, w), a point in homogeneous coordinates. Here w
 * is the scale factor for the first three numbers. Divide each by w to get the
 * grid position. For example, (2, 4, 6, 2) becomes (1, 2, 3).
 * @param ndc - Screen position scaled so bottom left is (-1, -1) and top right is (1, 1).
 * @param depth - Projected Z in deck.gl's depth convention. See fragmentMain.
 * @returns A point measured relative to the grid. Its faces lie at 0 and 1.
 * @see https://www.w3.org/TR/webgpu/#coordinate-systems
 */
fn unproject(ndc: vec2f, depth: f32) -> vec3f {
  let p = voxel.clipToVolume * vec4f(ndc, depth, 1.0);

  return p.xyz / p.w;
}

/**
 * Finds where the camera ray enters and leaves the clipping box.
 * Checks parallel rays separately to avoid multiplying zero by infinity on a box face.
 * @param origin - Ray start in 0-to-1 grid coordinates.
 * @param direction - Direction of the ray as a vector with length 1.
 * @returns Entry and exit distances. An exit before the entry means the ray missed.
 */
fn intersectBox(origin: vec3f, direction: vec3f) -> vec2f {
  var entry = 0.0;
  var exit = 1e20;

  for (var axis = 0u; axis < 3u; axis++) {
    if (abs(direction[axis]) < 1e-10) {
      if (origin[axis] < voxel.clipMin[axis] || origin[axis] > voxel.clipMax[axis]) {
        return vec2f(1.0, -1.0);
      }
    } else {
      let a = (voxel.clipMin[axis] - origin[axis]) / direction[axis];
      let b = (voxel.clipMax[axis] - origin[axis]) / direction[axis];

      entry = max(entry, min(a, b));
      exit = min(exit, max(a, b));
    }
  }

  return vec2f(entry, exit);
}

/**
 * Looks up a cell in the GPU texture by its integer [x, y, z] indices.
 * Indices just outside the grid use the nearest edge cell.
 * @param index - Integer sample index, which may lie one cell outside an edge.
 * @returns The data value and a flag that is 1 for valid data or 0 for missing data.
 */
fn loadScalar(index: vec3i) -> vec2f {
  let bounded = clamp(index, vec3i(0), vec3i(voxel.dimensions) - vec3i(1));

  return textureLoad(scalars, bounded, 0).xy;
}

/**
 * Reads the nearest cell or blends its neighbors along X, Y and Z (trilinear interpolation).
 * Multiply by the cell counts to go from fractions of the grid to cell units. Subtract
 * half a cell so index 0 lines up with the center of the first cell. Missing cells are
 * left out of the blend.
 * @param position - Position in 0-to-1 grid coordinates.
 * @returns The value and how much of the blend had data. Zero means the sample is missing.
 */
fn sampleScalar(position: vec3f) -> vec2f {
  let p = position * voxel.dimensions - vec3f(0.5);

  if (voxel.nearestSampling > 0.5) {
    return loadScalar(vec3i(floor(p + vec3f(0.5))));
  }

  let base = vec3i(floor(p));
  let fraction = fract(p);
  var total = vec2f(0.0);

  for (var z = 0; z < 2; z++) {
    for (var y = 0; y < 2; y++) {
      for (var x = 0; x < 2; x++) {
        let offset = vec3i(x, y, z);
        let weights = mix(vec3f(1.0) - fraction, fraction, vec3f(offset));
        let value = loadScalar(base + offset);
        let weight = weights.x * weights.y * weights.z * value.y;

        total += vec2f(value.x * weight, weight);
      }
    }
  }

  return vec2f(total.x / max(total.y, 1e-20), total.y);
}

/**
 * Reads two neighboring RGBA entries from the color ramp and blends them. Each entry
 * is one pixel in the GPU texture, so the entry index is X and Y is always zero.
 * @param coordinate - How far along the color ramp to read, from 0 to 1.
 * @returns RGB before alpha is applied, plus alpha for the configured reference distance.
 */
fn lookup(coordinate: f32) -> vec4f {
  let last = i32(textureDimensions(transfer).x) - 1;
  let index = clamp(coordinate, 0.0, 1.0) * f32(last);
  let low = i32(floor(index));
  let lowerColor = textureLoad(transfer, vec2i(low, 0), 0);
  let upperColor = textureLoad(transfer, vec2i(min(low + 1, last), 0), 0);

  return mix(lowerColor, upperColor, fract(index));
}

/**
 * Gets RGB from the data value or an axis position. Opacity always comes from the data value.
 * @param value - Sample in the dataset's units, such as m/s.
 * @param position - Position in 0-to-1 grid coordinates.
 * @returns Color and opacity for the distance set by opacityUnitDistance.
 */
fn sampleColor(value: f32, position: vec3f) -> vec4f {
  let coordinate = (value - voxel.valueRange.x) / (voxel.valueRange.y - voxel.valueRange.x);
  var color = lookup(coordinate);

  if (voxel.colorCoordinate > 0.5) {
    let axis = u32(voxel.colorCoordinate) - 1u;

    color = vec4f(lookup(position[axis]).rgb, color.a);
  }

  return color;
}

/**
 * Checks whether the sample came from valid cells, with a small margin for rounding.
 * @param sample - Value and valid weight returned by sampleScalar.
 * @returns Whether almost all the weight comes from cells with data. This keeps a gap
 * from looking like a surface just because a few neighbors happened to have values.
 */
fn supportsSurface(sample: vec2f) -> bool {
  return sample.y >= 1.0 - 1e-5;
}

/**
 * Narrows down where the value crosses the chosen level. Sample the midpoint eight times,
 * each time keeping the half that still contains the crossing.
 * @param first - First valid endpoint in 0-to-1 grid coordinates.
 * @param last - Valid endpoint on the other side of the level.
 * @param firstBelow - Whether the value at the first endpoint is below the level.
 * @returns A closer crossing position and a flag. Missing data inside the interval clears the flag.
 */
fn refineCrossing(first: vec3f, last: vec3f, firstBelow: bool) -> vec4f {
  var a = first;
  var b = last;

  for (var iteration = 0u; iteration < 8u; iteration++) {
    let middle = (a + b) * 0.5;
    let value = sampleScalar(middle);

    if (!supportsSurface(value)) {
      return vec4f(0.0);
    }

    if ((value.x < voxel.isovalue) == firstBelow) {
      a = middle;
    } else {
      b = middle;
    }
  }

  return vec4f((a + b) * 0.5, 1.0);
}

/**
 * Walks along the ray until two consecutive valid samples cross the requested level.
 * A surface comes from a change in data values. Grid edges, clipping and gaps just limit the search.
 * @param origin - Ray start in 0-to-1 grid coordinates.
 * @param direction - Unit direction in grid coordinates.
 * @param start - Visible entry distance along the ray.
 * @param end - Exit distance, shortened if opaque geometry blocks the ray.
 * @param step - Distance between samples after applying the step limit.
 * @returns The first crossing position and a flag that is 0 if the ray missed.
 */
fn findIsosurface(origin: vec3f, direction: vec3f, start: f32, end: f32, step: f32) -> vec4f {
  var t = start;
  var previousPosition = origin + direction * t;
  var previous = sampleScalar(previousPosition);

  for (var i = 0u; i < u32(voxel.maxSteps); i++) {
    if (t >= end) {
      break;
    }

    t = min(t + step, end);

    let position = origin + direction * t;
    let current = sampleScalar(position);

    if (supportsSurface(previous) && supportsSurface(current) &&
        (previous.x < voxel.isovalue) != (current.x < voxel.isovalue)) {
      let crossing = refineCrossing(previousPosition, position, previous.x < voxel.isovalue);

      if (crossing.w > 0.5) {
        return crossing;
      }
    }

    previous = current;
    previousPosition = position;
  }

  return vec4f(0.0);
}

/**
 * Lights the surface from the camera. Nearby values tell us which way the surface faces.
 * If a neighbor is missing, use the center and the neighbor on the other side.
 * The normal points perpendicular to the surface. The normal matrix keeps it perpendicular
 * when cells are taller than they are wide or the model stretches or flips an axis.
 * @param position - Surface crossing in 0-to-1 grid coordinates.
 * @param direction - Viewing-ray direction in the same coordinates.
 * @returns Brightness from either side of the surface, with a minimum for edge-on views.
 * Uses full brightness if the nearby values don't give a usable normal.
 */
fn surfaceLighting(position: vec3f, direction: vec3f) -> f32 {
  let center = sampleScalar(position).x;
  var gradient = vec3f(0.0);

  for (var axis = 0u; axis < 3u; axis++) {
    let delta = 1.0 / voxel.dimensions[axis];
    var lowPosition = position;
    var highPosition = position;

    lowPosition[axis] = max(0.0, position[axis] - delta);
    highPosition[axis] = min(1.0, position[axis] + delta);

    let low = sampleScalar(lowPosition);
    let high = sampleScalar(highPosition);

    if (supportsSurface(low) && supportsSurface(high)) {
      gradient[axis] = (high.x - low.x) / (highPosition[axis] - lowPosition[axis]);
    } else if (supportsSurface(high) && highPosition[axis] > position[axis]) {
      gradient[axis] = (high.x - center) / (highPosition[axis] - position[axis]);
    } else if (supportsSurface(low) && position[axis] > lowPosition[axis]) {
      gradient[axis] = (center - low.x) / (position[axis] - lowPosition[axis]);
    }
  }

  let normal = (voxel.normalToView * vec4f(gradient, 0.0)).xyz;
  let normalLength = length(normal);

  if (normalLength <= 1e-12) {
    return 1.0;
  }

  let viewDirection = normalize((voxel.volumeToView * vec4f(direction, 0.0)).xyz);

  return 0.3 + 0.7 * abs(dot(normal / normalLength, viewDirection));
}

/**
 * Shades a pixel by tracing a ray through the volume or finding the first surface hit.
 * Turn canvas pixels into a position relative to this view. Flip Y because pixel Y
 * increases down the canvas while NDC Y increases upward. For the ray's Z endpoints
 * use -1 and 1, the near and far depths from deck.gl 9.3's camera projection.
 * A saved scene depth can also be passed to unproject to find where an opaque object blocks it.
 * @param pixel - Position in device pixels, measured from the canvas's top left.
 * @returns RGBA with RGB already multiplied by alpha. A missed ray leaves the pixel alone.
 */
@fragment fn fragmentMain(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  if ((voxel.renderMode < 0.5 && voxel.density == 0.0) ||
      voxel.opacity == 0.0 || any(voxel.clipMin >= voxel.clipMax)) {
    discard;
  }

  let uv = (pixel.xy - voxel.viewport.xy) / voxel.viewport.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);

  let origin = unproject(ndc, -1.0);
  let far = unproject(ndc, 1.0);
  let direction = normalize(far - origin);
  let hit = intersectBox(origin, direction);
  var end = min(hit.y, length(far - origin));

  if (voxel.hasSceneDepth > 0.5) {
    let depth = textureLoad(sceneDepth, vec2i(pixel.xy), 0);
    let surface = unproject(ndc, depth);

    end = min(end, dot(surface - origin, direction));
  }

  if (end <= hit.x) {
    discard;
  }

  let step = getMarchStep(direction, end - hit.x);

  if (voxel.renderMode > 0.5) {
    let crossing = findIsosurface(origin, direction, hit.x, end, step);

    if (crossing.w < 0.5) {
      discard;
    }

    let color = sampleColor(voxel.isovalue, crossing.xyz).rgb;
    let shaded = color * surfaceLighting(crossing.xyz, direction);

    return vec4f(shaded * voxel.opacity, voxel.opacity);
  }

  return marchVolume(origin, direction, hit.x, end, step) * voxel.opacity;
}

/**
 * Turns a step measured in cells into a distance along the ray in grid coordinates.
 * Uses larger steps if the ray would need more samples than the limit allows.
 * @param direction - Unit ray direction in 0-to-1 grid coordinates.
 * @param rayLength - Length of the visible ray in those same coordinates.
 * @returns Distance along the ray between samples.
 */
fn getMarchStep(direction: vec3f, rayLength: f32) -> f32 {
  let voxelsPerUnit = length(direction * voxel.dimensions);

  return max(voxel.stepSize / voxelsPerUnit, rayLength / voxel.maxSteps);
}

/**
 * Blends samples from nearest to farthest. Each sample uses the opacity left by those ahead of it.
 * @param origin - Ray start in 0-to-1 grid coordinates.
 * @param direction - Unit ray direction in grid coordinates.
 * @param start - Visible entry distance along the ray.
 * @param end - Visible exit distance along the ray.
 * @param step - Distance along the ray between samples.
 * @returns RGBA with RGB already multiplied by the accumulated alpha, before layer opacity.
 */
fn marchVolume(origin: vec3f, direction: vec3f, start: f32, end: f32, step: f32) -> vec4f {
  let opacityDirection = (voxel.volumeToOpacity * vec4f(direction, 0.0)).xyz;
  let opacityUnitsPerGridUnit = length(opacityDirection) / voxel.opacityUnitDistance;
  var accumulated = vec4f(0.0);
  var t = start;

  for (var i = 0u; i < u32(voxel.maxSteps); i++) {
    if (t >= end || accumulated.a >= 0.995) {
      break;
    }

    let dt = min(step, end - t);
    let position = origin + direction * (t + dt * 0.5);
    let sample = sampleScalar(position);

    if (sample.y > 1e-8) {
      let color = sampleColor(sample.x, position);
      let alpha = correctOpacity(color.a, dt * opacityUnitsPerGridUnit * voxel.density);

      accumulated += (1.0 - accumulated.a) * vec4f(color.rgb * alpha, alpha);
    }

    t += dt;
  }

  return accumulated;
}

/**
 * Adjusts opacity for the distance each sample covers. Two reference-length steps with
 * opacity 0.5 each leave 25% transparent, so one double-length step should have opacity 0.75.
 * @param alpha - Opacity from the RGBA entry for the distance set by opacityUnitDistance.
 * @param distance - Step length divided by the reference distance and multiplied by density.
 * @returns Opacity for this step.
 */
fn correctOpacity(alpha: f32, distance: f32) -> f32 {
  if (alpha >= 1.0) {
    return 1.0;
  }

  return 1.0 - pow(1.0 - alpha, distance);
}
`;
