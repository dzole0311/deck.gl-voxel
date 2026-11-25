/** Cube faces use ordinary depth rasterization. The final triangle caps cells intersected by the near plane. */
export const cellShader = /* wgsl */ `
struct Settings { toClip: mat4x4<f32>, fromClip: mat4x4<f32>, size: vec4<f32>, mask: vec4<u32>, clipLow: vec4<f32>, clipHigh: vec4<f32> };
struct Cell { bounds: vec4<f32>, style: vec4<f32> };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var<storage, read> colors: array<vec4<f32>>;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) bin: u32,
 @location(1) @interpolate(flat) low: vec3<f32>, @location(2) @interpolate(flat) high: vec3<f32>,
 @location(3) @interpolate(flat) cap: u32, @location(4) ndc: vec2<f32>, @location(5) shade: f32 };
const indices = array<u32,36>(0,2,1,1,2,3,4,5,6,5,7,6,0,1,4,1,5,4,2,6,3,3,6,7,0,4,2,2,4,6,1,3,5,3,7,5);
const edges = array<vec2<u32>,12>(vec2<u32>(0,1),vec2<u32>(2,3),vec2<u32>(4,5),vec2<u32>(6,7),vec2<u32>(0,2),vec2<u32>(1,3),vec2<u32>(4,6),vec2<u32>(5,7),vec2<u32>(0,4),vec2<u32>(1,5),vec2<u32>(2,6),vec2<u32>(3,7));
fn corner(i: u32, low: vec3<f32>, high: vec3<f32>) -> vec3<f32> {
 return mix(low, high, vec3<f32>(f32(i & 1u), f32((i >> 1u) & 1u), f32((i >> 2u) & 1u)));
}
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
 let cell = cells[instance];
 let a = vec3<f32>(cell.bounds.xy,cell.bounds.z); let b = vec3<f32>(cell.bounds.xy + settings.size.xy,cell.bounds.w);
 let low = max(min(a,b),settings.clipLow.xyz); let high = min(max(a,b),settings.clipHigh.xyz);
 var out: Vertex; out.low = vec3<f32>(low.xy,(low.z * settings.size.z + cell.style.x * (1.0-settings.size.z))*cell.style.z);
 out.high = vec3<f32>(high.xy,(high.z * settings.size.z + cell.style.x * (1.0-settings.size.z))*cell.style.z); out.bin = u32(cell.style.y); out.cap = 0u; out.shade = 1.0; out.ndc = vec2<f32>(0.0);
 if (any(low >= high)) { out.position = vec4<f32>(2.0,2.0,2.0,1.0); return out; }
 if ((settings.mask.x & (1u << out.bin)) == 0u) { out.position = vec4<f32>(2.0,2.0,2.0,1.0); return out; }
 if (vertex < 36u) {
   var p = settings.toClip * vec4<f32>(corner(indices[vertex],out.low,out.high),1.0);
   p.z = (p.z+p.w)*0.5; out.position = p;
   out.shade = select(0.84,1.0,vertex < 12u); return out;
 }
 let plane = vec4<f32>(settings.toClip[0].z+settings.toClip[0].w,settings.toClip[1].z+settings.toClip[1].w,settings.toClip[2].z+settings.toClip[2].w,settings.toClip[3].z+settings.toClip[3].w);
 let center=(out.low+out.high)*0.5; let radius=dot(abs(plane.xyz),(out.high-out.low)*0.5); let distance=dot(plane,vec4<f32>(center,1.0));
 if (!(distance-radius < 0.0 && distance+radius >= 0.0)) { out.position = vec4<f32>(2.0,2.0,2.0,1.0); return out; }
 // Restrict each cap to its near-plane intersection; off-screen cells must not shade a full-screen triangle.
 var screenLow=vec2<f32>(1.0); var screenHigh=vec2<f32>(-1.0);
 for (var i=0u; i<12u; i++) {
   let a=settings.toClip*vec4<f32>(corner(edges[i].x,out.low,out.high),1.0);
   let b=settings.toClip*vec4<f32>(corner(edges[i].y,out.low,out.high),1.0);
   let da=a.z+a.w; let db=b.z+b.w;
   if ((da >= 0.0) != (db >= 0.0)) {
     let hit=mix(a,b,da/(da-db)); let screen=hit.xy/hit.w;
     screenLow=min(screenLow,screen); screenHigh=max(screenHigh,screen);
   }
 }
 screenLow=max(screenLow-vec2<f32>(0.00001),vec2<f32>(-1.0));
 screenHigh=min(screenHigh+vec2<f32>(0.00001),vec2<f32>(1.0));
 if (any(screenLow >= screenHigh)) { out.position = vec4<f32>(2.0,2.0,2.0,1.0); return out; }
 let triangle = array<vec2<f32>,3>(screenLow,vec2<f32>(2.0*screenHigh.x-screenLow.x,screenLow.y),vec2<f32>(screenLow.x,2.0*screenHigh.y-screenLow.y));
 out.ndc = triangle[vertex-36u]; out.position = vec4<f32>(out.ndc,0.0,1.0); out.cap = 1u; return out;
}
@fragment fn fragmentMain(in: Vertex) -> @location(0) vec4<f32> {
 if (in.cap == 1u) {
   let q=settings.fromClip*vec4<f32>(in.ndc,-1.0,1.0); let p=q.xyz/q.w;
   if (any(p < in.low) || any(p > in.high)) { discard; }
 }
 return vec4<f32>(colors[in.bin].rgb * in.shade,1.0);
}
`;
