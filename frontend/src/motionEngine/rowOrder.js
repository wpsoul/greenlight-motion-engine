/*
 * The rows of a film's timeline in GreenLight Dash's order, for every page of the engine (PlayerPage.jsx's timeline,
 * studio/lab.js's layer list and row names). A project's channels are its stack, bottom first: the LAST one draws on top.
 * The app pins the Camera to the top of that stack and the 3D Scene's rig right under it (editorState.js
 * pinSingletonChannels, on every load and edit) and its timeline lists the stack top first (Timeline.jsx). The same here:
 * the app's own two pins, then the stack read from the top.
 */
import { isCameraChannel, pinCameraChannelTop } from '../components/videoEditor/projectCamera';
import { pinRigChannelUnderCamera } from '../components/videoEditor/rig3d';

/** The channels as the app keeps them: the Camera last (on top), the 3D Scene's rig right under it. */
export const appChannelOrder = (channels) => pinRigChannelUnderCamera(pinCameraChannelTop(channels || []), isCameraChannel);

/** The channels as the app's timeline lists them, top row first. */
export const timelineOrder = (channels) => [...appChannelOrder(channels)].reverse();
