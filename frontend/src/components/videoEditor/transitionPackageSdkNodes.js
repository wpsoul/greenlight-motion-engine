/*
 * The transition SDK's WebGPU half — the only module in the package runtime that
 * carries a `three/webgpu` import.
 *
 * It exists so that import can be DYNAMIC. `three/webgpu` is a second, 1.9 MB
 * copy of three; while the SDK imported it directly, every editor session paid
 * for it, including the WebGL-only ones that cannot execute any of it. Splitting
 * the backend-specific half into its own file is what lets the bundler leave it
 * out of the chunk and fetch it only when a project asks for WebGPU.
 *
 * Loaded from `materialFactory.initMaterialBackend()`, which the Player already
 * awaits before it builds anything — so by the time a package's `createInstance`
 * runs, the SDK is whole. A package never imports this module or knows it exists.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { installNodeSdk } from './transitionPackageSdk.js';

export function installTransitionSdkNodes() {
  installNodeSdk({ THREE, TSL });
}
