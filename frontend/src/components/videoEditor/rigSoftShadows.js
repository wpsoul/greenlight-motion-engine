/*
 * Soft rig shadows — PCSS (percentage-closer soft shadows) for the WebGL backend.
 *
 * Why not three's PCF: r183's PCF filter takes FIVE noisy taps with a FIXED radius,
 * so a shadow is equally blurred where an object touches the floor and a metre
 * away. It reads grainy and never like a real light. PCSS first measures how far
 * the blocker is, then widens the filter with that distance: sharp at contact, soft
 * further out — the way a softbox or a sky actually shades.
 *
 * Mechanics. The renderer runs BasicShadowMap (raw depth, no comparison sampler —
 * the blocker search needs real depth values), and this module replaces three's
 * BASIC `getShadow` / `getPointShadow` with the PCSS versions below. Installed once,
 * when model3dLayer is first imported — i.e. only by projects that draw 3D at all —
 * and always before any shadowed program compiles, since shadows only exist inside
 * the model/rig/plate passes that module owns.
 *
 * Per-light parameters ride the existing `shadow.radius` uniform (three passes it
 * to every shadow lookup and ignores it for BASIC), packed by encodePcssRadius():
 *   cap  — the light's size in shadow-map texels: the widest the penumbra gets;
 *   k    — penumbra texels per unit of depth separation, which folds in the light's
 *          frustum depth range and its apparent angular size.
 * k is logarithmic so large sets and tightly fitted maps do not saturate it.
 * Packing keeps every value an exact float32 integer (< 2^24).
 *
 * WebGPU uses the equivalent filterNode in model3dNodes.js; ShaderChunk edits
 * do not reach TSL materials.
 */

import * as THREE from 'three';

const PCSS_DIR = `#else

		varying vec3 vPcssWorld;
		float pcssHash3( vec3 p3 ) {
			p3 = fract( p3 * 0.1031 );
			p3 += dot( p3, p3.zyx + 31.32 );
			return fract( ( p3.x + p3.y ) * p3.z );
		}
		// Disk rotation anchored to the RECEIVING SURFACE: one random angle per
		// world-space cell, so neither a camera move nor a light move changes the
		// pattern a point is filtered with — a moving shadow slides over fixed grain.
		//  * Unrotated (fixed) disk: its samples sit up to a hundred texels apart in a
		//    wide penumbra, so each flipped at its own spot and the edge drew as
		//    stepped copies of itself that jumped as the light or a caster moved.
		//  * Screen-space noise flashed with every camera move; noise on the shadow
		//    map's texel grid re-rolled with every keyframed light (the fitted map
		//    shifts a few hundredths of a texel per frame).
		// Cells follow the pixel footprint (fwidth): between half a pixel and two,
		// the two nearest power-of-two sizes mixed per cell so a zoom never pops.
		// floor(), not ceil(): ceil jumps a whole size exactly at a power of two,
		// where float noise in fwidth then flipped the pattern frame to frame.
		float pcssPhi() {
			vec3 fw = fwidth( vPcssWorld );
			float lv = log2( max( max( fw.x, fw.y ), max( fw.z, 1e-6 ) ) );
			float l0 = floor( lv );
			float coin = pcssHash3( floor( vPcssWorld / exp2( l0 ) ) + 17.0 );
			float level = coin < fract( lv ) ? l0 + 1.0 : l0;
			return pcssHash3( floor( vPcssWorld / exp2( level ) ) ) * PI2;
		}
		vec2 pcssVogel( int i, int n, float phi ) {
			float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
			float t = float( i ) * 2.399963229728653 + phi;
			return vec2( cos( t ), sin( t ) ) * r;
		}
		void pcssDecode( float packed, out float capTexels, out float k ) {
			float kq = floor( packed / 1024.0 );
			capTexels = max( ( packed - kq * 1024.0 ) * 0.25, 1.0 );
			k = exp2( kq / 256.0 ) - 1.0;
		}

		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			// Before the branch: derivatives are undefined in divergent control flow.
			float phi = pcssPhi();
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			if ( inFrustum && shadowCoord.z <= 1.0 ) {
				float capTexels; float k;
				pcssDecode( shadowRadius, capTexels, k );
				float texel = 1.0 / shadowMapSize.x;
				// Bounds read from a uniform so the compiler cannot unroll the loops:
				// unrolled, every light mix compiled into a much larger program.
				// With the rotated disk 16 + 32 taps are enough: 32 + 64 taps of a
				// fixed disk read the shadow map twice as often and still stepped.
				int nB = int( min( shadowMapSize.x, 16.0 ) );
				int nF = int( min( shadowMapSize.x, 32.0 ) );
				float search = capTexels * texel;
				float blockerSum = 0.0; float blockers = 0.0;
				for ( int i = 0; i < nB; i ++ ) {
					float d = texture2D( shadowMap, shadowCoord.xy + ( i == 0 ? vec2( 0.0 ) : pcssVogel( i - 1, nB - 1, phi ) * search ) ).r;
					#ifdef USE_REVERSED_DEPTH_BUFFER
						if ( d > shadowCoord.z ) { blockerSum += d; blockers += 1.0; }
					#else
						if ( d < shadowCoord.z ) { blockerSum += d; blockers += 1.0; }
					#endif
				}
				if ( blockers > 0.0 ) {
					float sep = abs( shadowCoord.z - blockerSum / blockers );
					float pen = ( min( sep * k, capTexels ) + 1.5 ) * texel;
					float lit = 0.0;
					for ( int i = 0; i < nF; i ++ ) {
						vec2 uv = shadowCoord.xy + pcssVogel( i, nF, phi ) * pen;
						// Bilinear interpolation of COMPARISONS, never of raw depth.
						// Raw nearest taps left staircase edges and noisy bands on the set.
						vec2 pixel = uv * shadowMapSize - 0.5;
						vec2 f = fract( pixel );
						vec2 base = ( floor( pixel ) + 0.5 ) / shadowMapSize;
						vec4 depths = vec4(
							texture2D( shadowMap, base ).r,
							texture2D( shadowMap, base + vec2( texel, 0.0 ) ).r,
							texture2D( shadowMap, base + vec2( 0.0, texel ) ).r,
							texture2D( shadowMap, base + vec2( texel ) ).r );
						#ifdef USE_REVERSED_DEPTH_BUFFER
							vec4 taps = step( depths, vec4( shadowCoord.z ) );
						#else
							vec4 taps = step( vec4( shadowCoord.z ), depths );
						#endif
						lit += mix( mix( taps.x, taps.y, f.x ), mix( taps.z, taps.w, f.x ), f.y );
					}
					shadow = lit / float( nF );
				}
			}
			return mix( 1.0, shadow, shadowIntensity );
		}

	`;

const PCSS_POINT = `#elif defined( SHADOWMAP_TYPE_BASIC )

	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			float capTexels; float k;
			pcssDecode( shadowRadius, capTexels, k );
			vec3 dir = normalize( lightToPosition );
			vec3 t = normalize( cross( dir, abs( dir.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
			vec3 b = cross( dir, t );
			// A cube face spans two tangent units, so one texel is 2 / size of them.
			float spread = capTexels * 2.0 / shadowMapSize.x;
			// Keep the sampling disk fixed around the light-to-receiver direction
			// so camera movement cannot change which cube depths are sampled.
			float phi = 0.0;
			int nP = int( min( shadowMapSize.x, 24.0 ) );
			float lit = 0.0;
			for ( int i = 0; i < nP; i ++ ) {
				vec2 o = pcssVogel( i, nP, phi ) * spread;
				float depth = textureCube( shadowMap, normalize( dir + t * o.x + b * o.y ) ).r;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					depth = 1.0 - depth;
				#endif
				lit += step( dp, depth );
			}
			shadow = lit / float( nP );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}

	`;

/**
 * Replace the BASIC branch of three's shadow lookup. Anchored on function
 * SIGNATURES, not comments — the published build strips GLSL comments, so
 * `#else // SHADOWMAP_TYPE_BASIC` does not exist in it.
 *
 * Returns false (and leaves three untouched) if the chunk no longer has the shape
 * this was written against — a three upgrade must then re-check this file; the
 * caller falls back to PCF rather than shipping unfiltered BASIC shadows.
 */
function installPcss() {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  const parsVertex = THREE.ShaderChunk.shadowmap_pars_vertex;
  const vertex = THREE.ShaderChunk.shadowmap_vertex;
  if (typeof src !== 'string' || typeof parsVertex !== 'string' || typeof vertex !== 'string') return false;
  if (src.includes('pcssDecode')) return true; // already installed (HMR / second import)
  const sig = 'float getShadow( sampler2D shadowMap';
  const first = src.indexOf(sig);
  const basicFn = first >= 0 ? src.indexOf(sig, first + 1) : -1; // [0] is VSM, [1] is BASIC
  const a = basicFn > 0 ? src.lastIndexOf('#else', basicFn) : -1;
  const pointIdx = basicFn > 0 ? src.indexOf('#if NUM_POINT_LIGHT_SHADOWS > 0', basicFn) : -1;
  const b = pointIdx > 0 ? src.lastIndexOf('#endif', pointIdx) : -1;
  const c = pointIdx > 0 ? src.indexOf('#elif defined( SHADOWMAP_TYPE_BASIC )', pointIdx) : -1;
  const last = src.lastIndexOf('#endif');
  const mid = src.lastIndexOf('#endif', last - 1);
  const d = src.lastIndexOf('#endif', mid - 1);
  if (!(a > 0 && b > a && c > b && d > c)) {
    // eslint-disable-next-line no-console
    console.warn('[rigSoftShadows] three shadow chunk changed shape — soft shadows not installed');
    return false;
  }
  // The world position pcssPhi() anchors its disk rotation to. shadowmap_vertex
  // already reads `worldPosition`, so every material that includes it has one.
  if (!parsVertex.includes('vPcssWorld')) {
    THREE.ShaderChunk.shadowmap_pars_vertex = `#ifdef USE_SHADOWMAP\n\tvarying vec3 vPcssWorld;\n#endif\n${parsVertex}`;
  }
  if (!vertex.includes('vPcssWorld')) {
    THREE.ShaderChunk.shadowmap_vertex = `${vertex}\n#ifdef USE_SHADOWMAP\n\tvPcssWorld = worldPosition.xyz;\n#endif\n`;
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = src.slice(0, a) + PCSS_DIR + src.slice(b, c) + PCSS_POINT + src.slice(d);
  return true;
}

export const PCSS_INSTALLED = installPcss();

/** The shadow type the WebGL renderer should run for soft rig shadows. */
export const SOFT_SHADOW_MAP_TYPE = PCSS_INSTALLED ? THREE.BasicShadowMap : THREE.PCFShadowMap;

/** Pack the per-light PCSS parameters into `shadow.radius` (see header). */
export function encodePcssRadius(capTexels, kTexelsPerDepth) {
  const capq = Math.max(0, Math.min(1023, Math.round((Number.isFinite(capTexels) ? capTexels : 4) * 4)));
  const kq = Math.max(0, Math.min(8191, Math.round(Math.log2(1 + Math.max(0, Number.isFinite(kTexelsPerDepth) ? kTexelsPerDepth : 0)) * 256)));
  return kq * 1024 + capq;
}

/**
 * A light's apparent size from the rig's `shadowSoftness` (0..10, default 1):
 *   capWorld — the widest penumbra, in world px (composition-height relative);
 *   tan      — how fast the penumbra opens per unit of separation from the occluder.
 * Softness 2–3 reads as a softbox or a sky, 0.3 as a noon sun or a hard spot.
 */
export function lightSpread(softness, compH) {
  const s = Number.isFinite(softness) ? Math.max(0, softness) : 1;
  return { capWorld: s * 0.09 * compH, tan: s * 0.22 };
}

/**
 * The packed `shadow.radius` for one light, from its fitted shadow camera.
 *
 * Directional (orthographic): depth is linear across [near, far].
 * Spot (perspective): depth is not linear — it is linearised at the subject's
 * distance, which is where the shadows that matter are.
 * Point: no PCSS (cube maps), only the cap is used as a fixed soft radius.
 */
export function pcssRadiusFor(light, { softness, compH, mapSize, subjectDist }) {
  const { capWorld, tan } = lightSpread(softness, compH);
  const cam = light.shadow?.camera;
  if (!cam) return encodePcssRadius(4, 0);
  const near = Math.max(1e-3, cam.near);
  const far = Math.max(near + 1e-3, cam.far);
  let texelWorld;
  let worldPerDepth;
  if (light.isDirectionalLight) {
    texelWorld = Math.max(1e-6, (cam.right - cam.left) / mapSize);
    worldPerDepth = far - near;
  } else if (light.isSpotLight) {
    const z = Math.max(near, Math.min(far, subjectDist));
    texelWorld = Math.max(1e-6, (2 * z * Math.tan(Math.max(1e-3, light.angle))) / mapSize);
    worldPerDepth = (z * z * (far - near)) / (far * near);
  } else {
    const z = Math.max(1, subjectDist);
    texelWorld = Math.max(1e-6, (2 * z) / mapSize);
    worldPerDepth = 0;
  }
  return encodePcssRadius(capWorld / texelWorld, (worldPerDepth * tan) / texelWorld);
}
